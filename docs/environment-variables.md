# NanoClaw Environment Variables Reference

Every NanoClaw-specific configuration knob read from `process.env` (or `.env` via `readEnvFile`), across `src/`, `container/agent-runner/src/`, `setup/`, and `scripts/`. Generic OS vars (`HOME`, `PATH`, `USER`, etc.) are excluded. "Current" reflects this install's `.env` (secrets redacted) at time of writing — re-check the file directly rather than trusting this snapshot indefinitely.

## Core / Provider & Model

| Name | Purpose | Default | Current |
|------|---------|---------|---------|
| `DEFAULT_AGENT_PROVIDER` | Instance-wide default provider stamped onto newly created agent groups (`src/config.ts`) | `claude` | (unset — using default) |
| `AGENT_PROVIDER` | Provider override, read directly by test harness (`scripts/test-v2-agent.ts`) | none | (unset — using default) |
| `NANOCLAW_AGENT_PROVIDER` | Setup-time: preselect the provider and skip the interactive picker | none (picker shown) | (unset — using default) |
| `NANOCLAW_PICKED_PROVIDER` | Internal handoff — stashes the setup wizard's provider pick for later init scripts | none | (unset — using default) |
| `ANTHROPIC_BASE_URL` | Custom Anthropic-compatible endpoint (e.g. PrefixRouter) injected into containers and MBIF/mailman subprocesses | SDK default (api.anthropic.com) | `http://host.docker.internal:8787` |
| `NANOCLAW_ANTHROPIC_BASE_URL` | Setup-time override for the base URL written to `.env` during onboarding | none | (unset — using default) |
| `NANOCLAW_ANTHROPIC_AUTH_TOKEN` | Setup-time custom auth token paired with `NANOCLAW_ANTHROPIC_BASE_URL` | none | (unset — using default) |
| `CLAUDE_CODE_OAUTH_TOKEN` | Claude Code OAuth token, threaded into MBIF/briefer/mbif-crew subprocess envs and read by setup's claude-assist flow | none | (unset — using default) |
| `CLAUDE_CONFIG_DIR` | Where the Claude Code CLI's config/session state lives | `$HOME/.claude` | (unset — using default) |
| `CLAUDE_CODE_AUTO_COMPACT_WINDOW` | Operator override for the token threshold at which Claude Code auto-compacts context | derived from model's context window × 0.825 | (unset — using default) |
| `CLAUDE_TRANSCRIPT_ROTATE_AGE_DAYS` | Rotate the agent-runner's Claude transcript file once it's this many days old | none → age-based rotation off | (unset — using default) |
| `CLAUDE_TRANSCRIPT_ROTATE_BYTES` | Rotate the transcript file once it exceeds this many bytes | `12 * 1024 * 1024` (12 MB) | (unset — using default) |
| `TZ` | Install/container timezone for scheduling, message formatting, log timestamps | validated candidate chain → system-detected IANA zone → `UTC` | (unset — system zone applies) |
| `USER_TIMEZONE` | Timezone used by transcript export formatting | `America/Chicago` | (unset — using default) |
| `ASSISTANT_NAME` | Agent's display name (deprecated re-export; WhatsApp adapter reads its own key now) | `Andy` | (unset — using default) |
| `ASSISTANT_HAS_OWN_NUMBER` | Whether the assistant has a dedicated phone number (deprecated re-export, WhatsApp-specific) | `false` | (unset — using default) |
| `NANOCLAW_AGENT_NAME` | Setup-time messaging-channel agent short name | `NanoClaw` | (unset — using default) |
| `NANOCLAW_DISPLAY_NAME` | Setup-time: how agents address the operator; skips that setup prompt | none (prompt shown) | (unset — using default) |

## Container Runtime

| Name | Purpose | Default | Current |
|------|---------|---------|---------|
| `CONTAINER_RUNTIME` | Which container runtime uninstall/verify scripts assume (`docker` vs Apple `container`) | `docker` | (unset — using default) |
| `CONTAINER_IMAGE` | Base image tag containers are built `FROM` | derived per-checkout | (unset — using default) |
| `CONTAINER_IMAGE_BASE` | Per-checkout image base tag prefix, avoids clobbering other installs' images | derived per-checkout | (unset — using default) |
| `CONTAINER_CPU_LIMIT` | `--cpus` limit passed to container spawn, opt-in | unbounded | (unset — using default) |
| `CONTAINER_MEMORY_LIMIT` | `--memory` limit passed to container spawn, opt-in | unbounded | (unset — using default) |
| `NANOCLAW_STAGE_MOUNTS` | Internal — JSON list of staged mounts passed to the container entrypoint (not operator-set) | none | (unset — internal only) |
| `NANOCLAW_HOST_SHIMS_DIR` | Directory of `<name>-host` executables the host-shim relay allows containers to invoke by name | `<project-root>/host-shims` | (unset — using default) |
| `NANOCLAW_CONVERSATIONS_DIR` | Where the Claude provider looks for conversation transcripts inside the container | `/workspace/agent/conversations` | (unset — using default) |
| `WORKSPACE_DIR` | Root of the agent's workspace inside the container | `/workspace/agent` | (unset — using default) |
| `HEIGHTENED_LOG_UNTIL` | `YYYY-MM-DD` date; while today is before it, container spawn captures heightened logs. Self-disarms after | off | `2026-07-17` (past — self-disarmed) |
| `NANOCLAW_EGRESS_LOCKDOWN` | Force all agent container traffic through the OneCLI gateway on a no-internet network | `false` | (unset — using default) |
| `NANOCLAW_EGRESS_NETWORK` | Name of the isolated network used for egress lockdown | `nanoclaw-egress` | (unset — using default) |
| `ONECLI_GATEWAY_CONTAINER` | Container name of the OneCLI gateway, attached to the egress-lockdown network | `onecli` | (unset — using default) |
| `NANOCLAW_TEMPLATES_DIR` | Override path for the local agent-template library | `<project-root>/templates` | (unset — using default) |
| `NANOCLAW_NATIVE_CREDENTIALS` | Opt out of the OneCLI gateway; thread Anthropic credentials from `.env` straight into container env (from the `use-native-credential-proxy` skill) | `false`/unset (gateway path used) | `true` |

## OneCLI & Secrets

| Name | Purpose | Default | Current |
|------|---------|---------|---------|
| `ONECLI_URL` | Base URL of the OneCLI gateway API, written by setup after probing | none | (unset — not present in this `.env`) |
| `ONECLI_API_KEY` | API key the host uses to talk to the OneCLI gateway (approvals bridge) | none | set (redacted) |
| `NANOCLAW_ONECLI_API_HOST` | Setup-time: remote OneCLI API host override | none (local default probed) | (unset — using default) |
| `NANOCLAW_ONECLI_API_TOKEN` | Setup-time: remote OneCLI API token, written into `.env` as `ONECLI_API_KEY` | none | (unset — using default) |
| `MEMSEARCH_BIN` | Path/name of the `memsearch` binary invoked for wikilink-cache lookups | `memsearch` (on `$PATH`) | (unset — using default) |

## Channels & Webhooks

| Name | Purpose | Default | Current |
|------|---------|---------|---------|
| `TELEGRAM_BOT_TOKEN` | Telegram bot API token, read via `readEnvFile` by the Telegram channel adapter | none (adapter disabled without it) | set (redacted) |
| `NANOCLAW_CHANNELS` | Non-interactive migration: comma-separated channel list to skip the interactive channel picker | none (interactive picker shown) | (unset — using default) |
| `NANOCLAW_CHANNELS_REMOTE` | Explicit override for the detected "channels" remote used when fetching the `channels` branch | auto-detected | (unset — using default) |
| `SIGNAL_CLI_PATH` | Path/name of the `signal-cli` binary used by Signal auth setup | `signal-cli` (on `$PATH`) | (unset — using default) |
| `WEBHOOK_PORT` | Port the shared inbound webhook HTTP server listens on | `3000` | (unset — using default) |
| `WEBHOOK_LUMEN_ENABLED` | On/off switch for delivering webhook content to the Lumen agent group | `false` | (unset — feature effectively off) |
| `WEBHOOK_LUMEN_PATH` | Unguessable URL path segment for the generic inbound webhook | none | `tundra-harbor-antelope` |
| `WEBHOOK_LUMEN_AGENT_GROUP_ID` | Agent group the webhook delivers messages into | none | `ag-1781738004490-2axf9a` |
| `WEBHOOK_SHARED_SECRET` | Bearer secret required on inbound webhook POSTs | none | set (redacted) |

## Mailman / Briefing (MBIF)

| Name | Purpose | Default | Current |
|------|---------|---------|---------|
| `MAILMAN_AGENT_GROUP_ID` | Agent group Mailman forks/notifications are delivered to | none (notify/fork skipped with a warning) | `ag-1781738004490-2axf9a` |
| `MAILMAN_MODEL` | Model used for Mailman's cheap triage subagent | `claude-haiku-4-5` | (unset — using default) |
| `ENRON_MAILDIR` | Corpus directory for the canary benchmark script, not a runtime var | `<cwd>/data/enron-corpus/maildir` | (unset — using default) |
| `MBIF_VAULT_PATH` | Path to the Obsidian vault MBIF/briefer/mbif-crew operate on | none (briefing/vault features disabled without it) | `/Users/lumen/Projects/obsidian/lumen-data/lumen-data` |
| `MBIF_LIVE_BRIEFER_MODEL` | Model override for the per-turn synthetic-context briefing pipeline (the one that actually runs live in production), [`briefing-cache.ts`](../src/modules/synthetic-context/briefing-cache.ts). Falls back to `MBIF_BRIEFER_MODEL`, then `ollama/kimi-k2.6:cloud` | `MBIF_BRIEFER_MODEL` → `ollama/kimi-k2.6:cloud` | (unset — using default: `MBIF_BRIEFER_MODEL` currently set, so live briefer runs `ollama/gpt-oss:20b-cloud`) |
| `MBIF_BRIEFER_MODEL` | Model override for the MBIF briefer subprocess — governs the on-demand `recall` tool directly, and is the fallback for `MBIF_LIVE_BRIEFER_MODEL` when that's unset. See [briefer.ts](../src/memory-briefing/briefer.ts) comment for why this default is unset — was hardcoded to haiku, switched off after haiku failed an edge case 2026-07-13 | provider default → `briefer.md` frontmatter (`sonnet`) | `ollama/gpt-oss:20b-cloud` |
| `MBIF_BRIEFER_BASE_URL` | Anthropic-compatible base URL for the briefer subprocess, separate from the container's shared `ANTHROPIC_BASE_URL` | none | `http://localhost:8787` |
| `MBIF_BRIEFER_OAUTH_TOKEN` | OAuth token for the briefer/mbif-crew subprocesses | none | set (redacted) |
| `VAULT_INBOX_PATH` | Where the container-side `remember` MCP tool writes vault inbox notes | `/workspace/vault/00-Inbox` | (unset — using default) |

## Canary (prompt-injection tripwire)

| Name | Purpose | Default | Current |
|------|---------|---------|---------|
| `CANARY_ROUTER_URL` | PrefixRouter URL the canary check talks to for local-model calls | `http://localhost:8787` | (unset — using default) |
| `CANARY_MODEL` | Small local model used as the canary tripwire detector | `ollama/qwen2.5:1.5b` | (unset — using default) |
| `CANARY_QUARANTINE_DIR` | Directory for canary-flagged content pending human review (chmod 700, gitignored) | `<cwd>/data/canary-quarantine` | (unset — using default) |
| `CANARY_OUBLIETTE_DIR` | Directory for confirmed-malicious content (trap tool triggered) | `<cwd>/data/canary-oubliette` | (unset — using default) |

## Synthetic Context

| Name | Purpose | Default | Current |
|------|---------|---------|---------|
| `NANOCLAW_SYNTHETIC_CONTEXT` | Opt-in A/B toggle: resume a truncated last-N-turns transcript each turn instead of full history (see [docs/synthetic-context.md](synthetic-context.md)) | off | (unset — using default, off) |
| `NANOCLAW_SYNTHETIC_CONTEXT_LINES` | Number of transcript lines kept when synthetic context is enabled | `40` | (unset — using default) |
| `NANOCLAW_SYNTHETIC_CONTEXT_SYNC` | Flips the briefing-cache promise to resolve synchronously (`src/modules/synthetic-context/briefing-cache.ts`, `src/router.ts`) | async | (unset — using default) |

## Dashboard

| Name | Purpose | Default | Current |
|------|---------|---------|---------|
| `DASHBOARD_SECRET` | Auth secret for the dashboard's `/api/ingest` endpoint; pusher no-ops entirely when unset | none (dashboard disabled) | set (redacted) |
| `DASHBOARD_PORT` | Port the dashboard pusher posts snapshots to | `3100` | `3100` |

## Setup / Bootstrap

| Name | Purpose | Default | Current |
|------|---------|---------|---------|
| `NANOCLAW_BOOTSTRAPPED` | Guard flag; when `'1'`, setup's bootstrap step is skipped entirely | unset (bootstrap runs) | (unset — using default) |
| `NANOCLAW_REEXEC_SG` | Internal — marks a setup re-exec after a Claude-assisted fix, so the resume path takes over | unset | (unset — using default) |
| `NANOCLAW_SKIP` | Comma-separated setup step names to skip on this run (resuming after a partial run/fix) | none | (unset — using default) |
| `NANOCLAW_SETUP_ASSIST_MODE` | Selects which Claude-assist dispatcher path setup's failure-handling uses | default dispatcher | (unset — using default) |
| `NANOCLAW_SKIP_CLAUDE_ASSIST` | Skip the Claude-assisted auto-fix step, for CI/scripted setup runs | assist enabled | (unset — using default) |
| `NANOCLAW_NO_DIAGNOSTICS` | Disable anonymous setup diagnostics/telemetry ping | diagnostics on | (unset — using default) |

## Misc / Debug

| Name | Purpose | Default | Current |
|------|---------|---------|---------|
| `LOG_LEVEL` | Host logger threshold (`debug`/`info`/`warn`/`error`) | `info` | (unset — using default) |
| `SESSION_DB_PATH` | Session DB path override, set only by the `scripts/test-v2-agent.ts` test harness | none | (unset — test-only) |

---

### `.env` entries not covered above

- `NANOCLAW_NATIVE_CREDENTIALS` — real, documented under Container Runtime.
- `TELEGRAM_BOT_TOKEN` — real, documented under Channels & Webhooks.
