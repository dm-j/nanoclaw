# Vault Memory Pipeline

End-to-end path from a live conversation turn to (a) the model attending to a curated briefing next turn, and (b) that turn becoming durable, wikilinked vault knowledge. Half of this lives in NanoClaw (this repo); half lives in the Obsidian vault as its own Claude Code project (a "MBIF-crew" install — see `My-Brain-Is-Full-Crew/README.md` in the vault for that template's own docs, not duplicated here). This doc is the seam between the two: what each side expects of the other.

Related: [docs/synthetic-context.md](synthetic-context.md) (the skeleton/briefing consumption side, in-session), [docs/memory-briefing-design.md](memory-briefing-design.md) (why the briefing model was chosen over compaction).

## The full loop

```
1. Turn happens in a NanoClaw session
        |
        v
2. add-message-export Stop hook writes the turn verbatim
   -> groups/<folder>/inbox/<ts>-<speaker>-<uuid>.md   (NanoClaw side)
        |
        v
3. Vault-side cron: assemble-transcript (every 3h + 01:55 daily)
   reads that day's inbox files, reshapes into one dated file
   -> 07-Daily/Transcripts-readonly/YYYY/MM/DD.md          (vault side)
        |
        v
4. Vault-side cron: digester agent (02:00 daily)
   reads yesterday's transcript, produces a wikilinked digest
   -> 07-Daily/Digests-readonly/YYYY/MM/DD.md               (vault side)
   (intraday: sketcher-check.sh gates a `sketcher` pass every 10 new
   turns, producing a provisional scaffold digester verifies/replaces)
        |
        v
5. On the NEXT inbound message, NanoClaw's briefing-cache.ts
   fires a Briefer call (async, fire-and-forget)               (NanoClaw side)
        |
        v
6. Briefer reads digests + vault context (never raw transcripts),
   returns a structured briefing                                (vault side, via `claude --agent briefer`)
        |
        v
7. Written to groups/<folder>/.briefing-cache.md                (NanoClaw side)
        |
        v
8. Next turn's skeleton substitutes this briefing into the
   load_briefing slot (one-turn-stale by design)                (NanoClaw side, claude.ts)
```

Separately, facts the agent explicitly decides are worth remembering (not the literal transcript) go through a different, synchronous path: the `remember` MCP tool writes directly to the vault's `00-Inbox/` (the vault is mounted straight into the container — see each group's `container.json` `additionalMounts`), and the vault's own `sorter` agent (via the `/inbox-triage` skill, watched by `com.lumen-vault.inbox-watch` launchd + a 02:30 cron fallback) files it into the right vault location on its next pass.

## Which side owns what

| Stage | Owner | Where |
|---|---|---|
| Per-turn export | NanoClaw | `add-message-export` skill, `container/agent-runner/src/transcript-export.ts` |
| Transcript assembly | Vault | `Meta/scripts/assemble-transcript` (+ `memsearch-to-transcript` fallback) — installed by NanoClaw's `add-vault-transcript-pipeline` skill, see below |
| Digesting | Vault | `.claude/agents/digester.md` (MBIF-crew, not NanoClaw's) |
| Intraday scaffolding | Vault | `.claude/agents/sketcher.md` + `Meta/scripts/sketcher-check.sh` |
| Fact filing | Both | `remember` MCP tool (NanoClaw, container-side) writes → `sorter`/`inbox-triage` (vault) files |
| Briefing synthesis | Vault (invoked by NanoClaw) | `.claude/agents/briefer.md`, called via `src/memory-briefing/briefer.ts` |
| Briefing caching + async kickoff | NanoClaw | `src/modules/synthetic-context/briefing-cache.ts` |
| Skeleton substitution | NanoClaw | `container/agent-runner/src/providers/claude.ts` |

## Fragility this creates

`assemble-transcript` reads NanoClaw's `inbox/` output as its **sole** source of truth for the primary (non-fallback) path. If `add-message-export` is ever removed or its output format changes, transcript assembly silently produces empty/missing days rather than erroring loudly — the only guard today is `memsearch-to-transcript`'s lower-fidelity fallback, and that one requires someone to notice the primary path went quiet and run it manually. Anyone removing or reshaping `add-message-export` must check this dependency first.

## Setting this up on a new install

1. NanoClaw side: apply `add-message-export`, then `add-synthetic-briefing-context`.
2. Vault side: needs an MBIF-crew install (out of scope here — see the vault's own `My-Brain-Is-Full-Crew/README.md`) with at least `digester`, `sorter`, `briefer`, and the `/inbox-triage` skill present.
3. Bridge the two: apply NanoClaw's `add-vault-transcript-pipeline` skill (installs `assemble-transcript`/`memsearch-to-transcript` into the vault + wires the cron entries). See [.claude/skills/add-vault-transcript-pipeline/SKILL.md](../.claude/skills/add-vault-transcript-pipeline/SKILL.md).
4. To bootstrap the vault side of the bridge from *inside* the vault (e.g. a fresh Claude Code session opened in the vault directory, or a vault being reconstructed on new hardware): point it at `Meta/nanoclaw-integration.md`, which `add-vault-transcript-pipeline`'s apply step writes into the vault itself with the concrete cron lines and paths for that specific install.

## Reference: the vault's own scheduled jobs

The vault maintains `Meta/scheduled-jobs.md` as its own living inventory of every cron/launchd entry relevant to this pipeline (both vault-native and NanoClaw-adjacent). Check that file for the current, authoritative schedule rather than assuming the timings above never drift.
