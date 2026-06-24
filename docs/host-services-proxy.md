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

## 5. Adding a new host service

A handler is a function that receives an HTTP request and returns a response. Registration:

```typescript
// In the proxy's handler registry
registerService('memsearch.internal', async (req) => {
  // Parse the request, run local logic, return response
});
```

### Checklist for a new service

1. **Choose a hostname:** `<name>.internal`. Must not collide with existing services.
2. **Write a handler:** A function `(req: IncomingMessage, res: ServerResponse) => void`. Runs on the host, full access to host filesystem and processes.
3. **Register it:** Add to the handler map in the proxy's config/startup.
4. **Document it:** Add to the routing table above.
5. **Container access:** The container calls `https://<name>.internal/<path>`. No container-side changes needed beyond knowing the hostname.

### What a handler can do

- Run a CLI tool and return stdout (memsearch)
- Forward to a local HTTP service (Wire Pod, Ollama)
- Read/write host filesystem (with appropriate scoping)
- Access the NanoClaw central DB (if needed)

### What a handler should NOT do

- Expose arbitrary command execution
- Return credentials or secrets (that's OneCLI's job)
- Bypass the proxy's routing — all traffic flows through the chokepoint

---

## 6. Memsearch service (first handler)

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

The `memsearch.internal` handler:

```
POST /cli
  body: args=search "medication schedule" --top-k 5 --json-output
  → spawn memsearch with those args
  → return stdout as response body

POST /index
  body: content=<markdown text>&path=<file path>
  → write to memory dir, run memsearch index
  → return success

GET /health
  → return memsearch stats
```

### Memory directory

Each agent group gets its own memsearch memory directory:

```
groups/<folder>/.memsearch/
  memory/           ← markdown files (source of truth)
  index/            ← Milvus Lite index (derived, rebuildable)
```

The proxy handler reads the agent group ID from a request header (stamped by the container at startup, like the session ID) and scopes the memsearch invocation to that group's directory.

**Cross-agent memory sharing** is possible by pointing multiple groups at the same `.memsearch/` directory, but that's a future decision, not a default.

---

## 7. Implementation plan

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

## 8. Alternatives considered

| Alternative | Why not |
|-------------|---------|
| `host.docker.internal` | Exposes all host services to container — breaks isolation |
| Session DB transport | Async (write message, poll for response) — too slow for CLI-like memsearch calls |
| Mount Unix socket | Per-service socket mounts; doesn't scale to N services |
| Run memsearch in container | Python + 558MB ONNX model per container; heavy |
| Mount host Python + model RO | Fragile cross-platform, version coupling |

---

## 9. Open questions

- **Per-agent scoping:** Should the proxy enforce which agent group can access which service? Currently no — any container can call any registered `.internal` hostname. Per-agent ACLs are a future enhancement.
- **TLS termination:** The proxy needs to present a cert for `*.internal` that containers trust. Simplest: reuse OneCLI's CA to sign a wildcard cert for `*.internal`.
- **Proxy location in startup:** Does it run as part of the NanoClaw host process, or as a separate sidecar? Ponytail says: same process, one more `listen()` call on a new port.
