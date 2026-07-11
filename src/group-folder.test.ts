import fs from 'fs';
import path from 'path';

import { afterEach, describe, expect, it } from 'vitest';

import { GROUPS_DIR, TIMEZONE } from './config.js';
import { isValidGroupFolder, resolveGroupFolderPath, resolveGroupTimezone } from './group-folder.js';

describe('group folder validation', () => {
  it('accepts normal group folder names', () => {
    expect(isValidGroupFolder('main')).toBe(true);
    expect(isValidGroupFolder('family-chat')).toBe(true);
    expect(isValidGroupFolder('Team_42')).toBe(true);
  });

  it('rejects traversal and reserved names', () => {
    expect(isValidGroupFolder('../../etc')).toBe(false);
    expect(isValidGroupFolder('/tmp')).toBe(false);
    expect(isValidGroupFolder('global')).toBe(false);
    expect(isValidGroupFolder('')).toBe(false);
  });

  it('resolves safe paths under groups directory', () => {
    const resolved = resolveGroupFolderPath('family-chat');
    expect(resolved.endsWith(`${path.sep}groups${path.sep}family-chat`)).toBe(true);
  });

  it('throws for unsafe folder names', () => {
    expect(() => resolveGroupFolderPath('../../etc')).toThrow();
  });
});

describe('resolveGroupTimezone', () => {
  const testFolder = 'test-tz-folder-tmp';
  const testDir = path.join(GROUPS_DIR, testFolder);

  afterEach(() => {
    if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true });
  });

  it('uses the .timezone override when present and valid', () => {
    fs.mkdirSync(testDir, { recursive: true });
    fs.writeFileSync(path.join(testDir, '.timezone'), 'America/Chicago\n');
    expect(resolveGroupTimezone(testFolder)).toBe('America/Chicago');
  });

  it('falls back to global TIMEZONE when no override file exists', () => {
    expect(resolveGroupTimezone(testFolder)).toBe(TIMEZONE);
  });

  it('falls back to global TIMEZONE when the override is not a valid IANA zone', () => {
    fs.mkdirSync(testDir, { recursive: true });
    fs.writeFileSync(path.join(testDir, '.timezone'), 'Not/AZone');
    expect(resolveGroupTimezone(testFolder)).toBe(TIMEZONE);
  });
});
