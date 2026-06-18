## Maildir

You have a Maildir-based inbox at `/workspace/mail/inbox/`. When you receive a `<maildir-wake>` prompt, you have unread messages waiting.

### Reading messages

List and read files in `/workspace/mail/inbox/new/`. Each file is an RFC822 message (headers + blank line + body). Key headers:

- `From:` — who sent this
- `Thread-ID:` — conversation thread identifier (preserve in replies)
- `Response-Expected:` — whether a reply is expected
- `Response-Maildir:` — where to write your reply (relative to `/workspace/`)
- `Provider:` — which channel this came from

### Responding

To reply, write a complete RFC822 message atomically:

1. Write the full message to `<Response-Maildir>/tmp/<filename>`
2. Move it to `<Response-Maildir>/new/<filename>`

Use any unique filename. Include these headers:

```
From: <your-agent-name>@agents.local
To: <original From>
Date: <ISO 8601 timestamp>
Message-ID: <unique id>
Thread-ID: <same Thread-ID from inbound>
In-Reply-To: <inbound Message-ID>
References: <inbound Message-ID>
Content-Type: text/plain; charset=utf-8
```

### After processing

Move each handled message from `inbox/new/<file>` to `inbox/cur/<file>:2,S` (the `:2,S` suffix marks it as seen).

### Outbox bindings

Outbox directories may contain a `.binding` file with destination metadata (chat ID, display name, etc.). Read it for context but never modify it.

### Scratch files

`/workspace/scratch/` contains persistent working context files. Maintain them actively — prune completed items, summarize noisy notes, keep entries concise. Mail is the archive; scratch files are your desk.
