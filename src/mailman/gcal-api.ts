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

async function pollOnce(config: GcalFeedConfig): Promise<void> {
  const ctx = await getProxyContext(config.agentId);
  if (!ctx) return;

  try {
    const now = new Date();
    const timeMin = new Date(now.getTime() - config.maxPastDays * 86400_000).toISOString();
    const timeMax = new Date(now.getTime() + config.maxFutureDays * 86400_000).toISOString();
    // updatedMin: only events changed since last poll (minus buffer)
    const updatedMin = new Date(now.getTime() - config.pollIntervalS * 2000).toISOString();

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

export function startGcalFeed(config: GcalFeedConfig): { stop: () => void } {
  let running = true;

  getProxyContext(config.agentId).then((ctx) => {
    if (!ctx) {
      log.info('GCal feed not starting — OneCLI not configured', { feed: config.feedName, agentId: config.agentId });
      return;
    }
    ctx.dispatcher.close();

    log.info('GCal feed started', {
      feed: config.feedName,
      pollIntervalS: config.pollIntervalS,
      calendarId: config.calendarId,
    });

    pollOnce(config).catch((err) => log.error('Initial GCal poll failed', { feed: config.feedName, err }));

    const timer = setInterval(() => {
      if (running) pollOnce(config).catch((err) => log.error('GCal poll failed', { feed: config.feedName, err }));
    }, config.pollIntervalS * 1000);

    handle.stop = () => {
      running = false;
      clearInterval(timer);
      log.info('GCal feed stopped', { feed: config.feedName });
    };
  });

  const handle = {
    stop: () => {
      running = false;
    },
  };
  return handle;
}
