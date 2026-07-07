# Memory Briefing: Design Notes (in progress)

**Status:** Noodling — not yet a build plan
**Authored by:** DMJ + Claude (design session, 2026-07-07)
**Intended audience:** Claude Code (future implementation), DMJ (future self)

---

## 1. Problem

Canonical transcript + periodic compaction is the current memory substrate for Lumen. Two complaints:

- **Transcript is vague for facts.** It's optimized for conversational flow, not for "what do we know and when did we learn it." Retrieving a fact means re-deriving it from prose.
- **Compaction is stale and uneven by construction.** It's a single lossy summary applied once per size ceiling, then frozen until the next one. It forgets evenly across the whole history rather than being shaped by what's actually relevant to the current turn.

Also flagged directly: a memory tool that requires the agent to *remember to invoke it* (e.g. today's memsearch skill) is partially self-defeating — the moments memory would help most are exactly the moments the agent doesn't think to check.

## 2. Core idea

Replace "canonical transcript + compaction" with **regenerated-per-turn targeted compression**, structurally different from compaction: a briefing agent reads the conversation and an Obsidian vault (the knowledge store), and produces a fresh markdown briefing — not a summary of everything, a retrieval shaped by what's relevant right now.

Lumen's per-turn context becomes:

- The briefing agent's markdown output (with wikilinks)
- The literal last N turns (for language/emotional tenor, not fact recall)

Lumen's response is appended to canonical transcript as before — canonical history still exists, it's just no longer what Lumen reads from directly.

**Scope decision:** this replaces context assembly for Lumen's conversational/personal-assistant traffic only. Task-execution work (e.g. an agent-coding session like this one) stays on literal transcript + compaction, for now — that work leans on verbatim continuity (exact stack traces, exact prior phrasing, in-progress plan state) in a way synthesized recall would actively hurt.

## 3. The vault

One Obsidian vault, holding both facts and journals (not separate vaults) — cross-linkable, so a fact note and the journal entry where it was first discussed can wikilink each other.

Notes carry an **ontological status** so a reader (the briefing agent, or a human) can tell settled fact from provisional/narrative without needing separate vaults or complex traversal logic:

- A `type` field (e.g. `fact | journal | inference`)
- A changelog of when things changed (e.g. "believed X until 2026-06, revised to Y per 2026-07 reconciliation")

## 4. Write paths (three separate jobs, decoupled)

**a. Intra-day writer** — runs during the day, out of scope for the briefing agent entirely. Creates new notes and **appends to existing notes**. No reconciliation, no conflict resolution — append-only, so it can never corrupt a note.

**b. Nightly reconciliation** — offline, regular (nightly-ish). Reads the day's appended notes and reconciles: resolves conflicts, dedupes, stamps ontological status and changelog. This is where "which fact wins" gets decided, deliberately isolated from the fast intra-day path.

**c. Nightly journal** — separate concern from reconciliation, explicitly decoupled: reads the **canonical transcript directly**, independent of whether reconciliation has run or succeeded, and writes a blog-style journal entry "from a place of hindsight." Wikilinked, stored in the same vault, indexed like any other note.

- **Weekly rollup**, compiled from the week's daily journals.
- **Monthly rollup**, compiled from the month's weekly journals.

Journaling and knowledge-graph update are separate concerns by design — neither blocks or depends on the other's success.

## 5. The briefing agent

Read-only. Given canonical history in conversation plus Obsidian tools (search / read / follow-backlinks), instructed **not to answer the user** — only to produce a briefing, with internal and external wikilinks, for the actual responding agent to use.

**Tool-surface decision:** don't pre-design the traversal (fixed-depth neighborhood vs. free agentic walk). Hand it the problem and a real Obsidian toolset, run it against real workload, and fix whatever specific failure shows up (missed links, too-shallow traversal, wrong notes surfaced) rather than designing around a hypothetical.

**Implementation approach:** reuse MBIF's existing pipeline (ingestion, consolidation, reconciliation, retrieval agents already exist there) rather than building new infrastructure. Concretely: invoke headless (`-p`) with a custom agent derived from MBIF's Seeker.

- The briefing task is **meaningfully different** from Seeker's original job (retrieval-for-triage vs. briefing synthesis) — confirmed this isn't just a reskin.
- **Minimal version: duplicate the Seeker agent file and rename it.** Let the two prompts diverge freely rather than forcing a shared abstraction between two meaningfully different tasks.
- **If/when real shared chunks emerge** (and only then): refactor the common part out and use include syntax in both agent files. Don't pre-extract a shared abstraction speculatively.

**Runs on the host, not in Lumen's container.** MBIF and the briefing agent live entirely outside any container's mounted filesystem — the vault is a host-FS directory, not something mounted into Lumen's session. Lumen's only filesystem touchpoint is a symlinked **MBIF Inbox** folder in her workspace, where she can drop her own files/documents/notes for the intra-day writer to pick up later — she has no live vault access mid-turn.

## 6. Lumen's tool surface

Lumen gets **only** a "read Obsidian note by path" tool — no search tool. She follows wikilinks already present in the injected briefing rather than deciding to go search on her own. This directly avoids the self-defeating-tool problem from §1: she never has to remember memory exists, because a link is already sitting in front of her when it's relevant.

## 7. Pipeline placement

Since the briefing runs on the host (§5) and must complete before Lumen's container is even woken, the loop is:

1. Trigger arrives (channel message, scheduled task, host-sweep due-wake) → written durably (queue, §7a), not routed straight to the container.
2. Host-side worker dequeues it, invokes the briefing agent (headless `-p`, no container involved) against the incoming message + last-N literal turns + vault.
3. Once the briefing markdown comes back, the host assembles Lumen's actual prompt (briefing + last-N literal turns + the new message) and **only then** wakes/spawns the container.
4. Lumen's turn runs as normal; response delivered; response appended to canonical transcript as before.

This is a mandatory pipeline stage, not a callable skill Lumen chooses to invoke — same reasoning as §6: a memory mechanism gated behind the recaller remembering to call it reproduces the exact failure mode being designed away from.

Accepted trade-off: every turn pays the briefing agent's latency/cost — including container-wake latency, since the container no longer wakes until briefing completes — even on turns where little or nothing relevant exists to retrieve. DMJ has explicitly signed off on slower interactions in exchange for this.

## 7a. Queue and concurrency

**Durable FIFO queue, reusing the existing pattern.** NanoClaw already has a durable queue shape for exactly this kind of problem: `inbound.db`'s `messages_in` (pending/processing/tries/backoff, with host-sweep recovering stale claims). The briefing-pending stage should reuse that shape rather than invent new queue infra — a message sits durably queued until a worker claims it, so a host restart mid-briefing can't lose or duplicate work.

**FIFO scope is per-session**, not global — one session's messages process in arrival order, but unrelated sessions aren't blocked behind each other. Ordering must be enforced by an **explicit per-session queue** (only the head-of-queue message for a session is ever a candidate to run), not by trusting a semaphore's internal wakeup order to preserve arrival order — generic semaphores aren't guaranteed FIFO-fair across waiters.

**Concurrency: three configurable knobs**, default `globalConcurrency = 1` (full serialization — this is deliberately the current experiment's starting condition, not a permanent architectural commitment; raising it later as backends change is just a config edit):

- `briefingConcurrency` — max concurrent briefing-agent invocations
- `agentConcurrency` — max concurrent Lumen container turns
- `globalConcurrency` — hard ceiling across both combined

**Acquisition order to avoid deadlock:** always acquire the global permit *before* the lane permit, never the reverse, across every code path — a fixed acquisition order rules out the classic circular-wait deadlock. Equally important: never hold a permit across an independent pipeline stage — release both permits fully once briefing completes, before the agent-stage separately acquires its own fresh permits for the same message.

**Real risk isn't deadlock, it's starvation/convoy**, sharper at `global=1`: a long-running agent turn (or a hung briefing call — plausible while validating a new external Tailscale backend or a fresh local Ollama link) holding the single global permit blocks *every other session* behind it, not just its own, and with no timeout this looks indistinguishable from a deadlock from the outside. Needs the same stale-claim recovery pattern host-sweep already does for `inbound.db` — a max-duration per task, forced release/requeue on timeout.

**Backend selection is orthogonal.** Whether briefing/Lumen calls land on local Ollama, a Tailscale-linked external machine, or the Anthropic API is a PrefixRouter model-prefix routing concern (see [inference-router.md](inference-router.md)), decoupled entirely from these concurrency knobs.

## 8. Open questions (not yet resolved)

- Exact vault frontmatter schema for ontological status / changelog — concept agreed, fields not finalized.
- Whether `-p` invocation of a Seeker-derived agent costs what's expected for a "small, focused model," or inherits Seeker's (possibly heavier) default model choice.
- Real failure modes of the briefing agent's traversal — deliberately left to observation, not designed in advance.
- Whether/how shared prompt chunks between Seeker and the briefing agent get identified once they exist.
- Whether `globalConcurrency=1` is actually viable in practice (part of the experiment) or becomes a bottleneck once real usage patterns show up.

## 9. Explicit non-goals (for now)

- Does not touch task-execution context assembly (agent-coding sessions keep literal transcript + compaction).
- Does not pre-build a fixed retrieval-depth or traversal algorithm for the briefing agent.
- Does not pre-extract shared prompt structure between Seeker and the briefing agent before duplication actually hurts.
- Does not tie concurrency limits to any specific backend — those are config, tuned independently of PrefixRouter's routing choices.
