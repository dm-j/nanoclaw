#!/usr/bin/env bun
/**
 * setlocaltimezone — update the agent's timezone.
 *
 * Usage:
 *   setlocaltimezone America/New_York
 *   setlocaltimezone --list         # show common timezones
 *   setlocaltimezone --current      # show current setting
 */

import fs from 'fs';

const TZ_FILE = '/workspace/agent/.timezone';
const args = process.argv.slice(2);

function isValidTimezone(tz: string): boolean {
  try {
    Intl.DateTimeFormat(undefined, { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

if (!args[0] || args[0] === '--help' || args[0] === '-h') {
  console.log(`Usage:
  setlocaltimezone <timezone>    Set the agent's local timezone (e.g. America/New_York)
  setlocaltimezone --current     Show current timezone setting
  setlocaltimezone --list        Show common timezone names

The change writes to .timezone but does NOT take effect until
the container restarts. Request a restart after calling this.`);
  process.exit(0);
}

if (args[0] === '--current') {
  const current = process.env.TZ || 'UTC';
  let fileValue = '';
  try { fileValue = fs.readFileSync(TZ_FILE, 'utf-8').trim(); } catch { /* no file */ }
  console.log(`Active TZ (this session): ${current}`);
  if (fileValue && fileValue !== current) {
    console.log(`Pending TZ (after restart): ${fileValue}`);
  }
  process.exit(0);
}

if (args[0] === '--list') {
  const zones = [
    'America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles',
    'America/Anchorage', 'Pacific/Honolulu', 'America/Toronto', 'America/Vancouver',
    'Europe/London', 'Europe/Paris', 'Europe/Berlin', 'Europe/Amsterdam',
    'Europe/Helsinki', 'Europe/Moscow', 'Asia/Tokyo', 'Asia/Shanghai',
    'Asia/Kolkata', 'Asia/Dubai', 'Asia/Singapore', 'Australia/Sydney',
    'Australia/Melbourne', 'Pacific/Auckland', 'UTC',
  ];
  for (const z of zones) {
    const now = new Date().toLocaleString('en-US', { timeZone: z, timeZoneName: 'short' });
    console.log(`  ${z.padEnd(24)} ${now}`);
  }
  process.exit(0);
}

const newTz = args[0];

if (!isValidTimezone(newTz)) {
  console.error(`Invalid timezone: ${newTz}`);
  console.error('Use IANA timezone names (e.g. America/New_York, Europe/London, Asia/Tokyo)');
  console.error('Run "setlocaltimezone --list" for common options.');
  process.exit(1);
}

const oldTz = process.env.TZ || 'UTC';
fs.writeFileSync(TZ_FILE, newTz + '\n');

console.log(`Timezone updated: ${oldTz} → ${newTz}`);
console.log('');
console.log('⚠ This takes effect after a container restart.');
console.log('Request a restart now, or schedule one soon.');
