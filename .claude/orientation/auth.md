# Auth & Identity

## Service Tokens (host-services-proxy)

IP-based identity is unreliable (NAT collapses all container traffic to one IP). Instead:

- A random 32-byte token is generated per-session at spawn: `crypto.randomBytes(32).toString('base64url')`
- Registered: `registerServiceToken(serviceToken, agentGroup.id, session.id)`
- Injected: `NANOCLAW_SERVICE_TOKEN=${serviceToken}` env var into the container
- Revoked: `revokeServiceToken(serviceToken)` in the `killContainer` onExit callback
- Containers send `Authorization: Bearer <token>` on all calls to host-services-proxy

## OneCLI Credential Injection

- OneCLI gateway at `127.0.0.1:10255` — host-only, not reachable from containers directly
- Containers reach it via CONNECT tunnel through host-services-proxy (port 10260)
- Secrets injected per-request at gateway time; nothing in env vars or chat
- `all` secret mode: every matching vault secret auto-injected. `selective` mode: must assign explicitly via `onecli agents set-secrets`
- Web UI at `http://127.0.0.1:10254` for approval rules and secret config (CLI can't set approval policies as of onecli@1.3.0)

## Mount Order (Critical)

OneCLI credential-stub mounts (e.g. `auth.json`) must be applied **after** parent volume mounts in `buildContainerArgs`. The gateway apply (`applyOneCLIContainerConfig`) runs after the volume-mounts loop — don't reorder. If stubs land before parent mounts, the parent shadows them and auth silently degrades.

## Egress Isolation

When `NANOCLAW_EGRESS_LOCKDOWN=true`:
- Agents spawn on an `--internal` Docker network (no direct internet route)
- OneCLI gateway is the only egress hop
- Misconfiguration fails fast (EgressLockdownError), not silently
