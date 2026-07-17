# Local Customizations

This install has diverged from upstream by 75+ commits of local features (see `/update-nanoclaw`'s divergence check for the live count). Per [customizing.md](customizing.md), a change only really "counts" as part of the fork once it's a skill or has a doc — this page is the index so that list doesn't just live in the commit log.

| Feature | Summary | Full doc |
|---|---|---|
| Inference routing via PrefixRouter | Containers hit a sibling PrefixRouter process (host `:8787`) for model-prefix routing to Ollama/Anthropic, instead of an in-repo router. | [inference-router.md](inference-router.md) |
| Apple Container runtime | Swapped the container runtime from Docker to Apple Container (`container` CLI) — different file-mount model, host gateway, and entrypoint. | [.claude/orientation/runtime.md](../.claude/orientation/runtime.md) |
| Host services proxy + memsearch relay | A host-side relay (`:10260`) that fronts OneCLI and exposes internal services like memsearch to containers without a direct network route. | [host-services-proxy.md](host-services-proxy.md) |
| Mailman triage pipeline | Multi-feed (Gmail, GCal, ICS, RSS) message triage pipeline with a header-trust model and fork-from-transcript evaluation. | [mailman-design.md](mailman-design.md) |
| Per-sender message batching | Groups rapid-fire messages from the same sender into one agent turn instead of one turn per message. | [per-sender-batching.md](per-sender-batching.md) |
| RTK token-compression proxy | Routes agent Bash tool calls (git, pytest, docker, etc.) through `rtk` for 60-90% token savings, wired into every agent group. | [.claude/skills/add-rtk/SKILL.md](../.claude/skills/add-rtk/SKILL.md) |
| Agent tools + per-group timezone | A drop-in CLI tools directory for agents (`tools` command), plus a `.timezone` override and `setlocaltimezone`/`datetime` tools. | [container/agent-runner/src/tools/README.md](../container/agent-runner/src/tools/README.md) |
| Gotcha registry + orientation docs | Self-maintaining "things that burned you" registry, auto-extracted from transcripts on compaction. | [.claude/orientation/index.md](../.claude/orientation/index.md) |
| Generic inbound webhook (Lumen) | `POST` plain text to an unguessable URL + bearer secret, delivered as a chat message to Lumen — server-injects an "external source, be skeptical" warning and logs every attempt for review. | [webhook-lumen.md](webhook-lumen.md) |
| Synthetic context (truncated-transcript A/B) | Opt-in toggle to resume a truncated last-N-turns copy of a session's transcript each turn instead of the full history, with the real transcript still growing untouched in the background. First step toward replacing generic SDK compaction with deliberate, curated context. | [synthetic-context.md](synthetic-context.md) |

## Smaller additions (no dedicated doc)

- **Dashboard** — `/add-dashboard` pushes periodic JSON snapshots for a monitoring UI.
- **`mbif-question` container skill** — structured message-based interactive-flow question asking.
- **`init-calendar` container skill** — calendar init for Lumen's agent group.
- **Chat SDK 4.29.0 bump** — Telegram adapter + core bridge updated together (pinned pair).
- **Agent-to-agent reply timing** — replies append elapsed processing time.

These live entirely in their own `SKILL.md` / commit and don't warrant a standalone doc — check `git log --oneline <base>..HEAD` for the commit if you need the full story.

## Declined upstream features

- **Provider-agnostic memory scaffold (2026-07-16)** — upstream's generic OKF memory feature was left out of a merge because Lumen's own memory system (`working-memory.md` + `.lumen-core.md` + `.memsearch` semantic recall) already does more. See [memory-decision-upstream-declined.md](memory-decision-upstream-declined.md) for the full reasoning and the bar for revisiting it.
