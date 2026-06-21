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
ls src/mailman/feeds.ts mailman/persona/kernel.md
```

If any fail, tell the user to run `/add-mailman` first and stop.

### 2. Update mailman source for gcal support

The gcal handler may be newer than the user's installed mailman files. Update them:

```bash
git fetch origin mailman
git show origin/mailman:src/mailman/gcal-api.ts  > src/mailman/gcal-api.ts
git show origin/mailman:src/mailman/maildir.ts   > src/mailman/maildir.ts
git show origin/mailman:src/mailman/feeds.ts     > src/mailman/feeds.ts
pnpm run build
```

Build must be clean.

### 3. Choose a feed name

Ask the user: **"What should this calendar feed be called?"**

Suggest names based on the calendar's purpose:
- `gcal-personal` — personal Google account
- `gcal-work` — work/corporate calendar
- `gcal-family` — shared family calendar
- `gcal-<project-name>` — project-specific calendar

Rules:
- Lowercase alphanumeric + hyphens only
- Must be unique across `mailman/feeds/`
- This name appears in logs and in triage messages so the agent knows which calendar an event came from

## Google Calendar OAuth Setup

### 4. Connect Google Calendar in OneCLI

Check if already connected:

```bash
onecli apps get --provider google-calendar
```

If the connection status shows `"connected"` with calendar scopes, skip to step 5.

If not connected, walk the user through it:

> **To connect Google Calendar:**
>
> 1. Open the OneCLI web UI: **http://127.0.0.1:10254**
> 2. Go to **Apps → Google Calendar**
> 3. Click **Connect** and sign in with the Google account that owns the calendar you want to watch
> 4. Grant at least **"See, edit, share & permanently delete all the calendars you can access using Google Calendar"** (the `calendar.events` scope) — read-only (`calendar.readonly`) also works if you only need change notifications
> 5. After authorizing, verify the connection shows as connected
>
> **Note:** This is separate from Gmail — if you've already connected Gmail, you still need to connect Google Calendar separately. They use different OAuth scopes.
>
> **Multiple accounts:** If you need to watch calendars from different Google accounts, you'll need to connect each account separately and create a separate feed for each.

### 5. Create the OneCLI agent for this feed

Each feed needs its own OneCLI agent so credentials route correctly.

```bash
onecli agents list 2>&1 | grep "mailman-<feed-name>"
```

If it doesn't exist:

```bash
onecli agents create --id "mailman-<feed-name>" --name "Mailman GCal (<feed-name>)"
onecli agents set-secret-mode --id "mailman-<feed-name>" --mode all
```

## Configure

### 6. Create the feed directory

```bash
mkdir -p "mailman/feeds/<feed-name>"
```

### 7. Choose the calendar

Ask the user: **"Which calendar should this feed watch?"**

- `primary` — their main calendar (the default, works for most people)
- A specific calendar ID — found in Google Calendar → Settings → gear icon next to the calendar name → **Integrate calendar** → **Calendar ID**. Looks like `abc123@group.calendar.google.com`.

If the user isn't sure, suggest starting with `primary`.

### 8. Configure polling and time window

Ask the user about their preferences. Explain the defaults:

> **Poll interval:** How often to check for changes (default: every 5 minutes). Calendar changes are less frequent than email, so 5 minutes is a good balance.
>
> **Future window:** Only track events within this many days ahead (default: 30 days). This prevents noise from bulk edits to old recurring events or events far in the future.
>
> **Past window:** How far back to watch for changes (default: 1 day). Keeps the feed focused on relevant events, not ancient history.

### 9. Write feed.json

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

### 10. Optionally create a feed-specific triage prompt

Ask the user: **"Does this calendar need special triage rules?"**

Give examples:
- **Work calendar:** "Meeting cancellations and time changes for events within the next 24 hours should always be escalated. New meeting invites can be deferred."
- **Family calendar:** "Only escalate cancellations and changes to events today. Defer everything else."
- **On-call calendar:** "Escalate all changes — any modification could affect coverage."

If yes, write `mailman/feeds/<feed-name>/prompt.md` with their guidance.

If no, skip — the base triage prompt handles calendar events reasonably (they arrive as structured messages describing the change).

### 11. Verify

```bash
pnpm run build
cat "mailman/feeds/<feed-name>/feed.json"
```

Build must be clean. Show the user their feed config for confirmation.

## Done

Tell the user:

> Google Calendar feed "**<feed-name>**" is configured. It will start polling on next service restart.
>
> To restart now: `launchctl kickstart -k gui/$(id -u)/com.nanoclaw`
>
> The feed checks for changes every 5 minutes by default. Only events within the configured time window are tracked — changes to old or far-future events are ignored.
>
> Triage messages will look like: *"Calendar event cancelled (feed: <feed-name>, type: gcal): Team standup — 2pm tomorrow"*
>
> To add another calendar, run `/add-mailman-gcal` again with a different feed name.

## Troubleshooting

- **"OneCLI not configured"** in logs — the agent ID in `feed.json` doesn't match an OneCLI agent, or Google Calendar isn't connected in OneCLI
- **"HTTPS_PROXY" error** — OneCLI isn't returning proxy config. Check `onecli apps get --provider google-calendar` shows connected status
- **No events arriving** — verify `calendar_id` is correct; try `primary` first. Check if there have been any actual changes to events in the time window.
- **Too much noise** — reduce `max_future_days`, or add a feed-specific `prompt.md` with rules like "defer new event additions, only escalate changes and cancellations"
- **Duplicate events** — the seen-events state file is at `mailman/state/gcal-seen-<feed-name>.json`; delete it to reset tracking
- **Wrong Google account** — each feed's `agent_id` must map to an OneCLI agent whose Google Calendar connection uses the right account
