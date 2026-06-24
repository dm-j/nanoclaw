#!/usr/bin/env bun
/**
 * datetime — timezone conversion and date arithmetic for agents.
 *
 * Usage:
 *   datetime convert <timestamp> --to <timezone>
 *   datetime convert <timestamp> --from <timezone> --to <timezone>
 *   datetime add <timestamp> [--years N] [--months N] [--days N] [--hours N] [--minutes N] [--seconds N]
 *   datetime now [--tz <timezone>]
 *   datetime parse <timestamp>  # show what we think this means
 */

const TZ = process.env.TZ || 'UTC';

// ponytail: best-effort timestamp parser. Handles ISO, common formats,
// and bare times. Falls back to new Date() which covers most cases.
function parseTimestamp(input: string, fromTz?: string): Date {
  let s = input.trim();

  // "3pm" / "3:00pm" / "15:00" — treat as today in fromTz
  const timeOnly = s.match(/^(\d{1,2}):?(\d{2})?\s*(am|pm)?$/i);
  if (timeOnly) {
    let hours = parseInt(timeOnly[1], 10);
    const minutes = parseInt(timeOnly[2] || '0', 10);
    const ampm = timeOnly[3]?.toLowerCase();
    if (ampm === 'pm' && hours < 12) hours += 12;
    if (ampm === 'am' && hours === 12) hours = 0;
    const now = new Date();
    const dateStr = now.toLocaleDateString('en-CA', { timeZone: fromTz || TZ }); // YYYY-MM-DD
    s = `${dateStr}T${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:00`;
    if (fromTz) {
      return fromZoned(s, fromTz);
    }
    return fromZoned(s, TZ);
  }

  // Compact ISO: 20260624T112109Z
  if (/^\d{8}T\d{6}Z?$/.test(s)) {
    s = s.replace(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})/, '$1-$2-$3T$4:$5:$6');
  }

  // Date only: 2026-06-24 → start of day in fromTz
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    s = `${s}T00:00:00`;
    if (fromTz) return fromZoned(s, fromTz);
    return fromZoned(s, TZ);
  }

  // ISO with timezone offset or Z — parse directly
  if (/[Z+-]\d{0,4}$/.test(s)) {
    const d = new Date(s);
    if (!isNaN(d.getTime())) return d;
  }

  // Naive datetime (no offset) — interpret in fromTz
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(s)) {
    if (fromTz) return fromZoned(s, fromTz);
    return fromZoned(s, TZ);
  }

  // Last resort: let Date() try
  const d = new Date(s);
  if (!isNaN(d.getTime())) return d;

  console.error(`Cannot parse timestamp: ${input}`);
  process.exit(1);
}

// Convert a naive datetime string to UTC by interpreting it in the given timezone.
// Strategy: parse as UTC, format that UTC instant in the target tz to find
// the offset, then shift by the difference.
function fromZoned(naive: string, tz: string): Date {
  const asUtc = new Date(naive + 'Z');
  // What does this UTC instant look like in tz?
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).formatToParts(asUtc);
  const get = (t: string) => parseInt(parts.find(p => p.type === t)?.value || '0', 10);
  const inTz = new Date(Date.UTC(get('year'), get('month') - 1, get('day'), get('hour') % 24, get('minute'), get('second')));
  const offset = inTz.getTime() - asUtc.getTime();
  return new Date(asUtc.getTime() - offset);
}

function formatInTz(d: Date, tz: string): string {
  return d.toLocaleString('en-US', {
    timeZone: tz,
    weekday: 'short',
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    timeZoneName: 'short',
    hour12: true,
  });
}

function formatIso(d: Date): string {
  return d.toISOString();
}

const args = process.argv.slice(2);
const cmd = args[0];

function getFlag(name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
}

function getFlagNum(name: string): number {
  const v = getFlag(name);
  return v ? parseInt(v, 10) : 0;
}

if (!cmd || cmd === '--help' || cmd === '-h') {
  console.log(`Usage:
  datetime convert <timestamp> --to <timezone> [--from <timezone>]
  datetime add <timestamp> [--years N] [--months N] [--days N] [--hours N] [--minutes N] [--seconds N]
  datetime now [--tz <timezone>]
  datetime parse <timestamp>

Timestamps: ISO 8601, "3pm", "15:00", "2026-06-24", "20260624T112109Z", or anything Date() accepts.
Default timezone: ${TZ} (from TZ env var)`);
  process.exit(0);
}

if (cmd === 'now') {
  const tz = getFlag('tz') || TZ;
  const now = new Date();
  console.log(`${formatInTz(now, tz)}`);
  console.log(`ISO: ${formatIso(now)}`);
  process.exit(0);
}

if (cmd === 'convert') {
  const input = args[1];
  if (!input) { console.error('Usage: datetime convert <timestamp> --to <timezone>'); process.exit(1); }
  const to = getFlag('to') || TZ;
  const from = getFlag('from');
  const d = parseTimestamp(input, from);
  console.log(`${formatInTz(d, to)}`);
  console.log(`ISO: ${formatIso(d)}`);
  process.exit(0);
}

if (cmd === 'add') {
  const input = args[1];
  if (!input) { console.error('Usage: datetime add <timestamp> --days N [--hours N] ...'); process.exit(1); }
  const d = parseTimestamp(input, getFlag('from'));
  d.setFullYear(d.getFullYear() + getFlagNum('years'));
  d.setMonth(d.getMonth() + getFlagNum('months'));
  d.setDate(d.getDate() + getFlagNum('days'));
  d.setHours(d.getHours() + getFlagNum('hours'));
  d.setMinutes(d.getMinutes() + getFlagNum('minutes'));
  d.setSeconds(d.getSeconds() + getFlagNum('seconds'));
  const tz = getFlag('tz') || TZ;
  console.log(`${formatInTz(d, tz)}`);
  console.log(`ISO: ${formatIso(d)}`);
  process.exit(0);
}

if (cmd === 'parse') {
  const input = args[1];
  if (!input) { console.error('Usage: datetime parse <timestamp>'); process.exit(1); }
  const from = getFlag('from');
  const d = parseTimestamp(input, from);
  console.log(`Interpreted as: ${formatIso(d)}`);
  console.log(`In ${TZ}: ${formatInTz(d, TZ)}`);
  console.log(`In UTC: ${formatInTz(d, 'UTC')}`);
  process.exit(0);
}

console.error(`Unknown command: ${cmd}. Run 'datetime --help' for usage.`);
process.exit(1);
