# External Workarounds

Code written specifically to work around a bug in third-party software we don't control (an SDK, a CLI, a library) — as opposed to our own bugs. These live in normal application code, not a separate module, so they need extra care: they should be easy to find, easy to understand why they exist, and easy to remove cleanly in one shot once the upstream bug is actually fixed, without dragging in unrelated changes made to the same files since.

## Conventions

**In code**: wrap the workaround in matching markers naming the tag:
```ts
// ===== WORKAROUND: <thing> (tag: <tag>) =====
...
// ===== END WORKAROUND: <thing> (tag: <tag>) =====
```
Don't interleave unrelated edits inside the markers when touching the file for something else later — that's exactly the "signing ourselves up for merge hell" this convention exists to avoid.

**In commits**: keep a workaround's changes in their own commit(s), separate from unrelated work in the same session. Prefix the subject with `workaround(<tag>):` and add a trailer line `Workaround-For: <upstream issue URL>` so `git log --grep` or `git log --all --grep="Workaround-For"` finds every commit belonging to one workaround, and so reverting is `git revert <sha1> <sha2> ...` without needing to hand-pick hunks out of a mixed commit.

**In this file**: one entry per workaround, added whenever a new one is introduced, removed (not just marked done) once actually reverted.

---

## Active Workarounds

### `sdk-hang-abort`

- **Upstream bug**: `@anthropic-ai/claude-agent-sdk` / Claude Code CLI — the underlying CLI subprocess can go permanently silent after a normal, error-free turn (no more SDK messages, ever, no error, no exit) when run in streaming-input mode with a long-lived kept-open stream. Confirmed independently reproducible on our end (984KB/444-line session, well under any size-related resume issue; zero network traffic during the hang, confirmed via PrefixRouter's own request-start+completion logging — so it's not a slow/stuck inference call, the CLI subprocess itself just stops). Matches, and we've added our own data point to:
  - [anthropics/claude-code#28482](https://github.com/anthropics/claude-code/issues/28482) — "Agent hangs indefinitely mid-task — no recovery path without Esc"
  - [anthropics/claude-agent-sdk-python#701](https://github.com/anthropics/claude-agent-sdk-python/issues/701) — "Agent SDK CLI hangs indefinitely during synthesis after successful tool calls"
- **Discovered**: 2026-07-10/11, though retroactive log analysis (`nanoclaw.log`, `absolute-ceiling` kills correlated with a pending message at kill time) shows the same shape going back to at least 2026-06-18 — the earliest data this install has. Likely present since well before that.
- **What we do about it** (`container/agent-runner/src/`):
  1. `poll-loop.ts` — hybrid threshold, not a flat timeout: `HANG_ABORT_URGENT_MS` (90s) applies only when something new is actually waiting on this session (a fresh chat message or due task); `HANG_ABORT_IDLE_MS` (30min, matching host-sweep's `ABSOLUTE_CEILING_MS`) applies otherwise. This avoids the flat-90s version's real risk: killing a genuinely long-running legitimate turn (deep research, a big Bash job) just because it produced no SDK event for a while, with nobody actually waiting on a reply. The threshold is always measured from the *original* last-event time, not from when new work arrived — a message arriving 10s into a silence doesn't trigger an early abort, but one arriving 5 minutes in triggers an abort on the very next tick rather than waiting for the full 30-min ceiling. Also logs an unconditional `tick` diagnostic every 15s and a `ps aux` snapshot at abort time — see the `poll-loop-diag` JSONL lines in container logs.
  2. `providers/claude.ts` — `abort()` was previously a no-op-on-the-actual-process (it only stopped our own stream consumption). Now calls the SDK's real `Query.interrupt()` (stdin-EOF → ~2s grace → force-kill via signal, per the SDK's own `spawnClaudeCodeProcess` doc comment) and awaits it before resolving.
  3. `poll-loop.ts` — `processQuery()`'s `finally` block awaits the triggered abort's promise (`pendingAbort`) before returning, so the outer loop can't start a *new* `sdkQuery()` (resumed against the same session) while the old, hung process might still be alive and torn down mid-teardown. Without this, `abort()` awaiting internally wasn't enough on its own — the SDK's own iterator completes (letting us return) well before `interrupt()`'s grace window elapses.
- **How to fully revert once Anthropic fixes it**: remove the `WORKAROUND: claude-agent-sdk (tag: sdk-hang-abort)` marked blocks in `poll-loop.ts` (the constants, the hybrid threshold check inside the pollHandle's async block, the `finally` await, and the `pendingAbort` declaration) and `claude.ts` (the `abort` implementation, reverting to the simple `aborted = true; stream.end();` form — check first whether that's even still correct, or whether the fixed SDK wants something different). The `tick` liveness diagnostic can stay independently — it's generically useful hang-detection instrumentation, not specific to this bug, even though it was added at the same time.
- **Confidence this is actually needed**: high. Reproduced twice independently in one evening, both times with zero network traffic during the hang and a normal (non-oversized) session transcript, ruling out our own two leading alternate hypotheses (slow inference call, large-resume-file issue).
