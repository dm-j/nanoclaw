# Inference Routing

Model-prefix routing (Ollama vs Anthropic) is handled by **PrefixRouter**, a
sibling project (`~/Projects/PrefixRouter`), not by NanoClaw itself. NanoClaw
used to run its own prefix-stripping proxy (`src/inference-router.ts`,
port 10261) — deleted in favor of pointing containers at PrefixRouter, which
already does this generically for any Anthropic-shaped client.

```
container
  ANTHROPIC_BASE_URL=http://host.docker.internal:8787
    → PrefixRouter :8787
        ollama/...   → localhost:11434
        anthropic/*  → api.anthropic.com (via OneCLI, HTTPS_PROXY-injected creds)
        <no prefix>  → api.anthropic.com (catch-all rule, default)
```

Set a group's model in `container.json` to `ollama/kimi-k2.6:cloud` (or similar)
to route it to Ollama; omit `model` (or use a bare Anthropic model name) to
hit Anthropic via OneCLI by default.

PrefixRouter's own config lives at `~/Projects/PrefixRouter/config.json` (not
in this repo). Credentials are never put in `apiKeyEnv`/`config.json` — the
`anthropic` endpoint has no key configured; PrefixRouter's `HTTPS_PROXY`
points at OneCLI (`127.0.0.1:10255`), which injects real credentials on the
wire per request, same as every other container egress path in NanoClaw.
See PrefixRouter's own `README.md` (`GET /readme` on the running instance)
for CLI usage and config format.

`NO_PROXY=host.docker.internal` still accompanies `ANTHROPIC_BASE_URL` in
`container-runner.ts` so the plain-HTTP hop to PrefixRouter isn't itself
routed through OneCLI's proxy.
