# Host Services Proxy — Design

**Status:** Design
**Context:** Agent containers need access to host-side services (memsearch, future Wire Pod bridge, local model inference) without weakening container isolation. Currently containers only reach the outside world via OneCLI's HTTPS proxy.

---

## 1. Problem

Containers are isolated by design — no `host.docker.internal`, no host filesystem, no raw network access. The sole egress path is OneCLI's HTTPS proxy, which intercepts outbound HTTPS calls and injects credentials.

New host-side services (memsearch, Wire Pod, local Ollama) need to be reachable from containers. Giving containers `host.docker.internal` access breaks the isolation model — a compromised container could probe any host service.

---

## 2. Solution: service proxy in front of OneCLI

A single host-side HTTP proxy sits between the container and OneCLI. The container's `HTTPS_PROXY` points at this proxy instead of directly at OneCLI.

```
Container
  ↓ HTTPS_PROXY=http://proxy:port
Host Services Proxy
  ├── *.memsearch.internal  →  memsearch CLI (local)
  ├── *.vector.internal     →  Wire Pod REST API (future)
  ├── *.ollama.internal     →  Ollama API (future)
  └── *                     →  forward to OneCLI (default)
```

The proxy is the **only** host endpoint the container can reach. It's a chokepoint — every outbound request flows through it, and only registered service routes get local handling. Everything else passes through to OneCLI unchanged.

---

## 3. Routing model

Routes are matched by **hostname**, not path. This preserves the HTTPS CONNECT tunnel semantics that OneCLI uses — the proxy sees the target hostname in the CONNECT request and can route before the TLS handshake.

### Internal hostnames

Services register under the `.internal` TLD (RFC 6762 — reserved, never resolves externally):

| Hostname pattern | Handler | What it does |
|-----------------|---------|--------------|
| `memsearch.internal` | `memsearch` CLI | Runs memsearch commands, returns stdout |
| `vector.internal` | Wire Pod bridge | Forwards to Wire Pod REST API (future) |
| `ollama.internal` | Ollama bridge | Forwards to local Ollama API (future) |
| `*` (default) | OneCLI forward | Pass-through to OneCLI HTTPS proxy |

The container calls `https://memsearch.internal/search?q=...`. The proxy intercepts the CONNECT to `memsearch.internal`, handles it locally, never forwards to OneCLI.

### Why hostnames, not paths

- HTTPS proxy protocol (CONNECT) routes by hostname — the proxy can't see the path until after it terminates TLS
- Clean separation — each service gets its own hostname, no path collision
- Container code uses normal `fetch("https://memsearch.internal/...")` — no special SDK

---

## 4. Trust model

### What the proxy trusts

- Requests from containers on the Docker network (same as OneCLI today)
- Registered service handlers (code running on the host)

### What the proxy does NOT trust

- Request content — memsearch queries could contain prompt injection; the proxy doesn't evaluate them, just relays
- Container identity — the proxy doesn't know which agent group is calling. Per-agent authorization is a future enhancement if needed.

### What containers gain

- Access to registered `.internal` services only
- No access to arbitrary host services
- No `host.docker.internal`
- Same CA cert / TLS setup as OneCLI (the proxy presents the same self-signed cert)

### What containers lose vs current

Nothing — this is strictly additive. The default route is OneCLI pass-through, so existing behavior is unchanged.

---

## 5. Agent identity (network-based, unforgeable)

The proxy must know which agent group is making a request — without trusting anything in the request itself. Headers, cookies, and query parameters are all forgeable by a compromised container.

### Identity from the network layer

Each container has a unique IP on the Docker bridge network. The container cannot forge its source IP. The proxy resolves identity via:

```
Incoming request from 172.17.0.5
  → Docker API: which container has this IP?
  → Container name: nanoclaw-v2-dm-with-dmj-1719100000
  → Parse folder from name: dm-with-dmj
  → DB lookup: folder → agent_group_id
  → Identity: ag-1781738004490-2axf9a
```

### Implementation

The proxy maintains a **container IP → agent group** cache, refreshed on:
- Container spawn (the proxy is in-process with the host, so it can hook `wakeContainer`)
- Cache miss (query Docker API on demand)
- Container exit (invalidate entry)

```typescript
// ponytail: Map, not a class. Refresh on miss.
const ipToAgentGroup = new Map<string, string>();

async function resolveAgent(remoteIp: string): Promise<string | null> {
  if (ipToAgentGroup.has(remoteIp)) return ipToAgentGroup.get(remoteIp)!;

  // Cache miss — query Docker
  const containers = await docker.listContainers({ filters: { label: [CONTAINER_INSTALL_LABEL] } });
  for (const c of containers) {
    const ip = c.NetworkSettings?.Networks?.bridge?.IPAddress;
    const folder = parseFolderFromName(c.Names[0]); // nanoclaw-v2-<folder>-<timestamp>
    if (ip && folder) {
      const group = getAgentGroupByFolder(folder);
      if (group) ipToAgentGroup.set(ip, group.id);
    }
  }

  return ipToAgentGroup.get(remoteIp) ?? null;
}
```

### Container restarts and IP reuse

Container names include a timestamp and change on every spawn. This doesn't affect identity — the cache is keyed by IP, not name. The Docker API query always returns the *current* container at that IP.

When a container exits, the host invalidates its cache entry (the `onExit` callback in `container-runner.ts` already fires on container death). This prevents stale entries from matching a new container that Docker assigns the same IP.

### What happens when identity fails

- **Unknown IP (not a NanoClaw container):** Request rejected. 403, no forwarding, not even to OneCLI.
- **Known IP, no ACL for requested service:** Request rejected. 403 with reason: "agent group X not authorized for service Y".
- **Known IP, authorized:** Request proceeds to handler with agent group ID available.

### Non-container callers

Requests not from a container IP (e.g. from the host itself, localhost) are rejected by default. If the host process needs to call a service handler directly, it calls the handler function in-process — not via HTTP.

---

## 6. Service ACLs

Each service declares which agent groups can access it. Default: none (deny-all).

```typescript
registerService('memsearch.internal', {
  handler: async (req, agentGroupId) => { ... },
  // ACL options (pick one):
  access: 'all',                           // any agent group
  access: ['ag-xxx', 'ag-yyy'],            // specific groups only
  access: (agentGroupId) => boolean,       // dynamic check
});
```

### Per-agent scoping in handlers

Handlers receive the resolved `agentGroupId` and can use it to scope behavior:

- **Memsearch:** reads/writes the agent group's own `.memsearch/` directory. Agent A can't search agent B's memories.
- **Vector:** only the Vector agent group (or groups with Vector access) can issue motor commands.
- **Ollama:** any agent group can call, but the proxy could enforce per-group rate limits.

The handler decides what to do with the identity — the proxy just provides it.

---

## 7. Adding a new host service

A handler is a function that receives an HTTP request, the resolved agent group ID, and returns a response. Registration:

```typescript
registerService('memsearch.internal', {
  access: 'all',
  async handler(req, res, agentGroupId) {
    // agentGroupId is verified — safe to use for scoping
    const memoryDir = path.join(GROUPS_DIR, getFolder(agentGroupId), '.memsearch');
    // ...
  },
});
```

### Checklist for a new service

1. **Choose a hostname:** `<name>.internal`. Must not collide with existing services.
2. **Write a handler:** `(req, res, agentGroupId) => void`. Runs on the host with full access.
3. **Set the ACL:** `'all'`, a list of group IDs, or a function.
4. **Register it** in the proxy's startup.
5. **Document it:** Add to the routing table in section 3.
6. **Container access:** The container calls `https://<name>.internal/<path>`. No container-side changes needed.

### What a handler can do

- Run a CLI tool and return stdout (memsearch)
- Forward to a local HTTP service (Wire Pod, Ollama)
- Read/write host filesystem, scoped by agent group ID
- Access the NanoClaw central DB (if needed)

### What a handler should NOT do

- Expose arbitrary command execution
- Return credentials or secrets (that's OneCLI's job)
- Trust the request content for identity — use the `agentGroupId` parameter
- Bypass the proxy's routing — all traffic flows through the chokepoint

---

## 8. Memsearch service (first handler)

### Scoping: agent group, not session

Memory belongs to the **agent group**, not to an individual session or container. Lumen might have multiple concurrent sessions (different conversations, different containers) — they all read and write the same memory store. The Vector agent has its own, separate store.

```
Lumen session A (container 172.17.0.5)
  → IP lookup → ag-1781738004490-2axf9a → folder: dm-with-dmj
  → memsearch --dir groups/dm-with-dmj/.memsearch/memory/ search "medication"

Lumen session B (container 172.17.0.8)
  → IP lookup → ag-1781738004490-2axf9a → folder: dm-with-dmj
  → same directory, same index, same results

Vector session (container 172.17.0.6)
  → IP lookup → f9e4e40f-... → folder: vector
  → memsearch --dir groups/vector/.memsearch/memory/ search "desk layout"
  → completely separate store
```

The ccplugin's stop hook writes a memory summary after each conversation turn. The init hook searches for relevant context at session start. Both calls hit the proxy, which resolves the agent group from the source IP and scopes the memsearch invocation to that group's directory. Multiple sessions accumulate memories into the same store; any session can recall them.

### Memory directory layout

```
groups/<folder>/.memsearch/
  memory/           ← markdown files, one per day (source of truth)
  index/            ← Milvus Lite index (derived, rebuildable via memsearch reset + index)
```

The `memory/` directory is the source of truth. The index is derived and can be rebuilt at any time. Both persist across container restarts because `groups/<folder>/` is mounted into the container.

### Container side

The ccplugin calls `memsearch` as a CLI tool. We provide a stub script in the container's PATH:

```bash
#!/bin/sh
# Relay memsearch commands to the host services proxy
curl -s "https://memsearch.internal/cli" \
  --data-urlencode "args=$*" \
  --cacert "$NODE_EXTRA_CA_CERTS"
```

The ccplugin hooks (stop hook: summarize + index, init hook: search for context) work unmodified — they just call `memsearch` which hits the stub.

### Host side

The `memsearch.internal` handler receives the verified `agentGroupId` from the proxy's identity layer. It resolves the agent group's folder and scopes all memsearch operations to that group's directory. **No directory parameter comes from the container** — the container cannot influence which memory store it reads or writes.

```typescript
registerService('memsearch.internal', {
  access: 'all',
  async handler(req, res, agentGroupId) {
    const group = getAgentGroup(agentGroupId);
    if (!group) return res.writeHead(404).end('agent group not found');
    const memDir = path.join(GROUPS_DIR, group.folder, '.memsearch', 'memory');
    // All memsearch commands run scoped to this directory
    // e.g.: memsearch search --dir <memDir> <query>
  },
});
```

Endpoints:

```
POST /cli
  body: args=search "medication schedule" --top-k 5 --json-output
  → spawn: memsearch --dir <agent-group-memory-dir> search "medication schedule" --top-k 5 --json-output
  → return stdout

POST /index
  body: content=<markdown text>&path=<relative-path>
  → write content to <agent-group-memory-dir>/<relative-path>
  → spawn: memsearch --dir <agent-group-memory-dir> index .
  → return success

GET /health
  → spawn: memsearch --dir <agent-group-memory-dir> stats
  → return result
```

The `--dir` flag is always injected by the handler, never passed from the container. A compromised container cannot read another agent's memories by manipulating the request.

### Cross-agent memory sharing (future)

By default, each agent group has isolated memory. Sharing is possible by symlinking one group's `.memsearch/` to another's, but that's a deliberate operator decision — not something agents can request. A future ACL extension could allow read-only cross-group search (e.g., Vector can search Lumen's memories but not write to them).

---

## 9. Implementation plan

### Phase 1: Proxy skeleton

1. HTTP proxy server on host, listens on a new port
2. Default route: forward CONNECT requests to OneCLI
3. `.internal` hostname interception: terminate TLS, route to handler
4. Same self-signed CA as OneCLI (containers already trust it)
5. Wire into container startup: `HTTPS_PROXY` points at proxy instead of OneCLI

### Phase 2: Memsearch handler

1. Install memsearch on host (`pip install "memsearch[onnx]"`)
2. Register `memsearch.internal` handler
3. Container stub script in agent image PATH
4. Install ccplugin in agent containers
5. Mount `.memsearch/` directory per agent group
6. Test: agent writes memory, new session searches it

### Phase 3: Future services

- `vector.internal` → Wire Pod REST API bridge
- `ollama.internal` → local model inference (for RSS summarization, etc.)
- Each is one handler registration + documentation

---

## 10. Alternatives considered

| Alternative | Why not |
|-------------|---------|
| `host.docker.internal` | Exposes all host services to container — breaks isolation |
| Session DB transport | Async (write message, poll for response) — too slow for CLI-like memsearch calls |
| Mount Unix socket | Per-service socket mounts; doesn't scale to N services |
| Run memsearch in container | Python + 558MB ONNX model per container; heavy |
| Mount host Python + model RO | Fragile cross-platform, version coupling |

---

## 11. Open questions

- **Per-agent scoping:** Should the proxy enforce which agent group can access which service? Currently no — any container can call any registered `.internal` hostname. Per-agent ACLs are a future enhancement.
- **TLS termination:** The proxy needs to present a cert for `*.internal` that containers trust. Simplest: reuse OneCLI's CA to sign a wildcard cert for `*.internal`.
- **Proxy location in startup:** Does it run as part of the NanoClaw host process, or as a separate sidecar? Ponytail says: same process, one more `listen()` call on a new port.
