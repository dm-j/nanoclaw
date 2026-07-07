# Operations

## `groups/<folder>/container.json` is a materialized copy of the DB, not the source of truth

Editing `groups/<folder>/container.json` directly looks like it works — the file changes, `cat` shows the new value — but it gets **overwritten from `container_configs` in `data/v2.db`** every time the container spawns (`materializeContainerJson`, per `CLAUDE.md`'s Container Config section). Burned us: after migrating model-prefix syntax from `ollama-foo` to `ollama/foo`, the on-disk file was hand-edited and looked correct, but the DB row still had the old dash-prefixed value — so every respawn quietly reverted the file, and the container kept sending the stale model name to the router (`400 No routing rule matches model "ollama-foo"`).

**Always update via `ncl groups config update --id <group-id> --model ...`** (or the other `config` verbs), never by hand-editing `container.json`. Check what's actually live with:
```bash
pnpm exec tsx scripts/q.ts data/v2.db "SELECT agent_group_id, model FROM container_configs"
```
Config changes need `ncl groups restart --id <group-id>` (optionally `--message` to wake it immediately) to actually take effect — updating the DB row alone doesn't touch a container that's already running.

## Editing `container/agent-runner/src/` doesn't need an image rebuild

That source tree is **bind-mounted read-only into the container at spawn time** (`src/container-runner.ts` — `agentRunnerSrc`), not `COPY`'d into the image by the Dockerfile. A host-side edit is visible inside an *already-running* container immediately (verify with `container exec <name> grep ... /app/src/...`) — no rebuild, and not even a restart, needed for the poll loop to pick it up on its next iteration. `./container/build.sh` only matters for things actually baked into the image (system packages, the CLI-tools block, `bun install`'s dependency layer) — running it after an agent-runner-only change is harmless but pointless, and its cached manifest digest won't change, which can look alarming but doesn't mean the build failed.

## Restart Patterns

```bash
# Restart with wake message (immediate respawn):
ncl groups restart --id <group-id> --message "reason text"

# Restart without message (respawns on next user message):
ncl groups restart --id <group-id>

# Rebuild image + restart service:
CONTAINER_BUILD_MEMORY=8G ./container/build.sh
launchctl kickstart -k gui/$(id -u)/com.nanoclaw

# Host-only rebuild (no image change):
pnpm run build && launchctl kickstart -k gui/$(id -u)/com.nanoclaw
```

`on_wake` column on `messages_in` ensures wake messages are only picked up by a fresh container's first poll — dying containers can't steal them.

## `container ls --format json` shape does not match Docker intuition

Apple Container's JSON output nests everything under `configuration`, and its container name is the top-level `id` field — there is no top-level `name`. This burned us badly: `cleanupOrphans()` was written reading `c.name` and `c.labels` at the top level (matching Docker's `docker ps --format json` shape, and matching normal intuition about "a container listing has a name and labels field"). Both were always `undefined` on Apple Container, so the orphan filter was silently empty on **every single run** since the Docker→Apple Container migration — zombie containers from every prior host restart stayed alive indefinitely, all racing to answer wake calls on the same session's DBs. One was old enough to still carry a dead env var from before the PrefixRouter migration, producing a `ConnectionRefused` that looked like an unrelated bug.

The actual shape (trimmed):

```json
[{
  "id": "nanoclaw-v2-dm-with-dmj-1783339327910",
  "configuration": { "id": "...", "labels": { "nanoclaw-install": "1328e183" } },
  "status": { "state": "running" }
}]
```

So: `c.id` for the name, `c.configuration.labels` for labels — never `c.name`/`c.labels`.

**The unit tests didn't catch this either**, because they hand-mocked the (wrong) shape the code expected, so the mock and the bug agreed with each other. `src/container-runtime.test.ts` now has a regression test built from a real captured `container ls --format json` sample specifically to prevent that recurring — when touching this code, extend that fixture rather than hand-rolling a new mock shape from intuition.

General rule: **don't trust Docker-shaped intuition against the `container` CLI's JSON output.** Apple Container's parity with Docker is at the command-line-flag level, not the structured-output level — always dump a real sample (`container ls --format json | python3 -m json.tool`) and check field paths before writing parsing code against it.

## Diagnosing a Stuck Container

1. Check heartbeat freshness: `ls -la data/v2-sessions/<group>/<session>/.heartbeat`
2. Check `logs/nanoclaw.error.log` first (delivery failures, warnings)
3. Check `logs/nanoclaw.log` for the full routing chain
4. If container is alive but not responding: it may be stuck mid-inference (long poll to Ollama/Anthropic). Kill and respawn.
5. Container logs are lost on exit (`--rm`). If the agent silently failed at boot, only the stderr tail (captured by container-runner and logged at warn on non-zero exit) survives.

## SQLite / Session DBs

- `journal_mode=DELETE` is load-bearing for cross-mount visibility — don't change without reading the comment block in `container/agent-runner/src/db/connection.ts`
- **bun:sqlite named params**: use `$name` in both SQL and JS object keys — `.run({ $id: msg.id })`. Unlike `better-sqlite3`, bun:sqlite does NOT auto-strip the `$` prefix.
- Session DBs live at `data/v2-sessions/<agent-group-id>/<session-id>/inbound.db` and `outbound.db`
- **`datetime('now')` produces a naive string `new Date()` silently mis-parses as local time.** SQLite's `datetime('now')` writes `"2026-07-07 08:00:00"` — genuinely UTC, but no `Z`/offset marker, and no `T` separator. `new Date()` parses that shape as *local* wall-clock time, not UTC, so a naive round-trip through a "convert to local time" helper silently cancels itself out — the raw UTC hour gets displayed as if it were already local. Burned us: `formatLocalTime()` in both `src/timezone.ts` and `container/agent-runner/src/timezone.ts` did exactly this with `msg.timestamp`, so a task that correctly fired at 3am local (08:00 UTC) displayed to the agent as "8:00 AM." Host-side `parseSqliteUtc()` in `host-sweep.ts` already handled this correctly (append `Z` when no offset marker is present) — `formatLocalTime` didn't, until fixed. **Any time you hand a SQLite timestamp column to `new Date()` or a Date-parsing helper, normalize it first** (`/[zZ]|[+-]\d{2}:?\d{2}$/.test(s) ? s : s.replace(' ', 'T') + 'Z'`) rather than assuming it's already proper ISO.

## Agent-to-Agent Messaging

A2A messages are fire-and-forget. The annotator's reply lands in the recipient's `inbound.db` as a pending message. It's picked up on the next poll turn — the recipient doesn't wait synchronously. The recipient can use the annotator's reply to proactively message the user without being prompted.

## Shell Scripts Inside the Container

The container's `/bin/sh` is **dash**, not bash. Scripts with `#!/bin/sh` that use bash-specific syntax (arrays, `[[ ]]`, `local -a`, etc.) will fail with a syntax error — often silently, since stubs relay output over curl.

**Always use `#!/bin/bash`** for any script that runs inside the container (stub scripts, hooks, entrypoint helpers). This burned us: `container/memsearch-stub/memsearch` had `#!/bin/sh` and the array syntax `AUTH_HEADER=()` caused a dash syntax error every time memsearch was called.

Hooks in `.hooks/` use `bash` explicitly in their shebang so they're fine. Watch out for new stubs or ad-hoc scripts dropped into the container.

## Useful One-Liners

```bash
# Query any DB without sqlite3 binary:
pnpm exec tsx scripts/q.ts data/v2.db "<sql>"
pnpm exec tsx scripts/q.ts data/v2-sessions/<group>/<session>/inbound.db "SELECT * FROM messages_in ORDER BY seq DESC LIMIT 5"

# List running containers:
container ls

# Check Apple Container host bridge:
ifconfig bridge100 | grep inet
```
