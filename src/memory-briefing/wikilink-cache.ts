/**
 * Wikilink cache: shortcuts Briefer's search by remembering which wikilinks
 * answered similar past queries. No new embedding infra — reuses `memsearch`
 * (already indexes/searches markdown for the container's own memory system)
 * against a dedicated vault folder of small cache notes, one per Briefer
 * invocation.
 *
 * On the way out: search the cache for a similar past query; if found, hand
 * Briefer those links as a first-tier hint (not a bypass — Briefer still
 * verifies, same "narrows focus, isn't ground truth" stance as
 * working-memory.md).
 * On the way back: scrape `[[...]]` wikilinks from the briefing response and
 * file a new cache note.
 */
import { randomUUID } from 'crypto';
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

import { BRIEFING_LOG_DIR, TIMEZONE } from '../config.js';
import { log } from '../log.js';
import {
  bumpEndorsement,
  CITED_WEIGHT,
  getEffectiveEndorsement,
} from '../modules/synthetic-context/wikilink-endorsements.js';
import { formatLocalStamp } from '../timezone.js';
import {
  buildBrieferPrompt,
  runBriefer,
  type BrieferOverrides,
  type BrieferResult,
  type LiteralTurn,
} from './briefer.js';

const CACHE_SUBDIR = 'Meta/wikilink-cache';
const MEMSEARCH_BIN = process.env.MEMSEARCH_BIN || 'memsearch';
const MEMSEARCH_TIMEOUT_MS = 15_000;

function cacheDir(vaultPath: string): string {
  return path.join(vaultPath, CACHE_SUBDIR);
}

// memsearch has no --vault flag — it resolves the target vault from the
// spawned process's own cwd, so this must always run with cwd set to the
// vault, never inherited from the host daemon's own cwd (the nanoclaw
// project root, which memsearch would otherwise silently treat as "no vault
// index found" — no error, just an empty/wrong result set).
function runMemsearch(args: string[], vaultPath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn(MEMSEARCH_BIN, args, { cwd: vaultPath, stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout: Buffer[] = [];
    const stderr: string[] = [];
    const timer = setTimeout(() => {
      proc.kill('SIGTERM');
      reject(new Error(`memsearch timed out after ${MEMSEARCH_TIMEOUT_MS}ms`));
    }, MEMSEARCH_TIMEOUT_MS);
    proc.stdout.on('data', (c: Buffer) => stdout.push(c));
    proc.stderr.on('data', (c: Buffer) => stderr.push(c.toString()));
    proc.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`memsearch exited ${code}: ${stderr.join('')}`));
        return;
      }
      resolve(Buffer.concat(stdout).toString('utf-8'));
    });
  });
}

/** Extracts `[[Target]]` / `[[Target|alias]]` / `[[Target#Heading]]` wikilinks, deduped, in order of first appearance. */
export function extractWikilinks(markdown: string): string[] {
  const seen = new Set<string>();
  const links: string[] = [];
  const re = /\[\[([^\]]+)\]\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(markdown)) !== null) {
    const raw = `[[${m[1]}]]`;
    if (!seen.has(raw)) {
      seen.add(raw);
      links.push(raw);
    }
  }
  return links;
}

interface CacheHit {
  query: string;
  links: string[];
  hotness: Record<string, number>; // normalized target -> effective endorsement at hit time
}

/**
 * Strips a `[[...]]`/alias/heading/`.md` wikilink down to the same lowercase
 * key `load_obsidian_wikilink` endorses under (see
 * container/agent-runner/src/mcp-tools/obsidian.ts `endorseWikilink`), so a
 * link scraped from a past briefing can be looked up against the store.
 */
function normalizeWikilinkTarget(raw: string): string {
  let target = raw.trim();
  if (target.startsWith('[[') && target.endsWith(']]')) target = target.slice(2, -2);
  const pipeIdx = target.indexOf('|');
  if (pipeIdx !== -1) target = target.slice(0, pipeIdx);
  target = target.trim();
  const hashIdx = target.indexOf('#');
  if (hashIdx !== -1) target = target.slice(0, hashIdx).trim();
  if (target.toLowerCase().endsWith('.md')) target = target.slice(0, -3);
  return target.toLowerCase();
}

// Endorsement (0-5, decaying) contributes up to this many similarity-score
// points — enough to visibly reorder near-tied results, not enough to bury
// a highly-relevant unendorsed link under a stale, frequently-followed one.
const ENDORSEMENT_WEIGHT = 0.1;

const MAX_CACHE_LINKS = 6;

/**
 * Caps a ranked link list at `MAX_CACHE_LINKS`, filling by hotness bucket
 * (highest first). A bucket that would overflow the limit is shuffled so the
 * links kept from it are random, not an artifact of scrape order.
 */
function selectByHotness(
  ranked: { link: string; hotness: number }[],
  limit = MAX_CACHE_LINKS,
): { link: string; hotness: number }[] {
  const buckets = new Map<number, { link: string; hotness: number }[]>();
  for (const r of ranked) {
    const bucket = buckets.get(r.hotness);
    if (bucket) bucket.push(r);
    else buckets.set(r.hotness, [r]);
  }
  const levels = [...buckets.keys()].sort((a, b) => b - a);
  const result: { link: string; hotness: number }[] = [];
  for (const level of levels) {
    const bucket = buckets.get(level)!;
    const remaining = limit - result.length;
    if (remaining <= 0) break;
    if (bucket.length <= remaining) {
      result.push(...bucket);
    } else {
      const shuffled = [...bucket];
      for (let i = shuffled.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
      }
      result.push(...shuffled.slice(0, remaining));
    }
  }
  return result;
}

/**
 * Best-effort — a cache-lookup failure should never block a real Briefer
 * call, just skip the hint. Pools links across the top-k similar past
 * queries (not just the single best match) and ranks them by similarity
 * score plus endorsement weight, so a note Lumen keeps following via
 * `load_obsidian_wikilink` surfaces more prominently even from a slightly
 * less similar past query.
 */
async function lookupCache(vaultPath: string, query: string): Promise<CacheHit | null> {
  const dir = cacheDir(vaultPath);
  if (!fs.existsSync(dir)) return null;
  try {
    const out = await runMemsearch(['search', query, '-k', '3', '--source-prefix', CACHE_SUBDIR, '-j'], vaultPath);
    const parsed = JSON.parse(out) as Array<{ path?: string; text?: string; content?: string; score?: number }>;
    if (!Array.isArray(parsed) || parsed.length === 0) return null;

    const ranked = new Map<string, { link: string; score: number; hotness: number }>();
    for (const note of parsed) {
      const text = note.text || note.content || '';
      const similarity = note.score ?? 0;
      for (const link of extractWikilinks(text)) {
        const key = normalizeWikilinkTarget(link);
        const hotness = getEffectiveEndorsement(key);
        const combined = similarity + ENDORSEMENT_WEIGHT * hotness;
        const existing = ranked.get(key);
        if (!existing || combined > existing.score) ranked.set(key, { link, score: combined, hotness });
      }
    }
    if (ranked.size === 0) return null;

    const sorted = [...ranked.values()].sort((a, b) => b.score - a.score);
    const capped = new Set(selectByHotness(sorted).map((r) => r.link));
    const links = sorted.filter((r) => capped.has(r.link)).map((r) => r.link);
    const hotness = Object.fromEntries(sorted.map((r) => [r.link, Math.round(r.hotness * 100) / 100]));
    return { query, links, hotness };
  } catch (err) {
    log.debug('wikilink cache lookup failed, skipping hint', { err });
    return null;
  }
}

/** Best-effort — a cache-write failure should never surface as a Briefer failure. */
async function writeCacheEntry(vaultPath: string, query: string, links: string[]): Promise<void> {
  if (links.length === 0) return;
  const dir = cacheDir(vaultPath);
  try {
    fs.mkdirSync(dir, { recursive: true });
    const id = randomUUID();
    const frontmatter = [
      '---',
      `query: ${JSON.stringify(query.slice(0, 200))}`,
      `timestamp: ${new Date().toISOString()}`,
      '---',
      '',
    ].join('\n');
    const body = links.map((l) => `- ${l}`).join('\n') + '\n';
    fs.writeFileSync(path.join(dir, `${id}.md`), frontmatter + body);
    await runMemsearch(['index', dir], vaultPath);
  } catch (err) {
    log.warn('wikilink cache write failed (non-fatal)', { err });
  }
}

interface TimingInfo {
  lookupMs: number;
  briefingMs: number;
  totalMs: number;
  promptChars: number;
}

/** One file per active clock hour (local time) — never created for hours with no briefing. */
function appendBriefingLog(
  query: string,
  hit: CacheHit | null,
  result: BrieferResult,
  timing: TimingInfo,
  workingMemory: string | null,
): void {
  try {
    fs.mkdirSync(BRIEFING_LOG_DIR, { recursive: true });
    const stamp = formatLocalStamp(new Date(), TIMEZONE); // "YYYY-MM-DD HH:mm"
    const hourFile = path.join(BRIEFING_LOG_DIR, `${stamp.slice(0, 10)}-${stamp.slice(11, 13)}.md`);
    const hitLine = hit
      ? `**Wikilink cache hit:** ${hit.links.map((l) => `${l} (hotness ${hit.hotness[l]})`).join(', ')}`
      : '**Wikilink cache:** miss';
    const fullReads = result.toolCalls.filter((t) => t.tool === 'Read' && t.detail.endsWith('(full file)')).length;
    const toolCallLines = result.toolCalls.length
      ? [
          `**Tool calls (${result.toolCalls.length}, ${fullReads} full-file read${fullReads === 1 ? '' : 's'}):**`,
          '',
          ...result.toolCalls.map((t) => `- \`${t.tool}\` ${t.detail} _(+${t.iterationMs}ms)_`),
          '',
        ]
      : ['**Tool calls:** none recorded', ''];
    const entry = [
      `## ${stamp}`,
      '',
      hitLine,
      `**Timing:** lookup ${timing.lookupMs}ms, briefing ${timing.briefingMs}ms, total ${timing.totalMs}ms`,
      `**Prompt length:** ${timing.promptChars} chars`,
      '',
      ...toolCallLines,
      `**Query:** ${query.slice(0, 300)}`,
      '',
      '**working-memory.md:**',
      '',
      workingMemory ?? '(none)',
      '',
      '**Briefing:**',
      '',
      result.briefing,
      '',
      '---',
      '',
    ].join('\n');
    fs.appendFileSync(hourFile, entry);
  } catch (err) {
    log.warn('briefing log write failed (non-fatal)', { err });
  }
}

/**
 * Runs Briefer with the wikilink-cache shortcut: checks the cache first and
 * folds a hit into the prompt as a hint, then scrapes and files whatever
 * wikilinks the real response cites. `vaultPath` is required (not read from
 * env here) since callers already resolve it for other reasons.
 */
export async function runBrieferWithWikilinkCache(
  vaultPath: string,
  recentTurns: LiteralTurn[],
  newMessage: string,
  overrides?: BrieferOverrides,
  workingMemoryPath?: string,
  previousBriefing?: string,
): Promise<BrieferResult> {
  const totalStart = Date.now();
  const lookupStart = Date.now();
  const hit = await lookupCache(vaultPath, newMessage);
  const lookupMs = Date.now() - lookupStart;
  if (hit) log.info('wikilink cache hit, folding into prompt', { query: newMessage.slice(0, 80), links: hit.links });
  const hotnessSortedLinks = hit ? [...hit.links].sort((a, b) => hit.hotness[b] - hit.hotness[a]) : [];
  const workingMemory =
    workingMemoryPath && fs.existsSync(workingMemoryPath) ? fs.readFileSync(workingMemoryPath, 'utf-8') : null;
  const basePrompt = buildBrieferPrompt(recentTurns, newMessage, previousBriefing, workingMemory ?? undefined);
  const prompt = hit
    ? `${basePrompt}\n\n## Cached hint (unverified — a similar past query cited these; check, don't assume)\n\n${hotnessSortedLinks.join('\n')}\n`
    : basePrompt;

  const briefingStart = Date.now();
  const result = await runBriefer(prompt, overrides);
  const briefingMs = Date.now() - briefingStart;

  const links = extractWikilinks(result.briefing);
  await writeCacheEntry(vaultPath, newMessage, links);
  // Citing a link in the briefing is a weaker endorsement than Lumen actually
  // following it (load_obsidian_wikilink), but still a real relevance signal
  // — same capped/decaying counter, same ranking pool.
  for (const link of links) bumpEndorsement(normalizeWikilinkTarget(link), CITED_WEIGHT);

  const totalMs = Date.now() - totalStart;
  appendBriefingLog(
    newMessage,
    hit,
    result,
    { lookupMs, briefingMs, totalMs, promptChars: prompt.length },
    workingMemory,
  );
  return result;
}
