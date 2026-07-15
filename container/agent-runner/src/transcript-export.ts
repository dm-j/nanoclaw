import fs from 'fs';
import path from 'path';

import { findTranscriptPath } from './memory-capture.js';

// Exports each completed turn to inbox/ (per-turn files) and sessions/ (running
// log), same job the old `export-turn.js` Stop hook did. Moved into the
// agent-runner's own onExchangeComplete path (like captureMemoryTurn already
// is) because Claude Code's Stop hook does not reliably fire under this SDK
// stream-json invocation mode -- ponytail: this is a known-good pattern in
// this codebase already, not a new mechanism.

interface TranscriptRecord {
  type?: string;
  subtype?: string;
  sessionId?: string;
  session_id?: string;
  uuid?: string;
  timestamp?: string;
  message?: { role?: string; content?: unknown };
}

interface ExportedMessage {
  uuid: string;
  role: string;
  text: string;
  timestamp: string;
  sessionId: string;
}

function workspaceDir(): string {
  return process.env.WORKSPACE_DIR ?? '/workspace/agent';
}

function markerFile(): string {
  return path.join(workspaceDir(), 'sessions', '.last-exported-uuid');
}

// USER_DISPLAY_NAME / USER_SLUG live in .claude-shared/settings.json's `env`
// block, which Claude Code injects into the `claude` CLI subprocess (and its
// hook children) -- but this code runs in agent-runner's own process, which
// doesn't inherit that block. Read it directly instead of assuming it's in
// process.env.
function readSettingsEnv(): { userName?: string; userSlug?: string } {
  const settingsPath = path.join(process.env.HOME || '/home/node', '.claude', 'settings.json');
  try {
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    return { userName: settings.env?.USER_DISPLAY_NAME, userSlug: settings.env?.USER_SLUG };
  } catch {
    return {};
  }
}

function extractText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const block of content) {
      if (typeof block === 'string') parts.push(block);
      else if (block?.type === 'text') {
        const t = (block.text ?? '').trim();
        if (t) parts.push(t);
      }
    }
    return parts.join('\n\n');
  }
  return '';
}

function parseNewMessages(transcriptPath: string): ExportedMessage[] {
  const lines = fs.readFileSync(transcriptPath, 'utf8').split('\n');
  const records: TranscriptRecord[] = [];
  for (const line of lines) {
    try {
      records.push(JSON.parse(line));
    } catch {
      // skip unparseable lines
    }
  }

  const lastUuid = fs.existsSync(markerFile()) ? fs.readFileSync(markerFile(), 'utf8').trim() : null;

  // Two passes, not one: a compact_boundary must only reset the cursor when
  // the marker itself is unreachable (truncated by compaction) -- NOT on
  // every scan, or every invocation after a compaction re-exports everything
  // since that boundary again (duplicate inbox files, one bug we shipped and
  // are now fixing here).
  //
  // Pass 1: does lastUuid still exist in this transcript at all?
  let markerFound = lastUuid === null; // null marker = first run, nothing to find
  if (!markerFound) {
    for (const rec of records) {
      if (rec.uuid === lastUuid) {
        markerFound = true;
        break;
      }
    }
  }

  // Pass 2: decide the resume point.
  // - Marker valid (or first run): resume right after the marker (or from
  //   the very start on a first run) -- exactly the old single-pass logic,
  //   compact_boundary irrelevant here since the marker itself is trustworthy.
  // - Marker missing (compaction truncated it): resume after the LAST
  //   compact_boundary in the file, ignoring any earlier ones and ignoring
  //   the stale marker entirely.
  let resumeAfterUuid: string | null = lastUuid;
  if (!markerFound && lastUuid !== null) {
    let lastBoundaryIdx = -1;
    for (let i = 0; i < records.length; i++) {
      if (records[i].type === 'system' && records[i].subtype === 'compact_boundary') lastBoundaryIdx = i;
    }
    resumeAfterUuid = lastBoundaryIdx >= 0 ? (records[lastBoundaryIdx].uuid ?? null) : null;
  }

  let sessionId: string | null = null;
  let foundStart = resumeAfterUuid === null;
  const messages: ExportedMessage[] = [];

  for (const rec of records) {
    if (!sessionId) sessionId = rec.sessionId ?? rec.session_id ?? null;

    // Uuid match must be checked on every record type (compact_boundary
    // records have no message.role and would never be seen if this ran
    // after the role filter below).
    const recUuid = rec.uuid ?? '';
    if (!foundStart) {
      if (recUuid === resumeAfterUuid) foundStart = true;
      continue;
    }

    const role = rec.message?.role;
    if (role !== 'user' && role !== 'assistant') continue;

    const text = extractText(rec.message?.content).trim();
    if (!text) continue;
    if (text.startsWith('This session is being continued from a previous conversation')) continue;

    messages.push({
      uuid: recUuid,
      role,
      text,
      timestamp: rec.timestamp ?? new Date().toISOString(),
      sessionId: sessionId ?? 'unknown',
    });
  }

  return messages;
}

function tsSlug(ts: string): string {
  return new Date(ts).toISOString().replace(/[-:]/g, '').slice(0, 15) + 'Z';
}

function tsDisplay(ts: string): string {
  return new Date(ts).toISOString().replace(/\.\d+Z$/, 'Z');
}

// Local time + UTC offset, e.g. "2026-07-14T06:46:15-05:00" — human-facing
// session-log header. Inbox frontmatter timestamps stay UTC for machine use.
function tsLocal(ts: string): string {
  const d = new Date(ts);
  const tz = process.env.USER_TIMEZONE || 'America/Chicago';
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    timeZoneName: 'shortOffset',
  }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  let offset = get('timeZoneName').replace('GMT', '') || '+00:00';
  if (!offset.includes(':')) {
    const sign = offset.startsWith('-') ? '-' : '+';
    offset = `${sign}${offset.replace(/[+-]/, '').padStart(2, '0')}:00`;
  }
  return `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}:${get('second')}${offset}`;
}

/**
 * Export every new turn (since the last call) to inbox/ + sessions/.
 * Best-effort: logs failures, never throws -- called from onExchangeComplete
 * alongside captureMemoryTurn, must not block the turn.
 */
export function exportTurnToInbox(sessionId: string | undefined, agentName = 'Agent', userNameOverride?: string): void {
  if (!sessionId) return;
  const transcriptPath = findTranscriptPath(sessionId);
  if (!transcriptPath) return;

  const inboxDir = path.join(workspaceDir(), 'inbox');
  const sessionsDir = path.join(workspaceDir(), 'sessions');
  fs.mkdirSync(inboxDir, { recursive: true });
  fs.mkdirSync(sessionsDir, { recursive: true });

  let messages: ExportedMessage[];
  try {
    messages = parseNewMessages(transcriptPath);
  } catch (err) {
    log(`failed to read transcript: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }
  if (messages.length === 0) return;

  const settingsEnv = readSettingsEnv();
  const userName = userNameOverride ?? settingsEnv.userName ?? 'User';
  const userSlug = settingsEnv.userSlug ?? userName.toLowerCase();
  const agentSlug = agentName.toLowerCase();
  const speaker = (role: string) => (role === 'assistant' ? agentName : userName);
  const slug = (role: string) => (role === 'assistant' ? agentSlug : userSlug);

  const sidShort = sessionId.slice(0, 8);
  const existing = fs.readdirSync(sessionsDir).filter((f) => f.includes(sidShort) && f.endsWith('.md'));

  let sessionFile: string;
  if (existing.length > 0) {
    sessionFile = path.join(sessionsDir, existing[0]);
  } else {
    const startSlug = tsSlug(messages[0].timestamp);
    sessionFile = path.join(sessionsDir, `${startSlug}-${sidShort}.md`);
    fs.writeFileSync(sessionFile, `---\nsession_id: ${sessionId}\nstarted: ${messages[0].timestamp}\n---\n\n`);
  }

  const logEntries: string[] = [];
  for (const msg of messages) {
    const spk = speaker(msg.role);
    const slg = slug(msg.role);
    const tsd = tsDisplay(msg.timestamp);
    const tss = tsSlug(msg.timestamp);

    // uuid suffix (not just timestamp+role) guarantees one file per message —
    // same-second turns (common; test fixtures even more so) would otherwise
    // collide on filename and silently overwrite each other.
    const uuidShort = msg.uuid.slice(0, 8) || 'noid';
    const inboxFile = path.join(inboxDir, `${tss}-${slg}-${uuidShort}.md`);
    fs.writeFileSync(
      inboxFile,
      `---\ntimestamp: ${tsd}\nspeaker: ${slg}\ndisplay_name: ${spk}\nsession_id: ${msg.sessionId}\nuuid: ${msg.uuid}\n---\n\n${msg.text}\n`,
    );
    logEntries.push(`## ${spk} — ${tsLocal(msg.timestamp)}\n${msg.text}`);
  }

  try {
    fs.appendFileSync(sessionFile, '\n' + logEntries.join('\n\n') + '\n');
  } catch (err) {
    log(`failed to append session log: ${err instanceof Error ? err.message : String(err)}`);
  }

  const lastUuid = messages[messages.length - 1]?.uuid;
  if (lastUuid) {
    try {
      fs.writeFileSync(markerFile(), lastUuid);
    } catch (err) {
      log(`failed to write marker: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  log(`exported ${messages.length} message(s) -> inbox + ${path.basename(sessionFile)}`);
}

function log(msg: string): void {
  console.error(`[transcript-export] ${msg}`);
}
