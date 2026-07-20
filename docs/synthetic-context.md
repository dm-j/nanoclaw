# Synthetic Context

An opt-in alternative to the Claude Agent SDK's default `resume` behavior: instead of resuming
an ever-growing session transcript, each turn resumes a small, reusable **skeleton** transcript
with fresh content substituted into it every time — literal recent history, and a Briefer-style
briefing — framed as tool calls the agent "just made" rather than system-prompt instruction text.
The original, full transcript keeps accumulating and auto-compacting in the background, untouched
by whether the toggle is on.

Implementation, container side: `container/agent-runner/src/providers/claude.ts` (the `// ──
Synthetic context ──` section), wired into `ClaudeProvider.query()`. Host side:
`src/modules/synthetic-context/briefing-cache.ts`, `src/memory-briefing/wikilink-cache.ts`,
`src/memory-briefing/briefer.ts`.

## Why

The SDK's native compaction is graceful but indiscriminate — it summarizes everything roughly
equally rather than making a deliberate choice about what a given turn actually needs. This
replaces it with something that doesn't compact at all: a curated last-N-turns window plus a
real, agent-generated briefing, delivered as synthetic tool calls so they read to the model as
things it just retrieved rather than instructions it was given (see the vault project
`01-Projects/Synthetic Context Delivery/` for the full design history and the "model attends more
to what it thinks it just did" premise this is built on).

## What was tried and ruled out first (2026-07-17)

Two earlier approaches were spiked and fully falsified before landing on the skeleton design
below — both are recorded in detail in the vault project note, summarized here because they rule
out designs someone might otherwise reach for again:

- **Appending fabricated content past a real transcript's end** (whether via a separate
  `fs.appendFileSync` or folded into one atomic write, whether truncated first or not, whether the
  tool name was fictional or a real registered tool) — reliably dropped on resume. Confirmed via
  the actual `claude` CLI's `--debug-file` output: the reconstructed API request contained far
  fewer messages than were written to the file, independent of file size. Root cause not fully
  understood even after checking the compiled CLI's own resume-reconstruction logic (readable —
  it's a Bun-compiled bundle, not opaque machine code) and testing a synthetic `compact_boundary`
  marker referencing real uuids to see if that "helpfully" fixed things (it didn't — made it
  worse).
- **Mutating the content of a real transcript's *existing* trailing entries** (same uuid, same
  position, same overall entry count, just different `content`/`input` fields) — worked
  reliably, 7/7 across every field tested (content, tool-call id pairing, uuid/parentUuid,
  message.id, usage, `toolUseResult`). This is the load-bearing fact the skeleton design below
  depends on: **substituting content into an already-correctly-shaped transcript works;
  extending a transcript's length does not.**

## The skeleton mechanism

A one-time-captured, permanently reusable transcript — `container/agent-runner/src/providers/
synthetic-context-skeleton.jsonl` — with genuine CLI-issued ids/uuid/parentUuid chain (captured
2026-07-17 from a real, disposable session, not fabricated), six entries:

```
[0] user message           <- substituted with the last real user message each turn
[1] assistant tool_use     load_transcript (real registered tool, see below)
[2] user tool_result       <- substituted with recent literal history (markdown)
[3] assistant tool_use     load_briefing (real registered tool, see below)
[4] user tool_result       <- substituted with the current briefing (markdown)
[5] assistant "done"       closes the tool-loading phase before the live turn's real prompt arrives
```

Every turn: `buildSkeletonTranscript()` loads this fixed skeleton, substitutes the three content
slots, rewrites `sessionId` throughout to a fresh id, writes it into the project directory the CLI
will actually check on `resume` (mangled from `cwd`, matching the same mangling rule discovered
while debugging the earlier approaches: every `/` → `-`). The live turn's actual prompt is still
pushed the normal way via the SDK's message stream after resume — the skeleton primes context, it
doesn't replace the live exchange.

`load_transcript` and `load_briefing` (`container/agent-runner/src/mcp-tools/briefing.ts`) are
real, registered MCP tools, not just names baked into the skeleton — so if the agent ever
genuinely tries to call one mid-turn (confusion about whether this turn already has the data),
it's a free, instant no-op rather than a wasted real retrieval: `load_transcript` replies "This
session has already loaded the transcript for this turn," `load_briefing` replies "This session
has already loaded the briefing for this turn. For answers to specific questions, use `recall`
tool."

After the turn, `mirrorSkeletonTurnToCanonical()` appends whatever new entries the SDK actually
generated back onto the canonical transcript, with the first new entry's `parentUuid` repointed
from the skeleton's own internal chain onto canonical's real last uuid (the skeleton has no
structural relationship to canonical's chain otherwise) — so canonical keeps growing and
auto-compacting exactly as it does today, unused but alive, regardless of the toggle.

## Briefing delivery: async, one turn behind

A real Briefer call (`claude -p --agent briefer` against the vault) took **24-46 seconds** in
direct testing 2026-07-17 — an unacceptable block on `router.ts`'s inbound-message path, which is
shared infrastructure for every agent group's messages, not something scoped to one group like
everything else here. So delivery is deliberately async and one turn stale:

1. On every inbound message, `router.ts` calls `maybeKickoffBriefing()`
   (`src/modules/synthetic-context/briefing-cache.ts`) — a fire-and-forget call, never awaited,
   that no-ops immediately (before touching the filesystem or spawning anything) unless the
   target agent group has `NANOCLAW_SYNTHETIC_CONTEXT` enabled. Zero cost for every other group.
2. If enabled, it kicks off `runBrieferWithWikilinkCache()` in the background and returns
   immediately — routing is never blocked.
3. When the Briefer call resolves (30-45s later), the result is written to
   `groups/<folder>/.briefing-cache.md`.
4. `claude.ts` reads whatever's in `.briefing-cache.md` when it builds *this* turn's skeleton —
   meaning the briefing a turn sees was computed for the *previous* message, not the current one.
   Falls back to `working-memory.md`'s content if the cache file doesn't exist yet (brand-new
   session, or the async kickoff hasn't completed a single round).

### Model override, not a permanent change

The Briefer call for this purpose routes through PrefixRouter to a local model
(`ollama/gemma4:31b-cloud`) instead of the installation-wide `MBIF_BRIEFER_MODEL`/
`MBIF_BRIEFER_BASE_URL` defaults (which stay sonnet-by-default and keep governing the regular
on-demand `recall` tool, untouched). `runBriefer()`
(`src/memory-briefing/briefer.ts`) now accepts an optional `{model, baseUrl}` override for
exactly this — only a caller that explicitly passes one gets rerouted.

Verified via PrefixRouter's actual per-request log (`PrefixRouter/logs/<date>.jsonl` — not just
its generic startup message, which says nothing per-request): both the override and the existing
default routed correctly to `localhost:11434` (real local Ollama), confirming `total_cost_usd` in
Claude Code's result JSON is not a reliable signal for Ollama-routed calls — it reports a nonzero
estimate regardless of backend, evidenced by the *already-trusted* default path reporting an even
higher figure than the override in a same-day side-by-side test.

### Wikilink cache

`src/memory-briefing/wikilink-cache.ts` wraps every Briefer call two ways, using `memsearch`
(already indexes/searches markdown for the container's own memory system — no new embedding infra
needed):

- **On the way out**: searches `Meta/wikilink-cache/` (via `memsearch search --source-prefix`)
  for a similar past query; a hit gets folded into the prompt as an explicitly-unverified hint
  (same "narrows focus, isn't ground truth" stance as `working-memory.md`'s own role) — Briefer
  still verifies, this doesn't bypass its own search.
- **On the way back**: scrapes `[[...]]` wikilinks from the response and files a new cache note
  (`Meta/wikilink-cache/<uuid>.md`, frontmatter `query`/`timestamp` + the links), re-indexed via
  `memsearch index`.

Both directions are best-effort — a cache lookup or write failure never blocks or fails the real
Briefer call.

## Configuration

| Env var | Default | Effect |
|---|---|---|
| `NANOCLAW_SYNTHETIC_CONTEXT` | unset (off) | `1` or `true` enables the whole mechanism — skeleton resume + async briefing kickoff |
| `NANOCLAW_SYNTHETIC_CONTEXT_LINES` | `40` | Number of trailing real transcript entries rendered into the literal-history slot |

Toggle per-agent-group via the group's container config `env` (this is also what
`briefing-cache.ts` reads host-side to decide whether to kick off a Briefer call for a given
group — the same flag gates both sides). No rebuild required — read at call time on both the
container and host sides.

## Path forward: making this synchronous

If one-turn staleness ever proves unacceptable (e.g. the briefing genuinely needs to reflect the
*current* message, not the previous one), the async design above would need to become a real
blocking call in `router.ts` before `writeSessionMessage`/`wakeContainer` — the tradeoff the
original design explicitly flagged and deferred rather than silently absorbed. Concretely:

- Await `runBrieferWithWikilinkCache()` directly in `router.ts` instead of firing it via
  `maybeKickoffBriefing()`'s fire-and-forget `.then()`.
- This adds the full 24-46s (up to Briefer's 120s timeout on a slow run) to the front of every
  message for synthetic-context-enabled groups — still gated by the same per-group check, so
  every other group stays unaffected, but *that* group's every message pays this cost.
- Would need a real timeout/fallback story for the blocking path specifically (today's async
  version already degrades gracefully — a failed kickoff just leaves next turn on the stale
  cache or the `working-memory.md` fallback; a synchronous caller blocking `router.ts` needs to
  decide what happens to the *message itself* if Briefer hangs or errors, since routing can't
  just silently drop it the way a background failure can).
- Worth instrumenting before deciding: log actual Briefer latency distribution over real usage
  (not just the two hand-timed calls from 2026-07-17) to know whether 24-46s is typical or a
  best case, and whether one-turn staleness is actually being felt in practice before paying for
  synchronous delivery.

## Verified (2026-07-17)

- Skeleton substitution + resume + mirror-back tested end-to-end against a throwaway copy of a
  real 340-entry session, using the actual production `ClaudeProvider` class (not a
  reimplementation) — `init` correctly reported the canonical id as continuation, canonical grew
  by exactly one turn's worth of new entries with the mirrored chain correctly repointed onto
  canonical's true prior uuid, and zero skeleton-internal content leaked into canonical.
- Content substitution confirmed working for both tool-call slots and ordinary conversational
  slots (not just tool pairs) via a full three-fact recall test against a real transcript.
- Real Briefer calls timed and confirmed correctly routed via PrefixRouter's per-request log (see
  above); wikilink scraping/caching confirmed against a real response, producing a correctly
  formed cache note.

## Interaction with `working-memory.md`

Still the fallback: used verbatim as the briefing-slot content whenever `.briefing-cache.md`
doesn't exist yet, and remains the sole delivery channel entirely when the toggle is off (folded
into `systemPrompt.append`, unaffected by any of the above either way — it was never part of the
resumable transcript).

## Safety notes for anyone testing this further

**This install runs containers via Apple's `container` CLI, not Docker** — `container ls`, never
`docker ps`, which silently reports nothing even when a container is genuinely live (see
`CLAUDE.md`'s Platform section; this cost real process discipline during development). All
validation so far was done against throwaway copies/isolated `CLAUDE_CONFIG_DIR`s, never the live
session transcript or the live `inbound.db`/`outbound.db`. Before testing against anything real:
back up the session's DBs and its canonical `.jsonl` (plain file copies — SQLite corrupts messily
under concurrent writers, see `docs/db.md`), and confirm via `container ls` that no live
container/subprocess holds a claim on the session first.
