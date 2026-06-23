# Mailman: Triage Pipeline Design Document

**Status:** MVP Design — Ready for Refinement
**Authored by:** DMJ + Claude (design session, 2026-06-19)
**Intended audience:** Claude Code (implementation)

---

## 1. Overview

Mailman is a personal agent runtime for triaging untrusted input (email, chat, notifications) on behalf of a primary user. Its core security property is that **the main agent never evaluates untrusted input directly**. All untrusted content is handled by isolated subagents with fresh contexts and restricted tool surfaces.

The system is orchestrated by a **TypeScript service**. Claude Code instances are invoked as capable subprocesses — inference endpoints with tool access — not as the orchestrator. The TypeScript service owns all state management, lifecycle, and cadence.

---

## 2. Core Security Principle

```
Untrusted input → Subagent (quarantined, fresh context)
                       ↓
              [escalation only, via tool call]
                       ↓
           Main Agent Fork (different model, controlled context)
                       ↓
              [agreed summaries only]
                       ↓
              Main Agent live context
```

Original untrusted content never enters the main agent's context. The subagent's processed summary is the trust boundary. The fork runs on a different model from the input subagent, raising the cost of a cross-model prompt injection attack.

**Container isolation:** All subagents run in Docker containers with scratch-only RW mounts. No host filesystem access, no credentials, no NanoClaw state. The host receives only structured tool-call output from stdout.

---

## 3. Agent Roles

Three distinct agent roles with distinct prompts and model tiers:

| Role | Question asked | Model tier |
|---|---|---|
| **Input subagent** | Would DMJ regret missing this? | Cheap / fast (e.g. Haiku) |
| **Digest sweep agent** | Does this batch constitute a pattern? | Mid-tier (e.g. Sonnet) |
| **Main agent fork** | Does this warrant action or notification? | Same class as main agent |

---

## 4. Agent Persona Files

The main agent persona is split into two files to balance identity integrity against injection cost:

### `kernel.md`
- Injected **verbatim** into all subagent system prompts
- Contains: core identity, behavioural axioms, decision-making priors, trust hierarchy, escalation disposition
- **User-writable only.** The main agent may propose changes but must not self-apply them.
- Small by design — authoritative and cheap to inject everywhere

### `extended.md`
- **Summarised** before injection (cheap model, triggered on file modification)
- Contains: accumulated context, ongoing projects, interests, communication style, relationship notes
- Agent-writable with audit logging
- Summarisation loss is acceptable — this is context, not identity. Flattened nuance here means the agent is slightly less informed. Flattened nuance in `kernel.md` means the agent behaves differently. That asymmetry is the reason for the split.

### `intents.md`
- Injected **verbatim** into all subagent system prompts
- Maintained by the main agent: free-form notes on elevated-interest topics, senders, channels
- **All changes trigger a user notification** (human-readable, e.g. "Added to interest list: shipping and delivery tracking")
- Writable only by the main agent (which never sees raw untrusted input — only summaries the fork has approved)
- Attack chain to poison intents requires: surviving input subagent triage → persuading a different-model fork → persuading the live main agent → triggering a visible user notification. This is the intended defence depth.

### User Capsule
- Injected verbatim into all subagent system prompts
- Basic data about the primary user to help subagents perform tasks with user needs in mind
- User-writable only

---

## 5. Input Subagent: Stateless (Email, Notifications)

One throwaway Claude Code instance per input. No persistent state.

### Lifecycle (managed by TypeScript service)

```
1. Write input payload to temp file
2. Docker run: scratch RW, persona + prompt RO, input RO
3. claude -p inside container, parses input, emits tool call
4. Host parses stdout for tool calls
5. Act on result (escalate or defer)
6. Container exits, scratch discarded
```

### Tools available to input subagent

| Tool | Actual behaviour | Agent knows? |
|---|---|---|
| `notify_user` | Spawns main agent fork | No — agent believes it notifies user directly |
| `defer` | Appends to digest | Yes |
| *(no action / timeout)* | Treated as implicit defer | N/A |

### Escalation payload (passed to fork via `notify_user`)

```json
{
  "subagent_summary": "Three failed delivery attempts, same carrier, 6-hour window",
  "subagent_reasoning": "Pattern suggests lost package requiring user intervention",
  "original_metadata": { "sender": "...", "timestamp": "...", "channel": "email" }
}
```

The fork evaluates the **claim**, not the raw message.

### Triage framing

The input subagent is instructed to invoke `notify_user` if **the user would regret knowing about or acting on the message until it is too late**. This frames the decision as "regret at missing" rather than "is this worthy" — a more tractable question for a cheap model with limited context.

---

## 6. Input Subagent: Stateful (Teams, Slack, Threaded Chat)

One persistent Claude Code session per thread. The thread is the unit of meaning.

### Lifecycle (managed by TypeScript service)

```
New message arrives for thread:
  → thread JSONL exists? Append message + invoke
  → thread JSONL absent? Write baseline + inject thread history + invoke

Thread goes quiet (configurable TTL, default 24h):
  → Summarise thread JSONL into closing note
  → Archive
  → Delete JSONL

Thread context exceeds size threshold:
  → Summarise early turns
  → Replace with summary, retain recent N turns
  → Continue
```

### Key difference from stateless

The stateful agent accumulates turns. It is **not reset after each message**. It reasons about thread trajectory. "ok" in isolation is noise; "ok" after three people escalating an incident is signal.

---

## 7. Digest

### Structure

Deferred items are appended to a digest file. Each entry:

```
[2026-06-19T09:14Z] sender: noreply@carrier.com | channel: email
  subject: Your package has been delayed
  subagent-summary: Shipping delay notice, no action required.
  subagent-confidence: defer

[2026-06-19T11:03Z] sender: noreply@carrier.com | channel: email
  subject: Delivery attempt failed
  subagent-summary: Delivery failed, redelivery needed.
  subagent-confidence: defer
```

Entries contain **subagent-processed metadata only** — original untrusted content is not stored in the digest. The trust boundary holds.

### Cadence

Digests are swept every **8 hours** — three sweeps per day. Long enough for within-digest patterns to accumulate; short enough to catch slow-burn escalations within a day.

---

## 8. Digest Sweep Agent

### Role

The sweep agent is a **pattern recogniser operating on a temporal slice**. Its job is distinct from the input subagent's job:

- Input subagent: *Would DMJ regret missing this specific message?*
- Sweep agent: *Does this collection, taken together, constitute something DMJ should know about?*

### Context injected

```
• Current digest (batched subagent summaries)
• Previous sweep's findings + thematic summary (for cross-digest continuity)
• intents.md
• kernel.md (verbatim)
• extended.md summary
• User capsule
```

The previous sweep's findings slot is **present in the prompt template but empty at MVP**. Populate it in a later iteration.

### Instruction framing

- Treat the digest as a **corpus**, not a queue
- Look for: accumulation, repetition, escalating urgency, thematic clustering
- A single item that looks more significant in context is a valid escalation reason
- Escalation justification must **name the pattern**, not re-summarise the item

### Output: two distinct artifacts

**1. Tool calls (during run) — one per synthesised finding**

```json
notify_user({
  "finding": "Three failed delivery attempts, same carrier, 6-hour window",
  "evidence": ["digest entry refs or subagent summaries"],
  "reasoning": "Pattern suggests lost package requiring user intervention"
})
```

Each tool call is independent. Multiple findings from one sweep = multiple independent forks. The sweep agent is forced to name each finding discretely before escalating — this prevents glob-escalation.

**2. Thematic summary (produced after tool calls)**

A structured closing statement: overarching themes, signal quality, notable absences, drift from recent norms. Appended to the archive alongside digest entries. Used by the next sweep agent as the "previous sweep" context.

**Prompt engineering note:** The sweep agent must produce the thematic summary **after** emitting tool calls. Findings must be based on direct batch analysis; the summary reflects what was found rather than shaping what is found.

### Model

Run on a **different model from the input subagent**. Mid-tier preferred — pattern synthesis is harder than single-item triage. Model diversity is a defence property, not just a capability choice.

---

## 9. Main Agent Fork

### Purpose

Evaluates a single escalation claim from either an input subagent or a digest sweep agent. Acts as a second opinion running on a different model from the input subagent.

### Lifecycle (managed by TypeScript service)

```
1. cp main.jsonl fork.jsonl
2. Append escalation payload to fork.jsonl
3. Docker run: fork.jsonl RO, scratch RW
4. Parse decision
5a. If act/notify: append agreed summary as system message to main.jsonl; notify user
5b. If disagree: log and discard
6. Container exits, scratch discarded
```

The fork reflects the **current main agent state at moment of escalation**. It diverges from main only in the appended escalation payload. After the run it is discarded — no reconciliation needed.

### Tool surface

The fork's tool surface should be **restricted at MVP**: notify-capable, but not write/execute/send capable unless the main agent's live context countersigns. This limits the blast radius if an adversarial message survives the triage chain.

### Context passed to fork

```json
{
  "finding": "...",
  "evidence": ["..."],
  "subagent_reasoning": "...",
  "source": "input_subagent | digest_sweep"
}
```

The fork evaluates a claim with supporting evidence. It does not re-evaluate raw messages.

---

## 10. Main Agent Context Updates

When the fork agrees to act or notify:

- A summary of the finding and actions taken is **appended as a system message** to `main.jsonl`
- The main agent's live context is updated without the main agent having processed any untrusted input
- The main agent is informed of outcomes, not inputs

---

## 11. Subagent Registry (Configuration)

A config file the TypeScript service reads to instantiate the correct subagent class per input source:

```toml
[subagents.email]
class = "stateless"
model = "claude-haiku-4-5"
prompt = "prompts/email_triage.md"

[subagents.teams]
class = "stateful"
model = "claude-haiku-4-5"
prompt = "prompts/teams_triage.md"
thread_ttl_hours = 24
context_compress_threshold_tokens = 8000

[subagents.digest_sweep]
class = "stateless"
model = "claude-sonnet-4-6"
prompt = "prompts/digest_sweep.md"
```

Adding a new input type = adding a config block and a prompt file. No TypeScript orchestrator changes required.

---

## 12. TypeScript Service Responsibilities

The TypeScript service is the orchestrator. It owns:

| Responsibility | Notes |
|---|---|
| Input source watching | Webhook endpoint, Maildir, etc. |
| Container lifecycle | Spawn, collect stdout, discard |
| Fork lifecycle | Write fork context, invoke, discard |
| Digest file management | Append deferred items, archive after sweep |
| 8-hour sweep cadence | Cron or interval |
| Intent change notifications | Human-readable, delivered to user |
| Thread TTL management | Archive and delete stale stateful agent state |
| User notification delivery | Through existing NanoClaw channel adapters |

Claude Code instances are **stateless subprocesses** from the service's perspective. The service does not depend on Claude Code specifically — any inference endpoint that consumes a context and emits structured tool calls is substitutable.

---

## 13. File Layout (Proposed)

```
mailman/
  persona/
    kernel.md
    extended.md
    intents.md
    user-capsule.md
  prompts/
    email_triage.md
    digest_sweep.md
  test-emails/
    *.eml
  state/
    main.jsonl
    threads/
      <thread-id>.jsonl
  digests/
    current.digest
    archive/
      <timestamp>.digest
  logs/
    intent-changes.log
    triage.log
src/
  mailman/
    subagent.ts
    webhook.ts
```

---

## 14. Known Limitations and Deferred Work

| Item | Notes |
|---|---|
| Cross-digest pattern recognition | Sweep agent currently sees only current digest + previous sweep summary. Full historical pattern matching deferred. |
| Fork tool surface | Restricted at MVP. Countersign mechanism for write/execute deferred. |
| Persona summarisation quality | Cheap summariser may flatten nuance in `extended.md`. Validation step or deterministic template deferred. |
| Intent change revert UX | Notifications are FYI at MVP. One-tap revert deferred. |
| Sweep agent historical injection | Previous sweep slot exists in template but is empty at MVP. |
| Model selection per subagent | Config-driven at MVP. Dynamic model routing (e.g. based on input volume or cost budget) deferred. |

---

## 15. Design Principles

- **Tiny and reason-able.** Each component does one thing and its behaviour is legible.
- **Fail loudly.** A compromised fork that disagrees with itself terminates. Silent failures are not acceptable.
- **Security through architecture.** Trust boundaries are structural, not policy-based. Untrusted content cannot reach the main agent context by construction.
- **Model diversity as defence.** Input subagent and fork run on different models. A prompt injection that works universally across models is harder to construct than one targeting a single model.
- **Substitutability.** Claude Code is a convenient subprocess, not a load-bearing dependency. The orchestrator is model-agnostic.
- **Container isolation.** Subagents run in Docker with minimal mounts. No host filesystem, no credentials unless explicitly granted.
