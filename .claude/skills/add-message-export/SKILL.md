---
name: add-message-export
description: Wire a Stop hook that exports each completed conversation turn to two places — a per-message inbox (for MBIF triage) and a per-session running log (persistent IR for compaction). Produces clean markdown files with YAML frontmatter. Designed for personal assistant agents (e.g. Lumen) but works on any Claude Code agent group.
---

# Add Message Export

After every completed turn, the Stop hook:

1. Writes a per-message markdown file to `workspace/inbox/` — consumed by MBIF triage
2. Appends both messages to `workspace/sessions/<isotimestamp>-<session>.md` — persistent IR

Inbox files are transient (MBIF removes them after filing). Session logs accumulate across the life of a container and are the stable input for custom compaction.

## File formats

**Inbox file** (`inbox/2026-06-29T143201Z-david.md`):
```markdown
---
timestamp: 2026-06-29T14:32:01Z
speaker: david
display_name: David
session_id: c40b79a0-...
uuid: 6ed84025-...
---

Hey Lumen, can you check my calendar for tomorrow?
```

**Session log entry** (appended to `sessions/2026-06-29T143201Z-c40b79a0.md`):
```markdown
## David — 2026-06-29T09:32:01-05:00
Hey Lumen, can you check my calendar for tomorrow?

## Lumen — 2026-06-29T09:32:15-05:00
Sure! You have a team standup at 9am and a dentist appointment at 3pm.
```

Header timestamps are local (`USER_TIMEZONE`, default `America/Chicago`) with UTC offset —
human-facing and directly addressable for wikilinks (`[[sessions-file#David — 2026-06-29T09:32:01-05:00]]`).
Inbox frontmatter timestamps stay UTC (`Z`) for machine consumption.

The session log has a YAML frontmatter header written once at session start:
```markdown
---
session_id: c40b79a0-abfb-4458-a7f9-88a28bb0ed68
started: 2026-06-29T14:32:01Z
---
```

## Pre-flight

### Check if already applied

```bash
jq '.hooks.Stop' data/v2-sessions/<group-id>/.claude-shared/settings.json
```

If it contains `export-turn.py`, already applied — re-running is idempotent.

### Identify the target agent group

```bash
ncl groups list
```

Note the group ID and folder name.

## Phase 1 — Place the export script

The script must be reachable inside the container. The simplest path: copy
`export-turn.js` directly into `groups/<folder>/.hooks/`, which maps to
`/workspace/agent/.hooks/` inside the container.

```bash
mkdir -p groups/<folder>/.hooks
cp .claude/skills/add-message-export/export-turn.js groups/<folder>/.hooks/export-turn.js
```

(Additional mounts work in Docker but are unreliable with Apple Container — direct copy is the safe path.)

## Phase 2 — Configure speaker names

The script reads display names from environment variables. Set them in the group's
container config:

```bash
ncl groups config update --id <group-id> \
  --env AGENT_NAME="Lumen" \
  --env USER_DISPLAY_NAME="David" \
  --env USER_SLUG="david" \
  --env USER_TIMEZONE="America/Chicago"
```

`WORKSPACE_DIR` defaults to `/workspace/agent` — only override if the group uses a
different workspace layout. `USER_TIMEZONE` (IANA name) defaults to `America/Chicago`.

## Phase 3 — Wire the Stop hook

The Stop hook lives in the group's shared Claude Code settings:

```bash
SETTINGS="data/v2-sessions/<group-id>/.claude-shared/settings.json"
[ -f "$SETTINGS" ] || echo '{}' > "$SETTINGS"

jq '.hooks.Stop = ((.hooks.Stop // [])
      | map(select((.hooks // []) | any(.command | test("export-turn")) | not)))
    + [{"hooks":[{"type":"command","command":"bun /workspace/agent/.hooks/export-turn.js"}]}]' \
  "$SETTINGS" > /tmp/msg-export-settings.json && mv /tmp/msg-export-settings.json "$SETTINGS"
```

Verify:

```bash
jq '.hooks.Stop' data/v2-sessions/<group-id>/.claude-shared/settings.json
```

## Phase 4 — Restart

```bash
ncl groups restart --id <group-id>
```

## Verify

After the next conversation turn, check that files appear:

```bash
# Session log created
ls data/v2-sessions/<group-id>/workspace/sessions/

# Inbox populated
ls data/v2-sessions/<group-id>/workspace/inbox/
```

Check the hook output in the container logs. You should see something like:
```
export-turn: 2 message(s) → inbox + 20260629T143201Z-c40b79a0.md
```

## Tracking state

`sessions/.last-exported-uuid` records the UUID of the last exported message.
This prevents re-exporting on subsequent Stop hook fires in the same session.
After a compaction boundary in the JSONL, the cursor resets automatically.

## Removing

See [REMOVE.md](REMOVE.md).
