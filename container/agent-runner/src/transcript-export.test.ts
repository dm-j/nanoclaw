import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { exportTurnToInbox } from './transcript-export.js';

const sessionId = 'aaaaaaaa-0000-0000-0000-000000000001';

let tmpRoot: string;
let origWorkspace: string | undefined;
let origConfigDir: string | undefined;
let origHome: string | undefined;

function writeTranscript(lines: object[]): void {
  const dir = path.join(tmpRoot, 'claude-config', 'projects', 'proj');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${sessionId}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
}

function rec(role: 'user' | 'assistant', text: string, uuid: string) {
  return { type: role, uuid, sessionId, timestamp: '2026-07-10T00:00:00.000Z', message: { role, content: text } };
}

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'transcript-export-'));
  origWorkspace = process.env.WORKSPACE_DIR;
  origConfigDir = process.env.CLAUDE_CONFIG_DIR;
  origHome = process.env.HOME;
  process.env.WORKSPACE_DIR = path.join(tmpRoot, 'workspace');
  process.env.CLAUDE_CONFIG_DIR = path.join(tmpRoot, 'claude-config');
  process.env.HOME = tmpRoot; // isolate from any real ~/.claude/settings.json
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  if (origWorkspace === undefined) delete process.env.WORKSPACE_DIR;
  else process.env.WORKSPACE_DIR = origWorkspace;
  if (origConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = origConfigDir;
  if (origHome === undefined) delete process.env.HOME;
  else process.env.HOME = origHome;
});

describe('exportTurnToInbox', () => {
  it('exports new turns to inbox/ and appends the session log', () => {
    writeTranscript([rec('user', 'hello', 'u1'), rec('assistant', 'hi there', 'a1')]);

    exportTurnToInbox(sessionId, 'Lumen', 'David');

    const inboxDir = path.join(tmpRoot, 'workspace', 'inbox');
    const files = fs.readdirSync(inboxDir);
    expect(files.length).toBe(2);

    const userFile = files.find((f) => f.endsWith('-david.md'))!;
    const content = fs.readFileSync(path.join(inboxDir, userFile), 'utf8');
    expect(content).toContain('hello');
    expect(content).toContain('speaker: david');
  });

  it('does not re-export the same turns on a second call (marker-based cursor)', () => {
    writeTranscript([rec('user', 'hello', 'u1'), rec('assistant', 'hi there', 'a1')]);
    exportTurnToInbox(sessionId, 'Lumen', 'David');

    const inboxDir = path.join(tmpRoot, 'workspace', 'inbox');
    const firstCount = fs.readdirSync(inboxDir).length;

    // Second call, same transcript, no new records -- must be a no-op.
    exportTurnToInbox(sessionId, 'Lumen', 'David');
    expect(fs.readdirSync(inboxDir).length).toBe(firstCount);
  });

  it('resumes correctly after a compact_boundary even when the marker uuid is gone', () => {
    writeTranscript([rec('user', 'hello', 'u1'), rec('assistant', 'hi there', 'a1')]);
    exportTurnToInbox(sessionId, 'Lumen', 'David');

    // Simulate compaction: transcript rewritten, old uuids no longer present.
    writeTranscript([
      { type: 'system', subtype: 'compact_boundary', sessionId, uuid: 'boundary1', timestamp: '2026-07-10T01:00:00.000Z' },
      rec('user', 'new turn after compaction', 'u2'),
      rec('assistant', 'reply after compaction', 'a2'),
    ]);
    exportTurnToInbox(sessionId, 'Lumen', 'David');

    const inboxDir = path.join(tmpRoot, 'workspace', 'inbox');
    const all = fs
      .readdirSync(inboxDir)
      .map((f) => fs.readFileSync(path.join(inboxDir, f), 'utf8'))
      .join('\n');
    expect(all).toContain('new turn after compaction');
    expect(all).toContain('reply after compaction');
  });

  it('does not re-export earlier post-compaction turns on a later call (regression: duplicate exports)', () => {
    writeTranscript([rec('user', 'hello', 'u1'), rec('assistant', 'hi there', 'a1')]);
    exportTurnToInbox(sessionId, 'Lumen', 'David');

    // Compaction happens; two turns land after it, exported once.
    writeTranscript([
      { type: 'system', subtype: 'compact_boundary', sessionId, uuid: 'boundary1', timestamp: '2026-07-10T01:00:00.000Z' },
      rec('user', 'turn A', 'u2'),
      rec('assistant', 'reply A', 'a2'),
    ]);
    exportTurnToInbox(sessionId, 'Lumen', 'David');

    // Transcript keeps growing (same boundary still present, further back).
    // A correct implementation exports only the new turn; the original bug
    // re-exported everything since the boundary, duplicating turn A/reply A.
    writeTranscript([
      { type: 'system', subtype: 'compact_boundary', sessionId, uuid: 'boundary1', timestamp: '2026-07-10T01:00:00.000Z' },
      rec('user', 'turn A', 'u2'),
      rec('assistant', 'reply A', 'a2'),
      rec('user', 'turn B', 'u3'),
      rec('assistant', 'reply B', 'a3'),
    ]);
    exportTurnToInbox(sessionId, 'Lumen', 'David');

    const inboxDir = path.join(tmpRoot, 'workspace', 'inbox');
    const files = fs.readdirSync(inboxDir);
    // 2 turns from the first export + 2 from the second call (A) + 2 new (B) = 6.
    // The bug produced 8 (turn A/reply A duplicated on the third call).
    expect(files.length).toBe(6);
  });
});
