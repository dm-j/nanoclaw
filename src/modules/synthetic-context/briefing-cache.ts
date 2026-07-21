/**
 * Async, one-turn-behind briefing delivery for the synthetic-context skeleton
 * (see docs/synthetic-context.md). Fire-and-forget on message arrival: kicks
 * off a real Briefer call and, when it resolves ~30-45s later, writes the
 * result to the group's `.briefing-cache.md`. claude.ts reads whatever's
 * there when it builds *this* turn's skeleton — meaning the briefing content
 * a turn sees was computed for the *previous* message, not the current one.
 * Deliberately not synchronous: a real Briefer call took 24-46s in testing
 * 2026-07-17, an unacceptable block on every inbound message. Trades
 * one-turn staleness for zero added latency. See docs/synthetic-context.md
 * "Path forward" for what synchronous delivery would need.
 */
import fs from 'fs';
import path from 'path';

import { getAgentGroup } from '../../db/agent-groups.js';
import { getContainerConfig } from '../../db/container-configs.js';
import { GROUPS_DIR } from '../../config.js';
import { readEnvFile } from '../../env.js';
import { log } from '../../log.js';
import { runBrieferWithWikilinkCache } from '../../memory-briefing/wikilink-cache.js';

const env = readEnvFile([
  'MBIF_VAULT_PATH',
  'MBIF_LIVE_BRIEFER_MODEL',
  'MBIF_BRIEFER_MODEL',
  'MBIF_LIVE_BRIEFER_BASE_URL',
]);
const VAULT_PATH = process.env.MBIF_VAULT_PATH || env.MBIF_VAULT_PATH;

// MBIF_LIVE_BRIEFER_MODEL > MBIF_BRIEFER_MODEL > sonnet (real Anthropic API,
// same default as briefer.ts/the vault's briefer.md frontmatter). No baseUrl
// override unless MBIF_LIVE_BRIEFER_BASE_URL is explicitly set — 2026-07-21
// surrendered the on-prem/PrefixRouter experiment for this call site;
// forcing localhost:8787 here regardless of model was the bug that kept
// routing even a plain "sonnet" request through the proxy hop.
const LIVE_BRIEFER_MODEL =
  process.env.MBIF_LIVE_BRIEFER_MODEL ||
  env.MBIF_LIVE_BRIEFER_MODEL ||
  process.env.MBIF_BRIEFER_MODEL ||
  env.MBIF_BRIEFER_MODEL ||
  'sonnet';
const LIVE_BRIEFER_BASE_URL = process.env.MBIF_LIVE_BRIEFER_BASE_URL || env.MBIF_LIVE_BRIEFER_BASE_URL;
const SYNTHETIC_BRIEFING_OVERRIDES = { model: LIVE_BRIEFER_MODEL, baseUrl: LIVE_BRIEFER_BASE_URL };

function synthContextEnabledFor(agentGroupId: string): boolean {
  const config = getContainerConfig(agentGroupId);
  if (!config?.env) return false;
  try {
    const parsedEnv = JSON.parse(config.env) as Record<string, string>;
    return parsedEnv.NANOCLAW_SYNTHETIC_CONTEXT === '1' || parsedEnv.NANOCLAW_SYNTHETIC_CONTEXT === 'true';
  } catch {
    return false;
  }
}

function briefingCachePath(agentGroupId: string): string | null {
  const group = getAgentGroup(agentGroupId);
  if (!group) return null;
  return path.join(GROUPS_DIR, group.folder, '.briefing-cache.md');
}

// groups/<folder>/working-memory.md is a symlink to /workspace/vault/Meta/working-memory.md
// (a container-internal path) — following it from the host would need
// VAULT_PATH anyway, so just build the real vault-relative path directly.
function workingMemoryPath(): string | undefined {
  if (!VAULT_PATH) return undefined;
  return path.join(VAULT_PATH, 'Meta', 'working-memory.md');
}

// A/B lever for comparing the two tradeoffs directly: async (default, one-turn
// stale, zero added latency) vs sync (fresh every turn, but the caller waits
// out the full 24-46s Briefer call before the container wakes). Same env var
// shape as NANOCLAW_SYNTHETIC_CONTEXT itself.
function syncModeEnabledFor(agentGroupId: string): boolean {
  const config = getContainerConfig(agentGroupId);
  if (!config?.env) return false;
  try {
    const parsedEnv = JSON.parse(config.env) as Record<string, string>;
    return parsedEnv.NANOCLAW_SYNTHETIC_CONTEXT_SYNC === '1' || parsedEnv.NANOCLAW_SYNTHETIC_CONTEXT_SYNC === 'true';
  } catch {
    return false;
  }
}

// Per-agent-group single-flight state. Concurrent `claude -p` processes
// against the same vault cwd have been observed to transiently deny each
// other file reads (2026-07-20 incident: a rapid back-and-forth conversation
// fired overlapping briefer kickoffs, one of which came back with "vault
// access denied" mid-run). Since briefing is already one-turn-stale by
// design, a second concurrent run adds no value anyway — messages that
// arrive while a run is in flight get batched into the *next* run instead of
// each spawning their own process.
interface FlightState {
  inFlight: boolean;
  pendingTexts: string[];
  // Shared by every caller batched into the *next* run — resolved once that
  // batch completes, so a sync-mode caller that lands mid-flight still waits
  // for a briefing that covers its own message, instead of falling through
  // immediately to a stale cache (the bug this replaced: sync mode silently
  // degraded to one-turn-behind under rapid messaging).
  pendingPromise: Promise<void> | null;
  pendingResolve: (() => void) | null;
}
const flightState = new Map<string, FlightState>();

function runBriefingCall(agentGroupId: string, cachePath: string, messageText: string): Promise<void> {
  return runBrieferWithWikilinkCache(VAULT_PATH!, [], messageText, SYNTHETIC_BRIEFING_OVERRIDES, workingMemoryPath())
    .then((result) => {
      fs.writeFileSync(cachePath, result.briefing);
      log.debug('synthetic-context briefing cache updated', { agentGroupId, costUsd: result.costUsd });
    })
    .catch((err) => {
      log.warn('synthetic-context briefing kickoff failed (non-fatal, next turn falls back)', { agentGroupId, err });
    });
}

function pumpQueue(agentGroupId: string, cachePath: string): void {
  const state = flightState.get(agentGroupId);
  if (!state) return;
  if (state.pendingTexts.length === 0) {
    state.inFlight = false;
    return;
  }
  const batched = state.pendingTexts.join('\n\n---\n\n');
  state.pendingTexts = [];
  const resolveBatch = state.pendingResolve;
  state.pendingPromise = null;
  state.pendingResolve = null;
  runBriefingCall(agentGroupId, cachePath, batched).then(() => {
    resolveBatch?.();
    pumpQueue(agentGroupId, cachePath);
  });
}

/**
 * Call on every routed message. No-ops immediately (before touching the
 * filesystem or spawning anything) unless the target agent group has
 * NANOCLAW_SYNTHETIC_CONTEXT enabled — zero cost for every other group.
 * Never throws. Async by default (fire-and-forget, caller doesn't await);
 * if NANOCLAW_SYNTHETIC_CONTEXT_SYNC is set, the returned promise resolves
 * only once a briefing covering this message has been written — whether
 * that's a run started just for it, or a batched run it got folded into
 * because another was already in flight against the same vault.
 */
export function maybeKickoffBriefing(agentGroupId: string, messageText: string): Promise<void> {
  if (!messageText.trim()) return Promise.resolve();
  if (!synthContextEnabledFor(agentGroupId)) return Promise.resolve();
  if (!VAULT_PATH) return Promise.resolve();

  const cachePath = briefingCachePath(agentGroupId);
  if (!cachePath) return Promise.resolve();

  let state = flightState.get(agentGroupId);
  if (!state) {
    state = { inFlight: false, pendingTexts: [], pendingPromise: null, pendingResolve: null };
    flightState.set(agentGroupId, state);
  }

  if (state.inFlight) {
    state.pendingTexts.push(messageText);
    if (!state.pendingPromise) {
      const s = state;
      s.pendingPromise = new Promise<void>((resolve) => {
        s.pendingResolve = resolve;
      });
    }
    const pending = state.pendingPromise!;
    return syncModeEnabledFor(agentGroupId) ? pending : Promise.resolve();
  }

  state.inFlight = true;
  const promise = runBriefingCall(agentGroupId, cachePath, messageText).then(() => {
    pumpQueue(agentGroupId, cachePath);
  });
  return syncModeEnabledFor(agentGroupId) ? promise : Promise.resolve();
}
