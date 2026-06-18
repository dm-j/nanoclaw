# NanoClaw Maildir Runtime — Design

## 1. Purpose

This document defines the design for replacing NanoClaw's transport/adaptor core with a Maildir-based runtime.

The system treats mail as the durable integration substrate.

The agent is not responsible for Telegram, Discord, email, cron, webhooks, or other transports. Those are host-side or adaptor-container concerns.

The agent's responsibility is:

1. Read promoted messages from its waking inbox.
2. Render context when needed.
3. Decide what to do.
4. Optionally write one or more outbound RFC822 messages into granted response Maildirs.
5. Maintain its own scratch/context files.

The surrounding host/adaptor processes are responsible for:

1. Producing inbound messages.
2. Watching Maildirs.
3. Delivering outbound messages.
4. Maintaining bindings and secrets.
5. Moving messages through Maildir lifecycle states.

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

If cold-start latency becomes a problem in practice, keep-alive makework (a no-op loop or periodic ping) is the first lever to pull. The container model is not changed until there is performance data justifying it.

---

## 13. Agent Processing Contract

When awakened, the agent should:

1. List messages in `mail/inbox/new`.
2. Read each message.
3. Optionally render context from the message.
4. Decide whether a response or other action is needed.
5. If responding, write a valid RFC822 message to the specified `Response-Maildir`.
6. Preserve `Thread-ID`.
7. Use `In-Reply-To` and `References` when replying.
8. Move handled inbound messages to `mail/inbox/cur/` with `S`.
9. Maintain scratch files as needed.
10. Avoid modifying source messages.

---

## 14. Context Rendering

Context rendering begins from a leaf message.

Command shape:

```text
render-context <message-path> --purpose agent-context --budget 12000
```

### 14.1 Generic Render Algorithm

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

### 14.2 Rendering Purposes

MVP only needs `agent-context`. Future purposes: `triage-context`, `summary-refresh`, `human-debug`, `audit`.

---

## 15. Scratch Context Files

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

## 16. System Events and Cron

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

## 17. Multi-Agent Future

Each agent has its own container and mounted Maildir tree.

```text
agents/
  lumen/
  archivist/
  researcher/
```

Agents communicate through mail. A host-side router moves messages between agent outboxes and agent inboxes. Agents do not directly write to each other's inboxes.

---

## 18. Host Components

### 18.1 Ingress Adaptor

- Receive external event.
- Construct RFC822 message.
- Apply transport-appropriate header hygiene (`Apparently-*` for untrusted claims).
- Add trusted headers.
- Enforce access control (before the message reaches the inbox).
- Write message via `tmp → new` into inbox.

### 18.2 Agent Watcher

- Watch `mail/inbox/new`.
- Wake agent when new messages arrive.
- Batch wake events when possible.

### 18.3 Egress Adaptor

- Watch one or more outbound Maildirs.
- Read new messages.
- Read `.binding`.
- Deliver through external provider.
- Move sent messages to `cur/` with flags.
- Record failures.
- Never expose secrets to agent.

### 18.4 Context Renderer

- Start from a leaf message.
- Load related source messages by `Thread-ID`.
- Render context for a specified purpose.
- Treat any cache as rebuildable.

---

## 19. Minimal Tooling

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

## 20. MVP Completion Criteria

1. A Telegram message from David appears as an RFC822 file in `mail/inbox/new`.
2. The watcher wakes the agent.
3. The agent reads the message.
4. The agent writes a response to `mail/out/telegram/direct/dmj/new`.
5. The Telegram egress adaptor sends the response.
6. The response preserves `Thread-ID`.
7. Both inbound and outbound messages can be rendered together by generic `Thread-ID` context rendering.
8. No Telegram secrets are visible inside the agent container.
9. The system can be tested by manually dropping a message into `mail/inbox/new`.

---

## 21. Implementation Order

1. Create directory skeleton.
2. Implement Maildir-safe write helper.
3. Implement Telegram binding file.
4. Implement fake ingress that writes test messages.
5. Implement fake egress that logs outbound messages.
6. Wire agent watcher.
7. Teach agent Maildir contract.
8. Implement generic `render-context`.
9. Replace fake ingress with Telegram ingress.
10. Replace fake egress with Telegram egress.
11. Add scratch file includes and maintenance instructions.
12. Add triage later.

Do not implement provider-specific renderers first.
Do not implement cool triage first.
Do not implement multi-agent routing first.

---

## 22. Deferred Questions

1. Whether inbound handled messages should be copied into a separate `archive/` Maildir or left in `inbox/cur/`. **Current decision:** leave in `inbox/cur/`; manage growth when usage data justifies it.
2. Whether outbound sent messages should be copied into global archive.
3. How to handle attachments.
4. How to record egress failures durably.
5. Whether scratch files are writable by agent directly or only through tools.
6. Whether context render caches live under `context/rendered/` or beside threads.
7. Triage flow: `cool/`, hot vs. cold triage models.
8. Multi-agent routing protocol.
