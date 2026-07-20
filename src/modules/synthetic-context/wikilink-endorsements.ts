/**
 * Wikilink endorsements — two signals bump a target's score: the Briefer
 * citing it in a briefing (weak signal, +1) and Lumen actually following it
 * via `load_obsidian_wikilink` (stronger signal, +2). Capped at 10 (doubled
 * from 5 so the stronger read-signal isn't immediately clipped against the
 * weaker citation-signal) and decays 1/hour (computed lazily on read, no
 * cron/sweep). `src/memory-briefing/wikilink-cache.ts` blends this with
 * similarity score to rank which wikilinks it hands the briefer as a hint —
 * see docs/synthetic-context.md.
 *
 * Container writes a fire-and-forget `wikilink_endorse` system message (see
 * container/agent-runner/src/mcp-tools/obsidian.ts); this module just bumps
 * a local JSON store, so it's unguarded — no privileged side effect, nothing
 * to gate.
 */
import fs from 'fs';

import { WIKILINK_ENDORSEMENTS_PATH } from '../../config.js';
import { registerDeliveryAction } from '../../delivery.js';
import { unguarded } from '../../guard/index.js';
import { log } from '../../log.js';

const CAP = 10;
const DECAY_PER_HOUR = 1;
export const CITED_WEIGHT = 1;
export const READ_WEIGHT = 2;

interface EndorsementEntry {
  count: number;
  lastUpdatedAt: string;
}

type Store = Record<string, EndorsementEntry>;

function readStore(): Store {
  try {
    return JSON.parse(fs.readFileSync(WIKILINK_ENDORSEMENTS_PATH, 'utf-8')) as Store;
  } catch {
    return {};
  }
}

function writeStore(store: Store): void {
  fs.mkdirSync(WIKILINK_ENDORSEMENTS_PATH.replace(/\/[^/]+$/, ''), { recursive: true });
  fs.writeFileSync(WIKILINK_ENDORSEMENTS_PATH, JSON.stringify(store, null, 2));
}

function decayedCount(entry: EndorsementEntry, now: number): number {
  const elapsedHours = (now - new Date(entry.lastUpdatedAt).getTime()) / (60 * 60 * 1000);
  return Math.max(0, entry.count - elapsedHours * DECAY_PER_HOUR);
}

/** Read-only — never persists, so concurrent ranking reads can't race a write. */
export function getEffectiveEndorsement(target: string): number {
  const entry = readStore()[target.toLowerCase()];
  if (!entry) return 0;
  return decayedCount(entry, Date.now());
}

/**
 * Bump a target's endorsement by `weight`. Exported for two callers: the
 * `wikilink_endorse` delivery action below (Lumen actually followed the
 * link via load_obsidian_wikilink — READ_WEIGHT) and wikilink-cache.ts (the
 * link merely appeared in a Briefer response — CITED_WEIGHT).
 */
export function bumpEndorsement(target: string, weight: number): void {
  const key = target.toLowerCase();
  const store = readStore();
  const now = Date.now();
  const current = store[key] ? decayedCount(store[key], now) : 0;
  store[key] = { count: Math.min(CAP, current + weight), lastUpdatedAt: new Date(now).toISOString() };
  writeStore(store);
}

registerDeliveryAction(
  'wikilink_endorse',
  async (content) => {
    const target = typeof content.target === 'string' ? content.target : '';
    if (!target) return;
    bumpEndorsement(target, READ_WEIGHT);
    log.debug('wikilink endorsed', { target });
  },
  unguarded('bumps a local ranking counter — no privileged side effect, nothing to gate'),
);
