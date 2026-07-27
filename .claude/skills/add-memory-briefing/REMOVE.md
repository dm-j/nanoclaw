# Remove Memory Briefing

**Check dependents first.** If `add-synthetic-briefing-context` is applied, removing this breaks it entirely (its briefing slot has nothing to substitute). Remove that skill first.

## 1. Remove the host-sweep hook

Delete from `src/host-sweep.ts`:

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

## 2. Remove the vault-inbox watcher wiring

Delete from `src/index.ts`: the `startVaultInboxWatcher`/`stopVaultInboxWatcher` import, the `startVaultInboxWatcher()` call, and the `stopVaultInboxWatcher()` call in shutdown.

## 3. Remove the module registrations

Delete from `src/modules/index.ts`:

```typescript
import './memory-briefing/index.js';
import './mbif-crew/index.js';
```

## 4. Remove the MCP tool registrations

Delete from `container/agent-runner/src/mcp-tools/index.ts`:

```typescript
import './briefing.js';
import './mbif-crew.js';
import './obsidian.js';   // only if it was applied
```

## 5. Delete copied files

```bash
rm -rf src/memory-briefing/
rm -rf src/modules/memory-briefing/
rm -rf src/modules/mbif-crew/
rm -f container/agent-runner/src/mcp-tools/briefing.ts
rm -f container/agent-runner/src/mcp-tools/mbif-crew.ts
rm -f container/agent-runner/src/mcp-tools/obsidian.ts
```

## 6. Remove env vars (optional)

`MBIF_VAULT_PATH`, `MBIF_BRIEFER_MODEL`, `MBIF_BRIEFER_BASE_URL`, `MBIF_BRIEFER_OAUTH_TOKEN`, `MBIF_CREW_LOG_PATH` from `.env` — only if nothing else on the install still needs them.

## 7. Rebuild, typecheck, restart

```bash
./container/build.sh
pnpm run build
pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit
source setup/lib/install-slug.sh
launchctl kickstart -k gui/$(id -u)/$(launchd_label)  # macOS
systemctl --user restart $(systemd_unit)              # Linux
```

Leave the vault itself untouched — `00-Inbox/` notes already written by `remember`, and any MBIF-crew agents, are vault content this skill never owned.
