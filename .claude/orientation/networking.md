# Networking

## Ports

| Port | Service | Notes |
|------|---------|-------|
| 10260 | host-services-proxy | Listens `0.0.0.0`; handles `.internal` service calls (memsearch) + CONNECT tunnel to OneCLI; Bearer token auth |
| 10261 | inference-router | Listens `0.0.0.0`; model-prefix routing (see inference.md); sub-agents inherit via `ANTHROPIC_BASE_URL` |
| 10254 | OneCLI web UI | Approval rules, secret config |
| 10255 | OneCLI proxy | Credential injection; host-only (`127.0.0.1`); containers reach it via CONNECT through port 10260 |
| 11434 | Ollama | Local model server; plain HTTP, no auth |

## Host Gateway (Apple Container)

- Containers reach host via vmnet bridge (`bridge100`), typically `192.168.64.1`
- `detectHostGateway()` in `src/container-runtime.ts` reads the bridge address at spawn time
- Env var `CONTAINER_HOST_GATEWAY` is injected into every container — use this in any URL pointing at the host
- Never hardcode `127.0.0.1` or `host.docker.internal` in container-visible config

## HTTP_PROXY Rewriting

OneCLI injects `HTTP_PROXY=http://127.0.0.1:10255` into containers. Container-runner rewrites this to `http://${CONTAINER_HOST_GATEWAY}:10260` so traffic routes through host-services-proxy (which CONNECT-tunnels to OneCLI). The rewrite happens in `src/container-runner.ts` before spawn.

## NO_PROXY

`NO_PROXY=${CONTAINER_HOST_GATEWAY}` is injected before per-group env overrides so the `HTTP_PROXY` doesn't intercept the plain-HTTP inference router request on port 10261.
