# Remove Synthetic Briefing Context

Reverses every change [SKILL.md](SKILL.md) made. Run per agent group first, then the shared code removal once no group uses it anymore.

## 1. Unwire per-agent-group

For every group this was enabled on:

```bash
ncl groups list
ncl groups config update --id <group-id> --env '{"NANOCLAW_SYNTHETIC_CONTEXT":"", "NANOCLAW_SYNTHETIC_CONTEXT_LINES":""}'
```

## 2. Revert the `claude.ts` reach-in

Remove the three insertion points from Phase 2 of SKILL.md:

- The helper-function block (`syntheticContextEnabled` through `transcriptStartMs`) plus the `SkeletonResume` interface and `SKELETON_TEMPLATE_PATH` constant.
- The pre-`sdkQuery` block that computes `resumeTarget`/`skeleton`/`canonicalId`.
- The `translateEvents()` canonical-marker init-branch logic and the post-loop `mirrorSkeletonTurnToCanonical` call.

Diff against a copy of `claude.ts` from before this skill was applied (or against `main`'s pre-feature history) to confirm nothing else changed in the same region.

## 3. Remove the router.ts reach-in

Delete both lines:

```typescript
import { maybeKickoffBriefing } from './modules/synthetic-context/briefing-cache.js';
```

and the call site:

```typescript
if (parsed.text) await maybeKickoffBriefing(session.agent_group_id, parsed.text);
```

## 4. Remove the MCP tool registration

Delete from `container/agent-runner/src/mcp-tools/index.ts`:

```typescript
import './briefing.js';
```

## 5. Delete copied files

```bash
rm container/agent-runner/src/providers/synthetic-context-skeleton.jsonl
rm container/agent-runner/src/mcp-tools/briefing.ts
rm src/modules/synthetic-context/briefing-cache.ts
rm src/modules/synthetic-context/wikilink-endorsements.ts
rm src/modules/synthetic-context/wikilink-endorsements.test.ts
rm src/memory-briefing/wikilink-cache.ts
rmdir src/modules/synthetic-context 2>/dev/null  # only if now empty
```

Leave `src/memory-briefing/briefer.ts` alone — it's the prerequisite memory-briefing system, not something this skill installed.

## 6. Rebuild, typecheck, restart

```bash
./container/build.sh
pnpm run build
pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit
source setup/lib/install-slug.sh
launchctl kickstart -k gui/$(id -u)/$(launchd_label)  # macOS
systemctl --user restart $(systemd_unit)              # Linux
```

## 7. Clean up per-group state (optional)

```bash
rm -f groups/<folder>/.briefing-cache.md groups/<folder>/.canonical-session-id
```

Not required — harmless if left, since nothing reads them once the toggle and code are gone.
