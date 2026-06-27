---
name: init-calendar
description: Set up calendar integration for DMJ. Guides through writing the .ics config, testing the cal tool, scheduling the morning briefing, and setting up passive change polling. Run this the first time calendar access is needed, or to reconfigure.
---

# /init-calendar

Set up the `cal` tool and automate DMJ's calendar workflow. Work through the steps below in order.

## Step 1 — Get the .ics URLs

Check if config already exists:

```bash
cat /workspace/agent/cal-urls.json 2>/dev/null || echo "NOT FOUND"
```

If missing or empty, ask DMJ:

> I need two calendar URLs to get started:
> 1. **Google Calendar**: Settings → [calendar name] → "Secret address in iCal format"
> 2. **Work calendar**: the .ics URL your IT team provides (or whatever URL gives you a .ics feed)
>
> You can share just the Google one for now — I can add the work calendar later.

Once you have at least one URL, write the config:

```bash
cat > /workspace/agent/cal-urls.json << 'EOF'
{ "urls": ["<url1>", "<url2>"] }
EOF
```

## Step 2 — Test the tool

```bash
cal --days 7
```

Confirm events appear and the timezone looks right (should be America/Chicago). If no events show up for the next 7 days, try `--days 30` — DMJ might just have a quiet week.

If you see a fetch error, double-check the URL by pasting it in a browser — Google Calendar URLs expire if the calendar sharing setting is changed.

## Step 3 — Schedule the morning briefing

Schedule a recurring task at 7am CDT (weekdays) that runs the morning calendar workflow:

```
Tool: schedule_task
prompt: "Run the morning calendar briefing: cal --days 1

For each event today:
- Note the time and any location
- If it has a location, estimate drive time from Nashville (use your judgment or a quick search) and schedule a departure reminder that fires early enough to arrive on time
- Schedule a 15-minute heads-up reminder before each meeting

After setting reminders, send DMJ a brief morning summary: today's events, any travel notes, and any divergences (new/changed/canceled) flagged by the tool."
processAfter: <today's date>T07:00:00  (naive local, so it runs at 7am CDT)
recurrence: "0 7 * * 1-5"
```

Confirm the task was created with `list_tasks`.

## Step 4 — Set up passive polling via subagent

Create a lightweight polling subagent so Lumen is never woken for routine checks:

```
Tool: create_agent
name: "cal-poller"
model: <cheapest available — claude-haiku-4-5-20251001 or equivalent>
instructions: |
  You are a background calendar poller. Your only job:

  1. When woken, run: cal --diff
  2. If there are any divergences (new, changed, or removed events), send the output to DMJ via send_message immediately.
  3. If output is empty, do nothing — no message.

  Do not contact Lumen. Do not summarize or add commentary. Forward the raw diff output only.
```

After the agent is created, send it a message to kick off its first run and schedule itself:

```
Tool: send_message
to: "cal-poller"
message: "Run your first calendar diff check now. Then use schedule_task with recurrence '0,30 8-18 * * 1-5' to keep running on that schedule. After that, only wake up on schedule — don't wait for further messages from me."
```

## Done

Calendar is live. Tell DMJ:
- Morning briefing fires at 7am weekdays
- Any mid-day changes will be flagged within 30 minutes
- He can run `cal --days 7` any time to see the week ahead

---

## Reference

**Tool:** `cal` (on PATH via `/workspace/group/tools/`)  
**Config:** `/workspace/agent/cal-urls.json`  
**Cache:** `/workspace/agent/cal-cache/` — one `.md` file per event; never overwritten so you can annotate them  

**Key flags:**  
- `--days N` — lookahead window (default 7)  
- `--hours H` — add hours (e.g. `--days 1 --hours 4`)  
- `--from DATE --to DATE` — explicit range  
- `--diff` — divergences only (new/changed/removed vs. cache)  

Divergences are always reported alongside the event list. `--diff` just suppresses the event list for the polling use case.
