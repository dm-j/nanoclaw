import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import * as ical from 'node-ical';

import { log } from '../log.js';
import { writeToMaildir } from './maildir.js';

export interface IcsFeedConfig {
  feedName: string;
  url: string;
  pollIntervalS: number;
  maxPastDays: number;
}

const STATE_DIR = path.resolve(import.meta.dirname, '../../mailman/state');
const HOUR_MS = 3600_000;
const DAY_MS = 86400_000;
const OFFSET_MS = -2 * 60_000;

interface EventSnapshot {
  uid: string;
  startIso: string;
  hash: string;
  summary: string;
}

type SnapshotMap = Record<string, EventSnapshot>; // key: uid+startIso

function snapshotPath(feedName: string): string {
  return path.join(STATE_DIR, `ics-snapshot-${feedName}.json`);
}

function loadSnapshot(feedName: string): SnapshotMap {
  try {
    return JSON.parse(fs.readFileSync(snapshotPath(feedName), 'utf-8'));
  } catch {
    return {};
  }
}

function saveSnapshot(feedName: string, snap: SnapshotMap): void {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.writeFileSync(snapshotPath(feedName), JSON.stringify(snap));
}

function hashEvent(e: ical.EventInstance): string {
  const parts = [
    String(e.summary ?? ''),
    e.start?.toISOString() ?? '',
    e.end?.toISOString() ?? '',
    String(e.event.location ?? ''),
    e.event.status ?? '',
    e.event.attendee ? JSON.stringify(e.event.attendee) : '',
  ];
  return crypto.createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 16);
}

function eventKey(uid: string, startIso: string): string {
  return `${uid}@${startIso}`;
}

function formatEventMessage(e: ical.EventInstance, changeType: string, feedName: string): string {
  const ev = e.event;
  const lines = [
    `Calendar event ${changeType} (feed: ${feedName}, type: ics):`,
    `Event: ${e.summary ?? '(no title)'}`,
    `When: ${e.start?.toISOString() ?? 'unknown'}${e.end ? ' → ' + e.end.toISOString() : ''}`,
  ];

  if (ev.organizer) {
    const org = typeof ev.organizer === 'string' ? ev.organizer : ((ev.organizer as { val?: string }).val ?? '');
    lines.push(`Organizer: ${org.replace(/^mailto:/i, '')}`);
  }
  if (ev.location) lines.push(`Location: ${String(ev.location)}`);
  if (ev.status === 'CANCELLED') lines.push('Status: CANCELLED');
  if (ev.description) lines.push(`\nDescription:\n${String(ev.description).slice(0, 500)}`);

  return lines.join('\n');
}

function expandEvents(
  cal: ical.CalendarResponse,
  from: Date,
  to: Date,
): Array<{ instance: ical.EventInstance; uid: string }> {
  const results: Array<{ instance: ical.EventInstance; uid: string }> = [];

  for (const comp of Object.values(cal)) {
    if (!comp || comp.type !== 'VEVENT') continue;
    const event = comp as ical.VEvent;

    if (event.rrule) {
      const instances = ical.expandRecurringEvent(event, { from, to });
      for (const inst of instances) {
        results.push({ instance: inst, uid: event.uid });
      }
    } else {
      const start = event.start ? new Date(event.start.toISOString()) : null;
      if (!start || start < from || start > to) continue;
      results.push({
        instance: {
          start: event.start,
          end: event.end ?? event.start,
          summary: event.summary,
          isFullDay: event.datetype === 'date',
          isRecurring: false,
          isOverride: false,
          event,
        },
        uid: event.uid,
      });
    }
  }

  return results;
}

async function fetchIcs(url: string): Promise<ical.CalendarResponse> {
  // ponytail: node-ical has fromURL but it doesn't support custom fetch options well.
  // Plain fetch + parseICS is simpler.
  const res = await fetch(url);
  if (!res.ok) throw new Error(`ICS fetch failed: ${res.status} ${res.statusText}`);
  const body = await res.text();
  return ical.parseICS(body);
}

interface PollWindow {
  futureMs: number;
  emitChanges: boolean; // false for midnight baseline sweep
}

async function pollOnce(config: IcsFeedConfig, window: PollWindow): Promise<void> {
  let cal: ical.CalendarResponse;
  try {
    cal = await fetchIcs(config.url);
  } catch (err) {
    log.error('ICS fetch failed', { feed: config.feedName, err });
    return;
  }

  const now = new Date();
  const from = new Date(now.getTime() - config.maxPastDays * DAY_MS);
  const to = new Date(now.getTime() + window.futureMs);

  const events = expandEvents(cal, from, to);
  const prevSnap = loadSnapshot(config.feedName);
  const newSnap: SnapshotMap = {};

  let emitted = 0;

  for (const { instance, uid } of events) {
    const startIso = instance.start?.toISOString() ?? '';
    const key = eventKey(uid, startIso);
    const hash = hashEvent(instance);
    const summary = String(instance.summary ?? '');

    newSnap[key] = { uid, startIso, hash, summary };

    if (!window.emitChanges) continue;

    const prev = prevSnap[key];
    if (prev && prev.hash === hash) continue; // unchanged

    const changeType = prev ? 'updated' : 'new';

    const body = formatEventMessage(instance, changeType, config.feedName);
    const subject = `Calendar: ${summary || '(no title)'} — ${changeType}`;

    writeToMaildir(body, {
      'X-Mailman-Source': config.feedName,
      'X-Mailman-Trust': 'ics-file',
      Subject: subject,
      From: 'calendar@ics',
      Date: now.toUTCString(),
      'X-Calendar-Event-Id': uid,
    });
    emitted++;
  }

  // Detect removed events (in previous snapshot but not in current)
  if (window.emitChanges) {
    for (const [key, prev] of Object.entries(prevSnap)) {
      if (newSnap[key]) continue;
      // Only emit removal if the event was within our current window
      const prevStart = new Date(prev.startIso);
      if (prevStart < from || prevStart > to) continue;

      const body = `Calendar event cancelled (feed: ${config.feedName}, type: ics):\nEvent: ${prev.summary || '(no title)'}\nWhen: ${prev.startIso}`;
      writeToMaildir(body, {
        'X-Mailman-Source': config.feedName,
        'X-Mailman-Trust': 'ics-file',
        Subject: `Calendar: ${prev.summary || '(no title)'} — cancelled`,
        From: 'calendar@ics',
        Date: now.toUTCString(),
        'X-Calendar-Event-Id': prev.uid,
      });
      emitted++;
    }
  }

  // Merge new snapshot into previous (keep events outside current window)
  const merged = { ...prevSnap };
  // Remove keys in current window range — they'll be replaced by newSnap
  for (const key of Object.keys(merged)) {
    const s = new Date(merged[key].startIso);
    if (s >= from && s <= to) delete merged[key];
  }
  Object.assign(merged, newSnap);
  saveSnapshot(config.feedName, merged);

  if (emitted > 0) {
    log.info('ICS changes delivered', { feed: config.feedName, count: emitted });
  }
}

interface PollTier {
  intervalMs: number;
  window: PollWindow;
  label: string;
}

// Same tiered structure as gcal: frequent near, infrequent far.
// Midnight sweep seeds the full 14-day baseline (emitChanges: false on first run).
const TIERS: PollTier[] = [
  { intervalMs: 5 * 60_000, window: { futureMs: HOUR_MS, emitChanges: true }, label: '5min/1h' },
  { intervalMs: 15 * 60_000, window: { futureMs: DAY_MS, emitChanges: true }, label: '15min/24h' },
  { intervalMs: HOUR_MS, window: { futureMs: 3 * DAY_MS, emitChanges: true }, label: '1h/3d' },
  { intervalMs: DAY_MS, window: { futureMs: 14 * DAY_MS, emitChanges: false }, label: 'midnight/14d baseline' },
];

function scheduleAligned(intervalMs: number, fn: () => void): { clear: () => void } {
  const now = Date.now();
  const nextSlot = Math.ceil((now - OFFSET_MS) / intervalMs) * intervalMs + OFFSET_MS;
  const initialDelay = Math.max(nextSlot - now, 0);

  let interval: ReturnType<typeof setInterval> | null = null;
  const startup = setTimeout(() => {
    fn();
    interval = setInterval(fn, intervalMs);
  }, initialDelay);

  return {
    clear: () => {
      clearTimeout(startup);
      if (interval) clearInterval(interval);
    },
  };
}

export function startIcsFeed(config: IcsFeedConfig): { stop: () => void } {
  let running = true;
  const cleanups: Array<() => void> = [];

  // If no snapshot exists, do an initial baseline sweep before starting tiers
  const snapExists = fs.existsSync(snapshotPath(config.feedName));

  const boot = async () => {
    if (!snapExists) {
      log.info('ICS feed: initial baseline sweep', { feed: config.feedName });
      await pollOnce(config, { futureMs: 14 * DAY_MS, emitChanges: false }).catch((err) =>
        log.error('ICS baseline sweep failed', { feed: config.feedName, err }),
      );
    }

    if (!running) return;

    log.info('ICS feed started (tiered polling)', {
      feed: config.feedName,
      tiers: TIERS.map((t) => t.label),
    });

    for (const tier of TIERS) {
      const scheduled = scheduleAligned(tier.intervalMs, () => {
        if (!running) return;
        pollOnce(config, tier.window).catch((err) =>
          log.error('ICS poll failed', { feed: config.feedName, tier: tier.label, err }),
        );
      });
      cleanups.push(scheduled.clear);
    }
  };

  boot();

  const handle = {
    stop: () => {
      running = false;
      for (const cleanup of cleanups) cleanup();
      log.info('ICS feed stopped', { feed: config.feedName });
    },
  };
  return handle;
}
