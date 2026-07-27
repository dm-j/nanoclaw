---
name: add-vault-transcript-pipeline
description: Bring the vault-side transcript-assembly scripts (assemble-transcript, memsearch-to-transcript) under NanoClaw's version control and install/wire them into the Obsidian vault. These scripts read add-message-export's per-turn inbox files and assemble them into dated 07-Daily/Transcripts-readonly/ files that the vault's own digester agent consumes — a load-bearing downstream dependency of add-message-export that previously existed only as unversioned files in the vault.
---

# Add Vault Transcript Pipeline

Unlike every other `add-*` skill, this one's apply target is mostly **outside this repo** — the Obsidian vault at `MBIF_VAULT_PATH`, which is its own separate Claude Code project. NanoClaw carries the scripts as skill assets (so they're versioned and reviewable here) but installs them into the vault's `Meta/scripts/`, wires the vault's own crontab, and writes a bootstrap doc into the vault itself.

Full pipeline context: [docs/vault-memory-pipeline.md](../../../docs/vault-memory-pipeline.md).

**Prerequisite.** The vault must already be a working MBIF-crew install with `digester`, `sorter`/`inbox-triage`, and `briefer` present (`.claude/agents/digester.md`, `.claude/skills/inbox-triage/SKILL.md`, `.claude/agents/briefer.md`). This skill does not set up MBIF-crew itself — see the vault's own `My-Brain-Is-Full-Crew/README.md`. It also assumes `add-message-export` is already applied on the NanoClaw side (its `inbox/` output is the sole input to `assemble-transcript`).

## Phase 1: Pre-flight

```bash
V="${MBIF_VAULT_PATH:?set MBIF_VAULT_PATH first}"
test -f "$V/.claude/agents/digester.md" && echo "OK: digester present" || echo "MISSING — set up MBIF-crew in the vault first"
test -f "$V/.claude/agents/briefer.md" && echo "OK: briefer present" || echo "MISSING"
test -f "$V/.claude/skills/inbox-triage/SKILL.md" && echo "OK: inbox-triage present" || echo "MISSING"
grep -q "export function exportTurnToInbox" container/agent-runner/src/transcript-export.ts && echo "OK: add-message-export applied" || echo "MISSING — apply add-message-export first"
```

### Check if already applied

```bash
test -x "$V/Meta/scripts/assemble-transcript" && echo "ALREADY APPLIED — skip to Phase 3 (verify cron)"
```

## Phase 2: Apply — install the scripts

```bash
S=.claude/skills/add-vault-transcript-pipeline/assets
mkdir -p "$V/Meta/scripts" "$V/Meta/scripts/logs"
cp "$S/assemble-transcript"       "$V/Meta/scripts/assemble-transcript"
cp "$S/memsearch-to-transcript"   "$V/Meta/scripts/memsearch-to-transcript"
chmod +x "$V/Meta/scripts/assemble-transcript" "$V/Meta/scripts/memsearch-to-transcript"
```

`assemble-transcript` hardcodes the NanoClaw inbox path and the local timezone assumption (`America/Chicago` default, override via `USER_TIMEZONE`). If this install's group folder differs from `dm-with-dmj`, edit the `INBOX_DIR` line before copying:

```bash
grep -n "^INBOX_DIR=" "$V/Meta/scripts/assemble-transcript"
```

`memsearch-to-transcript` hardcodes `MEMSEARCH_DIR` the same way — update it to match this install's group folder (`groups/<folder>/.memsearch/memory`).

### Sanity-check the scripts

No build step (plain bash/node) — a syntax check is the equivalent guard:

```bash
bash -n "$V/Meta/scripts/assemble-transcript" && echo "OK: bash syntax"
node --check "$V/Meta/scripts/memsearch-to-transcript" && echo "OK: node syntax"
```

## Phase 3: Wire — cron

Idempotent: check each line isn't already present before appending. Uses the vault's own `Meta/scheduled-jobs.md` conventions.

```bash
crontab -l 2>/dev/null > /tmp/crontab.bak
grep -q "assemble-transcript" /tmp/crontab.bak && echo "cron already wired — skip" || {
  cat /tmp/crontab.bak - <<EOF | crontab -
55 1 * * * $V/Meta/scripts/assemble-transcript "\$(date +\%F)" "\$(date -v-1d +\%F)" >> $V/Meta/scripts/logs/assemble-transcript.log 2>&1
5 */3 * * * $V/Meta/scripts/assemble-transcript "\$(date +\%F)" "\$(date -v-1d +\%F)" >> $V/Meta/scripts/logs/assemble-transcript.log 2>&1
EOF
}
```

**Not minute `0`.** The every-3h run is deliberately offset to `:05`, not `:00` — several recurring NanoClaw tasks fire on the hour too (e.g. a 3am "free period" task at `0 3 * * *`), and running assembly at the exact same minute races the task's own message landing in `add-message-export`'s `inbox/`. Confirmed in production 2026-07-27: assembly ran ~2 seconds before the message was written, silently producing a transcript missing that entry — Scribe (vault-side) then couldn't find it. A few minutes of buffer avoids the race entirely.

macOS gates `crontab` edits behind a one-time Full Disk Access TCC prompt — the user will see it the first time this runs; approve it once.

Then append (or verify present) the entry to the vault's own `Meta/scheduled-jobs.md` inventory table, so it stays the single source of truth for what's scheduled — don't let this skill's cron entries go undocumented there.

## Phase 4: Validate

```bash
crontab -l | grep -c assemble-transcript   # expect 2
"$V/Meta/scripts/assemble-transcript" "$(date -v-1d +%F)"   # dry-run against yesterday, safe to re-run
ls "$V/07-Daily/Transcripts-readonly/$(date +%Y)/$(date +%m)/"
```

## Phase 5: Verify + write the vault-side bootstrap doc

Write `Meta/nanoclaw-integration.md` into the vault — this is what a fresh Claude Code session opened in the vault directory should be pointed at to understand (and, if missing, reconstruct) this half of the pipeline:

```bash
cat > "$V/Meta/nanoclaw-integration.md" <<'EOF'
---
type: meta
---

# NanoClaw Integration

This vault is the memory/briefing backend for a NanoClaw agent (Lumen). If you are
a Claude Code session opened in this vault and asked to "set up the NanoClaw side"
or "check the NanoClaw integration," this file is your entry point.

## What this vault provides to NanoClaw

- `digester` (.claude/agents/digester.md) — turns `07-Daily/Transcripts-readonly/`
  into `07-Daily/Digests-readonly/`. Never touches the raw transcript.
- `briefer` (.claude/agents/briefer.md) — reads digests + vault context, returns a
  structured briefing on demand (called from NanoClaw's `src/memory-briefing/briefer.ts`).
- `sorter` / `/inbox-triage` — files anything dropped in `00-Inbox/` (including
  facts NanoClaw's `remember` MCP tool writes there directly).
- `Meta/scripts/assemble-transcript` + `memsearch-to-transcript` — read NanoClaw's
  exported per-turn files and assemble them into `07-Daily/Transcripts-readonly/`.
  These two scripts are versioned in the NanoClaw repo itself
  (`.claude/skills/add-vault-transcript-pipeline/assets/`) — this vault's copies
  are installed by that skill's apply step, not hand-maintained here.

## What to verify is set up

1. `Meta/scripts/assemble-transcript` and `memsearch-to-transcript` exist and are executable.
2. Crontab has the `assemble-transcript` entries (see `Meta/scheduled-jobs.md` for the
   authoritative current schedule — don't assume the timings here are still accurate).
3. `digester`, `briefer`, `sorter` agents and the `/inbox-triage` skill exist under `.claude/`.
4. If any of the above is missing, re-run NanoClaw's `add-vault-transcript-pipeline` skill
   (from the NanoClaw repo) for the scripts/cron, or set up MBIF-crew (this vault's own
   `My-Brain-Is-Full-Crew/README.md`) for the agents.

## Full pipeline reference

The end-to-end diagram and NanoClaw-side code pointers live in the NanoClaw repo at
`docs/vault-memory-pipeline.md` — read that for the complete picture, not just this vault's half.
EOF
```

Tell the user:

> Vault-side transcript pipeline installed. Cron will pick it up within 3 hours, or run `Meta/scripts/assemble-transcript $(date +%F)` by hand to check now. A fresh Claude Code session opened in the vault can read `Meta/nanoclaw-integration.md` to understand or re-verify this half of the setup.

## Removal

See [REMOVE.md](REMOVE.md).

## Notes

- **Not a NanoClaw-container concern.** These scripts run on the host, in cron, against the vault — never inside an agent container.
- **Timezone and path constants are install-specific.** Re-check `INBOX_DIR` / `MEMSEARCH_DIR` / `USER_TIMEZONE` on any fork before applying — they are not read from NanoClaw's own config.
- **`memsearch-to-transcript` is a fallback, not routine.** It only matters on days the primary `add-message-export` → `assemble-transcript` path was down; it produces frontmatter-flagged lower-fidelity output and must never silently be treated as equivalent.

## Credits & references

- Original scripts authored directly in the vault's `Meta/scripts/`, folded into NanoClaw's skill system here so the load-bearing dependency on `add-message-export`'s output format is visible and versioned.
- Pipeline overview: [docs/vault-memory-pipeline.md](../../../docs/vault-memory-pipeline.md).
- Skill pattern: [docs/skill-phase-paradigm.md](../../../docs/skill-phase-paradigm.md).
