# Inference Router

Port 10261. Every agent container points `ANTHROPIC_BASE_URL` here.

## Model Prefix Routing

| Prefix | Route |
|--------|-------|
| `ollama-` | Strip prefix → forward to `localhost:11434` (plain HTTP) |
| `anthropic-` or none | Forward to Anthropic API via OneCLI CONNECT tunnel on port 10255 |

Example: Lumen's model is `ollama-kimi-k2.6:cloud` — the router strips `ollama-`, sends `kimi-k2.6:cloud` to Ollama.

## Sub-agent Inheritance

Sub-agents (spawned by the SDK inside a container) inherit `ANTHROPIC_BASE_URL` from the parent container env, so model-prefix routing works transitively without extra config.

## No_PROXY Requirement

The inference router is plain HTTP on `CONTAINER_HOST_GATEWAY:10261`. Without `NO_PROXY=${CONTAINER_HOST_GATEWAY}`, the HTTP_PROXY set by OneCLI would intercept the request and break routing.
