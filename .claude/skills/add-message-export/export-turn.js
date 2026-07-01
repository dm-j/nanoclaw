#!/usr/bin/env bun
// Stop hook: export each completed conversation turn to inbox/ and sessions/
// Config via env: AGENT_NAME, USER_DISPLAY_NAME, USER_SLUG, WORKSPACE_DIR=/workspace/agent
import { readFileSync, writeFileSync, appendFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';

const workspace    = process.env.WORKSPACE_DIR ?? '/workspace/agent';
const inboxDir     = join(workspace, 'inbox');
const sessionsDir  = join(workspace, 'sessions');
const markerFile   = join(sessionsDir, '.last-exported-uuid');

const agentName = process.env.AGENT_NAME        ?? 'Lumen';
const userName  = process.env.USER_DISPLAY_NAME ?? 'David';
const userSlug  = process.env.USER_SLUG         ?? 'david';
const agentSlug = agentName.toLowerCase();

mkdirSync(inboxDir,    { recursive: true });
mkdirSync(sessionsDir, { recursive: true });

// Read hook payload from stdin
let payload = {};
try { payload = JSON.parse(readFileSync('/dev/stdin', 'utf8')); } catch {}

const transcriptPath = payload.transcript_path ?? '';
if (!transcriptPath || !existsSync(transcriptPath)) process.exit(0);

// Parse JSONL
const lines = readFileSync(transcriptPath, 'utf8').split('\n');
const records = [];
for (const line of lines) {
  try { records.push(JSON.parse(line)); } catch {}
}

let sessionId       = null;
let sessionStartTs  = null;
let lastUuid        = existsSync(markerFile) ? readFileSync(markerFile, 'utf8').trim() : null;
let foundStart      = lastUuid === null;
let lastSeenUuid    = lastUuid;
const newMessages   = [];

for (const rec of records) {
  if (!sessionId) sessionId = rec.sessionId ?? rec.session_id ?? null;

  // Compact boundary resets cursor
  if (rec.type === 'system' && rec.subtype === 'compact_boundary') {
    foundStart = true;
    lastUuid   = null;
    continue;
  }

  const msg  = rec.message ?? {};
  const role = msg.role;
  if (role !== 'user' && role !== 'assistant') continue;

  const recUuid = rec.uuid ?? '';
  const ts      = rec.timestamp ?? null;
  if (!sessionStartTs && ts) sessionStartTs = ts;

  if (!foundStart) {
    if (recUuid === lastUuid) foundStart = true;
    continue;
  }

  // Extract plain text blocks only
  const textParts = [];
  const content   = msg.content;
  if (typeof content === 'string') {
    textParts.push(content);
  } else if (Array.isArray(content)) {
    for (const block of content) {
      if (typeof block === 'string') textParts.push(block);
      else if (block?.type === 'text') { const t = (block.text ?? '').trim(); if (t) textParts.push(t); }
    }
  }

  const text = textParts.join('\n\n').trim();
  if (!text) continue;
  if (text.startsWith('This session is being continued from a previous conversation')) continue;

  newMessages.push({ uuid: recUuid, role, text, timestamp: ts ?? new Date().toISOString(), session_id: sessionId ?? 'unknown' });
  lastSeenUuid = recUuid;
}

if (!newMessages.length) process.exit(0);

// Helpers
function parseTs(ts) { try { return new Date(ts); } catch { return new Date(); } }
function tsSlug(ts)    { return parseTs(ts).toISOString().replace(/[-:]/g, '').replace('T', 'T').slice(0, 15) + 'Z'; }
function tsDisplay(ts) { return parseTs(ts).toISOString().replace(/\.\d+Z$/, 'Z'); }
function speaker(role) { return role === 'assistant' ? agentName : userName; }
function slug(role)    { return role === 'assistant' ? agentSlug : userSlug; }

// Resolve session log file
const sidShort  = (sessionId ?? 'unknown').slice(0, 8);
const existing  = existsSync(sessionsDir)
  ? (await import('fs')).readdirSync(sessionsDir).filter(f => f.includes(sidShort) && f.endsWith('.md'))
  : [];

let sessionFile;
if (existing.length) {
  sessionFile = join(sessionsDir, existing[0]);
} else {
  const startSlug = sessionStartTs ? tsSlug(sessionStartTs) : new Date().toISOString().replace(/[-:]/g, '').replace('T', 'T').slice(0, 15) + 'Z';
  sessionFile = join(sessionsDir, `${startSlug}-${sidShort}.md`);
  writeFileSync(sessionFile, `---\nsession_id: ${sessionId}\nstarted: ${sessionStartTs}\n---\n\n`);
}

// Write inbox files + accumulate log entries
const logEntries = [];
for (const msg of newMessages) {
  const spk = speaker(msg.role);
  const slg = slug(msg.role);
  const tsd = tsDisplay(msg.timestamp);
  const tss = tsSlug(msg.timestamp);

  const inboxFile = join(inboxDir, `${tss}-${slg}.md`);
  writeFileSync(inboxFile,
    `---\ntimestamp: ${tsd}\nspeaker: ${slg}\ndisplay_name: ${spk}\nsession_id: ${msg.session_id}\nuuid: ${msg.uuid}\n---\n\n${msg.text}\n`
  );

  logEntries.push(`## ${tsd} · ${spk}\n${msg.text}`);
}

appendFileSync(sessionFile, '\n' + logEntries.join('\n\n') + '\n');

if (lastSeenUuid) writeFileSync(markerFile, lastSeenUuid);

console.log(`export-turn: ${newMessages.length} message(s) → inbox + ${sessionFile.split('/').pop()}`);
