# Mailman Prototype

**Status:** Ready to build
**Goal:** Prove the core mechanical loop — untrusted input handled by a containerised subagent that never touches the host filesystem.

## What this proves

The Mailman design's central security property: untrusted content is evaluated by an isolated subagent in a container with no access to host files, credentials, or NanoClaw state. The host receives only the subagent's structured tool-call output.

## Vertical slice

```
curl (fake email) → webhook handler → spawn container → subagent triages → tool call → host logs result
```

One email in, one decision out. No digest, no fork, no threads — just the triage loop.

## Pieces to build

### 1. Minimal persona file (`kernel.md`)

A short identity/disposition file injected read-only into every subagent container. Covers: who DMJ is, what the agent's role is, escalation disposition (regret framing). User-writable only.

Location: `mailman/persona/kernel.md`

### 2. Triage prompt (`email_triage.md`)

First-draft system prompt for stateless email triage. Instructs the subagent to call `notify_user` if DMJ would regret missing the message, otherwise call `defer`. Includes the tool schemas for both calls. Injected as the system prompt alongside kernel.md.

Location: `mailman/prompts/email_triage.md`

### 3. Container profile

A lightweight container spawn — reuse the existing NanoClaw container image but with a minimal mount set:

| Mount | Mode | Contents |
|-------|------|----------|
| `/workspace/scratch` | RW | Empty scratch dir, disposable per invocation |
| `/workspace/persona` | RO | `kernel.md` |
| `/workspace/prompt` | RO | `email_triage.md` |
| `/workspace/input` | RO | The email payload (single file, written by host before spawn) |

No session DBs, no outbox Maildirs, no OneCLI gateway, no vault secrets. The container runs `claude -p` with assembled context and exits.

Key question: can we reuse `container-runner.ts`'s spawn machinery, or is it simpler to write a dedicated lightweight spawner? The existing runner is tightly coupled to session DB setup and agent-group lifecycle. A standalone `spawnSubagent()` function that calls `docker run` with explicit args is probably cleaner for the prototype.

### 4. Webhook handler (or CLI script)

Two options, both trivial:

**Option A — Webhook handler (preferred):**
Register via `registerWebhookHandler('mailman', handler)` in `src/webhook-server.ts`. Accepts a POST with JSON or raw email body. Writes payload to a temp file, spawns the container, collects stdout.

**Option B — CLI script:**
`scripts/mailman-triage.ts` — takes a file path or stdin, does the same thing. Useful for testing without the host running.

Build both: the script for dev iteration, the webhook for integration.

### 5. Stdout parser

The container's `claude -p` writes to stdout. Parse the output for tool calls (`notify_user` or `defer`). Log the decision. For the prototype, logging is sufficient — no delivery through channel adapters yet.

## File layout (prototype)

```
mailman/
  persona/
    kernel.md
  prompts/
    email_triage.md
  test-emails/
    shipping-delay.eml
    newsletter.eml
    urgent-from-known-sender.eml
src/
  mailman/
    subagent.ts          — spawnSubagent(): write input, docker run, parse stdout
    webhook.ts           — registerWebhookHandler('mailman', ...), calls subagent
scripts/
  mailman-triage.ts      — CLI entry point for manual testing
```

## What we skip

| Skipped | Why |
|---------|-----|
| Digest + sweep agent | Prototype only needs one decision per email |
| Fork lifecycle | Subagent escalation goes straight to log output |
| Stateful/threaded agents | Email is stateless; threads come later |
| Extended.md + summariser | kernel.md alone is enough for triage |
| intents.md | No interest-list matching yet |
| User capsule | Can fold minimal user context into kernel.md |
| TOML subagent registry | One hardcoded subagent config |
| Real email relay | curl/script simulates inbound email |
| Channel adapter delivery | Log output, not Telegram/Slack notification |

## Estimated effort

~3–4 focused sessions. The mechanical risk is in piece 3 (container profile) — getting the right `docker run` incantation with minimal mounts and a `claude -p` entrypoint that exits cleanly.

## How to test

```bash
# Drop a test email through the CLI script
echo '{"from":"carrier@example.com","subject":"Delivery failed","body":"..."}' | pnpm exec tsx scripts/mailman-triage.ts

# Or via webhook (with host running)
curl -X POST http://localhost:3000/webhook/mailman \
  -H 'Content-Type: application/json' \
  -d '{"from":"carrier@example.com","subject":"Delivery failed","body":"Your package could not be delivered."}'
```

Expected output: a log line showing the subagent's tool call (`notify_user` with reasoning, or `defer`).

## After the prototype

Once this works, the path to the full Mailman design (see design doc) is:

1. Add fork lifecycle — second container, different model, evaluates escalation claims
2. Add digest + sweep — deferred items accumulate, 8hr sweep finds patterns
3. Add stateful agents — per-thread JSONL management for chat channels
4. Add persona files — extended.md, intents.md, user capsule, summariser
5. Wire notification delivery through existing NanoClaw channel adapters
6. Config-driven subagent registry

Each step is additive. The prototype's `spawnSubagent()` is reused by every subsequent piece.

## Design doc reference

The full Mailman triage pipeline design lives in the conversation where it was authored (2026-06-19 session with DMJ). Key architectural decisions: untrusted input never reaches the main agent context; model diversity between subagent and fork; persona split into kernel (verbatim) vs extended (summarised); regret-framing for triage decisions.
