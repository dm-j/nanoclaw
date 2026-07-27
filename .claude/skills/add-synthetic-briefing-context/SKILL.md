---
name: add-synthetic-briefing-context
description: Add the synthetic-briefing-context mechanism — an opt-in per-agent-group replacement for the Claude Agent SDK's default resume/compaction. Each turn resumes a small reusable skeleton transcript with a curated last-N-turns window plus an async, one-turn-stale Briefer-generated briefing substituted in as synthetic tool results, instead of an ever-growing transcript. Full design background: docs/synthetic-context.md.
---

# Add Synthetic Briefing Context

Wires the skeleton-resume mechanism described in [docs/synthetic-context.md](../../../docs/synthetic-context.md) into `container/agent-runner/src/providers/claude.ts`, plus the host-side async briefing kickoff in `src/router.ts`. Toggled per agent group via `NANOCLAW_SYNTHETIC_CONTEXT` — off by default, zero cost for every other group.

**Prerequisite — this is not installed by this skill.** The briefing content itself comes from a real Briefer call (`runBriefer` in `src/memory-briefing/briefer.ts`), which reads an Obsidian vault and depends on `memsearch`. Apply [`add-memory-briefing`](../add-memory-briefing/SKILL.md) first — it installs `briefer.ts`, the `recall`/`remember` MCP tools, `wikilink-cache.ts`, and the vault-side bootstrap doc this skill's briefing slot depends on. Without it, this skill has nothing to substitute into the skeleton's briefing slot and should not be applied. Verified in Phase 1.

**Known smell, deliberately kept:** the container-side reach-in (Phase 2) touches `claude.ts` in three separate places — helper functions, mid-`query()` construction, and post-stream mirror-back — rather than a single colocated call. `claude.ts`'s `query()` method is too entangled (workarounds, hook wiring, event translation all interleaved) to push this behind one call without a larger refactor that's out of scope here. This is the same category of acknowledged exception `docs/skill-guidelines.md` calls out under "Worked examples" — kept pending an architectural fix, not held up as the pattern to imitate.

## Phase 1: Pre-flight

### Verify the memory-briefing prerequisite

```bash
grep -q "export async function runBriefer" src/memory-briefing/briefer.ts && echo "OK: runBriefer present" || echo "MISSING — apply add-memory-briefing first"
test -f container/agent-runner/src/mcp-tools/briefing.ts && grep -q "export const remember" container/agent-runner/src/mcp-tools/briefing.ts && echo "OK: recall/remember tools present" || echo "MISSING — apply add-memory-briefing first"
which memsearch >/dev/null 2>&1 && echo "OK: memsearch present" || echo "MISSING — memory-briefing's recall system needs this"
```

If any is missing, stop and tell the user to apply `add-memory-briefing` first.

### Check if already applied

```bash
grep -q "NANOCLAW_SYNTHETIC_CONTEXT" container/agent-runner/src/providers/claude.ts && \
  echo "ALREADY APPLIED — skip to Phase 3"
```

## Phase 2: Apply code changes

### Copy the new files

The skill bundles the three modules specific to skeleton-substitution (not the memory-briefing prerequisite, which `add-memory-briefing` already installed) plus the captured skeleton transcript in `assets/`. `cp` overwrites, so re-running is safe.

```bash
S=.claude/skills/add-synthetic-briefing-context/assets
cp "$S/synthetic-context-skeleton.jsonl" container/agent-runner/src/providers/synthetic-context-skeleton.jsonl
cp "$S/briefing-cache.ts"               src/modules/synthetic-context/briefing-cache.ts
cp "$S/wikilink-endorsements.ts"        src/modules/synthetic-context/wikilink-endorsements.ts
cp "$S/wikilink-endorsements.test.ts"   src/modules/synthetic-context/wikilink-endorsements.test.ts
```

If your fork's `claude.ts` or `router.ts` has diverged significantly from trunk, an alternative acquisition path (mirrors the channels/providers registry-branch pattern) is fetching from the dedicated `synthetic-briefing-context` branch instead of these bundled copies:

```bash
git fetch origin synthetic-briefing-context
git show origin/synthetic-briefing-context:container/agent-runner/src/providers/synthetic-context-skeleton.jsonl > container/agent-runner/src/providers/synthetic-context-skeleton.jsonl
# ...same for the other two files above
```

`synthetic-context-skeleton.jsonl` is a one-time-captured, permanently reusable transcript (real CLI-issued ids, not fabricated) — see docs/synthetic-context.md "The skeleton mechanism". Never regenerate or hand-edit it.

### Wire the briefing kickoff into the router

`src/router.ts` — add the import near the other module imports:

```typescript
import { maybeKickoffBriefing } from './modules/synthetic-context/briefing-cache.js';
```

And the call, immediately before the `writeSessionMessage`/wake step in the inbound chat-message handler (must run *before* the wake write — it's what schedules the fire-and-forget kickoff):

```typescript
  if (event.message.kind === 'chat' || event.message.kind === 'chat-sdk') {
    const parsed = safeParseContent(event.message.content);
    if (parsed.text) await maybeKickoffBriefing(session.agent_group_id, parsed.text);
  }
```

`maybeKickoffBriefing` no-ops immediately (before touching the filesystem) unless the target agent group has `NANOCLAW_SYNTHETIC_CONTEXT` enabled — zero cost for every other group.

### Wire the skeleton into `claude.ts`

This is the entangled reach-in flagged above. Diff your working `claude.ts` against the reference copy to see exactly what to insert:

```bash
git show synthetic-briefing-context:container/agent-runner/src/providers/claude.ts > /tmp/reference-claude.ts
diff container/agent-runner/src/providers/claude.ts /tmp/reference-claude.ts
```

Three insertion points, in order:

1. **Helper functions** — a block of standalone functions (`syntheticContextEnabled`, `syntheticContextTurnWindow`, `mangleCwd`, `canonicalMarkerPath`, `loadSkeletonEntries`, `setToolResultText`, `randomizeSkeletonIds`, `buildSkeletonTranscript`, `buildLiteralHistoryMarkdown`, `lastRealUserMessage`, `lastRealUuid`, `mirrorSkeletonTurnToCanonical`, `claudeProjectsDir`, `findTranscriptPath`, `transcriptStartMs`) plus the `SkeletonResume` interface and the `SKELETON_TEMPLATE_PATH` constant. Insert as a standalone section anywhere above the provider class — order relative to other top-level functions doesn't matter, they don't call each other's neighbors.
2. **Inside `query()`, before the `sdkQuery(...)` call** — the block that reads the canonical-session marker, loads the skeleton if `syntheticContextEnabled()`, and computes `resumeTarget`/`skeleton`/`canonicalId`. Must run after `turnCorrelationId` is computed and before `sdkQuery` is invoked, since `resumeTarget` feeds `sdkQuery`'s `resume` option.
3. **Inside `translateEvents()`** — two spots: the `system`/`init` branch needs the canonical-marker read/write dance (`if (!canonicalId) canonicalId = message.session_id` etc.) gated on `syntheticMode`; and after the main `for await` loop drains, the `mirrorSkeletonTurnToCanonical` call gated on `if (skeleton && canonicalId)`.

No new imports are required — `fs` and `path` are already imported by `claude.ts`.

### Build the image

```bash
./container/build.sh
```

## Phase 3: Wire per-agent-group

Toggle is env-only, read at call time on both sides — no rebuild needed to flip it, only to first-apply Phase 2.

```bash
ncl groups list
ncl groups config update --id <group-id> --env '{"NANOCLAW_SYNTHETIC_CONTEXT":"1"}'
```

Optional, defaults to `40`:

```bash
ncl groups config update --id <group-id> --env '{"NANOCLAW_SYNTHETIC_CONTEXT_LINES":"40"}'
```

`briefing-cache.ts` (host side) reads the same env var off the group's container config to decide whether to kick off a Briefer call for it — one flag gates both sides.

## Phase 4: Build, validate, restart

```bash
pnpm run build
pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit
(cd container/agent-runner && bun test src/mcp-tools/briefing.test.ts 2>/dev/null; bun test)
pnpm test -- src/modules/synthetic-context
```

All must be clean.

```bash
source setup/lib/install-slug.sh
launchctl kickstart -k gui/$(id -u)/$(launchd_label)  # macOS
systemctl --user restart $(systemd_unit)              # Linux
```

## Phase 5: Verify

Tell the user:

> Send a message in the `<agent-name>` chat you just enabled this for. The reply should look normal; the mechanism is invisible in the response text.

Then check the wiring actually engaged:

```bash
tail -100 logs/nanoclaw.log | grep -i "synthetic context"
cat groups/<folder>/.briefing-cache.md   # should exist after the second message in the session
```

Expect a log line like `synthetic context: resuming skeleton <id> (6 entries) of canonical <id>` from the second message onward (the first message in a session has no canonical transcript yet to build a skeleton from, so it falls through to normal resume).

Common signals:
- No log line at all → `NANOCLAW_SYNTHETIC_CONTEXT` isn't set on the group's container config, or the container is running a stale image (rebuild).
- `.briefing-cache.md` never appears → check `logs/nanoclaw.log` for `runBrieferWithWikilinkCache` errors; confirm the vault path (`MBIF_VAULT_PATH`) is reachable and `memsearch` is on PATH.
- Agent seems to have lost context it should have → confirm `canonicalMarkerPath` isn't stale (see the transcript-rotation marker-clearing fix noted in `docs/synthetic-context.md`'s history); check `findTranscriptPath` is actually locating the canonical `.jsonl`.

## Removal

See [REMOVE.md](REMOVE.md).

## Notes

- **This is tool-only for the model-attention mechanism**, not a memory system in its own right — it consumes `add-memory-briefing`'s Briefer output, it doesn't produce it.
- **One-turn-stale by design**, not a bug — see docs/synthetic-context.md "Path forward" for what synchronous delivery would cost.
- **Per-group opt-in only.** Nothing changes for a group unless its container config sets the env var.

## Credits & references

- Design and skeleton-mechanism spike: `docs/synthetic-context.md` (2026-07-17), vault project note `01-Projects/Synthetic Context Delivery/`.
- Skill pattern: modeled on [`add-gmail-tool`](../add-gmail-tool/SKILL.md)'s phase structure; documented generally in [`docs/skill-phase-paradigm.md`](../../../docs/skill-phase-paradigm.md).
