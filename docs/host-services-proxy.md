# Host Services Proxy — Design

**Status:** Design
**Context:** Agent containers need access to host-side services (memsearch, future Wire Pod bridge, local model inference) without weakening container isolation.

---

## 1. Problem

Containers are isolated by design — no `host.docker.internal`, no host filesystem, no raw network access. The sole egress path is OneCLI's HTTPS proxy. New host-side services need to be reachable without breaking isolation.

---

## 2. Solution: service proxy in front of OneCLI

A single host-side HTTP proxy sits between the container and OneCLI. The container's `HTTPS_PROXY` points at this proxy instead of directly at OneCLI.

```
Container
  ↓ HTTPS_PROXY=http://proxy:port
Host Services Proxy
  ├── memsearch.internal  →  memsearch CLI (local)
  └── *                   →  forward to OneCLI (default)
```

The proxy is the **only** host endpoint the container can reach. Only registered `.internal` hostnames get local handling. Everything else passes through to OneCLI unchanged.

---

## 3. Routing

Routes match by **hostname** (not path) — HTTPS CONNECT tunnels expose the hostname before TLS, so the proxy can route without terminating the connection for pass-through traffic.

Services register under `.internal` (RFC 6762 — reserved, never resolves externally). The container calls `https://memsearch.internal/search?q=...`. The proxy intercepts the CONNECT, handles it locally, never forwards to OneCLI.

To add another service: register a handler for a new `.internal` hostname.

---

## 4. Agent identity (network-based, unforgeable)

The proxy must know which agent group is calling — without trusting anything in the request. Headers, cookies, and query parameters are forgeable.

Each container has a unique IP on the Docker bridge network. The container cannot forge its source IP. The proxy resolves identity via:

```
Incoming request from 172.17.0.5
  → Docker API: which container has this IP?
  → Container name: nanoclaw-v2-dm-with-dmj-1719100000
  → Parse folder from name: dm-with-dmj
  → DB lookup: folder → agent_group_id
  → Identity: ag-1781738004490-2axf9a
```

The proxy maintains a **container IP → agent group** cache, refreshed on container spawn, cache miss (Docker API query), and container exit (invalidate via `onExit` callback).

```typescript
// ponytail: Map, not a class. Refresh on miss.
const ipToAgentGroup = new Map<string, string>();

async function resolveAgent(remoteIp: string): Promise<string | null> {
  if (ipToAgentGroup.has(remoteIp)) return ipToAgentGroup.get(remoteIp)!;

  const containers = await docker.listContainers({ filters: { label: [CONTAINER_INSTALL_LABEL] } });
  for (const c of containers) {
    const ip = c.NetworkSettings?.Networks?.bridge?.IPAddress;
    const folder = parseFolderFromName(c.Names[0]);
    if (ip && folder) {
      const group = getAgentGroupByFolder(folder);
      if (group) ipToAgentGroup.set(ip, group.id);
    }
  }

  return ipToAgentGroup.get(remoteIp) ?? null;
}
```

**Identity failure:** Unknown IP → 403, no forwarding. Known IP, unauthorized service → 403. Non-container callers (localhost) → rejected; host calls handlers in-process.

**Container restarts:** Cache is keyed by IP, not container name. Container exit invalidates the entry. New container gets a fresh IP and a fresh cache-miss lookup.

---

## 5. Memsearch service

### Scoping: agent group, not session

Memory belongs to the **agent group**. Multiple Lumen sessions (different containers) read and write the same store. The Vector agent has a separate store.

```
Lumen session A (172.17.0.5) → ag-1781738004490-2axf9a → groups/dm-with-dmj/.memsearch/memory/
Lumen session B (172.17.0.8) → ag-1781738004490-2axf9a → same directory, same index
Vector session  (172.17.0.6) → f9e4e40f-...            → groups/vector/.memsearch/memory/
```

### Memory directory

```
groups/<folder>/.memsearch/
  memory/           ← markdown files, one per day (source of truth)
  index/            ← Milvus Lite index (derived, rebuildable)
```

### Container side

The ccplugin calls `memsearch` as a CLI tool. We provide a stub script in the container's PATH:

```bash
#!/bin/sh
curl -s "https://memsearch.internal/cli" \
  --data-urlencode "args=$*" \
  --cacert "$NODE_EXTRA_CA_CERTS"
```

The ccplugin hooks (stop hook: summarize + index, init hook: search) work unmodified.

### Host side

The handler receives the verified `agentGroupId`, resolves the folder, and scopes all operations. **The container cannot influence which memory store it accesses.**

```typescript
registerService('memsearch.internal', {
  access: 'all',
  async handler(req, res, agentGroupId) {
    const group = getAgentGroup(agentGroupId);
    if (!group) return res.writeHead(404).end('agent group not found');
    const memDir = path.join(GROUPS_DIR, group.folder, '.memsearch', 'memory');
    // Parse args from request, spawn: memsearch --dir <memDir> <args>
    // Return stdout
  },
});
```

One endpoint: `POST /cli` with `args=<memsearch subcommand and flags>`. The `--dir` flag is always injected by the handler.

---

## 6. Implementation plan

### Phase 1: Proxy skeleton

1. HTTP proxy server in the host process, new port
2. Default route: forward CONNECT requests to OneCLI
3. `.internal` hostname interception: terminate TLS, route to handler
4. Reuse OneCLI's CA to sign a `*.internal` cert
5. Wire into container startup: `HTTPS_PROXY` points at proxy instead of OneCLI

### Phase 2: Memsearch handler

1. Install memsearch on host (`pip install "memsearch[onnx]"`)
2. Register `memsearch.internal` handler
3. Container stub script in agent image PATH
4. Install ccplugin in agent containers
5. Mount `.memsearch/` directory per agent group
6. Test: agent writes memory, new session searches it

### Phase 3: Future services

Wire Pod, Ollama, etc. — one handler registration each, same pattern.

---

## 7. Alternatives considered

| Alternative | Why not |
|-------------|---------|
| `host.docker.internal` | Exposes all host services — breaks isolation |
| Session DB transport | Async poll — too slow for CLI-like calls |
| Mount Unix socket | Per-service socket mounts; doesn't scale |
| Run memsearch in container | Python + 558MB ONNX model per container |
| Mount host Python + model RO | Fragile cross-platform, version coupling |
