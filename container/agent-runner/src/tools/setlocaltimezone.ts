#!/usr/bin/env bun
/**
 * setlocaltimezone — update the agent's timezone.
 *
 * Usage:
 *   setlocaltimezone America/New_York
 *   setlocaltimezone --list         # show common timezones
 *   setlocaltimezone --current      # show current setting
 *
 * Writes through `ncl groups config update --timezone <tz>` into the
 * group's DB-configured container_configs.timezone — the single source of
 * truth for both the container's own TZ env and host-side task scheduling.
 * No more `.timezone` file: that was a separate, file-based mechanism this
 * fork has retired in favor of NanoClaw's own DB-backed one.
 */
import { execSync } from 'child_process';

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

Writes via \`ncl groups config update --timezone <tz>\`. From inside a
container this is approval-gated — an admin must approve before it lands —
and does NOT take effect until the group container restarts. Request a
restart after it's approved.`);
  process.exit(0);
}

if (args[0] === '--current') {
  console.log(`Active TZ (this session): ${process.env.TZ || 'UTC'}`);
  try {
    const out = execSync('ncl groups config get', { encoding: 'utf-8' });
    const match = out.match(/"timezone":\s*"([^"]+)"/);
    if (match && match[1] !== process.env.TZ) {
      console.log(`Pending TZ (after approval + restart): ${match[1]}`);
    }
  } catch {
    // ncl not reachable or no config yet — active TZ above is all we can show
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

try {
  execSync(`ncl groups config update --timezone ${newTz}`, { encoding: 'utf-8', stdio: 'pipe' });
} catch (err) {
  const stderr = err && typeof err === 'object' && 'stderr' in err ? String((err as { stderr: unknown }).stderr) : String(err);
  console.error(`Failed to submit timezone update: ${stderr}`);
  process.exit(1);
}

console.log(`Timezone update submitted: ${oldTz} → ${newTz}`);
console.log('');
console.log('⚠ This is approval-gated (an admin must approve) and takes effect after a container restart.');
console.log('Request a restart once approved, or schedule one soon.');
