---
name: add-mailman-gcal
description: Add a Google Calendar feed to Mailman. Polls for event changes (new, updated, cancelled) and triages them. Supports multiple calendars. Run /add-mailman first.
---

# Add Google Calendar Feed to Mailman

Adds a Google Calendar as an input feed for the Mailman triage pipeline. Polls for recently-changed events and delivers them as synthetic messages to the shared inbox for triage ("Your 2pm meeting with Ashley got cancelled").

Each invocation creates one feed — run multiple times for multiple calendars or accounts.

## Pre-flight

### 1. Verify Mailman core is set up

```bash
grep MAILMAN_AGENT_GROUP_ID .env
ls src/mailman/feeds.ts src/mailman/gcal-api.ts mailman/persona/kernel.md
```

If `src/mailman/gcal-api.ts` is missing, update the mailman source files:

```bash
git fetch origin mailman
git show origin/mailman:src/mailman/gcal-api.ts  > src/mailman/gcal-api.ts
git show origin/mailman:src/mailman/maildir.ts   > src/mailman/maildir.ts
git show origin/mailman:src/mailman/feeds.ts     > src/mailman/feeds.ts
pnpm run build
```

If `src/mailman/feeds.ts` or other core files are also missing, run `/add-mailman` first.

### 2. Choose a feed name

Ask the user what to call this feed. Examples: `gcal-personal`, `gcal-work`, `gcal-family`.

Rules:
- Lowercase alphanumeric + hyphens only
- Must be unique across `mailman/feeds/`
- Will appear in logs and the `X-Mailman-Source` header

### 3. Verify OneCLI has Google Calendar connected

```bash
onecli apps get --provider google-calendar
```

Expected: connected status with `calendar.readonly` or `calendar.events` scopes.

If not connected:

> Open the OneCLI web UI at http://127.0.0.1:10254, go to Apps → Google Calendar, and click Connect. Sign in with the Google account for this feed.

### 4. Create or verify the OneCLI agent for this feed

```bash
onecli agents list 2>&1 | grep "mailman-<feed-name>"
```

If it doesn't exist:

```bash
onecli agents create --id "mailman-<feed-name>" --name "Mailman GCal (<feed-name>)"
onecli agents set-secret-mode --id "mailman-<feed-name>" --mode all
```

## Configure

### 5. Create the feed directory

```bash
mkdir -p "mailman/feeds/<feed-name>"
```

### 6. Choose the calendar

Ask the user which calendar to watch. `primary` is the default and covers their main calendar. They can also specify a calendar ID (found in Google Calendar settings → Integrate calendar).

### 7. Write feed.json

```bash
cat > "mailman/feeds/<feed-name>/feed.json" <<'EOF'
{
  "type": "gcal",
  "agent_id": "mailman-<feed-name>",
  "poll_interval_s": 300,
  "calendar_id": "primary",
  "max_future_days": 30,
  "max_past_days": 1
}
EOF
```

Configurable fields:
- `poll_interval_s` — how often to check for changes (default 300 = 5min, calendars change less often than email)
- `calendar_id` — which calendar to watch (default: `primary`)
- `max_future_days` — only report changes to events within this window (default 30). Prevents noise from bulk edits to old recurring events.
- `max_past_days` — how far back to check (default 1). Keeps the feed focused on upcoming events, not ancient history.

### 8. Optionally create a feed-specific triage prompt

Ask the user if this calendar has special triage rules. Examples:
- Work calendar: "Meeting cancellations and time changes within 24 hours should always be escalated"
- Family calendar: "Only escalate cancellations, defer new event additions"

If yes, write `mailman/feeds/<feed-name>/prompt.md` with their guidance.

If no, skip — the base `email_triage.md` prompt handles calendar events too (they arrive as structured messages with Subject, From, and body describing the change).

### 9. Verify

```bash
pnpm run build
cat "mailman/feeds/<feed-name>/feed.json"
```

Build must be clean. Show the user their feed config for confirmation.

## Done

Tell the user:

> Google Calendar feed "<feed-name>" is configured. It will start polling on next service restart.
>
> To restart now: `launchctl kickstart -k gui/$(id -u)/com.nanoclaw`
>
> The feed checks for changes every 5 minutes by default. Only events within the next 30 days are tracked — changes to old events are ignored.
>
> To add another calendar, run `/add-mailman-gcal` again with a different feed name.

## Troubleshooting

- **"OneCLI not configured"** in logs — the agent ID in `feed.json` doesn't match an OneCLI agent, or Google Calendar isn't connected
- **No events arriving** — verify `calendar_id` is correct; try `primary` first
- **Too much noise** — reduce `max_future_days`, or add a feed-specific `prompt.md` that tells the triage agent to defer routine additions
- **Stale events re-appearing** — the seen-events state file is at `mailman/state/gcal-seen-<feed-name>.json`; delete it to reset
