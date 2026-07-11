/**
 * Check whether a timezone string is a valid IANA identifier
 * that Intl.DateTimeFormat can use.
 */
export function isValidTimezone(tz: string): boolean {
  try {
    Intl.DateTimeFormat(undefined, { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/**
 * Return the given timezone if valid IANA, otherwise fall back to UTC.
 */
export function resolveTimezone(tz: string): string {
  return isValidTimezone(tz) ? tz : 'UTC';
}

/**
 * Convert a UTC ISO timestamp to a localized display string.
 * Uses the Intl API (no external dependencies).
 * Falls back to UTC if the timezone is invalid.
 *
 * `utcIso` may be a naive SQLite `datetime('now')` string with no offset
 * marker (e.g. "2026-07-07 08:00:00") — genuinely UTC, but `new Date()`
 * parses an unmarked, space-separated string as *local* time, silently
 * canceling out the timezone conversion below. Normalize first, same as
 * the host's `parseSqliteUtc` in host-sweep.ts.
 */
export function formatLocalTime(utcIso: string, timezone: string): string {
  const hasOffset = /[zZ]|[+-]\d{2}:?\d{2}$/.test(utcIso);
  const date = new Date(hasOffset ? utcIso : `${utcIso.replace(' ', 'T')}Z`);
  return date.toLocaleString('en-US', {
    timeZone: resolveTimezone(timezone),
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
}
