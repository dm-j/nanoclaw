import fs from 'fs';
import path from 'path';

import { GROUPS_DIR, TIMEZONE } from './config.js';
import { isValidTimezone } from './timezone.js';

const GROUP_FOLDER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const RESERVED_FOLDERS = new Set(['global']);

export function isValidGroupFolder(folder: string): boolean {
  if (!folder) return false;
  if (folder !== folder.trim()) return false;
  if (!GROUP_FOLDER_PATTERN.test(folder)) return false;
  if (folder.includes('/') || folder.includes('\\')) return false;
  if (folder.includes('..')) return false;
  if (RESERVED_FOLDERS.has(folder.toLowerCase())) return false;
  return true;
}

export function assertValidGroupFolder(folder: string): void {
  if (!isValidGroupFolder(folder)) {
    throw new Error(`Invalid group folder "${folder}"`);
  }
}

function ensureWithinBase(baseDir: string, resolvedPath: string): void {
  const rel = path.relative(baseDir, resolvedPath);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`Path escapes base directory: ${resolvedPath}`);
  }
}

export function resolveGroupFolderPath(folder: string): string {
  assertValidGroupFolder(folder);
  const groupPath = path.resolve(GROUPS_DIR, folder);
  ensureWithinBase(GROUPS_DIR, groupPath);
  return groupPath;
}

/**
 * A group's effective timezone: its `.timezone` override file if present and
 * valid (the agent's own live/travel override, see `setlocaltimezone`), else
 * the group's DB-configured `container_configs.timezone` (see
 * `resolveGroupTimezone` in container-config.ts — pass the DB value in as
 * `dbTimezone` if the caller has it), else the global config TIMEZONE.
 * Single source of truth for both the container's own TZ env
 * (container-runner.ts) and host-side scheduling (recurrence.ts) — they must
 * agree, or a task scheduled "3am" per the group's override fires at 3am UTC
 * instead.
 */
export function resolveGroupTimezone(folder: string, dbTimezone?: string | null): string {
  try {
    const raw = fs.readFileSync(path.join(GROUPS_DIR, folder, '.timezone'), 'utf-8').trim();
    // An invalid override falls back the same way a missing file does — not
    // timezone.ts's hardcoded 'UTC' fallback, which would silently diverge
    // from every other unaffected group.
    if (raw && isValidTimezone(raw)) return raw;
  } catch {
    // no per-group override — fall through to the DB value, then global
  }
  if (dbTimezone && isValidTimezone(dbTimezone)) return dbTimezone;
  return TIMEZONE;
}
