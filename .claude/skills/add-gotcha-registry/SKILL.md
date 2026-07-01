---
name: add-gotcha-registry
description: Set up a self-maintaining "gotcha" registry for Claude Code projects. Creates a structured orientation directory of project-specific surprises and wires a PreCompact hook that runs Haiku on the session transcript before each compaction to extract new gotchas automatically.
---

# Add Gotcha Registry

Sets up a lightweight, self-maintaining knowledge base of project-specific surprises — things that burned you, corrected wrong assumptions, or had to be looked up repeatedly. Claude populates and updates it; a `PreCompact` hook runs Haiku on the transcript before each compaction to catch anything missed in the moment.

## What this sets up

- `.claude/orientation/` — directory of short gotcha files, one per topic area
- `.claude/orientation/index.md` — loaded every session via `@include` in CLAUDE.md; just the index table + maintenance instructions
- `.claude/hooks/precompact-gotcha.sh` — PreCompact hook that extracts new gotchas from the session transcript using Haiku before compaction proceeds
- `@.claude/orientation/index.md` appended to `CLAUDE.md`
- `PreCompact` hook entry in `.claude/settings.json`

The index loads on every turn (tiny — one table). Detail files are only read when you're working in that area. The hook runs Haiku automatically, so the registry stays current without manual effort.

## Pre-flight

### Check if already applied

```bash
test -d .claude/orientation && echo "Already applied" || echo "Not applied"
```

If already applied, all steps below are idempotent — re-running will update files to the latest versions without losing existing content. Skip to [Verify](#verify).

### Check that `claude` CLI is available (needed by the hook)

```bash
claude --version
```

If missing, the hook will silently skip (exit 0) rather than block compaction, but it won't extract gotchas.

## Phase 1 — Create the orientation directory

### 1. Create directory structure

```bash
mkdir -p .claude/orientation .claude/hooks
```

### 2. Copy template files from the skill

Copy the index and starter topic files. These are templates — tailor the topic files to the project after install:

```bash
cp .claude/skills/add-gotcha-registry/templates/index.md        .claude/orientation/index.md
cp .claude/skills/add-gotcha-registry/templates/gotchas.md      .claude/orientation/gotchas.md
```

If the project already has an `.claude/orientation/` directory with content, **do not overwrite** — skip this step and merge manually if needed.

### 3. Customize the index for this project

Open `.claude/orientation/index.md` and:
- Replace `<project>` with the project name
- Update the topic files listed in the table to match what's relevant (or leave the default single-file layout)

The single-file default (`gotchas.md`) works for most projects. Split into multiple files only if the content grows unwieldy (>200 lines in one file).

## Phase 2 — Install the PreCompact hook

### 1. Copy the hook script

```bash
cp .claude/skills/add-gotcha-registry/precompact-gotcha.sh .claude/hooks/precompact-gotcha.sh
chmod +x .claude/hooks/precompact-gotcha.sh
```

### 2. Wire the hook in `.claude/settings.json`

Read the current file first. If `.claude/settings.json` doesn't exist, create it as `{}`.

Add a `PreCompact` key to `hooks`. Preserve all existing keys and entries — do not remove anything. The merged result should include:

```json
{
  "hooks": {
    "PreCompact": [
      {
        "hooks": [
          {
            "type": "command",
            "command": ".claude/hooks/precompact-gotcha.sh"
          }
        ]
      }
    ]
  }
}
```

If `hooks.PreCompact` already exists, append the entry rather than replacing. Use `jq` to merge safely:

```bash
# Create settings.json if missing
[ -f .claude/settings.json ] || echo '{}' > .claude/settings.json

# Merge in the PreCompact hook (idempotent: drops any existing gotcha hook first)
jq '.hooks.PreCompact = ((.hooks.PreCompact // [])
      | map(select((.hooks // []) | any(.command == ".claude/hooks/precompact-gotcha.sh") | not)))
    + [{"hooks":[{"type":"command","command":".claude/hooks/precompact-gotcha.sh"}]}]' \
  .claude/settings.json > /tmp/gotcha-settings.json && mv /tmp/gotcha-settings.json .claude/settings.json
```

Verify:

```bash
jq '.hooks.PreCompact' .claude/settings.json
```

## Phase 3 — Wire the index into CLAUDE.md

### 1. Check if already included

```bash
grep -q '@.claude/orientation/index.md' CLAUDE.md && echo "Already included" || echo "Need to add"
```

### 2. Append the @include if missing

```bash
grep -q '@.claude/orientation/index.md' CLAUDE.md || \
  printf '\n@.claude/orientation/index.md\n' >> CLAUDE.md
```

Verify:

```bash
tail -3 CLAUDE.md
```

## Phase 4 — Seed with initial gotchas (optional but recommended)

If you have context about common surprises in this project already (from prior sessions, docs, or painful experience), add them now so future-you doesn't re-learn them:

Open `.claude/orientation/gotchas.md` and add bullet points under the appropriate headers. See the [template](templates/gotchas.md) for the format.

Alternatively, leave it empty and let the PreCompact hook populate it naturally over a few sessions.

## Verify

### Confirm files are in place

```bash
ls .claude/orientation/
ls .claude/hooks/precompact-gotcha.sh
grep '@.claude/orientation' CLAUDE.md
jq '.hooks.PreCompact' .claude/settings.json
```

### Dry-run the hook

Run the hook manually with fake stdin to confirm it executes without error (it will log "no transcript found, skipping" since there's no real transcript yet):

```bash
echo '{}' | .claude/hooks/precompact-gotcha.sh
```

Expected output: `precompact-gotcha: no transcript found, skipping`

### Trigger a real pass

At the end of your next session, run `/compact`. The hook fires first, Haiku reviews the transcript, and any new gotchas are appended to the orientation files. You'll see a one-line summary in the hook output before compaction proceeds.

## How the hook works

1. Reads `transcript_path` from the stdin JSON payload (provided by Claude Code)
2. Falls back to the most recently modified JSONL in `~/.claude/projects/<cwd>/`
3. Takes the last 3000 lines of the transcript (recent session content)
4. Calls `claude --model claude-haiku-4-5-20251001 -p` with a structured prompt comparing the transcript against existing orientation content
5. Parses the JSON response and appends non-empty sections to their respective files
6. Exits 0 — default compaction always proceeds

If Haiku errors or finds nothing new, the hook exits 0 cleanly. Compaction is never blocked.

## Ongoing maintenance

- **Add gotchas in the moment**: when something surprises you mid-session, add it directly to the relevant orientation file. Don't wait for compaction.
- **Update stale entries**: if the codebase changes and an old gotcha no longer applies, edit or remove it.
- **Split files when they grow**: if any file exceeds ~200 lines, split it and add a new row to the index.
- **The hook is a safety net**, not a substitute for in-the-moment awareness. Its job is to catch things you noticed but didn't write down.

## Customising the topic files

The default layout ships with a single `gotchas.md`. For larger projects, split by topic — e.g. `networking.md`, `auth.md`, `runtime.md`, `ops.md`. Update the index table to match. The hook prompt references all files listed in the orientation directory, so new files are picked up automatically.

## Removing

See [REMOVE.md](REMOVE.md).
