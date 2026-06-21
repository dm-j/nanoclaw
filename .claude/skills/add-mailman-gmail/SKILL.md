---
name: add-mailman-gmail
description: Add a Gmail account as a Mailman input feed. Supports multiple instances (personal, work, etc.) each with their own triage prompts. Run /add-mailman first.
---

# Add Gmail Feed to Mailman

Adds a Gmail account as an input feed for the Mailman triage pipeline. Each invocation creates one feed — run multiple times for multiple accounts.

## Pre-flight

### 1. Verify Mailman core is set up

```bash
grep MAILMAN_AGENT_GROUP_ID .env
ls mailman/persona/kernel.md mailman/prompts/email_triage.md
```

If either fails, tell the user to run `/add-mailman` first and stop.

### 2. Choose a feed name

Ask the user what to call this feed. Examples: `gmail-personal`, `gmail-work`, `gmail-alerts`.

Rules:
- Lowercase alphanumeric + hyphens only
- Must be unique across `mailman/feeds/`
- Will appear in logs and the `X-Mailman-Source` header

### 3. Verify OneCLI has Gmail connected

Ask the user which Google account this feed should poll. Then check OneCLI:

```bash
onecli apps get --provider gmail
```

Expected: connected status with `gmail.readonly` and `gmail.modify` scopes.

If not connected:

> Open the OneCLI web UI at http://127.0.0.1:10254, go to Apps → Gmail, and click Connect. Sign in with the Google account for this feed.

### 4. Create or verify the OneCLI agent for this feed

Each feed needs its own OneCLI agent so credentials route correctly.

```bash
onecli agents list 2>&1 | grep "mailman-<feed-name>"
```

If it doesn't exist:

```bash
onecli agents create --id "mailman-<feed-name>" --name "Mailman Gmail (<feed-name>)"
onecli agents set-secret-mode --id "mailman-<feed-name>" --mode all
```

## Configure

### 5. Create the feed directory

```bash
mkdir -p "mailman/feeds/<feed-name>"
```

### 6. Write feed.json

Ask the user about poll interval and query preferences. Defaults are sensible for most cases.

```bash
cat > "mailman/feeds/<feed-name>/feed.json" <<'EOF'
{
  "type": "gmail",
  "agent_id": "mailman-<feed-name>",
  "poll_interval_s": 1200,
  "max_age_days": 3,
  "query": "is:unread category:primary"
}
EOF
```

Configurable fields:
- `poll_interval_s` — how often to check (default 1200 = 20min)
- `max_age_days` — only fetch messages newer than this (default 3)
- `query` — Gmail search query (default: unread primary inbox)

### 7. Optionally create a feed-specific triage prompt

Ask the user if this account has special triage rules. Examples:
- Work email: "Emails from @company.co colleagues are always from known senders"
- Alerts account: "This account only receives automated alerts — treat all as low priority unless they indicate service failure"

If yes, write `mailman/feeds/<feed-name>/prompt.md` with their guidance. This gets appended to the base triage prompt for emails from this feed only.

If no, skip — the base `email_triage.md` prompt applies.

### 8. Verify

```bash
pnpm run build
cat "mailman/feeds/<feed-name>/feed.json"
```

Build must be clean. Show the user their feed config for confirmation.

## Done

Tell the user:

> Gmail feed "<feed-name>" is configured. It will start polling on next service restart.
>
> To restart now: `launchctl kickstart -k gui/$(id -u)/com.nanoclaw`
>
> To add another Gmail account, run `/add-mailman-gmail` again with a different feed name.

## Troubleshooting

- **"OneCLI not configured"** in logs — the agent ID in `feed.json` doesn't match an OneCLI agent, or Gmail isn't connected
- **No messages arriving** — check `query` in `feed.json`; try the query in Gmail's search bar first
- **Wrong account** — each feed's `agent_id` must map to an OneCLI agent connected to the right Google account
- **Feed not starting** — check `mailman/feeds/<feed-name>/feed.json` is valid JSON and `type` is `"gmail"`
