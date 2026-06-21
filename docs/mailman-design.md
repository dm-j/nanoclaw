# Mailman: Triage Pipeline Design Document

**Status:** Implemented — multi-feed architecture with Gmail, Google Calendar, and ICS feeds
**Authored by:** DMJ + Claude (design sessions, 2026-06-19 through 2026-06-20)
**Code location:** `mailman` branch (installed via `/add-mailman` skill)

---

## 1. Overview

Mailman is a personal triage pipeline for untrusted input (email, calendar changes, notifications). Its core security property is that **the main agent never evaluates untrusted input directly**. All untrusted content is handled by isolated subagents with fresh contexts and restricted tool surfaces.

The system is orchestrated by the NanoClaw host process (TypeScript). Claude Code instances are invoked as stateless subprocesses — inference endpoints with no tool access — not as the orchestrator.

---

## 2. Core Security Principle

```
Untrusted input → Sanitizer (header trust model)
                       ↓
              Subagent (quarantined, fresh context, no tools)
                       ↓
              [escalation only, structured JSON]
                       ↓
              Fork (snapshot of main agent's context)
                       ↓
              [agreed summaries only]
                       ↓
              Main Agent (notification via session message)
```

Original untrusted content never enters the main agent's context. The subagent produces a structured JSON summary; the fork evaluates the **claim**, not the raw message.

### Header Trust Model

Authority headers (From, Sender, Reply-To) in raw input are **untrusted**. The sanitizer (`sanitize.ts`) rewrites them to `Unverified-*` before the triage subagent sees them. Each ingress stamps what it can verify:

- `X-Mailman-Source: <feed-name>` — which feed produced this message
- `X-Mailman-Trust: <method>` — how the ingress authenticated (e.g. `gmail-api`, `gcal-api`, `ics-file`)
- `X-Verified-From: <address>` — sender identity verified by the provider

The triage prompt teaches the subagent to trust `X-Verified-From` and treat `Unverified-From` with suspicion.

### Attachment Stripping

Base64-encoded MIME parts are stripped before reaching the triage subagent, replaced with `[attachment stripped: image/png, 3.2MB]`. Hard cap at 32KB total. This prevents large attachments from overwhelming the model's context.

---

## 3. Agent Roles

| Role | Question asked | Model | Implementation |
|---|---|---|---|
| **Triage subagent** | Would DMJ regret missing this? | Cheap (Haiku) | `subagent.ts` |
| **Fork evaluator** | Given everything I know, does this warrant interrupting? | Same as main agent | `fork.ts` |

### Fork = Main Agent Snapshot

The fork evaluator is not a generic second-opinion model. It's a **read-only snapshot of the main agent's mind** — same CLAUDE.md, same model, same recent conversation transcript (`.jsonl`). It has the user's learned priorities, current projects, and recent context.

The main agent's transcript changes slowly, so the API prompt cache stays warm across fork invocations. Multiple emails arriving in the same window all hit the cached prefix. This makes the fork cheaper than a standalone evaluator despite using a more capable model.

**Fallback:** If no main agent session exists (e.g. before first user message), falls back to standalone kernel persona with Haiku.

---

## 4. Persona Files

### `kernel.md` (verbatim injection into triage subagents)
Core identity, decision-making priors, trust hierarchy. User-writable only. Small by design.

### `intents.md` (verbatim injection into triage subagents)
Standing directives from the main agent that override default triage behavior. Examples: "Notify about all package shipping updates", "Emails from @company.co are always from known senders".

The main agent edits this file directly. Changes take effect on the next triage — no restart needed. The main agent's CLAUDE.local.md tells it about this capability.

### `extended.md` (deferred)
Accumulated context, summarised before injection. Not yet implemented.

---

## 5. Feed System

Feeds are discovered from `mailman/feeds/*/feed.json` at startup. Each directory can optionally contain a `prompt.md` with feed-specific triage guidance appended to the subagent's system prompt.

All feeds write to a single shared Maildir inbox (`mailman/inbox/new/`). The inbox watcher is feed-agnostic — it reads the `X-Mailman-Source` header to load the feed-specific prompt.

### Feed Types

| Type | Handler | Auth | Change detection | Polling |
|------|---------|------|-----------------|---------|
| `gmail` | `gmail-api.ts` | OneCLI OAuth | Gmail API `is:unread` query | Flat interval (default 20min) |
| `gcal` | `gcal-api.ts` | OneCLI OAuth | API `updatedMin` parameter | Tiered (see below) |
| `ics` | `ics-feed.ts` | Plain HTTP URL | Snapshot hash diffing | Tiered (see below) |

### feed.json Format

```json
{
  "type": "gmail | gcal | ics",
  "agent_id": "mailman-<feed-name>",
  "url": "https://...",
  "poll_interval_s": 300,
  "calendar_id": "primary",
  "max_future_days": 30,
  "max_past_days": 1,
  "max_age_days": 3,
  "query": "is:unread category:primary"
}
```

Fields are type-specific. Unknown types log a warning and are skipped.

### Tiered Calendar Polling

Calendar feeds (gcal, ics) use tiered polling — frequent for imminent events, infrequent for distant ones. All tiers offset by -2 minutes from clock boundaries to catch last-minute changes (someone cancels at 1:59, poll at :03 catches it).

| Cadence | Lookahead | What it catches |
|---------|-----------|----------------|
| 5 minutes | 1 hour | Imminent changes |
| 15 minutes | 24 hours | Today/tomorrow |
| 1 hour | 3 days (ics) / 7 days (gcal) | This week |
| Daily (midnight) | 14 days | Baseline sweep |

### ICS Snapshot Diffing

ICS feeds receive calendar snapshots, not change events. The system:

1. **First run / midnight**: fetches ICS, expands recurring events (via `node-ical`) for 14 days, saves hashes as baseline. No notifications.
2. **Tiered polls**: fetches ICS, expands for the tier's window, diffs hashes against baseline.
   - Hash changed on known event → real change, emit
   - New UID not in baseline → genuinely new, emit
   - Event in baseline but missing from current → cancelled, emit
   - Hash unchanged → skip

Events are hashed on meaningful fields (summary, start, end, location, status, attendees). Re-exports without real changes are silent.

---

## 6. Notification Delivery

When the fork agrees an escalation is warranted:

1. The agreed summary is appended to `mailman/state/main-context.jsonl`
2. `notifyMainAgent()` writes a chat message into the target agent group's session (configured via `MAILMAN_AGENT_GROUP_ID`)
3. The container is woken to process the notification
4. The main agent decides how to notify the user via its configured channel

---

## 7. File Layout

```
mailman/                           # On the mailman branch
  persona/
    kernel.md                      # Core triage identity
    intents.md                     # Main agent's standing directives
  prompts/
    email_triage.md                # Triage subagent instructions
    fork_eval.md                   # Fork evaluator instructions
  feeds/                           # Per-feed config + prompts
    gmail-personal/
      feed.json
      prompt.md                    # Optional feed-specific triage rules
    gcal-work/
      feed.json
    ics-work/
      feed.json
      prompt.md
  inbox/
    new/                           # Incoming messages (all feeds write here)
    cur/                           # Processed (with Maildir flags)
    tmp/                           # In-flight (atomic write)
  state/
    main-context.jsonl             # Accumulated agreed escalations
    gcal-seen-<feed>.json          # GCal dedup state
    ics-snapshot-<feed>.json       # ICS baseline snapshots
  test-emails/
    *.eml
src/mailman/
  spawn.ts                         # Shared container-spawn utility
  sanitize.ts                      # Header trust + attachment stripping
  subagent.ts                      # Triage subagent spawner
  fork.ts                          # Fork evaluator (main agent snapshot)
  notify.ts                        # Notification delivery to main agent
  inbox-watcher.ts                 # Maildir watcher → triage → fork pipeline
  webhook.ts                       # HTTP webhook handler
  feeds.ts                         # Feed discovery and type dispatch
  gmail-api.ts                     # Gmail API ingress
  gcal-api.ts                      # Google Calendar API ingress
  ics-feed.ts                      # ICS snapshot-diff ingress
  maildir.ts                       # Shared Maildir writer for synthetic feeds
```

Skills (on `main` branch):
```
.claude/skills/
  add-mailman/                     # Core pipeline install + config
  add-mailman-gmail/               # Gmail feed setup
  add-mailman-gcal/                # Google Calendar feed setup
  add-mailman-ics/                 # ICS calendar feed setup
```

---

## 8. Installation Pattern

Mailman source lives on the `mailman` branch, not trunk. Skills follow the NanoClaw fetch-and-copy pattern (same as `/add-discord`, `/add-telegram`):

1. `/add-mailman` — fetches source from branch, wires into `src/index.ts`, configures target agent group, creates persona kernel, teaches main agent about intents.md
2. `/add-mailman-gmail` — creates feed directory + `feed.json`, sets up OneCLI agent
3. `/add-mailman-gcal` — same, walks through Google Calendar OAuth in OneCLI
4. `/add-mailman-ics` — same, installs `node-ical` dependency, tests ICS URL accessibility

---

## 9. Known Limitations and Deferred Work

| Item | Notes |
|---|---|
| Digest sweep agent | Batch pattern recognition across deferred items. Design exists, not implemented. |
| Stateful/threaded agents | Per-thread JSONL for Teams/Slack channels. Design exists, not implemented. |
| `extended.md` | Agent-writable accumulated persona context, summarised before injection. |
| Intent change notifications | Currently silent. Design calls for human-readable notification on every change. |
| Fork tool surface | No tools at all currently. Countersign mechanism for limited tool access deferred. |

---

## 10. Design Principles

- **Tiny and reason-able.** Each component does one thing and its behaviour is legible.
- **Feed-agnostic pipeline.** All feeds write RFC822-ish messages to one Maildir inbox. Triage is source-blind. New feed types need one handler function and a `feed.json` entry.
- **Security through architecture.** Trust boundaries are structural, not policy-based. Untrusted content cannot reach the main agent context by construction. Header trust is enforced by the sanitizer, not by hoping the model ignores spoofed headers.
- **Fork is the main agent.** The fork evaluator has the same context, model, and priorities as the main agent. It knows what the user is working on and who matters to them this week.
- **Prompt cache friendly.** The fork's system prompt (CLAUDE.md + transcript) changes slowly. Multiple triage calls in the same window share the cached prefix.
- **Container isolation.** Subagents run in Docker with no tools, no host filesystem access, no credentials. OneCLI egress proxy applies API keys on egress.
- **Ponytail.** Flat JSON files for state, a plain Record for the feed registry, no abstractions ahead of need. `// ponytail:` comments mark deliberate shortcuts.
