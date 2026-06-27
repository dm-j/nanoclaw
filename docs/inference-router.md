# Inference Router

Routes agent inference requests to different backends based on a model-name prefix, without changing per-container environment variables.

## Problem

- Agents hardcode `ANTHROPIC_BASE_URL` to reach a backend (Anthropic or Ollama directly).
- Sub-agents spawned by Claude Code inherit the container env but may not get the right URL.
- No way to target a specific backend per-request without a container restart.

## Approach

A lightweight HTTP proxy on the host (port **10261**) sits between every agent container and the backends. All containers point `ANTHROPIC_BASE_URL` at the router. The router reads the `model` field from each request body, strips any prefix, rewrites the body, and forwards to the right backend.

```
container
  ANTHROPIC_BASE_URL=http://host.docker.internal:10261
    → inference-router :10261
        ollama-...     → localhost:11434  (plain HTTP)
        anthropic-...  → OneCLI :10255   (CONNECT tunnel, secrets injected)
        <no prefix>    → OneCLI :10255   (default, backward compat)
```

## Model prefix contract

| Prefix | Backend | Example |
|--------|---------|---------|
| `ollama-` | Local Ollama at :11434 | `ollama-kimi-k2.6:cloud` |
| `anthropic-` | Anthropic via OneCLI | `anthropic-claude-sonnet-4-6` |
| _(none)_ | Anthropic via OneCLI | `claude-sonnet-4-6` |

Prefix is stripped before forwarding. Ollama receives the bare model name; Anthropic receives the bare model name with secrets injected by OneCLI.

## Files

| File | Change |
|------|--------|
| `src/inference-router.ts` | New — HTTP server on 10261, body-rewriting prefix router |
| `src/index.ts` | Start inference router alongside host-services-proxy |
| `src/container-runner.ts` | Inject `ANTHROPIC_BASE_URL=http://host.docker.internal:10261` as baseline default |
| `container/agent-runner/src/mcp-tools/agents.ts` | Add optional `model` param to `create_agent` tool schema |
| `src/modules/agent-to-agent/create-agent.ts` | Thread `model` through to `updateContainerConfigScalars` on the new group |
| `groups/dm-with-dmj/container.json` | `model → ollama://kimi-k2.6:cloud`; drop direct Ollama env overrides |

## Routing detail

The router buffers the request body, parses JSON to extract `model`, strips the prefix, rewrites the body, then:

- **Ollama**: plain `http.request` to `localhost:11434`, same path/headers (minus `Host`).
- **Anthropic**: `net.connect` to OneCLI at 10255, `CONNECT api.anthropic.com:443`, TLS upgrade, forward request. OneCLI injects the API key on the wire.

Streaming responses (`text/event-stream`) are piped directly after the prefix rewrite — no buffering of the response.

## Sub-agent inheritance

Built-in Claude Code `Agent` tool sub-agents inherit the container's `ANTHROPIC_BASE_URL`. With the router as the baseline default in `container-runner.ts`, all sub-agents automatically go through it. No extra wiring needed.

## `create_agent` model parameter

Adds optional `model` field to the `create_agent` MCP tool. When set, the new agent group gets that model in its container config at creation time (same path as `provider` inheritance today). Allows an agent to spawn a cheap Ollama worker or a capable Anthropic specialist without operator intervention.
