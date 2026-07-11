# Orientation Index

> **Maintenance instruction (for Claude):** This is a gotcha registry — things that burned you, corrected wrong intuition, or required repeated lookup while working on this project. Not exhaustive docs. When something surprises you or turns out differently than you assumed, add it to the relevant file. A PreCompact hook also runs Haiku on the session transcript before each compaction to catch anything you missed. Update or remove entries when they change. Add a new file + index row if a new category warrants it.

Operational knowledge not covered by CLAUDE.md. Read the relevant file before working in that area.

| File | When to read |
|------|-------------|
| [networking.md](networking.md) | Before touching anything involving ports, proxies, or host↔container connectivity. Covers ports (10260/8787/10254/10255/11434), host gateway IP, HTTP_PROXY rewriting, NO_PROXY. |
| [inference.md](inference.md) | Before editing the inference router or any model-prefix routing logic. Before debugging "model not found" or routing errors. Covers `ollama-` / `anthropic-` prefixes and sub-agent inheritance. |
| [auth.md](auth.md) | Before touching credential injection, OneCLI secrets, service tokens, or egress lockdown. Read this if a container is getting 401s or can't reach an API. |
| [runtime.md](runtime.md) | Before adding or modifying container mounts, writing stub scripts, changing the entrypoint, or rebuilding the image. Covers Apple Container file-mount limits, bash-vs-dash, Bun/Node split. |
| [ops.md](ops.md) | When a container is stuck, unresponsive, or producing errors. Before restarting containers. Covers restart patterns, stuck-container diagnosis, SQLite quirks, a2a messaging, one-liners. |
| [external-workarounds.md](external-workarounds.md) | Before touching code that works around a bug in third-party software (SDK/CLI/library) — check here first for the tagging/commit convention and the current list, so a fix stays isolated and cleanly revertable when the upstream bug is eventually fixed. Add a new entry whenever you introduce one. |
