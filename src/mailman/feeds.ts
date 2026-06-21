import fs from 'fs';
import path from 'path';

import { log } from '../log.js';
import { startGcalFeed, type GcalFeedConfig } from './gcal-api.js';
import { startGmailFeed, type GmailFeedConfig } from './gmail-api.js';
import { startIcsFeed, type IcsFeedConfig } from './ics-feed.js';
import { startRssFeed, type RssFeedConfig } from './rss-feed.js';

const PROJECT_ROOT = path.resolve(import.meta.dirname, '../..');
const FEEDS_DIR = path.join(PROJECT_ROOT, 'mailman/feeds');

interface FeedJson {
  type: string;
  agent_id: string;
  poll_interval_s?: number;
  max_age_days?: number;
  query?: string;
  calendar_id?: string;
  max_future_days?: number;
  max_past_days?: number;
  url?: string;
  fetch_content?: boolean;
  max_items?: number;
}

type FeedHandler = (feedName: string, config: FeedJson) => { stop: () => void };

// ponytail: map, not an interface+registry. Add handlers here when new feed types land.
const handlers: Record<string, FeedHandler> = {
  gmail: (feedName, config) => {
    const gmailConfig: GmailFeedConfig = {
      feedName,
      agentId: config.agent_id,
      pollIntervalS: config.poll_interval_s ?? 1200,
      maxAgeDays: config.max_age_days ?? 3,
      query: config.query ?? 'is:unread category:primary',
    };
    return startGmailFeed(gmailConfig);
  },
  gcal: (feedName, config) => {
    const gcalConfig: GcalFeedConfig = {
      feedName,
      agentId: config.agent_id,
      pollIntervalS: config.poll_interval_s ?? 300,
      calendarId: config.calendar_id ?? 'primary',
      maxFutureDays: config.max_future_days ?? 30,
      maxPastDays: config.max_past_days ?? 1,
    };
    return startGcalFeed(gcalConfig);
  },
  ics: (feedName, config) => {
    if (!config.url) throw new Error(`ICS feed "${feedName}" missing required "url" field`);
    const icsConfig: IcsFeedConfig = {
      feedName,
      url: config.url,
      pollIntervalS: config.poll_interval_s ?? 300,
      maxPastDays: config.max_past_days ?? 1,
    };
    return startIcsFeed(icsConfig);
  },
  rss: (feedName, config) => {
    if (!config.url) throw new Error(`RSS feed "${feedName}" missing required "url" field`);
    const rssConfig: RssFeedConfig = {
      feedName,
      url: config.url,
      pollIntervalS: config.poll_interval_s ?? 1800,
      fetchContent: config.fetch_content ?? true,
      maxItems: config.max_items ?? 10,
    };
    return startRssFeed(rssConfig);
  },
};

const activeFeeds: Array<{ name: string; stop: () => void }> = [];

export function startFeeds(): void {
  if (!fs.existsSync(FEEDS_DIR)) {
    log.info('No mailman/feeds/ directory — no feeds to start');
    return;
  }

  const dirs = fs.readdirSync(FEEDS_DIR, { withFileTypes: true }).filter((d) => d.isDirectory());

  for (const dir of dirs) {
    const configPath = path.join(FEEDS_DIR, dir.name, 'feed.json');
    if (!fs.existsSync(configPath)) continue;

    let config: FeedJson;
    try {
      config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    } catch (err) {
      log.error('Invalid feed.json', { feed: dir.name, err });
      continue;
    }

    const handler = handlers[config.type];
    if (!handler) {
      log.warn(`Unknown feed type "${config.type}" — skipping`, { feed: dir.name });
      continue;
    }

    try {
      const handle = handler(dir.name, config);
      activeFeeds.push({ name: dir.name, stop: handle.stop });
    } catch (err) {
      log.error('Failed to start feed', { feed: dir.name, err });
    }
  }

  log.info('Mailman feeds started', { count: activeFeeds.length, feeds: activeFeeds.map((f) => f.name) });
}

export function stopFeeds(): void {
  for (const feed of activeFeeds) {
    try {
      feed.stop();
    } catch (err) {
      log.error('Failed to stop feed', { feed: feed.name, err });
    }
  }
  activeFeeds.length = 0;
  log.info('Mailman feeds stopped');
}
