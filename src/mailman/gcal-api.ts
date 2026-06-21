import fs from 'fs';
import os from 'os';
import path from 'path';
import { ProxyAgent, fetch as undiciFetch } from 'undici';

import { log } from '../log.js';
import { writeToMaildir } from './maildir.js';

const ONECLI_LOCAL_URL = 'http://127.0.0.1:10254';
const GCAL_API = 'https://www.googleapis.com/calendar/v3';

export interface GcalFeedConfig {
  feedName: string;
  agentId: string;
  pollIntervalS: number;
  calendarId: string;
  maxFutureDays: number;
  maxPastDays: number;
}

interface ProxyContext {
  dispatcher: ProxyAgent;
}

async function getProxyContext(agentId: string): Promise<ProxyContext | null> {
  const url = `${ONECLI_LOCAL_URL}/api/container-config?agent=${encodeURIComponent(agentId)}`;
  let res: Response;
  try {
    res = await fetch(url);
  } catch {
    log.warn('OneCLI not reachable — gcal ingress skipping this cycle', { agentId });
    return null;
  }

  if (!res.ok) {
    const body = await res.text();
    log.error('OneCLI container-config failed', { agentId, status: res.status, body });
    return null;
  }

  const config = (await res.json()) as {
    env: Record<string, string>;
    caCertificate: string;
    caCertificateContainerPath: string;
  };
  const proxyUrl = config.env.HTTPS_PROXY || config.env.https_proxy;
  if (!proxyUrl) {
    log.error('OneCLI config has no HTTPS_PROXY', { agentId });
    return null;
  }

  const caPath = path.join(os.tmpdir(), `onecli-gcal-${agentId}-ca.pem`);
  fs.writeFileSync(caPath, config.caCertificate);
  const ca = fs.readFileSync(caPath);

  return { dispatcher: new ProxyAgent({ uri: proxyUrl, connect: { ca } }) };
}

interface CalendarEvent {
  id: string;
  summary?: string;
  description?: string;
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
  status?: string;
  organizer?: { email?: string; displayName?: string };
  attendees?: Array<{ email?: string; displayName?: string; responseStatus?: string }>;
  location?: string;
  updated?: string;
  htmlLink?: string;
}

// ponytail: track seen event update timestamps in a flat file, not a DB
const STATE_DIR = path.resolve(import.meta.dirname, '../../mailman/state');

function getSeenUpdates(feedName: string): Map<string, string> {
  const statePath = path.join(STATE_DIR, `gcal-seen-${feedName}.json`);
  try {
    const data = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
    return new Map(Object.entries(data));
  } catch {
    return new Map();
  }
}

function saveSeenUpdates(feedName: string, seen: Map<string, string>): void {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  const statePath = path.join(STATE_DIR, `gcal-seen-${feedName}.json`);
  fs.writeFileSync(statePath, JSON.stringify(Object.fromEntries(seen)));
}

function formatEventAsMessage(event: CalendarEvent, changeType: string, feedName: string): string {
  const start = event.start?.dateTime || event.start?.date || 'unknown';
  const end = event.end?.dateTime || event.end?.date || '';
  const organizer = event.organizer?.displayName || event.organizer?.email || 'unknown';
  const attendees = (event.attendees || [])
    .map((a) => `${a.displayName || a.email || '?'} (${a.responseStatus || '?'})`)
    .join(', ');

  const lines = [
    `Calendar event ${changeType} (feed: ${feedName}, type: gcal):`,
    `Event: ${event.summary || '(no title)'}`,
    `When: ${start}${end ? ' → ' + end : ''}`,
    `Organizer: ${organizer}`,
  ];

  if (attendees) lines.push(`Attendees: ${attendees}`);
  if (event.location) lines.push(`Location: ${event.location}`);
  if (event.status === 'cancelled') lines.push('Status: CANCELLED');
  if (event.description) lines.push(`\nDescription:\n${event.description.slice(0, 500)}`);

  return lines.join('\n');
}

interface PollWindow {
  futureMs: number;
  updatedWithinMs: number;
}

async function pollOnce(config: GcalFeedConfig, window: PollWindow): Promise<void> {
  const ctx = await getProxyContext(config.agentId);
  if (!ctx) return;

  try {
    const now = new Date();
    const timeMin = new Date(now.getTime() - config.maxPastDays * 86400_000).toISOString();
    const timeMax = new Date(now.getTime() + window.futureMs).toISOString();
    const updatedMin = new Date(now.getTime() - window.updatedWithinMs).toISOString();

    const params = new URLSearchParams({
      timeMin,
      timeMax,
      updatedMin,
      singleEvents: 'true',
      orderBy: 'updated',
      maxResults: '20',
    });

    const url = `${GCAL_API}/calendars/${encodeURIComponent(config.calendarId)}/events?${params}`;
    const res = (await undiciFetch(url, { dispatcher: ctx.dispatcher })) as unknown as Response;

    if (!res.ok) {
      const body = await res.text();
      log.error('GCal events list failed', { feed: config.feedName, status: res.status, body: body.slice(0, 300) });
      return;
    }

    const data = (await res.json()) as { items?: CalendarEvent[] };
    if (!data.items?.length) return;

    const seen = getSeenUpdates(config.feedName);
    let newCount = 0;

    for (const event of data.items) {
      if (!event.id || !event.updated) continue;
      // Skip if we've already seen this exact update timestamp
      if (seen.get(event.id) === event.updated) continue;

      const changeType = event.status === 'cancelled' ? 'cancelled' : seen.has(event.id) ? 'updated' : 'new';

      const body = formatEventAsMessage(event, changeType, config.feedName);
      const subject = `Calendar: ${event.summary || '(no title)'} — ${changeType}`;

      writeToMaildir(body, {
        'X-Mailman-Source': config.feedName,
        'X-Mailman-Trust': 'gcal-api',
        'X-Verified-From': event.organizer?.email || 'calendar',
        Subject: subject,
        From: event.organizer?.email || 'calendar@google.com',
        Date: new Date(event.updated).toUTCString(),
        'X-Calendar-Event-Id': event.id,
        'X-Calendar-Event-Status': event.status || 'confirmed',
      });

      seen.set(event.id, event.updated);
      newCount++;
    }

    if (newCount > 0) {
      saveSeenUpdates(config.feedName, seen);
      log.info('GCal changes delivered', { feed: config.feedName, count: newCount });
    }
  } catch (err) {
    log.error('GCal poll failed', { feed: config.feedName, err });
  } finally {
    ctx.dispatcher.close();
  }
}

// Tiered polling: check nearby events frequently, distant events less often.
// All offsets -2min from clock boundaries to catch last-minute changes.
const HOUR_MS = 3600_000;
const DAY_MS = 86400_000;
const OFFSET_MS = -2 * 60_000;

interface PollTier {
  intervalMs: number;
  window: PollWindow;
  label: string;
}

const TIERS: PollTier[] = [
  { intervalMs: 5 * 60_000, window: { futureMs: HOUR_MS, updatedWithinMs: 10 * 60_000 }, label: '5min/1h' },
  { intervalMs: 15 * 60_000, window: { futureMs: DAY_MS, updatedWithinMs: 30 * 60_000 }, label: '15min/24h' },
  { intervalMs: HOUR_MS, window: { futureMs: 7 * DAY_MS, updatedWithinMs: 2 * HOUR_MS }, label: '1h/7d' },
  { intervalMs: DAY_MS, window: { futureMs: 14 * DAY_MS, updatedWithinMs: 2 * DAY_MS }, label: '24h/14d' },
];

function scheduleAligned(
  intervalMs: number,
  fn: () => void,
): { timer: ReturnType<typeof setTimeout>; clear: () => void } {
  const now = Date.now();
  const nextSlot = Math.ceil((now - OFFSET_MS) / intervalMs) * intervalMs + OFFSET_MS;
  const initialDelay = Math.max(nextSlot - now, 0);

  let interval: ReturnType<typeof setInterval> | null = null;
  const startup = setTimeout(() => {
    fn();
    interval = setInterval(fn, intervalMs);
  }, initialDelay);

  return {
    timer: startup,
    clear: () => {
      clearTimeout(startup);
      if (interval) clearInterval(interval);
    },
  };
}

export function startGcalFeed(config: GcalFeedConfig): { stop: () => void } {
  let running = true;
  const cleanups: Array<() => void> = [];

  getProxyContext(config.agentId).then((ctx) => {
    if (!ctx) {
      log.info('GCal feed not starting — OneCLI not configured', { feed: config.feedName, agentId: config.agentId });
      return;
    }
    ctx.dispatcher.close();

    log.info('GCal feed started (tiered polling)', {
      feed: config.feedName,
      calendarId: config.calendarId,
      tiers: TIERS.map((t) => t.label),
    });

    for (const tier of TIERS) {
      const scheduled = scheduleAligned(tier.intervalMs, () => {
        if (!running) return;
        pollOnce(config, tier.window).catch((err) =>
          log.error('GCal poll failed', { feed: config.feedName, tier: tier.label, err }),
        );
      });
      cleanups.push(scheduled.clear);
    }

    handle.stop = () => {
      running = false;
      for (const cleanup of cleanups) cleanup();
      log.info('GCal feed stopped', { feed: config.feedName });
    };
  });

  const handle = {
    stop: () => {
      running = false;
      for (const cleanup of cleanups) cleanup();
    },
  };
  return handle;
}
