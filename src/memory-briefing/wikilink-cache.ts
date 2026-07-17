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

import { log } from '../log.js';
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

function runMemsearch(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn(MEMSEARCH_BIN, args, { stdio: ['ignore', 'pipe', 'pipe'] });
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
}

/** Best-effort — a cache-lookup failure should never block a real Briefer call, just skip the hint. */
async function lookupCache(vaultPath: string, query: string): Promise<CacheHit | null> {
  const dir = cacheDir(vaultPath);
  if (!fs.existsSync(dir)) return null;
  try {
    const out = await runMemsearch(['search', query, '-k', '3', '--source-prefix', CACHE_SUBDIR, '-j']);
    const parsed = JSON.parse(out) as Array<{ path?: string; text?: string; content?: string }>;
    if (!Array.isArray(parsed) || parsed.length === 0) return null;
    const top = parsed[0];
    const text = top.text || top.content || '';
    const links = extractWikilinks(text);
    if (links.length === 0) return null;
    return { query, links };
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
    await runMemsearch(['index', dir]);
  } catch (err) {
    log.warn('wikilink cache write failed (non-fatal)', { err });
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
): Promise<BrieferResult> {
  const hit = await lookupCache(vaultPath, newMessage);
  const prompt = hit
    ? `${buildBrieferPrompt(recentTurns, newMessage)}\n\n## Cached hint (unverified — a similar past query cited these; check, don't assume)\n\n${hit.links.join(', ')}`
    : buildBrieferPrompt(recentTurns, newMessage);

  const result = await runBriefer(prompt, overrides);
  const links = extractWikilinks(result.briefing);
  await writeCacheEntry(vaultPath, newMessage, links);
  return result;
}
