# NanoClaw Maildir Runtime — Design

## 1. Purpose

This document defines the design for replacing NanoClaw's transport/adaptor core with a Maildir-based runtime.

The system treats mail as the durable integration substrate.

The agent is not responsible for Telegram, Discord, email, cron, webhooks, or other transports. Those are host-side or adaptor-container concerns.

The system has three agent roles:

- **Thread agents** — persistent subagents, each bound to a single `Thread-ID`. They own conversational continuity for one thread and escalate when the user should be informed or action is needed.
- **Main agent** — the user-facing judgment authority. It reviews escalations from thread agents, decides what to do, and is the only agent that contacts the user directly.
- **Thread dispatcher** — a host-side component that groups unread messages by `Thread-ID`, finds or creates the appropriate thread agent, and delivers messages.

The surrounding host/adaptor processes are responsible for:

1. Producing inbound messages.
2. Watching Maildirs.
3. Delivering outbound messages.
4. Maintaining bindings and secrets.
5. Moving messages through Maildir lifecycle states.
6. Dispatching messages to thread agents by `Thread-ID`.

---

## 2. Core Architecture

```text
External systems
  ↓
Ingress adaptors
  ↓
Agent Maildir inbox
  ↓
Agent container
  ↓
Outbound Maildirs
  ↓
Egress adaptors
  ↓
External systems
```

The middle is intentionally opaque.

The host contract does not care whether the agent is NanoClaw, Claude Code, a shell script, or another future agent runtime.

---

## 3. Fundamental Principles

### 3.1 Mail is Truth

Mail messages are the authoritative event record.

Every inbound and outbound communication is represented as an immutable RFC822-style message file.

Messages are not edited after publication.

### 3.2 Context is a Query

Context is not the source of truth.

Context is generated from authoritative mail records, starting from a leaf message.

### 3.3 Threads are Views

Threads are materialized views built from messages.

Threads can be deleted and regenerated.

A thread is never authoritative.

### 3.4 Summaries are Opinions

Summaries are generated interpretations.

They may be incomplete, stale, or wrong.

Source mail wins over summaries.

### 3.5 Intents are Promotion Criteria

Intents influence triage and promotion.

They are not behavioral instructions.

They are not authoritative memory.

They answer only:

> Should this message be promoted for attention?

### 3.6 Scratch Files are Workspace

Included Markdown scratch files are persistent working context.

They must be actively pruned, summarized, and maintained by the agent.

Mail is the archive. Scratch files are the desk.

The agent is responsible for keeping scratch files concise. This mirrors how CLAUDE.md-based memory systems like MEMORY.md work in practice — build it, watch usage, manage growth once there is data to manage.

### 3.7 Outboxes are Capabilities

A response Maildir is permission to communicate through a destination.

The agent does not infer destinations.

It writes only to Maildirs granted by trusted headers or stable configuration.

### 3.8 Trust is a Property of the Transport

Header hygiene is the adaptor's responsibility.

Trust is determined by the transport, not the header name.

- A Discord adaptor delivers API-verified identities and may promote `From:` and other headers directly to trusted status.
- An email adaptor delivers unverified claims and must relegate most sender-supplied headers to `Apparently-*`.

The adaptor author knows which they have and encodes that decision at ingestion time.

The agent may behave differently based on the presence or absence of a trusted `From:`. If the trusted `From:` is absent or synthetic, the agent treats the message with appropriate skepticism — without needing to know anything about transport mechanics.

### 3.9 Ingestion Confers Authority

Trusted ingress/runtime components add authoritative headers.

The agent trusts authoritative headers over apparent headers.

### 3.10 Bindings Describe Destinations; Secrets Enable Delivery

`.binding` files contain non-secret routing metadata.

Secrets remain in host/adaptor configuration.

Agents may know where. Adaptors know how.

### 3.11 Access Control is Host-Side

Each agent owns its Maildir tree.

Access control — which users or channels may write to the inbox — is enforced entirely by the host-side ingress layer, before a message reaches `new/`.

The agent trusts whatever the ingress placed in its inbox.

This means roles, membership gates, and unknown-sender policies are ingress concerns. The agent never has to reason about them.

### 3.12 Thread-ID Owns Context

A `Thread-ID` is not merely a rendering key.

A `Thread-ID` identifies a persistent thread-local agent context.

```text
Thread-ID → thread agent instance
```

Each thread agent owns exactly one conversational context. It persists across messages in that thread, receives only new unread messages for that same thread, and does not process unrelated threads.

This prevents context tax (repeatedly loading unrelated histories) and context contamination (unrelated thread histories polluting each other inside one model context).

---

## 4. Directory Layout

Recommended MVP layout for a single agent named `lumen`:

```text
agents/
  lumen/
    mail/
      inbox/
        tmp/
        new/
        cur/

      archive/
        tmp/
        new/
        cur/

      junk/
        tmp/
        new/
        cur/

      out/
        telegram/
          direct/
            dmj/
              tmp/
              new/
              cur/
              .binding

    context/
      rendered/
      summaries/

    scratch/
      intents.md
      current-focus.md
      notes.md

    logs/
```

Future layout may add `mail/triage/` and `mail/cool/` for the triage phase, but MVP routes all messages directly to `mail/inbox/new`.

---

## 5. Maildir Semantics

Every Maildir has:

```text
tmp/
new/
cur/
```

### 5.1 Writing a Message

1. Write the complete message into `tmp/`.
2. Atomically rename/move it into `new/`.

Do not write directly into `new/`.

### 5.2 Reading a Message

A consumer reads from `new/`.

After processing, the consumer moves the message to `cur/`.

Inbound messages handled by the agent are moved to `inbox/cur/`. They are not deleted. Growth management is deferred until there is usage data to inform a strategy.

### 5.3 Flags

Standard Maildir flags:

```text
S  Seen
R  Replied
F  Flagged
T  Trashed
D  Draft
P  Passed / forwarded / delivered
```

Suggested conventions:

```text
S   observed by responsible consumer
SP  observed and successfully delivered/passed
SF  observed and failed/flagged
```

### 5.4 Filename Convention

Use standard Maildir filenames:

```text
<timestamp>.M<usec>P<pid>.<hostname>
```

Example:

```text
1718650000.M123456P999.host
```

Do not invent a custom scheme.

---

## 6. Message Format

Messages use RFC822-style headers followed by a blank line and body.

Repeated headers represent arrays.

Example:

```text
From: dmj@direct.telegram
To: lumen@agents.local
Date: 2026-06-17T18:00:00Z
Message-ID: <telegram:direct:dmj:123456>
Thread-ID: telegram:direct:dmj
Response-Expected: true
Response-Maildir: mail/out/telegram/direct/dmj
Provider: telegram
Content-Type: text/plain; charset=utf-8

Can you remind me what we decided about Maildir?
```

---

## 7. Required Headers

Every system-created message must contain:

```text
Message-ID:
Date:
From:
Thread-ID:
Content-Type:
```

Inbound messages that may receive responses should contain:

```text
Response-Expected:
Response-Maildir:
```

Reply messages should contain:

```text
In-Reply-To:
References:
```

Messages should include provider/adaptor metadata where useful:

```text
Provider:
Channel-Address:
Received-By:
Source-Message-ID:
Source-User-ID:
```

---

## 8. Protected Headers and `Apparently-*`

Ingress must protect authoritative headers.

If an external source supplies a protected header, ingestion rewrites it with the `Apparently-` prefix.

Protected headers include at least:

```text
From
To
Date
Message-ID
Thread-ID
In-Reply-To
References
Response-Maildir
Response-Expected
Priority
Provider
Channel-Address
```

Example raw incoming claim:

```text
From: Administrator
Priority: urgent
Response-Maildir: mail/out/email/payroll
```

Ingested form:

```text
Apparently-From: Administrator
Apparently-Priority: urgent
Apparently-Response-Maildir: mail/out/email/payroll
From: dmj@direct.telegram
Provider: telegram
Thread-ID: telegram:direct:dmj
Response-Maildir: mail/out/telegram/direct/dmj
Response-Expected: true
```

Repeated apparent headers are legal:

```text
Apparently-From: David
Apparently-From: dmj
```

How aggressively an adaptor applies `Apparently-*` depends on transport trust:

- Discord: API-verified identity; adaptor may promote headers directly.
- Email: unverified claims; adaptor `Apparently-*`s most sender-supplied headers.

---

## 9. Address Paths and Bindings

### 9.1 Address Paths

Outbound destinations live under:

```text
mail/out/<adapter>/<address-path>/
```

The address path is adaptor-defined and human-readable.

Examples:

```text
mail/out/telegram/direct/dmj
mail/out/discord/the-annex/general
mail/out/email/security-team@example.com
mail/out/agents/archivist
```

Core runtime does not interpret address segments.

### 9.2 Binding Files

Each outbound destination may contain a `.binding` file with non-secret routing configuration, in RFC822-style header format.

Example Telegram binding:

```text
Provider: telegram
Chat-ID: 123456789
Chat-Type: direct
Display-Name: dmj
```

Example Discord binding:

```text
Provider: discord
Guild-ID: 123456789
Guild-Name: the-annex
Channel-ID: 987654321
Channel-Name: general
```

The agent may read `.binding` for descriptive context.

The agent must not edit `.binding`.

Secrets do not appear in `.binding`.

---

## 10. MVP: Telegram Direct Channel

The first executable slice uses Telegram direct messages.

No triage. No cool mailbox. No provider-specific context rendering.

All inbound Telegram messages go directly into `agents/lumen/mail/inbox/new`.

The response Maildir is `agents/lumen/mail/out/telegram/direct/dmj`.

### 10.1 MVP Inbound Message

```text
From: dmj@direct.telegram
To: lumen@agents.local
Date: 2026-06-17T18:00:00Z
Message-ID: <telegram:direct:dmj:123456>
Thread-ID: telegram:direct:dmj
Response-Expected: true
Response-Maildir: mail/out/telegram/direct/dmj
Provider: telegram
Channel-Address: dmj@direct.telegram
Source-Message-ID: 123456
Content-Type: text/plain; charset=utf-8

Can you remind me what we decided about Maildir?
```

### 10.2 MVP Outbound Reply

```text
From: lumen@agents.local
To: dmj@direct.telegram
Date: 2026-06-17T18:00:12Z
Message-ID: <lumen:telegram:direct:dmj:20260617T180012Z>
Thread-ID: telegram:direct:dmj
In-Reply-To: <telegram:direct:dmj:123456>
References: <telegram:direct:dmj:123456>
Provider: telegram
Content-Type: text/plain; charset=utf-8

We decided that Maildir is the durable event substrate...
```

The agent writes this into `mail/out/telegram/direct/dmj/tmp/`, then atomically moves it to `mail/out/telegram/direct/dmj/new/`.

The egress adaptor delivers it and moves it to `cur/` with appropriate flags.

---

## 11. Agent Wake Model

The agent is awakened by a host-side watcher when files appear in `mail/inbox/new`.

Wake message example:

```text
You have 3 unread messages in mail/inbox.
Read the messages, process them, and write any required responses to the Response-Maildir specified in each message.
```

The wake event does not include message contents. The agent reads the Maildir itself.

---

## 12. Agent Container

The agent runs in a Docker container. The container is the blast radius boundary — the agent has more authority inside the container than would be acceptable in a bare host environment.

Each thread agent gets its own persistent Claude session within the container. The container hosts multiple thread agent sessions, each keyed by `Thread-ID`. Thread agent sessions are isolated — they share the container filesystem but maintain separate model contexts.

If cold-start latency becomes a problem in practice, keep-alive makework (a no-op loop or periodic ping) is the first lever to pull. The container model is not changed until there is performance data justifying it.

---

## 13. Thread Dispatcher

The thread dispatcher is a host-side component responsible for thread-agent routing. It runs in the NanoClaw host process, not inside agent containers.

### 13.1 Dispatch Algorithm

```text
watch inbox/new for arriving messages
group unread messages by Thread-ID
for each Thread-ID:
  find existing thread agent or create one
  pass all unread messages for that Thread-ID as one invocation
  move passed messages from new/ to cur/:2,S
```

### 13.2 Responsibilities

The dispatcher:

- Groups unread messages by `Thread-ID`.
- Finds or creates the thread agent for each `Thread-ID`.
- Delivers all unread messages for a `Thread-ID` as a single batch.
- Moves delivered messages to `cur/:2,S`.
- Marks escalated messages `cur/:2,SF` when a thread agent calls `notify_user` or `request_action`.

The dispatcher is distinct from the transport adaptor. Adaptors create mail; the dispatcher routes it to thread agents.

### 13.3 Adaptor vs Dispatcher

```text
Ingress adaptor:
  creates authoritative RFC822 mail
  assigns Thread-ID according to channel rules
  writes to inbox/new

Thread dispatcher:
  reads inbox/new
  groups by Thread-ID
  routes to thread agents
  manages message lifecycle (new/ → cur/)
```

---

## 14. Thread Agents

A thread agent is a persistent subagent bound to a single `Thread-ID`.

### 14.1 Properties

A thread agent has:

```text
one Thread-ID
one persistent model context (Claude session)
one channel/adaptor-specific system prompt
one local notes file or scratch area
one set of channel-specific guidance documents
limited tools for escalation or requested action
```

A thread agent does not have direct authority to contact the user.

A thread agent does not own user-facing judgment.

### 14.2 Lifecycle

**First message in a thread:**

1. The ingress adaptor assigns authoritative headers, including `Thread-ID`.
2. The thread dispatcher checks whether a thread agent exists for that `Thread-ID`.
3. If not, the dispatcher creates one.
4. The dispatcher assembles the thread agent's system prompt according to adaptor/channel rules.
5. The dispatcher passes all unread messages for that thread as the initial input.
6. The passed messages are moved from `new/` to `cur/:2,S`.

**Subsequent messages:**

1. The dispatcher finds the existing thread agent.
2. It gathers all unread messages for that `Thread-ID`.
3. It passes those unread messages to the same thread agent as a single invocation.
4. The thread agent already has prior messages, prior responses, and prior decisions in its persistent context.
5. The passed messages are moved from `new/` to `cur/:2,S`.

### 14.3 System Prompt Assembly

When creating a thread agent, the dispatcher assembles a system prompt from included Markdown files. Conceptual layers:

```text
global agent rules
medium rules
adaptor rules
channel rules
thread-specific notes
notification guidance
user preference files
tool instructions
```

Example paths:

```text
global/thread-agent.md
medium/email.md
provider/gmail.md
channel/david-gmail.md
guidance/notification.md
threads/<thread-id>/notes.md
```

The assembled prompt tells the thread agent:

1. It owns one message thread only.
2. It should preserve local continuity.
3. It should update its local notes when useful.
4. It should not contact the user directly.
5. It should use `notify_user` when the user would likely regret not knowing.
6. It should use `request_action` when the main agent should evaluate or perform an action.
7. It should avoid escalating low-value noise.
8. It may propose notification guidance amendments, but must not apply them directly.

---

## 15. Thread Agent Tools

Thread agents receive objective-oriented tools, not plumbing-oriented tools. Tool names describe the desired outcome, not the implementation effect.

### 15.1 `notify_user`

Purpose: request that the user be informed of something.

Implementation: creates an escalation message for the main agent.

The thread agent should not think in terms of "notify main agent". It should think:

> Would the user likely regret not being told about this within the relevant time window?

Tool description:

```text
Use this when the user would likely regret not being told about this.
This request will be reviewed by the main agent, which may decide how, when, or whether to notify the user.
```

### 15.2 `request_action`

Purpose: request that the main agent evaluate or perform an action.

Examples: calendar action, email reply decision, security review, delegation to utility agent, information lookup.

Implementation: creates an action request message for the main agent.

### 15.3 Tool Effects

Both `notify_user` and `request_action`:

- Send an escalation/request to the main agent.
- Include the thread message(s).
- Include thread-agent notes.
- Include relevant guidance path(s).
- Mark the source messages Flagged: `cur/...:2,SF`.

Neither tool directly contacts the user.

---

## 16. Notification Judgment Criterion

The thread agent should not use "Should the user be notified?" as its primary discriminator. That question biases too strongly toward interruption avoidance.

Instead, the thread agent should use:

> If the user found out about this a week later and learned they were not notified, would they regret it?

Or more generally:

> Would silence create future regret?

This captures non-urgent but costly-to-miss information.

Examples that may justify `notify_user`:

```text
deadline or expiring opportunity
security, money, health, legal, or work consequence
direct request from the user
reply expected from the user
rare/high-signal event matching an active intent
something that changes a prior plan
```

The thread agent raises regret-risk candidates. The main agent decides delivery.

---

## 17. Main Agent Review Loop

Thread agents do not communicate with the user. They send notification/action requests to the main agent.

The main agent is the user-facing judgment authority.

When the main agent receives a `notify_user` or `request_action` escalation, the runtime forks the main agent's current context. The fork receives:

```text
the escalation/request message
the relevant source message(s)
the thread agent's notes
the path to the thread/channel notification guidance document
any relevant thread/channel/medium guidance excerpts
```

The forked main agent decides what to do.

### 17.1 Possible Outcomes

**`notify-now`** — The main agent contacts the user directly. Also adds the item to the nightly digest, marked as already notified.

**`digest-attention`** — Not urgent enough for immediate interruption. Added to a digest for later user attention.

**`dismiss`** — No user-facing attention needed. May record a brief reason.

**`delegate-action`** — Delegates to a utility agent (calendar, email drafting, research, archive/search).

**`amend-guidance`** — If the main agent strongly disagrees with the escalation, it may amend the relevant notification guidance document. Appropriate for obvious spam, phishing, abusive messages, or recurring low-value false positives. Amendments should be narrow and auditable.

Example guidance amendment:

```text
## 2026-06-18 amendment

Reason:
Gmail thread agent escalated obvious phishing as urgent.

Change:
Do not notify for account-emergency emails when sender authentication
fails and links are suspicious, unless the user has an active intent
matching the sender or service.
```

Thread agents may propose amendments. Only the main agent applies them.

### 17.2 Main-Thread Ledger

If the main agent decides to notify the user or perform a user-relevant action, a compact ledger entry is inserted into the main agent's persistent context.

Purpose: the main agent's ongoing user-facing context knows that the user was contacted or that an action occurred, without loading the full thread.

Example:

```text
2026-06-18: Notified user about Thread-ID email:gmail:kickstarter-456 —
Kickstarter shipping-delay update; low urgency; also added to nightly
digest as notified.
```

Ledger entries include: date/time, action taken, brief reason, Thread-ID, digest status, lookup path or message ID.

Note: the main agent's persistent session is a design commitment for the next implementation phase.

---

## 18. Digest Handling

The system maintains two digest pathways.

### 18.1 Notified Digest Items

Items the user was already directly notified about. Purpose: recordkeeping, nightly recap, avoid duplicate surprise.

### 18.2 Attention Digest Items

Items not urgent enough for immediate interruption but worth showing later. Purpose: batch low/medium priority user attention, reduce interruption load, preserve useful signal.

A main-agent decision can send an item to either or both.

---

## 19. Context Rendering

Context rendering begins from a leaf message.

Active thread continuity is maintained by persistent thread agents keyed by `Thread-ID`. Context rendering is no longer the primary active context mechanism — it is a fallback for recovery, debugging, audit, cold-start, and manual inspection.

Command shape:

```text
render-context <message-path> --purpose agent-context --budget 12000
```

### 19.1 Generic Render Algorithm

```text
input: message path

read Thread-ID
find all message files containing exact header:
  Thread-ID: <id>
search locations: inbox/new, inbox/cur, and all outbound Maildirs

parse Date, From, Message-ID, body
sort by Date
render as Markdown transcript
```

### 19.2 Rendering Purposes

MVP only needs `agent-context`. Future purposes: `triage-context`, `summary-refresh`, `human-debug`, `audit`.

### 19.3 Constraints

Rendered context must remain:

```text
bounded
lossy
non-recursive
derived from source mail
excluded from mail truth
```

Rendered context must never be written back into source mail as conversation content.

---

## 20. Scratch Context Files

Scratch files are persistent working context included in the agent's project context.

Suggested files:

```text
scratch/intents.md        — active user attention requests for triage/promotion
scratch/current-focus.md  — current working set for the agent
scratch/notes.md          — temporary observations, to be summarized or deleted
```

The agent is responsible for pruning, summarizing, and avoiding unbounded growth. Mail is the archive; scratch files are the desk.

Example inclusion in project context:

```text
@scratch/current-focus.md
@scratch/intents.md
@scratch/notes.md
```

---

## 21. System Events and Cron

Cron and system events are just mail.

Example:

```text
From: cron@system.local
To: lumen@agents.local
Date: 2026-06-17T09:00:00Z
Message-ID: <cron:daily-review:20260617>
Thread-ID: cron:daily-review
Idempotency-Key: cron:daily-review:2026-06-17
Response-Expected: false
Content-Type: text/plain; charset=utf-8

Run the daily review.
```

No special agent pathway is needed.

---

## 22. Multi-Agent Future

Each agent has its own container and mounted Maildir tree.

```text
agents/
  lumen/
  archivist/
  researcher/
```

Agents communicate through mail. A host-side router moves messages between agent outboxes and agent inboxes. Agents do not directly write to each other's inboxes.

---

## 23. Host Components

### 23.1 Ingress Adaptor

- Receive external event.
- Construct RFC822 message.
- Apply transport-appropriate header hygiene (`Apparently-*` for untrusted claims).
- Add trusted headers.
- Enforce access control (before the message reaches the inbox).
- Write message via `tmp → new` into inbox.

### 23.2 Thread Dispatcher

- Watch `mail/inbox/new`.
- Group unread messages by `Thread-ID`.
- Find or create thread agent for each `Thread-ID`.
- Deliver all unread messages for a `Thread-ID` as one batch.
- Move delivered messages to `cur/:2,S`.
- Mark escalated messages `cur/:2,SF`.

### 23.3 Egress Adaptor

- Watch one or more outbound Maildirs.
- Read new messages.
- Read `.binding`.
- Deliver through external provider.
- Move sent messages to `cur/` with flags.
- Record failures.
- Never expose secrets to agent.

### 23.4 Context Renderer

- Start from a leaf message.
- Load related source messages by `Thread-ID`.
- Render context for a specified purpose.
- Treat any cache as rebuildable.

---

## 24. Minimal Tooling

### `mail-write`
Create an RFC822 message in a Maildir (write to `tmp/`, atomic rename to `new/`).

### `mail-list`
List messages in a Maildir.

### `mail-read`
Read a message file.

### `mail-seen`
Move a message from `new/` to `cur/` with `S`.

### `render-context`
Render context from a leaf message by `Thread-ID`.

### `egress-telegram`
Watch Telegram outbound Maildir and deliver messages.

### `ingress-telegram`
Receive Telegram messages and write inbound mail.

---

## 25. MVP Completion Criteria

Given the context-tax problem (§3.12), the MVP should use thread-agent routing from the start.

1. A Telegram message appears as an RFC822 file in `mail/inbox/new`.
2. The thread dispatcher groups it by `Thread-ID` and routes to a thread agent.
3. The thread agent reads the message in its isolated persistent context.
4. The thread agent writes a response to the `Response-Maildir`.
5. The Telegram egress adaptor delivers the response.
6. The response preserves `Thread-ID`.
7. Subsequent messages with the same `Thread-ID` route to the same thread agent.
8. The thread agent's context grows only with its own thread — no cross-thread contamination.
9. The system can be tested by manually dropping a message into `mail/inbox/new`.
10. No Telegram secrets are visible inside the agent container.

---

## 26. Updated Execution Flow

```text
external message arrives
  ↓
ingress adaptor creates RFC822 mail and assigns Thread-ID
  ↓
mail appears in inbox/new
  ↓
thread dispatcher groups unread messages by Thread-ID
  ↓
dispatcher finds existing thread agent or creates one
  ↓
dispatcher passes all unread messages for that Thread-ID to the thread agent
  ↓
dispatcher moves passed messages new/ → cur/:2,S
  ↓
thread agent processes messages in isolated persistent context
  ↓
thread agent may do nothing
  ↓
thread agent may update local notes
  ↓
thread agent may call notify_user / request_action
  ↓
source messages become cur/:2,SF if escalated
  ↓
main-agent fork reviews escalation/action request
  ↓
main agent notifies, digests, dismisses, delegates, or amends guidance
  ↓
if user-facing action occurs, compact ledger line added to main agent thread
```

---

## 27. Implementation Order

Phase 1 (done):
1. Directory skeleton.
2. Maildir-safe write helper.
3. Telegram ingress adaptor.
4. Telegram egress adaptor.
5. Maildir watcher.
6. Agent Maildir contract (container skill).
7. Generic `render-context`.
8. `INBOUND_MODE` switch (traditional / maildir / both).

Phase 2 (next):
9. Thread dispatcher — group by `Thread-ID`, route to per-thread sessions.
10. Thread agent sessions — persistent Claude session per `Thread-ID`.
11. Thread agent system prompt assembly.
12. `notify_user` and `request_action` tools for thread agents.

Phase 3 (after thread agents work):
13. Main agent review loop (fork, outcomes).
14. Digest handling.
15. Guidance amendment.
16. Main-thread ledger.

Do not implement triage before thread agents.
Do not implement multi-agent routing before the main agent review loop.

---

## 28. Deferred Questions

1. Whether inbound handled messages should be copied into a separate `archive/` Maildir or left in `inbox/cur/`. **Current decision:** leave in `inbox/cur/`; manage growth when usage data justifies it.
2. Whether outbound sent messages should be copied into global archive.
3. How to handle attachments.
4. How to record egress failures durably.
5. Whether scratch files are writable by agent directly or only through tools.
6. Whether context render caches live under `context/rendered/` or beside threads.
7. Triage flow: `cool/`, hot vs. cold triage models.
8. Multi-agent routing protocol.
9. Thread agent session lifecycle — when to rotate, compact, or discard stale thread agent sessions.
10. Thread agent resource limits — max concurrent thread agents, session size caps.
11. Main agent persistent session — how it is bootstrapped, maintained, and rotated.
12. Cross-thread knowledge sharing — when a thread agent learns something relevant to other threads.
13. Thread agent handoff — what happens when a thread's channel adaptor changes (e.g. conversation moves from Telegram to email).
