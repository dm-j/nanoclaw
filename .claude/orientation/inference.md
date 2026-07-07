# Inference Routing (PrefixRouter)

Port 8787, on the sibling **PrefixRouter** project (`~/Projects/PrefixRouter`), not this repo. Every agent container points `ANTHROPIC_BASE_URL` here. NanoClaw's own in-process router (`src/inference-router.ts`, port 10261) was deleted in favor of this — see [docs/inference-router.md](../../docs/inference-router.md).

## Model Prefix Routing

| Prefix | Route |
|--------|-------|
| `ollama/` | Strip prefix → forward to `localhost:11434` (plain HTTP) |
| `anthropic/` | Strip prefix → forward to `api.anthropic.com` |
| _(no prefix)_ | Catch-all rule (`*`, lowest priority) → `api.anthropic.com` |

Example: Lumen's model is `ollama/kimi-k2.6:cloud` — PrefixRouter strips `ollama/`, sends `kimi-k2.6:cloud` to Ollama.

Rules match top to bottom, first hit wins — config lives at `~/Projects/PrefixRouter/config.json` (not in this repo).

## Sub-agent Inheritance

Sub-agents (spawned by the SDK inside a container) inherit `ANTHROPIC_BASE_URL` from the parent container env, so model-prefix routing works transitively without extra config.

## Credentials

The `anthropic` endpoint in PrefixRouter's config has no `apiKeyEnv` set. Instead PrefixRouter's own process runs with `HTTPS_PROXY=http://127.0.0.1:10255` (OneCLI's credential-injecting gateway, not the `:10254` web UI — a prior misconfiguration on this install), so real credentials are injected on the wire per-request, same as every other container egress path.

## NO_PROXY Requirement

PrefixRouter is plain HTTP on `CONTAINER_HOST_GATEWAY:8787`. Without `NO_PROXY=${CONTAINER_HOST_GATEWAY}`, the HTTP_PROXY set by OneCLI would intercept the request and break routing.
