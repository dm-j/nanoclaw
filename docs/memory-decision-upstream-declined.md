# Declined: upstream provider-agnostic memory feature

**Decision date:** 2026-07-16
**Status:** Declined for now, not ruled out permanently.

Upstream landed a generic memory scaffold (`docs/memory.md` upstream,
`container/agent-runner/src/memory/`) in the batch merged via `/update-nanoclaw`
on this date: an OKF-formatted `memory/index.md` + `memory/system/definition.md`
pair, auto-injected at every fresh context window, capped 16k chars each, with
everything else left as agent-organized linked files. It's designed to be
provider-portable (`/migrate-memory` carries it across a provider switch).

This install did **not** merge that feature. The 15 memory-feature commits
were left out of the `/update-nanoclaw` cherry-pick; only the unrelated
Telegram deep-link fix and WhatsApp Cloud docs commit came in from that batch.

## Why

Lumen's agent group (`groups/dm-with-dmj/`) already has a memory system built
purpose-first over the prior week, and it's a superset of what upstream ships:

- `working-memory.md` — hand-curated snapshot (Now/Open/Soon/Watch/Back-burner),
  injected each turn, with an explicit pruning ritual ("whiteboard wipe") against
  calcification.
- `.lumen-core.md` — persona/identity, shared into subagent CLAUDE.md via
  `@include`.
- `.memsearch/` — a real semantic index (milvus-backed) behind a three-function
  memory system: `remember` (store), the working-memory snapshot (inject), and
  `recall` (delta-focused briefs via a cheap local model).

Upstream's design only solves the static-injection half of that (two files,
always loaded, capped size) and stops there — it has no semantic recall layer
and no delta-aware briefing. Adopting it would mean either running two
memory systems side by side or ripping out working infrastructure to adopt a
strictly less capable generic version.

## What would change this

Not a permanent rejection. Re-evaluate a future upstream memory revision if it
brings something Lumen's system doesn't have and can't cheaply grow — e.g.
built-in provider-portable migration significantly better than a manual
`/migrate-memory`-style pass, or a scaffold the growing `.memsearch` /
`recall` layer could sit on top of instead of duplicating. The bar is
"materially better than what's already running," not "upstream has a
memory feature now."
