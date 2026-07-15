# Host Shims

Lets a containerized agent invoke a whitelisted host-side executable by name — the one
narrow door out of the container-only sandbox for tools that must run on the actual host
(the first case: an Obsidian CLI that needs the real Obsidian app running).

## Why

The container has no shell access to the host and no shared exec channel — the only
host↔container IO is the two per-session SQLite DBs (see [docs/db.md](db.md)). Host shims
reuse that same transport, generalized from the existing `cli_request`/`ncl` round trip
(`src/cli/dispatch.ts`) rather than inventing a new channel.

## Round trip

1. Inside the container, the agent runs `host-shim <name> [args...]`
   (`container/agent-runner/src/tools/host-shim.ts` — auto-wrapped onto PATH by
   `entrypoint.sh`, same mechanism as any other file in `src/tools/`).
2. It writes a `kind: 'system'` row to `outbound.db.messages_out` with
   `content: {action: 'host_shim_exec', requestId, name, args}`.
3. The host's delivery poller dispatches to `src/modules/host-shim/index.ts`, which calls
   `execHostShim` (`src/modules/host-shim/exec.ts`).
4. `execHostShim` resolves `<HOST_SHIMS_DIR>/<name>-host` — this presence check **is** the
   whitelist, there is no DB table or config entry. It refuses if the name is invalid, the
   script doesn't exist, isn't executable, or its realpath escapes `HOST_SHIMS_DIR` (symlink
   escape). Otherwise it runs the script via `execFile` (never a shell string — `args` is a
   plain argv array, no injection surface from arg content), with a 30s timeout and a 1MB
   output cap.
5. The result (`exitCode`, `stdout`, `stderr`, or a refusal reason) is written back as a
   `host_shim_response` system message via `writeSessionMessage` (trigger=0 — an inline
   reply to the tool call, not a wake).
6. `host-shim` polls `inbound.db` for the matching response (same 500ms poll as
   `container/agent-runner/src/cli/ncl.ts`), prints stdout/stderr, and exits with the
   script's exit code.

## The whitelist directory

`host-shims/` at repo root (override via `NANOCLAW_HOST_SHIMS_DIR`). Gitignored — these are
host-specific and potentially sensitive. See `host-shims/README.md` for the authoring
convention (`<name>-host`, executable, receives argv, does its own arg validation).

## Guard

`host_shim.exec` (`src/modules/host-shim/guard.ts`) always resolves ALLOW — there is no
per-call human approval. The whitelist-file check plus each `-host` script's own validation
is the security boundary; approval-gating every routine call (e.g. every Obsidian read)
would make the tool unusable. If multiple agent groups ever need different shim access,
that's the natural place to add a per-group restriction — the guard function already exists
for this, it just always allows today.

## Concurrent writers to outbound.db

`host-shim` runs as a separate process from the agent-runner's own poll loop, so two
processes can write to `outbound.db` around the same time — same situation `ncl.ts` already
has. `host-shim.ts` copies its mitigation exactly: `BEGIN IMMEDIATE` acquires the write lock
before computing the next `seq`, so a concurrent writer can't race into the same seq value.
This is why `journal_mode=DELETE` (not WAL) is used — WAL doesn't survive the container's
cross-mount filesystem reliably. If corruption still occurs, session-DB corruption
detection + auto-repair is the existing backstop, not something this feature reinvents.

**Escalation if the lock-and-retry approach proves insufficient:** introduce a single
serial writer process per session DB that accepts write jobs on a queue and applies them
one at a time — every other writer (agent-runner, `ncl`, `host-shim`) becomes a queue
producer instead of a direct SQLite writer. This removes multi-writer contention entirely
rather than just narrowing the race window, at the cost of real infrastructure (a
long-lived process, a way for callers to reach it, error propagation back to the caller).
Not built — no evidence yet that `BEGIN IMMEDIATE` is inadequate.

## Known limitation (v1)

Each call is one full request/response round trip through the session DB — real CLI
piping *inside the container* works fine (`obsidian cat foo.md | grep bar`), but there's no
live-streaming pipe *between two separate host-side invocations*: each call fully
materializes its stdout before returning. A use case that needs a persistent host-side
stream held open across multiple shim calls isn't supported by this design.
