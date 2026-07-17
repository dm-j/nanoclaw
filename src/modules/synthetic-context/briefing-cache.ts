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

/**
 * Call on every routed message. No-ops immediately (before touching the
 * filesystem or spawning anything) unless the target agent group has
 * NANOCLAW_SYNTHETIC_CONTEXT enabled — zero cost for every other group.
 * Never throws, never awaited by the caller — routing must not wait on this.
 */
export function maybeKickoffBriefing(agentGroupId: string, messageText: string): void {
  if (!messageText.trim()) return;
  if (!synthContextEnabledFor(agentGroupId)) return;
  if (!VAULT_PATH) return;

  const cachePath = briefingCachePath(agentGroupId);
  if (!cachePath) return;

  runBrieferWithWikilinkCache(VAULT_PATH, [], messageText, SYNTHETIC_BRIEFING_OVERRIDES)
    .then((result) => {
      fs.writeFileSync(cachePath, result.briefing);
      log.debug('synthetic-context briefing cache updated', { agentGroupId, costUsd: result.costUsd });
    })
    .catch((err) => {
      log.warn('synthetic-context briefing kickoff failed (non-fatal, next turn falls back)', { agentGroupId, err });
    });
}
