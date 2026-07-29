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
import { BRIEFING_LOG_DIR, GROUPS_DIR } from '../../config.js';
import { readEnvFile } from '../../env.js';
import { log } from '../../log.js';
import type { LiteralTurn } from '../../memory-briefing/briefer.js';
import { runBrieferWithWikilinkCache } from '../../memory-briefing/wikilink-cache.js';
import { inboundDbPath, outboundDbPath } from '../../session-manager.js';
import { openInboundDb, openOutboundDb } from '../../db/session-db.js';

// How much history Briefer gets alongside the inciting message — kept small
// deliberately. Briefer's own job is a fresh lookup against the vault, not
// re-summarizing the conversation; too many turns just crowds out the vault
// content it's supposed to be citing. Not the same knob as Lumen's own
// NANOCLAW_SYNTHETIC_CONTEXT_LINES (container/agent-runner), which sizes a
// different, unrelated context window.
const BRIEFER_RECENT_TURNS = 6;

/** Last N chat turns (both directions) for an agent group's session, oldest
 * first — Briefer gets these for tone/continuity, not as source material. */
function getRecentTurns(agentGroupId: string, sessionId: string, n: number): LiteralTurn[] {
  type Row = { role: LiteralTurn['role']; text: string; timestamp: string };
  const rows: Row[] = [];
  try {
    const inDb = openInboundDb(inboundDbPath(agentGroupId, sessionId));
    for (const row of inDb
      .prepare(
        `SELECT content, timestamp FROM messages_in WHERE kind IN ('chat', 'chat-sdk') ORDER BY timestamp DESC LIMIT ?`,
      )
      .all(n) as { content: string; timestamp: string }[]) {
      const text = safeParseText(row.content);
      if (text) rows.push({ role: 'user', text, timestamp: row.timestamp });
    }
  } catch (err) {
    log.debug('recent-turns inbound read failed (non-fatal)', { agentGroupId, sessionId, err });
  }
  try {
    const outDb = openOutboundDb(outboundDbPath(agentGroupId, sessionId));
    for (const row of outDb
      .prepare(
        `SELECT content, timestamp FROM messages_out WHERE kind IN ('chat', 'chat-sdk') ORDER BY timestamp DESC LIMIT ?`,
      )
      .all(n) as { content: string; timestamp: string }[]) {
      const text = safeParseText(row.content);
      if (text) rows.push({ role: 'assistant', text, timestamp: row.timestamp });
    }
  } catch (err) {
    log.debug('recent-turns outbound read failed (non-fatal)', { agentGroupId, sessionId, err });
  }
  return rows
    .sort((a, b) => a.timestamp.localeCompare(b.timestamp))
    .slice(-n)
    .map(({ role, text }) => ({ role, text }));
}

function safeParseText(raw: string): string | undefined {
  try {
    return (JSON.parse(raw) as { text?: string }).text;
  } catch {
    return raw;
  }
}

const env = readEnvFile([
  'MBIF_VAULT_PATH',
  'MBIF_LIVE_BRIEFER_MODEL',
  'MBIF_BRIEFER_MODEL',
  'MBIF_LIVE_BRIEFER_BASE_URL',
  'NANOCLAW_BRIEFING_DEBUG_LOG',
]);
const VAULT_PATH = process.env.MBIF_VAULT_PATH || env.MBIF_VAULT_PATH;
// Opt-in: also overwrite logs/briefings/last-debug.md with the same debug
// content written per-group (see briefingDebugPath) — one rolling file
// across all agent groups, easier to tail/grep than hunting per group folder.
const BRIEFING_DEBUG_LOG_ENABLED = (process.env.NANOCLAW_BRIEFING_DEBUG_LOG ?? env.NANOCLAW_BRIEFING_DEBUG_LOG) === '1';

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

// Debug-only inspection file, overwritten every run — not read by anything
// (Lumen's context comes from .briefing-cache.md only). Only tool-call
// metadata (name/detail/timing) is included, never subagent free text — same
// isolation guarantee as the log line in runBriefingCall below.
function briefingDebugPath(agentGroupId: string): string | null {
  const group = getAgentGroup(agentGroupId);
  if (!group) return null;
  return path.join(GROUPS_DIR, group.folder, '.briefing-debug.md');
}

function formatDebugMarkdown(result: {
  briefing: string;
  costUsd: number;
  durationMs: number;
  toolCalls: { tool: string; detail: string; iterationMs: number; parentTask?: string }[];
  prompt: string;
}): string {
  const bySubject = new Map<string, typeof result.toolCalls>();
  for (const call of result.toolCalls) {
    const key = call.parentTask ?? 'Top-level';
    bySubject.set(key, [...(bySubject.get(key) ?? []), call]);
  }

  const lines: string[] = [
    `# Briefing debug — ${new Date().toISOString()}`,
    '',
    `Model: ${LIVE_BRIEFER_MODEL}`,
    `Total cost: $${result.costUsd.toFixed(4)}`,
    `Total duration: ${result.durationMs}ms`,
    `Tool calls: ${result.toolCalls.length}`,
    '',
  ];

  for (const [subject, calls] of bySubject) {
    const ms = calls.reduce((sum, c) => sum + c.iterationMs, 0);
    lines.push(`## ${subject} — ${calls.length} call(s), ${ms}ms`, '');
    for (const c of calls) lines.push(`- **${c.tool}** (${c.iterationMs}ms): ${c.detail}`);
    lines.push('');
  }

  lines.push('---', '', '## Prompt sent', '', result.prompt);
  lines.push('---', '', '## Final briefing', '', result.briefing);
  return lines.join('\n');
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

function runBriefingCall(
  agentGroupId: string,
  sessionId: string,
  cachePath: string,
  messageText: string,
): Promise<void> {
  const previousBriefing = fs.existsSync(cachePath) ? fs.readFileSync(cachePath, 'utf-8') : undefined;
  const recentTurns = getRecentTurns(agentGroupId, sessionId, BRIEFER_RECENT_TURNS);
  return runBrieferWithWikilinkCache(
    VAULT_PATH!,
    recentTurns,
    messageText,
    SYNTHETIC_BRIEFING_OVERRIDES,
    workingMemoryPath(),
    previousBriefing,
  )
    .then((result) => {
      fs.writeFileSync(cachePath, result.briefing);
      const debugPath = briefingDebugPath(agentGroupId);
      const debugMarkdown = debugPath || BRIEFING_DEBUG_LOG_ENABLED ? formatDebugMarkdown(result) : null;
      if (debugPath && debugMarkdown) fs.writeFileSync(debugPath, debugMarkdown);
      if (BRIEFING_DEBUG_LOG_ENABLED && debugMarkdown) {
        fs.mkdirSync(BRIEFING_LOG_DIR, { recursive: true });
        fs.writeFileSync(path.join(BRIEFING_LOG_DIR, 'last-debug.md'), debugMarkdown);
      }
      const toolMs = result.toolCalls.reduce((sum, c) => sum + c.iterationMs, 0);
      // Per-subject breakdown: calls with no parentTask are the top-level
      // briefer loop; calls tagged with a parentTask ran inside that Task's
      // dispatched subagent (see parseStreamJson in briefer.ts). Only
      // tool-call metadata (name/detail/timing) is logged here — never
      // subagent free text — so this stays a host-log-only audit trail and
      // never touches what Lumen's context is built from.
      const bySubject = new Map<string, { count: number; ms: number }>();
      for (const call of result.toolCalls) {
        const key = call.parentTask ?? 'top-level';
        const entry = bySubject.get(key) ?? { count: 0, ms: 0 };
        entry.count += 1;
        entry.ms += call.iterationMs;
        bySubject.set(key, entry);
      }
      log.info('synthetic-context briefing cache updated', {
        agentGroupId,
        model: LIVE_BRIEFER_MODEL,
        costUsd: result.costUsd,
        durationMs: result.durationMs,
        toolCallCount: result.toolCalls.length,
        toolMs,
        bySubject: Object.fromEntries(bySubject),
        toolCalls: result.toolCalls,
      });
    })
    .catch((err) => {
      log.warn('synthetic-context briefing kickoff failed (non-fatal, next turn falls back)', { agentGroupId, err });
    });
}

function pumpQueue(agentGroupId: string, sessionId: string, cachePath: string): void {
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
  runBriefingCall(agentGroupId, sessionId, cachePath, batched).then(() => {
    resolveBatch?.();
    pumpQueue(agentGroupId, sessionId, cachePath);
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
export function maybeKickoffBriefing(agentGroupId: string, sessionId: string, messageText: string): Promise<void> {
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
  const promise = runBriefingCall(agentGroupId, sessionId, cachePath, messageText).then(() => {
    pumpQueue(agentGroupId, sessionId, cachePath);
  });
  return syncModeEnabledFor(agentGroupId) ? promise : Promise.resolve();
}
