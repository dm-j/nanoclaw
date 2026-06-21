import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import RssParser from 'rss-parser';

import { log } from '../log.js';
import { writeToMaildir } from './maildir.js';

export interface RssFeedConfig {
  feedName: string;
  url: string;
  pollIntervalS: number;
  fetchContent: boolean;
  maxItems: number;
}

const STATE_DIR = path.resolve(import.meta.dirname, '../../mailman/state');

function seenPath(feedName: string): string {
  return path.join(STATE_DIR, `rss-seen-${feedName}.json`);
}

function loadSeen(feedName: string): Set<string> {
  try {
    return new Set(JSON.parse(fs.readFileSync(seenPath(feedName), 'utf-8')));
  } catch {
    return new Set();
  }
}

function saveSeen(feedName: string, seen: Set<string>): void {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  // ponytail: cap at 2000 entries to prevent unbounded growth. Drop oldest.
  const arr = [...seen];
  const capped = arr.length > 2000 ? arr.slice(-2000) : arr;
  fs.writeFileSync(seenPath(feedName), JSON.stringify(capped));
}

function itemKey(item: RssParser.Item): string {
  return (
    item.guid ||
    item.link ||
    crypto
      .createHash('sha256')
      .update(item.title || '')
      .digest('hex')
      .slice(0, 16)
  );
}

// ponytail: regex strip, not a DOM parser. Good enough for triage context.
function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#\d+;/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

const MAX_CONTENT_CHARS = 8000;

async function fetchArticleText(url: string): Promise<string> {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'NanoClaw-Mailman/1.0 (feed reader)' },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return `[fetch failed: ${res.status}]`;
    const html = await res.text();
    const text = stripHtml(html);
    if (text.length > MAX_CONTENT_CHARS) {
      return text.slice(0, MAX_CONTENT_CHARS) + '\n[truncated]';
    }
    return text;
  } catch (err) {
    return `[fetch failed: ${(err as Error).message}]`;
  }
}

async function pollOnce(config: RssFeedConfig): Promise<void> {
  const parser = new RssParser();
  let feed: RssParser.Output<Record<string, unknown>>;

  try {
    feed = await parser.parseURL(config.url);
  } catch (err) {
    log.error('RSS fetch failed', { feed: config.feedName, err });
    return;
  }

  const seen = loadSeen(config.feedName);
  const items = (feed.items || []).slice(0, config.maxItems);
  let newCount = 0;

  for (const item of items) {
    const key = itemKey(item);
    if (seen.has(key)) continue;

    let content = '';
    if (config.fetchContent && item.link) {
      content = await fetchArticleText(item.link);
    } else {
      content = stripHtml(item.contentSnippet || item.content || item.summary || '');
      if (content.length > MAX_CONTENT_CHARS) {
        content = content.slice(0, MAX_CONTENT_CHARS) + '\n[truncated]';
      }
    }

    const body = [
      `New item from RSS feed (feed: ${config.feedName}, type: rss):`,
      `Title: ${item.title || '(no title)'}`,
      item.creator ? `Author: ${item.creator}` : null,
      item.link ? `Link: ${item.link}` : null,
      item.pubDate ? `Published: ${item.pubDate}` : null,
      feed.title ? `Feed: ${feed.title}` : null,
      '',
      content,
    ]
      .filter((l) => l !== null)
      .join('\n');

    writeToMaildir(body, {
      'X-Mailman-Source': config.feedName,
      'X-Mailman-Trust': 'rss',
      Subject: item.title || '(no title)',
      From: item.creator || feed.title || 'rss',
      Date: item.pubDate ? new Date(item.pubDate).toUTCString() : new Date().toUTCString(),
      'X-RSS-Link': item.link || '',
      'X-RSS-Feed': feed.title || config.url,
    });

    seen.add(key);
    newCount++;
  }

  if (newCount > 0) {
    saveSeen(config.feedName, seen);
    log.info('RSS items delivered', { feed: config.feedName, count: newCount });
  }
}

export function startRssFeed(config: RssFeedConfig): { stop: () => void } {
  let running = true;

  log.info('RSS feed started', {
    feed: config.feedName,
    pollIntervalS: config.pollIntervalS,
    fetchContent: config.fetchContent,
  });

  pollOnce(config).catch((err) => log.error('Initial RSS poll failed', { feed: config.feedName, err }));

  const timer = setInterval(() => {
    if (running) pollOnce(config).catch((err) => log.error('RSS poll failed', { feed: config.feedName, err }));
  }, config.pollIntervalS * 1000);

  return {
    stop: () => {
      running = false;
      clearInterval(timer);
      log.info('RSS feed stopped', { feed: config.feedName });
    },
  };
}
