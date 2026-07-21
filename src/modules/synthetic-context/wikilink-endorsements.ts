/**
 * Wikilink endorsements — two signals bump a target's score: the Briefer
 * citing it in a briefing (weak signal, +1) and Lumen actually following it
 * via `load_obsidian_wikilink` (stronger signal, +2). Capped at 10 (doubled
 * from 5 so the stronger read-signal isn't immediately clipped against the
 * weaker citation-signal). `src/memory-briefing/wikilink-cache.ts` blends
 * this with similarity score to rank which wikilinks it hands the briefer as
 * a hint — see docs/synthetic-context.md.
 *
 * Decay is two-term, computed lazily on read (no cron/sweep):
 *  - proportional time decay (`TIME_RETENTION_PER_HOUR`), so it never zeroes
 *    a link out purely from being asleep for 8 hours — old linear decay
 *    (flat 1pt/hour) treated "overnight" identically to "a week gone".
 *  - linear step decay (`DECAY_PER_STEP`), against a global counter bumped
 *    once per Briefer invocation — this is what actually kills a link:
 *    querying other topics ages it out, not the clock alone.
 * Both terms are small per unit, so order between them doesn't matter.
 */
import fs from 'fs';

import { WIKILINK_ENDORSEMENTS_PATH } from '../../config.js';
import { registerDeliveryAction } from '../../delivery.js';
import { unguarded } from '../../guard/index.js';
import { log } from '../../log.js';

const CAP = 10;
// Retention per hour of wall-clock time (proportional, never fully zeroes).
// 0.97/hr ≈ 30%/day — an overnight gap dents hotness, doesn't erase it.
const TIME_RETENTION_PER_HOUR = 0.97;
// Linear decay per Briefer invocation (step), the term that actually zeroes
// a link out once other topics have been queried enough times.
const DECAY_PER_STEP = 0.3;
export const CITED_WEIGHT = 1;
export const READ_WEIGHT = 2;

interface EndorsementEntry {
  count: number;
  lastUpdatedAt: string;
  lastUpdatedStep: number;
}

interface Store {
  _step: number;
  entries: Record<string, EndorsementEntry>;
}

function readStore(): Store {
  try {
    const parsed = JSON.parse(fs.readFileSync(WIKILINK_ENDORSEMENTS_PATH, 'utf-8'));
    if (!parsed || typeof parsed !== 'object') return { _step: 0, entries: {} };
    if ('entries' in parsed) return parsed as Store;
    // Migrate old flat-map store (target -> {count, lastUpdatedAt}, no _step
    // wrapper) — reading it as empty would silently discard live hotness
    // data accumulated before this format changed.
    const entries: Record<string, EndorsementEntry> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, { count: number; lastUpdatedAt: string }>)) {
      entries[key] = { count: value.count, lastUpdatedAt: value.lastUpdatedAt, lastUpdatedStep: 0 };
    }
    return { _step: 0, entries };
  } catch {
    return { _step: 0, entries: {} };
  }
}

function writeStore(store: Store): void {
  fs.mkdirSync(WIKILINK_ENDORSEMENTS_PATH.replace(/\/[^/]+$/, ''), { recursive: true });
  fs.writeFileSync(WIKILINK_ENDORSEMENTS_PATH, JSON.stringify(store, null, 2));
}

export function decayedCount(entry: EndorsementEntry, now: number, currentStep: number): number {
  const elapsedHours = (now - new Date(entry.lastUpdatedAt).getTime()) / (60 * 60 * 1000);
  const afterTime = entry.count * Math.pow(TIME_RETENTION_PER_HOUR, Math.max(0, elapsedHours));
  const elapsedSteps = Math.max(0, currentStep - entry.lastUpdatedStep);
  return Math.max(0, afterTime - elapsedSteps * DECAY_PER_STEP);
}

/** Read-only — never persists, so concurrent ranking reads can't race a write. */
export function getEffectiveEndorsement(target: string): number {
  const store = readStore();
  const entry = store.entries[target.toLowerCase()];
  if (!entry) return 0;
  return decayedCount(entry, Date.now(), store._step);
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
  const existing = store.entries[key];
  const current = existing ? decayedCount(existing, now, store._step) : 0;
  store.entries[key] = {
    count: Math.min(CAP, current + weight),
    lastUpdatedAt: new Date(now).toISOString(),
    lastUpdatedStep: store._step,
  };
  writeStore(store);
}

/**
 * Advances the global step counter by one. Call once per Briefer invocation
 * (see `wikilink-cache.ts`) — this is the "clock" the linear decay term
 * measures against, so it only ticks when a briefing actually happens, not
 * on unrelated activity.
 */
export function advanceStep(): void {
  const store = readStore();
  store._step += 1;
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
