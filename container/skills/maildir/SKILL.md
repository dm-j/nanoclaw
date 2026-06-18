---
name: maildir
description: >-
  Maildir-based message IO. Teaches the agent to read RFC822 messages from
  its inbox, write responses to outbound Maildirs, and maintain scratch files.
metadata:
  version: "0.1.0"
---

# Maildir

The Maildir skill teaches the agent to communicate via durable RFC822 messages instead of (or alongside) the session DB transport.

## Principles

- **Mail is truth.** Every message is an immutable RFC822 file. Messages are never edited after publication.
- **Context is a query.** Context is generated from authoritative mail records, not stored separately.
- **Threads are views.** Threads are materialized from `Thread-ID` headers and can be regenerated.
- **Outboxes are capabilities.** A response Maildir is permission to communicate through a destination. Write only to Maildirs granted by `Response-Maildir` headers or stable configuration.
- **Mail is the archive. Scratch files are the desk.** Scratch files are working context; keep them pruned and concise.

## Directory Layout

```
/workspace/mail/
  inbox/
    tmp/        # staging area for atomic writes
    new/        # unread messages (read these)
    cur/        # handled messages (move here after processing)
  archive/
    tmp/ new/ cur/
  junk/
    tmp/ new/ cur/
  out/
    <adapter>/<address-path>/
      tmp/ new/ cur/
      .binding   # non-secret routing metadata (read-only)

/workspace/scratch/
  intents.md         # active attention requests for triage
  current-focus.md   # current working set
  notes.md           # temporary observations
```

## Message Format

RFC822 headers + blank line + body. Example inbound:

```
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

Example response:

```
From: lumen@agents.local
To: dmj@direct.telegram
Date: 2026-06-17T18:00:12Z
Message-ID: <lumen:reply:20260617T180012Z>
Thread-ID: telegram:direct:dmj
In-Reply-To: <telegram:direct:dmj:123456>
References: <telegram:direct:dmj:123456>
Content-Type: text/plain; charset=utf-8

We decided that Maildir is the durable event substrate...
```

## Maildir Atomicity

Never write directly to `new/`. Always:

1. Write complete message to `tmp/`
2. Rename (atomic move) to `new/`

This prevents partial reads by watchers.

## Flags

After processing, move messages from `new/` to `cur/` with standard flags:

```
:2,S    Seen (processed by agent)
:2,SR   Seen + Replied
:2,SP   Seen + Passed/delivered (used by egress)
:2,SF   Seen + Flagged (failed delivery)
```

## Binding Files

Each outbound Maildir may contain a `.binding` file with RFC822-style headers describing the destination:

```
Provider: telegram
Chat-ID: 123456789
Chat-Type: direct
Display-Name: dmj
```

Read for context. Never modify. Secrets are never in `.binding` files.

## Trusted vs Apparent Headers

Headers set by trusted ingress are authoritative (`From:`, `Thread-ID:`, etc.). Headers from untrusted sources are prefixed with `Apparently-` (e.g. `Apparently-From:`). If a message has both, trust the unprefixed version.
