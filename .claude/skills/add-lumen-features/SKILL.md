---
name: add-lumen-features
description: Orchestrator skill — applies the "minimum viable Lumen" feature set to a fresh upstream NanoClaw checkout in the correct order — Apple Container runtime, OneCLI init, message export, memory-briefing/Briefer, synthetic-briefing-context, and the vault transcript pipeline. This skill does not carry its own code; it sequences the other skills and stops at the first failed pre-flight so scope decisions surface early instead of mid-way.
---

# Add Lumen Features

A meta-skill: it doesn't ship its own assets, it runs [`add-apple-container-runtime`](../add-apple-container-runtime/SKILL.md), [`add-message-export`](../add-message-export/SKILL.md), [`add-memory-briefing`](../add-memory-briefing/SKILL.md), [`add-synthetic-briefing-context`](../add-synthetic-briefing-context/SKILL.md), and [`add-vault-transcript-pipeline`](../add-vault-transcript-pipeline/SKILL.md) in the one order that satisfies every prerequisite chain, plus the base `/init-onecli` setup step. Existing memory: `minimum-viable-lumen-plan` (project memory) records why this set was chosen and the gaps that led to it.

**Why this order, not alphabetical:**

```
1. add-apple-container-runtime   (host runtime — nothing else depends on it, but do it first: a
                                   mid-stream runtime swap means re-verifying every later step)
2. /init-onecli                  (core upstream skill, not one of ours — secrets substrate)
3. add-message-export             (produces inbox/ — nothing downstream works without it)
4. add-memory-briefing            (Briefer/recall/remember — needs an MBIF-crew vault already set up,
                                   independent of #3, but must precede #5)
5. add-synthetic-briefing-context (needs #4's briefer.ts + recall/remember + wikilink-cache)
6. add-vault-transcript-pipeline  (needs #3's inbox/ output; feeds #4's digester real digests —
                                   applying it last is fine since #4/#5 degrade gracefully without
                                   it, just with raw-vault-content briefings instead of digest-based)
```

## Phase 1: Pre-flight

Confirm the starting point is what this sequence assumes:

```bash
git remote -v | grep -q upstream || echo "No 'upstream' remote — add one: git remote add upstream <upstream-url>"
git log --oneline upstream/main..HEAD | wc -l   # expect near-0 on a truly fresh checkout
uname -s | grep -q Darwin && echo "OK: macOS (required for step 1)"
```

Confirm the two things every downstream step needs but this skill doesn't itself install:
- `MBIF_VAULT_PATH` set, pointing at an MBIF-crew vault with `briefer`/`digester`/`sorter`/`inbox-triage` already present (see `add-memory-briefing`'s own Phase 1).
- `memsearch` installed and on `PATH`.

If either is missing, stop — steps 4-6 will each independently refuse to apply without them, so fix this once up front instead of hitting the same wall three times.

## Phase 2: Apply, in order

Invoke each skill in turn via the Skill tool (not by hand-copying its steps) — each one manages its own idempotency and already-applied checks, so re-running this whole sequence on a partially-applied install is safe:

1. `add-apple-container-runtime`
2. `/init-onecli`
3. `add-message-export`
4. `add-memory-briefing`
5. `add-synthetic-briefing-context`
6. `add-vault-transcript-pipeline`

Do not batch-apply all six blind — run each one's own Phase 1 pre-flight and read its output before moving to the next. A pre-flight failure partway through (e.g. `add-memory-briefing` discovering the vault doesn't have `briefer.md` yet) should stop the sequence there, not skip ahead.

## Phase 3: Wire per-agent-group

After all six are applied, decide which agent groups get the opt-in pieces:

```bash
ncl groups list
ncl groups config update --id <group-id> --env '{"NANOCLAW_SYNTHETIC_CONTEXT":"1"}'
```

`recall`/`remember`/`mbif_crew_prompt` are available to every group automatically once `add-memory-briefing` is applied (no per-group toggle) — see that skill's own Phase 3 note.

## Phase 4: Build, validate, restart

Each sub-skill already does this in its own Phase 4. After all six, one final full-repo check to catch any cross-skill interaction:

```bash
pnpm run build
pnpm test
pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit
(cd container/agent-runner && bun test)
./container/build.sh
```

## Phase 5: Verify

Run each sub-skill's own Phase 5 verification in the same order as Phase 2 above. Then confirm the full loop end-to-end per [docs/vault-memory-pipeline.md](../../../docs/vault-memory-pipeline.md):

1. Send a message in a synthetic-context-enabled group.
2. Confirm `groups/<folder>/inbox/` gets a new file (message export).
3. Confirm `.briefing-cache.md` appears after the next message (memory-briefing + synthetic-context working together).
4. Wait for the vault's own cron (or run `assemble-transcript` by hand) and confirm `07-Daily/Transcripts-readonly/` picks up the day.

## Removal

Run each sub-skill's own `REMOVE.md` in **reverse** order (6 → 1) — this respects the same dependency chain in the opposite direction. Do not write a combined removal script here; each skill's REMOVE.md already knows its own footprint precisely, and duplicating that logic here would be exactly the kind of hand-maintained mirror `docs/skill-guidelines.md`'s anti-patterns section warns against.

## Notes

- **This skill carries no assets of its own.** Its only job is sequencing; all actual code lives in the six skills it invokes.
- **Not every "local customization" is here.** PrefixRouter inference routing, host-services-proxy, Mailman, per-sender batching, RTK, agent tools/timezone, gotcha registry, inbound webhook, dashboard are all deliberately out of scope — see `docs/local-customizations.md` for the full list if you want to add more later. This skill packages the ones flagged as necessary for a working "hooked up to synthetic-briefing-context" install, per the `minimum-viable-lumen-plan` memory this was scoped from.
- **Fresh-install target, not a partial-fork target.** If applying to the existing heavily-customized fork rather than a clean upstream checkout, most of Phase 1's "already applied" checks in each sub-skill will short-circuit correctly — but double-check no other local feature has already touched the same files (`claude.ts`, `container-runner.ts`, `router.ts` are the ones most likely to collide).

## Credits & references

- Feature index: [docs/local-customizations.md](../../../docs/local-customizations.md).
- Full pipeline: [docs/vault-memory-pipeline.md](../../../docs/vault-memory-pipeline.md).
- Skill pattern: [docs/skill-phase-paradigm.md](../../../docs/skill-phase-paradigm.md).
