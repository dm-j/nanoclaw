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

const env = readEnvFile(['MBIF_VAULT_PATH']);
const VAULT_PATH = process.env.MBIF_VAULT_PATH || env.MBIF_VAULT_PATH;

// Scoped to this purpose only — see docs/synthetic-context.md "Model
// override, not a permanent change". Does not touch MBIF_BRIEFER_MODEL /
// MBIF_BRIEFER_BASE_URL, which still govern the on-demand `recall` tool.
const SYNTHETIC_BRIEFING_OVERRIDES = { model: 'ollama/gemma4:31b-cloud', baseUrl: 'http://localhost:8787' };

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

function workingMemoryPath(agentGroupId: string): string | undefined {
  const group = getAgentGroup(agentGroupId);
  if (!group) return undefined;
  return path.join(GROUPS_DIR, group.folder, 'working-memory.md');
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

/**
 * Call on every routed message. No-ops immediately (before touching the
 * filesystem or spawning anything) unless the target agent group has
 * NANOCLAW_SYNTHETIC_CONTEXT enabled — zero cost for every other group.
 * Never throws. Async by default (fire-and-forget, caller doesn't await);
 * if NANOCLAW_SYNTHETIC_CONTEXT_SYNC is set, the returned promise resolves
 * only once the fresh briefing is written, so an awaiting caller blocks the
 * container wake on it.
 */
export function maybeKickoffBriefing(agentGroupId: string, messageText: string): Promise<void> {
  if (!messageText.trim()) return Promise.resolve();
  if (!synthContextEnabledFor(agentGroupId)) return Promise.resolve();
  if (!VAULT_PATH) return Promise.resolve();

  const cachePath = briefingCachePath(agentGroupId);
  if (!cachePath) return Promise.resolve();

  const promise = runBrieferWithWikilinkCache(
    VAULT_PATH,
    [],
    messageText,
    SYNTHETIC_BRIEFING_OVERRIDES,
    workingMemoryPath(agentGroupId),
  )
    .then((result) => {
      fs.writeFileSync(cachePath, result.briefing);
      log.debug('synthetic-context briefing cache updated', { agentGroupId, costUsd: result.costUsd });
    })
    .catch((err) => {
      log.warn('synthetic-context briefing kickoff failed (non-fatal, next turn falls back)', { agentGroupId, err });
    });

  return syncModeEnabledFor(agentGroupId) ? promise : Promise.resolve();
}
