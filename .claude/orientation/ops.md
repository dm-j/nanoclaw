# Operations

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
