# NanoClaw Maildir Runtime — Design Document

## 1. Overview

This document describes a Maildir-based runtime for NanoClaw agents. It replaces the session-DB transport with plain RFC822 files in standard Maildir directories, watched by `fs.watch`, delivered by channel-specific egress adaptors.

The system has three agent roles:

- **Thread agents** — persistent subagents, each bound to a single `Thread-ID`. They own conversational continuity for one thread. They do not contact the user directly; they escalate to the main agent.
- **Main agent** — the user-facing authority. It communicates with the user, reviews escalations from thread agents, and maintains shared guidance files.
- **Thread dispatcher** — a host-side component that groups inbound messages by `Thread-ID` and routes them to the correct thread agent's inbox.

The host is responsible for producing inbound mail, dispatching it to thread agents, watching outbox Maildirs for responses, and delivering those responses through channel adaptors. The agent's only IO surface is the filesystem.

---

## 2. Why Maildir

### 2.1 Context Tax

A single agent processing all threads pays the cost of loading every thread's history into one model context. A Telegram DM, an email thread, and a Discord channel all accumulate in the same session — each subsequent turn replays the full history.

Thread-per-session isolation eliminates this. Each thread agent's context contains only its own thread.

### 2.2 Context Contamination

When unrelated threads share a model context, their histories become entangled. A conversation about a package delivery influences how the model reasons about an unrelated email. Thread isolation prevents this.

### 2.3 Durability

RFC822 files in Maildirs are the most durable message format available. They survive process crashes, don't require transaction journals, and can be inspected with `cat`. SQLite databases on Docker Desktop's virtual filesystem layer are vulnerable to page-cache coherency bugs that corrupt data during normal read operations.

### 2.4 Universality

Every LLM has been trained on decades of email and Maildir examples. The agent doesn't need special tooling — it uses `cat`, `mv`, `grep`, and heredocs. The paradigm is self-documenting.

---

## 3. Principles

### 3.1 Mail is Truth

Mail messages are the authoritative event record. Every inbound and outbound communication is an immutable RFC822 file. Messages are never edited after creation.

### 3.2 Thread-ID Owns Context

A `Thread-ID` identifies a persistent thread-local agent session. Each thread agent owns exactly one conversational context that persists across messages. Thread agents do not see other threads' messages.

### 3.3 Trust is a Property of the Transport

Header hygiene is the ingress adaptor's responsibility. A Discord adaptor delivers API-verified identities and may promote headers directly. An email adaptor delivers unverified claims and must relegate sender-supplied headers to `Apparently-*` prefixed alternatives. The adaptor author encodes this decision at ingestion time.

### 3.4 Outboxes are Capabilities

A `Response-Maildir` header grants the agent permission to write to a destination. The agent does not infer destinations. It writes only to Maildirs specified in trusted headers.

### 3.5 Access Control is Host-Side

The host-side ingress layer enforces access control before a message reaches the agent's inbox. The agent trusts whatever the ingress placed there.

### 3.6 No SQLite in the Maildir Path

The maildir transport uses plain files and `fs.watch` exclusively. No SQLite databases are read or written for message delivery between host and container. This avoids the Docker Desktop macOS virtualization layer's page-cache coherency bugs that can corrupt SQLite databases during cross-mount reads.

---

## 4. Architecture

```text
External message
  ↓
Ingress adaptor (host-side)
  — Creates RFC822 message with authoritative headers
  — Writes to shared inbox: groups/<folder>/mail/inbox/new/
  ↓
Thread dispatcher (host-side, fs.watch on inbox/new/)
  — Parses Thread-ID from each message header
  — Groups messages by Thread-ID
  — Atomically renames each message into the thread's inbox:
    groups/<folder>/mail/threads/<thread-id>/inbox/new/
  — Ensures a per-thread session exists
  — Wakes the thread's container (if not running)
  ↓
Thread agent container (fs.watch on thread inbox/new/)
  — Claims messages: mv new/* → cur/:2,S
  — Reads message content
  — Writes RFC822 replies to Response-Maildir (outbox)
  — May escalate to main agent via mail/escalations/new/
  ↓
Egress adaptor (host-side, fs.watch on outbox/new/)
  — Claims message: rename to cur/:2, (no flags)
  — Reads .binding for delivery metadata
  — Delivers via channel API (Telegram, Discord, etc.)
  — Renames to cur/:2,SP on success or cur/:2,F on failure
  — Staggers deliveries (1s between messages) to avoid rate limits
```

---

## 5. Directory Layout

```text
groups/<folder>/
  mail/
    inbox/                    ← Shared landing zone
      tmp/ new/ cur/            Ingress writes here; dispatcher reads + renames out
    threads/
      <thread-id>/
        inbox/
          tmp/ new/ cur/      ← Thread agent reads from here
    escalations/
      tmp/ new/ cur/          ← Thread agents write escalations here
    out/
      <channel>/
        <address>/
          tmp/ new/ cur/      ← Agent writes responses here
          .binding            ← Non-secret routing metadata (RFC822 headers)
  scratch/
    intents.md                ← Active user interests (main agent maintains)
    notification-guidance.md  ← Escalation rules (main agent maintains)
    ledger.md                 ← Action log for escalation forks
```

Thread-specific directories under `mail/threads/` are created on demand by the dispatcher when the first message for a Thread-ID arrives.

---

## 6. Message Format

Every message is RFC822: headers, blank line, body.

### 6.1 Inbound Message Example

```text
From: telegram:8681992127
To: Lumen
Date: Thu, 19 Jun 2026 14:30:00 GMT
Message-ID: <uuid@hostname>
Thread-ID: mg-1781737993807-3hujo0
Response-Maildir: /workspace/mail/out/telegram/8681992127
Response-Expected: yes
Channel-Type: telegram
Platform-ID: telegram:8681992127
Content-Type: text/plain; charset=utf-8

Can you remind me what we decided about the deployment?
```

### 6.2 Reply Example

```text
From: agent@agents.local
To: telegram:8681992127
Date: Thu, 19 Jun 2026 14:30:15 GMT
Message-ID: <reply-uuid@hostname>
Thread-ID: mg-1781737993807-3hujo0
In-Reply-To: <uuid@hostname>
Content-Type: text/plain; charset=utf-8

We decided to deploy on Friday after the freeze lifts.
```

### 6.3 Escalation Example

```text
From: thread-agent@agents.local
Date: Thu, 19 Jun 2026 14:31:00 GMT
Message-ID: <esc-uuid@hostname>
Thread-ID: mg-1781737993807-3hujo0
Escalation-Type: notify_user
Content-Type: text/plain; charset=utf-8

Kickstarter project "XYZ" has shipped. Tracking number attached.
User may want to know — matches active intent "package tracking".
```

---

## 7. Key Headers

### 7.1 Required on Every Message

| Header | Purpose |
|--------|---------|
| `Message-ID` | Unique identifier |
| `Date` | Creation timestamp |
| `From` | Sender identity |
| `Thread-ID` | Conversation thread key — determines which thread agent processes the message |
| `Content-Type` | Body format |

### 7.2 Inbound-Specific

| Header | Purpose |
|--------|---------|
| `Response-Expected` | `yes`, `no`, or `only if you have something material to add` |
| `Response-Maildir` | Container path to the outbox where the agent writes replies |
| `Channel-Type` | Source channel (telegram, discord, email, etc.) |
| `Platform-ID` | Channel-specific address |
| `Is-Main-Agent` | When `true`, routes to the main agent instead of a thread agent |

### 7.3 Reply-Specific

| Header | Purpose |
|--------|---------|
| `In-Reply-To` | The inbound `Message-ID` being replied to |

### 7.4 Escalation-Specific

| Header | Purpose |
|--------|---------|
| `Escalation-Type` | `notify_user` or `request_action` |

### 7.5 Adaptor Headers

Adaptors may add channel-specific headers. Headers that the adaptor cannot verify as authentic must be prefixed with `Apparently-` (e.g. `Apparently-From` for unverified email senders).

---

## 8. Maildir Semantics

Standard Maildir conventions apply throughout.

### 8.1 Writing

Write to `tmp/`, then atomically rename to `new/`. Never write directly to `new/`.

### 8.2 Claiming

A consumer claims a message by renaming it from `new/` to `cur/` with a `:2,S` suffix (Seen). This is atomic — if two consumers race, only one rename succeeds.

### 8.3 Flags

```text
S   Seen (claimed by consumer)
P   Passed / delivered
F   Failed / flagged
```

Combinations: `:2,SP` = delivered successfully. `:2,SF` = escalated. `:2,F` = delivery failed.

### 8.4 Filenames

Standard Maildir: `<timestamp>.M<usec>P<pid>.<hostname>`

---

## 9. Ingress Adaptors

An ingress adaptor converts external messages into RFC822 files in the shared inbox. Each adaptor implements a `MaildirAdaptor` interface with three concerns:

### 9.1 Threading

`threadId(event, messagingGroup)` — determines the `Thread-ID` header. Threading is channel-specific:
- **Telegram**: all DMs from one person share a Thread-ID; all messages in a group chat share a Thread-ID (keyed on messaging group ID)
- **Email**: threaded by References/In-Reply-To chains
- **Discord**: per-channel or per-thread

### 9.2 Response Expectations

`responseExpected(event, messagingGroup)` — determines the `Response-Expected` header:
- Telegram DM: `yes`
- Telegram group, agent mentioned: `yes`
- Telegram group, not mentioned: `only if you have something material to add`

### 9.3 Main Agent Routing

`isMainAgent(event, messagingGroup)` — when `true`, sets `Is-Main-Agent: true` header. The dispatcher routes these to the main agent session instead of a thread agent.

### 9.4 Typing Indicator

`onIngested(event, messagingGroup)` — optional fire-and-forget hook. The Telegram adaptor sends a `sendChatAction: typing` indicator here.

### 9.5 Binding Overrides

The outbox `.binding` file may contain:
- `Thread-Override: <id>` — forces all messages through this channel into a specific thread, enabling cross-channel conversations.

---

## 10. Thread Dispatcher

The thread dispatcher is a host-side `fs.watch` on `groups/<folder>/mail/inbox/new/`. When files appear (debounced: 500ms window, 2s cap):

1. Parse `Thread-ID` and `Is-Main-Agent` headers from each file
2. Group files by routing:
   - `Is-Main-Agent: true` → main agent (agent-shared session)
   - Has `Thread-ID` → per-thread session
   - No `Thread-ID` → main agent (fallback)
3. For each thread group:
   - Ensure thread inbox exists: `mail/threads/<thread-id>/inbox/{tmp,new,cur}/`
   - Atomically rename each file from `inbox/new/` to the thread's `inbox/new/`
   - Ensure a per-thread session exists in the DB (keyed by agent group + thread ID, no messaging group FK)
   - Wake the container if not running
4. For main-agent messages:
   - Leave files in `inbox/new/` (the main agent container watches this directly)
   - Ensure agent-shared session exists
   - Wake the container if not running

The dispatcher does NOT write to any SQLite database for message delivery. It only creates session rows (once per thread, not per message) and calls `wakeContainer`.

---

## 11. Agent Container Model

Each session gets its own Docker container with an isolated Claude Code session.

### 11.1 Wake Model

The container's agent-runner detects a maildir inbox at startup and runs a **watch-driven loop** instead of the traditional DB poll loop:

1. `fs.watch` on the inbox `new/` directory
2. When files appear (debounced), claim all messages: `mv new/* → cur/:2,S`
3. Read claimed messages, format as a prompt with the full RFC822 content
4. Query the provider (Claude Code SDK)
5. The agent uses bash tool calls to write RFC822 replies to the outbox
6. After the query completes, check for more messages (in case files arrived during processing)
7. Processing is serialized — only one query runs at a time

This eliminates SQLite from the container's inbound path entirely.

### 11.2 Container Mounts

**Thread agent containers** (session has `thread_id`):
- `mail/threads/<thread-id>/` → `/workspace/mail/thread/` (RW — agent reads its inbox)
- `mail/out/` → `/workspace/mail/out/` (RW — agent writes responses)
- `mail/escalations/` → `/workspace/mail/escalations/` (RW — agent writes escalations)
- `scratch/` → `/workspace/scratch/` (RW — shared guidance files)
- Group dir → `/workspace/agent/` (RW — CLAUDE.local.md, working files)

**Main agent containers** (no `thread_id`):
- Full `mail/` → `/workspace/mail/` (RW — reads inbox directly)
- `scratch/` → `/workspace/scratch/` (RW)
- Group dir → `/workspace/agent/` (RW)

### 11.3 Role-Specific Instructions

The agent's CLAUDE.md is composed from shared fragments. The `skill-maildir.md` fragment is overridden at mount time based on session role:

- Thread agent → `thread-agent.md` (own one thread, escalate via mail, regret-based notification criterion)
- Main agent → `main-agent.md` (user-facing authority, escalation review, guidance file ownership, ledger keeping)

Both roles share: base agent instructions, MCP tool fragments, per-group memory (`CLAUDE.local.md`), and `@`-included scratch files (intents.md, notification-guidance.md).

---

## 12. Egress Adaptors

The egress watches all outbox `new/` directories via `fs.watch`. When a file appears:

1. Read the RFC822 body
2. Claim the file: rename to `cur/<name>:2,` (no flags — atomic claim prevents duplicate delivery from concurrent watch fires)
3. Read the `.binding` file for delivery metadata (Channel-Type, Chat-ID, Platform-ID)
4. Deliver via the channel adapter's `deliver()` method
5. Rename to `cur/<name>:2,SP` on success or `cur/<name>:2,F` on failure
6. Stagger 1 second between deliveries in the same batch to avoid channel rate limits (e.g. Telegram)

---

## 13. Thread Agents

A thread agent is a persistent subagent bound to a single `Thread-ID`.

### 13.1 Properties

- One Thread-ID, one persistent Claude session
- Receives only messages for its thread
- Does not contact the user directly
- Escalates via `notify_user` or `request_action` (RFC822 messages to `mail/escalations/new/`)
- Reads shared guidance files (intents, notification rules) but does not modify them

### 13.2 Lifecycle

**First message**: dispatcher creates thread inbox dirs and a session row. Container spawns, detects maildir inbox, starts watching.

**Subsequent messages**: dispatcher renames into existing thread inbox. Running container's `fs.watch` detects the file and processes it. If container has exited, it respawns and resumes the Claude session via continuation.

### 13.3 Notification Criterion

The thread agent does not ask "should the user be notified?" — that biases toward silence.

Instead: "If the user found out about this a week later and learned they were not notified, would they regret it?"

Thread agents check `scratch/intents.md` (what the user is currently paying attention to) and `scratch/notification-guidance.md` (rules and amendments from the main agent) when calibrating escalation decisions.

---

## 14. Main Agent

The main agent is the user-facing authority.

### 14.1 Direct Communication

The main agent is the only agent that contacts the user. It reads from `mail/inbox/new/` (messages marked `Is-Main-Agent: true` or without a `Thread-ID`).

### 14.2 Escalation Review

When a thread agent writes to `mail/escalations/new/`, a host-side escalation watcher creates an **ephemeral fork** — a fresh Claude session that inherits:

- The group's personality and memory (CLAUDE.local.md)
- Shared scratch files (intents, guidance, ledger)
- The full mail tree (for sending notifications)
- A tail of the main agent's recent Claude transcript (~8K chars of user/assistant messages), injected as read-only context so the fork knows what the user has been discussing

The fork reviews the escalation and decides one of five outcomes:

| Outcome | Effect |
|---------|--------|
| **notify-now** | Contact user immediately; add to digest as already-notified |
| **digest-attention** | Add to digest for later user attention |
| **dismiss** | No action; optionally record reason |
| **delegate-action** | Delegate to utility agent (calendar, drafting, research) |
| **amend-guidance** | Update notification-guidance.md to correct recurring patterns |

### 14.3 Fork Lifecycle

After the fork container exits:
1. Read the fork's outbound for result text
2. Write a compact `escalation-summary` system message to the main agent's session (context-only, does not wake)
3. Delete the ephemeral session directory and DB row

The main agent's next turn sees the summary as background context.

### 14.4 Shared Guidance Files

The main agent owns:
- `scratch/intents.md` — what the user is currently paying attention to
- `scratch/notification-guidance.md` — escalation rules and amendments
- `scratch/ledger.md` — compact action log

Thread agents read these via `@` includes in CLAUDE.local.md. Only the main agent modifies them.

---

## 15. Binding Files

Each outbox directory may contain a `.binding` file with RFC822-style non-secret routing metadata:

```text
Channel-Type: telegram
Chat-ID: 8681992127
Platform-ID: telegram:8681992127
Display-Name: DMJ
Is-Group: false
```

Optional fields:
- `Thread-Override: <thread-id>` — forces all messages through this channel into a single thread (cross-channel conversations)

The agent reads `.binding` for context but never modifies it. Secrets are never in `.binding`.

---

## 16. INBOUND_MODE Switch

The host router supports three modes via the `INBOUND_MODE` environment variable:

| Value | Session DB | Maildir |
|-------|-----------|---------|
| `traditional` | writes to inbound.db, wakes container | no maildir write |
| `maildir` | no session DB write, no direct wake | writes RFC822, dispatcher handles wake |
| `both` (default) | writes to both | both paths active |

This allows gradual migration from the traditional transport to maildir.

---

## 17. Execution Flow

```text
External message arrives
  ↓
Ingress adaptor creates RFC822 in inbox/new/
  (assigns Thread-ID, Response-Expected, Response-Maildir per channel rules)
  ↓
Thread dispatcher (fs.watch) groups by Thread-ID
  ↓
Dispatcher renames message to thread inbox/new/
  (atomic — no copy, no intermediate state)
  ↓
Container's fs.watch detects new file
  ↓
Agent claims message (mv new/ → cur/:2,S)
  ↓
Agent reads, processes, may respond or escalate
  ↓
Response → outbox/new/ → egress delivers → cur/:2,SP
Escalation → escalations/new/ → ephemeral fork reviews → summary to main session
```

---

## 18. Key Lessons from Implementation

These are non-obvious constraints discovered during implementation. A reimplementation should account for them from the start.

### 18.1 No SQLite Across Docker Mounts

Docker Desktop on macOS uses a virtualization layer (virtiofs/gRPC-FUSE) with kernel page-cache coherency bugs. SQLite databases written by the host and read by the container can return corrupt pages during normal operation. Plain files with atomic rename are immune. The maildir path must not use SQLite for host-container communication.

### 18.2 One Claude Session Per Container

The Claude Agent SDK manages one session per `query()` call. Concurrent queries against the same session cause silent failures. The agent-runner's maildir loop must serialize: one query completes before the next starts. A `processing` flag gates `fire()`.

### 18.3 Claude Code SDK Startup Cost

Each fresh Claude Code session requires spawning a subprocess, loading CLAUDE.md files, initializing MCP servers, and establishing an API connection. First-turn latency is 30-60 seconds. Subsequent turns (with a warm session) are fast. Thread agents that process many messages benefit from container keep-alive.

### 18.4 Don't Block api.anthropic.com

When routing model requests through Ollama (or any alternative provider), do NOT block `api.anthropic.com` via Docker `--add-host`. Claude Code SDK requires connectivity to this endpoint for initialization. Blocking it (even to `127.0.0.1`) causes the SDK to hang indefinitely. The `ANTHROPIC_BASE_URL` environment variable is sufficient to redirect model API calls.

### 18.5 Egress Race Conditions

Multiple `fs.watch` debounce fires can process the same outbox file concurrently, causing duplicate delivery. The fix: claim before delivering. Rename the file from `new/` to `cur/:2,` (no flags) before calling the channel API. If the rename fails, another fire already claimed it — skip. After delivery, rename to add flags (`:2,SP` or `:2,F`).

### 18.6 Stagger Outbound Deliveries

Channel APIs (especially Telegram) rate-limit bot messages. Delivering a batch of responses simultaneously causes the second message to fail. Add a 1-second delay between deliveries in the same batch.

### 18.7 Follow-Up Pushes Don't Work for Maildir Wakes

The agent-runner's poll loop can push follow-up messages into an active query. For maildir-wake messages, this fails: the model sees "you have 1 new message" pushed mid-turn and decides the prior response already handled it. Each maildir wake must get its own query turn. The watch-driven loop (§11.1) solves this by design — each debounce fire produces one query.

### 18.8 Container Config File-Only Fields

The `container_configs` DB table doesn't have columns for `env` or `blockedHosts`. These fields exist only in `container.json`, but `materializeContainerJson()` overwrites the file from the DB on every spawn. File-only fields must be preserved by reading the existing file before overwriting.

---

## 19. Implementation Order

### Phase 1: Core Maildir Loop

1. Maildir directory scaffolding in `initGroupFilesystem`
2. Ingress: write RFC822 to shared inbox from router's `deliverToAgent`
3. `MaildirAdaptor` interface (threadId, responseExpected, isMainAgent, onIngested)
4. Telegram adaptor registration
5. Thread dispatcher: `fs.watch` on inbox, parse Thread-ID, rename to thread inbox
6. Container maildir loop: `fs.watch` on thread inbox, claim, query provider
7. Egress: `fs.watch` on outbox dirs, claim-before-deliver, staggered delivery
8. `INBOUND_MODE` switch in router
9. Container mount logic (thread-specific vs full mail tree)
10. Role-specific instructions (thread-agent.md, main-agent.md) mounted as fragment overlay

### Phase 2: Escalation Pipeline

11. Escalation Maildir scaffold (`mail/escalations/`)
12. Escalation watcher: `fs.watch`, create ephemeral fork, inject main agent transcript tail
13. Fork cleanup: read outbound, write summary to main session, delete ephemeral session
14. `onContainerClose` callback registry
15. Thread agent escalation instructions (how to write to `mail/escalations/`)

### Phase 3: Shared Guidance

16. Seed files: `scratch/intents.md`, `scratch/notification-guidance.md`, `scratch/ledger.md`
17. `@` includes in CLAUDE.local.md
18. Main agent instructions for maintaining guidance files
19. Thread agent instructions for reading guidance files

### Phase 4: Future Work

20. Digest handling (notified vs attention pathways)
21. Cron/system events as mail
22. Email ingress/egress (true RFC822 email channel)
23. Triage phase (mail/triage/, hot vs cold)
24. Thread agent session rotation and lifecycle management
25. Container pooling for reduced cold-start latency
