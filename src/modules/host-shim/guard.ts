/**
 * Host-shim guard adapter — the module's single catalog entry.
 *
 * Unlike self-mod, this action can never hold or deny at the guard layer:
 * the security boundary is the whitelist-file check in ./exec.ts (does a
 * `<name>-host` script exist?) plus whatever validation that script does
 * itself. Per-call human approval would make routine tool use (e.g. every
 * read through the Obsidian CLI) unusably slow. An explicit guard (rather
 * than `unguarded`) gives a future per-group restriction a natural place to
 * live if multiple agent groups ever need different shim access.
 */
import { ALLOW, defineGuardedAction } from '../../guard/index.js';

export const hostShimExec = defineGuardedAction({
  action: 'host_shim.exec',
  decide: () => ALLOW('host-shim whitelist is filesystem-based; each -host script validates its own args'),
});
