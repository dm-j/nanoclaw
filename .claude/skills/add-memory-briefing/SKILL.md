---
name: add-memory-briefing
description: Add the memory-briefing/Briefer system — an Obsidian-vault-backed briefing agent NanoClaw can call on-demand (recall) or as a background kickoff (used by add-synthetic-briefing-context). Installs the recall/remember MCP tools, the host-side Briefer invocation, wikilink caching, the vault-inbox watcher, and the mbif_crew_prompt freeform-vault-instruction tool. Full design background: docs/memory-briefing-design.md.
---

# Add Memory Briefing

The foundational vault-memory integration other features build on — `add-synthetic-briefing-context` requires this to be applied first, and `add-vault-transcript-pipeline` feeds it real digests instead of raw vault content. On its own, this skill gives an agent group two new tools (`recall`, `remember`) plus the ability to hand freeform instructions to the vault's own Claude Code (`mbif_crew_prompt`, always approval-gated).

**Prerequisite — this is not installed by this skill.** The vault side: an MBIF-crew install with at least `briefer`, `digester`, `sorter`/`inbox-triage` present (`.claude/agents/briefer.md`, `.claude/agents/digester.md`, `.claude/skills/inbox-triage/SKILL.md` under `MBIF_VAULT_PATH`). MBIF-crew itself is a separate template project (see the vault's own `My-Brain-Is-Full-Crew/README.md`) — this skill only wires NanoClaw's side of the integration. Also assumes `memsearch` is installed and reachable (`which memsearch`).

Design background: [docs/memory-briefing-design.md](../../../docs/memory-briefing-design.md), [docs/vault-memory-pipeline.md](../../../docs/vault-memory-pipeline.md).

## Phase 1: Pre-flight

```bash
V="${MBIF_VAULT_PATH:?set MBIF_VAULT_PATH first}"
test -f "$V/.claude/agents/briefer.md"  && echo "OK: briefer agent present"  || echo "MISSING — set up MBIF-crew in the vault first"
test -f "$V/.claude/agents/digester.md" && echo "OK: digester agent present" || echo "MISSING"
test -f "$V/.claude/skills/inbox-triage/SKILL.md" && echo "OK: inbox-triage present" || echo "MISSING"
which memsearch >/dev/null 2>&1 && echo "OK: memsearch present" || echo "MISSING — install memsearch first"
```

### Check if already applied

```bash
grep -q "export async function runBriefer" src/memory-briefing/briefer.ts 2>/dev/null && echo "ALREADY APPLIED — skip to Phase 3"
```

## Phase 2: Apply code changes

### Copy the new files

```bash
S=.claude/skills/add-memory-briefing/assets
mkdir -p src/memory-briefing src/modules/mbif-crew
cp "$S/briefer.ts"               src/memory-briefing/briefer.ts
cp "$S/briefer.test.ts"          src/memory-briefing/briefer.test.ts
cp "$S/wikilink-cache.ts"        src/memory-briefing/wikilink-cache.ts
cp "$S/vault-inbox-watcher.ts"   src/memory-briefing/vault-inbox-watcher.ts
cp "$S/memory-briefing-module.ts" src/modules/memory-briefing/index.ts
cp "$S/mbif-crew/"*.ts           src/modules/mbif-crew/
cp "$S/briefing.ts"              container/agent-runner/src/mcp-tools/briefing.ts
cp "$S/mbif-crew-tool.ts"        container/agent-runner/src/mcp-tools/mbif-crew.ts
```

Alternative acquisition path (registry-branch style, mirrors channels/providers):

```bash
git fetch origin memory-briefing
git show origin/memory-briefing:src/memory-briefing/briefer.ts > src/memory-briefing/briefer.ts
# ...same per-file as above
```

### Optional: `obsidian.ts` (lets the chat agent open/preview a wikilink directly)

Not required for `recall`/`remember`/`mbif_crew_prompt` — Briefer itself reads the vault directly via its own `Read`/`Glob`/`Grep` tools against the vault as `cwd`, no MCP tool involved. `obsidian.ts` is a separate, optional convenience (`open_obsidian_wikilink`) that depends on the `host-shim` relay (`src/modules/host-shim/`, [docs/host-shims.md](../../../docs/host-shims.md)) — itself another local addition, not upstream. Skip this file unless host-shim is already applied:

```bash
cp "$S/obsidian.ts" container/agent-runner/src/mcp-tools/obsidian.ts   # only if host-shim is present
```

### Register the MCP tools

`container/agent-runner/src/mcp-tools/index.ts` self-registers via side-effecting imports — add:

```typescript
import './briefing.js';
import './mbif-crew.js';
```

Add `import './obsidian.js';` too, only if you copied that file.

### Register the host-side modules

`src/modules/index.ts` — add:

```typescript
import './memory-briefing/index.js';
import './mbif-crew/index.js';
```

### Start the vault-inbox watcher

`src/index.ts` — add the import near the other module imports:

```typescript
import { startVaultInboxWatcher, stopVaultInboxWatcher } from './memory-briefing/vault-inbox-watcher.js';
```

Call `startVaultInboxWatcher()` during startup (alongside the other `start*()` calls) and `stopVaultInboxWatcher()` in the shutdown handler.

### Add the mbif-crew sweep hook

`src/host-sweep.ts` already has a `MODULE-HOOK` convention for this — add a new paired block next to the existing `approvals-reason-sweep` one:

```typescript
  // MODULE-HOOK:mbif-crew-timeout-sweep:start
  try {
    const { sweepStaleMbifCrewRequests } = await import('./modules/mbif-crew/index.js');
    await sweepStaleMbifCrewRequests();
  } catch (err) {
    log.error('MBIF-crew sweep failed', { err });
  }
  // MODULE-HOOK:mbif-crew-timeout-sweep:end
```

This finalizes any `mbif_crew_prompt` approval hold older than 12h as a silent deny (see `src/modules/mbif-crew/index.ts`'s own doc comment).

### Environment variables

Set in `.env` (read via `readEnvFile`, no rebuild needed to change):

| Var | Purpose |
|---|---|
| `MBIF_VAULT_PATH` | Path to the Obsidian vault. Required — every module above no-ops or errors without it. |
| `MBIF_BRIEFER_MODEL` | Model Briefer runs as (default: sonnet, per its own agent frontmatter if unset). |
| `MBIF_BRIEFER_BASE_URL` | Override for routing Briefer calls through a different endpoint (e.g. PrefixRouter). |
| `MBIF_BRIEFER_OAUTH_TOKEN` | OAuth token for `claude` CLI subprocess auth — same launchd/Keychain workaround needed for any host-spawned `claude -p` call under a daemon (not an interactive shell). |
| `MBIF_CREW_LOG_PATH` | Where `mbif_crew_prompt` audit log entries are appended. |

## Phase 3: Wire per-agent-group

Nothing agent-group-specific to configure — `recall`/`remember`/`mbif_crew_prompt` become available to every group as soon as the MCP tools are registered and the image rebuilt. If you want to restrict which groups get these tools, gate it the same way other optional MCP tools are gated (per-group `mcpServers` config), which is out of scope for this skill's default (all-groups) install.

## Phase 4: Build, validate, restart

```bash
./container/build.sh
pnpm run build
pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit
pnpm test -- src/memory-briefing src/modules/mbif-crew src/modules/memory-briefing
(cd container/agent-runner && bun test src/mcp-tools/briefing.test.ts src/mcp-tools/obsidian.test.ts src/mcp-tools/mbif-crew.test.ts 2>/dev/null)
source setup/lib/install-slug.sh
launchctl kickstart -k gui/$(id -u)/$(launchd_label)  # macOS
systemctl --user restart $(systemd_unit)              # Linux
```

## Phase 5: Verify

Tell the user:

> Send "remember that my favorite color is blue" in any agent chat, then "recall my favorite color" in a later turn. The first should write a note into the vault's `00-Inbox/`; the second should return a Briefer-synthesized answer (may take 20-45s).

```bash
tail -100 logs/nanoclaw.log | grep -iE "recall|briefer|mbif"
ls "$MBIF_VAULT_PATH/00-Inbox/" | tail -5
```

Common signals:
- `recall` never returns → check `logs/nanoclaw.log` for `runBriefer` errors; confirm `claude` CLI auth works standalone (`claude --agent briefer -p "test" --dangerously-skip-permissions` from a shell, cwd the vault).
- `remember` errors "vault inbox is not mounted" → this tool needs the vault mounted into the *container* (`additionalMounts` in the group's `container.json`), separate from `MBIF_VAULT_PATH` which is host-side only for `recall`/Briefer.
- `mbif_crew_prompt` never prompts for approval → confirm `src/modules/mbif-crew/index.ts` is actually imported by `src/modules/index.ts` (a missing import is fail-safe-by-omission: the tool call still "succeeds" from the agent's view but nothing happens).

## Removal

See [REMOVE.md](REMOVE.md).

## Notes

- **`recall` is fire-and-forget from the container's perspective** — it can't reach the vault filesystem or spawn `claude` itself, so it writes an outbound system action and the host runs the actual Briefer call, waking the container with the result.
- **`remember` writes directly**, no host round-trip, since the vault is mounted straight into the container.
- **`mbif_crew_prompt` always holds for approval** — no trusted tier, since it's an unbounded freeform instruction against live vault content. Denials are silent (agent isn't told), matching the self-mod pattern.
- **This is the prerequisite, not the whole memory system.** `add-synthetic-briefing-context` is what actually makes Briefer's output shape the model's per-turn context; without it, this skill only gives on-demand `recall`.

## Credits & references

- Design: [docs/memory-briefing-design.md](../../../docs/memory-briefing-design.md).
- Downstream consumer: [`add-synthetic-briefing-context`](../add-synthetic-briefing-context/SKILL.md).
- Skill pattern: [docs/skill-phase-paradigm.md](../../../docs/skill-phase-paradigm.md).
