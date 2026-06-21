---
name: add-mailman-ics
description: Add an ICS calendar feed to Mailman. Polls an ICS URL for event changes via snapshot diffing. For calendars where the only external access is a .ics export URL. Run /add-mailman first.
---

# Add ICS Calendar Feed to Mailman

Adds an ICS (iCalendar) URL as an input feed for the Mailman triage pipeline. Designed for calendars where the only external access is a `.ics` export link — typically work calendars behind corporate firewalls.

Unlike the Google Calendar API feed, ICS gives us snapshots, not change events. This feed diffs each snapshot against the previous one to detect new, changed, and removed events.

**How it works:**
- On first run (or daily at midnight): fetches the ICS, expands recurring events for the next 14 days, saves as a baseline. No notifications.
- On subsequent polls: fetches ICS, expands events for the near future, diffs against the baseline. Only real changes (new events, time/location/title changes, cancellations) produce notifications.
- Tiered polling: every 5min checks the next hour, every 15min checks 24 hours, every hour checks 3 days. The midnight sweep refreshes the full 14-day baseline.

**Requires:** `node-ical` package (installed automatically).

## Pre-flight

### 1. Verify Mailman core is set up

```bash
grep MAILMAN_AGENT_GROUP_ID .env
ls src/mailman/feeds.ts mailman/persona/kernel.md
```

If any fail, tell the user to run `/add-mailman` first and stop.

### 2. Update mailman source for ICS support

```bash
git fetch origin mailman
git show origin/mailman:src/mailman/ics-feed.ts  > src/mailman/ics-feed.ts
git show origin/mailman:src/mailman/maildir.ts   > src/mailman/maildir.ts
git show origin/mailman:src/mailman/feeds.ts     > src/mailman/feeds.ts
```

### 3. Install the ICS parser

```bash
pnpm install node-ical@0.26.1
pnpm run build
```

Build must be clean.

### 4. Choose a feed name

Ask the user: **"What should this calendar feed be called?"**

Suggest names based on the calendar's purpose:
- `ics-work` — work/corporate calendar
- `ics-team` — team shared calendar
- `ics-<project-name>` — project-specific calendar

Rules:
- Lowercase alphanumeric + hyphens only
- Must be unique across `mailman/feeds/`
- This name appears in logs and in triage messages

## Configure

### 5. Get the ICS URL

Ask the user: **"What's the ICS export URL for this calendar?"**

Help them find it:

> **Google Calendar:** Settings → gear icon next to the calendar → **Integrate calendar** → **Secret address in iCal format** (use the secret one, not the public one, for private calendars)
>
> **Outlook / Exchange:** Open the calendar in Outlook on the web → Settings → **Shared calendars** → **Publish a calendar** → copy the ICS link
>
> **Apple Calendar (iCloud):** Calendar sharing → enable public sharing → copy the webcal:// URL (change `webcal://` to `https://`)
>
> **Other systems:** Look for "Subscribe to calendar", "ICS export", or "iCal feed" in the calendar's sharing settings. You need a URL that returns an `.ics` file, not a download link that requires authentication.

**Important:** The URL must be accessible without interactive authentication from the NanoClaw host. If it requires a login, it won't work as a feed. Some corporate calendars require VPN access — that's fine as long as the host machine is on the VPN.

### 6. Test the URL

```bash
curl -s -o /dev/null -w "%{http_code}" "<ics-url>"
```

Should return `200`. If it returns `401`/`403`, the URL requires authentication that we can't provide. If `000` or timeout, the host can't reach it (firewall/VPN).

### 7. Create the feed directory

```bash
mkdir -p "mailman/feeds/<feed-name>"
```

### 8. Write feed.json

```bash
cat > "mailman/feeds/<feed-name>/feed.json" <<'EOF'
{
  "type": "ics",
  "url": "<ics-url>",
  "poll_interval_s": 300,
  "max_past_days": 1
}
EOF
```

Note: `agent_id` is not needed for ICS feeds — there's no OAuth, just a plain HTTP fetch.

Configurable fields:
- `url` — the ICS export URL (required)
- `poll_interval_s` — base poll interval (default 300 = 5min). The tiered system handles the actual cadence.
- `max_past_days` — how far back to track (default 1)

### 9. Optionally create a feed-specific triage prompt

Ask the user: **"Does this calendar need special triage rules?"**

Since this is typically a work calendar, suggest:
- "This is my work calendar. Meeting cancellations and time changes within the next 24 hours should always be escalated. New meeting invites can be deferred unless they're in the next 2 hours."
- "Only escalate changes to meetings I'm organizing. Changes to meetings organized by others can be deferred."

If yes, write `mailman/feeds/<feed-name>/prompt.md`.

### 10. Verify

```bash
pnpm run build
cat "mailman/feeds/<feed-name>/feed.json"
```

Build must be clean. Show the user their feed config for confirmation.

## Done

Tell the user:

> ICS calendar feed "**<feed-name>**" is configured. On first startup, it will do a silent baseline sweep of the next 14 days — no notifications. After that, only real changes (new/updated/cancelled events within the next 3 days) trigger triage.
>
> To restart now: `launchctl kickstart -k gui/$(id -u)/com.nanoclaw`
>
> To add another ICS calendar, run `/add-mailman-ics` again with a different feed name.

## Troubleshooting

- **"ICS fetch failed: 401/403"** — the URL requires authentication. You need a public or secret URL that doesn't require login.
- **"ICS fetch failed: 000"** — the host can't reach the URL. Check VPN/firewall.
- **Flood of notifications on first real poll** — the baseline sweep may have failed. Delete `mailman/state/ics-snapshot-<feed-name>.json` and restart to re-baseline.
- **Missing recurring events** — `node-ical` handles most RRULE patterns. If a specific recurrence isn't expanding, check the ICS file for unusual RRULE constructs.
- **Stale events** — the snapshot persists across restarts. Delete `mailman/state/ics-snapshot-<feed-name>.json` to force a fresh baseline.
