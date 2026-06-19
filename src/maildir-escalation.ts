/**
 * Escalation watcher.
 *
 * Watches mail/escalations/new/ for messages from thread agents
 * (notify_user, request_action). Each escalation spawns an ephemeral
 * main-agent fork that reviews and acts without polluting the main
 * agent's persistent context.
 *
 * The fork inherits the group's personality (CLAUDE.local.md), scratch
 * files (including ledger.md), and mail tree — but gets a fresh Claude
 * session that is not resumed.
 */
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

import { DATA_DIR, GROUPS_DIR } from './config.js';
import { onContainerClose, wakeContainer } from './container-runner.js';
import { getAgentGroupByFolder } from './db/agent-groups.js';
import { createSession, deleteSession, findSessionByAgentGroup } from './db/sessions.js';
import { log } from './log.js';
import { initSessionFolder, writeSessionMessage, sessionDir, openOutboundDb } from './session-manager.js';
import type { Session } from './types.js';

const CONTEXT_BUDGET = 8000;

/**
 * Read the tail of the main agent's Claude transcript and extract a
 * conversational summary. Returns user and assistant messages (skipping
 * tool calls, thinking, attachments) bounded by CONTEXT_BUDGET chars.
 */
function readMainAgentContext(agentGroupId: string): string {
  const mainSession = findSessionByAgentGroup(agentGroupId);
  if (!mainSession) return '';

  const transcriptDir = path.join(DATA_DIR, 'v2-sessions', agentGroupId, '.claude-shared', 'projects', '-workspace-agent');
  if (!fs.existsSync(transcriptDir)) return '';

  // Find the transcript file for the main session's continuation
  const files = fs.readdirSync(transcriptDir).filter((f) => f.endsWith('.jsonl'));
  if (files.length === 0) return '';

  // Use the most recently modified transcript
  let latestFile = '';
  let latestMtime = 0;
  for (const f of files) {
    const stat = fs.statSync(path.join(transcriptDir, f));
    if (stat.mtimeMs > latestMtime) {
      latestMtime = stat.mtimeMs;
      latestFile = f;
    }
  }
  if (!latestFile) return '';

  try {
    const raw = fs.readFileSync(path.join(transcriptDir, latestFile), 'utf-8');
    const lines = raw.trim().split('\n');

    const entries: string[] = [];
    let totalLen = 0;

    // Walk backwards to get recent context first
    for (let i = lines.length - 1; i >= 0 && totalLen < CONTEXT_BUDGET; i--) {
      try {
        const obj = JSON.parse(lines[i]);
        if (obj.type === 'user' && obj.message?.content) {
          const text = typeof obj.message.content === 'string'
            ? obj.message.content
            : JSON.stringify(obj.message.content);
          const entry = `[user] ${text.slice(0, 1000)}`;
          entries.unshift(entry);
          totalLen += entry.length;
        } else if (obj.type === 'assistant' && obj.message?.content) {
          const blocks = Array.isArray(obj.message.content) ? obj.message.content : [];
          const textParts = blocks
            .filter((b: { type: string }) => b.type === 'text')
            .map((b: { text: string }) => b.text);
          if (textParts.length > 0) {
            const entry = `[assistant] ${textParts.join(' ').slice(0, 1000)}`;
            entries.unshift(entry);
            totalLen += entry.length;
          }
        }
      } catch {
        continue;
      }
    }

    return entries.join('\n');
  } catch {
    return '';
  }
}

const DEBOUNCE_MS = 500;
const DEBOUNCE_MAX_MS = 2000;

interface WatchState {
  watcher: fs.FSWatcher;
  timer: ReturnType<typeof setTimeout> | null;
  deadline: number | null;
}

const watchers = new Map<string, WatchState>();

function escalationsNewPath(folder: string): string {
  return path.join(GROUPS_DIR, folder, 'mail', 'escalations', 'new');
}

function fire(folder: string, escalationsNew: string): void {
  const state = watchers.get(folder);
  if (state) {
    state.timer = null;
    state.deadline = null;
  }

  const agentGroup = getAgentGroupByFolder(folder);
  if (!agentGroup) {
    log.warn('Escalation watcher: agent group not found', { folder });
    return;
  }

  let fileNames: string[];
  try {
    fileNames = fs.readdirSync(escalationsNew).filter((f) => !f.startsWith('.'));
  } catch {
    return;
  }
  if (fileNames.length === 0) return;

  // Read all escalation messages
  const messages: { name: string; content: string }[] = [];
  for (const name of fileNames) {
    const filePath = path.join(escalationsNew, name);
    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      // Move to cur/:2,S — claimed
      const curDir = path.join(path.dirname(escalationsNew), 'cur');
      fs.renameSync(filePath, path.join(curDir, `${name}:2,S`));
      messages.push({ name, content });
    } catch (err) {
      log.warn('Escalation watcher: failed to read/claim', { name, err });
    }
  }

  if (messages.length === 0) return;

  // Create an ephemeral session — never resumed
  const sessionId = `sess-esc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const session: Session = {
    id: sessionId,
    agent_group_id: agentGroup.id,
    messaging_group_id: null,
    thread_id: null,
    agent_provider: null,
    status: 'active',
    container_status: 'stopped',
    last_active: null,
    created_at: new Date().toISOString(),
  };
  createSession(session);
  initSessionFolder(agentGroup.id, sessionId);

  const noun = messages.length === 1 ? 'escalation' : 'escalations';
  const messagesBlock = messages.map((m) => m.content).join('\n---\n');
  const mainContext = readMainAgentContext(agentGroup.id);
  const contextSection = mainContext
    ? `\n\n<main-agent-context>\nRecent main agent activity (read-only context for your review):\n${mainContext}\n</main-agent-context>`
    : '';
  const content = JSON.stringify({
    type: 'maildir-wake',
    text: `You have ${messages.length} ${noun} from thread agents to review.\n\n${messagesBlock}${contextSection}`,
    inboxNew: '/workspace/mail/inbox/new',
  });

  writeSessionMessage(agentGroup.id, sessionId, {
    id: crypto.randomUUID(),
    kind: 'maildir-wake',
    timestamp: new Date().toISOString(),
    content,
    trigger: 1,
  });

  log.info('Escalation dispatch', {
    folder,
    agentGroupId: agentGroup.id,
    sessionId,
    count: messages.length,
  });

  // After the fork exits: read its outbound, inject a summary into the main
  // agent's session, then delete the ephemeral session.
  onContainerClose(sessionId, () => {
    try {
      let summary = '';
      try {
        const db = openOutboundDb(agentGroup.id, sessionId);
        try {
          const rows = db.prepare('SELECT content FROM messages_out ORDER BY seq DESC LIMIT 5').all() as { content: string }[];
          const texts = rows
            .map((r: { content: string }) => {
              try { return JSON.parse(r.content).text; } catch { return null; }
            })
            .filter(Boolean)
            .reverse();
          summary = texts.join('\n');
        } finally {
          db.close();
        }
      } catch {
        // DB may not exist if fork produced no output
      }

      if (!summary) summary = '(escalation fork produced no output)';

      // Write summary to the main agent's session
      const mainSession = findSessionByAgentGroup(agentGroup.id);
      if (mainSession) {
        writeSessionMessage(agentGroup.id, mainSession.id, {
          id: crypto.randomUUID(),
          kind: 'system',
          timestamp: new Date().toISOString(),
          content: JSON.stringify({
            type: 'escalation-summary',
            text: `Escalation review completed:\n${summary}`,
          }),
          trigger: 0,
        });
        log.info('Escalation summary written to main session', {
          mainSessionId: mainSession.id,
          escalationSessionId: sessionId,
        });
      }

      // Clean up ephemeral session
      const dir = sessionDir(agentGroup.id, sessionId);
      fs.rmSync(dir, { recursive: true, force: true });
      deleteSession(sessionId);
      log.info('Ephemeral escalation session cleaned up', { sessionId });
    } catch (err) {
      log.warn('Escalation cleanup failed', { sessionId, err });
    }
  });

  wakeContainer(session).catch((err) => {
    log.error('Escalation dispatch: container wake failed', { folder, err });
  });
}

function schedule(folder: string, escalationsNew: string): void {
  const state = watchers.get(folder);
  if (!state) return;

  const now = Date.now();
  if (state.timer === null) {
    state.deadline = now + DEBOUNCE_MAX_MS;
  }
  if (state.timer !== null) {
    clearTimeout(state.timer);
    state.timer = null;
  }

  const remaining = state.deadline! - now;
  const delay = Math.min(DEBOUNCE_MS, Math.max(0, remaining));
  state.timer = setTimeout(() => fire(folder, escalationsNew), delay);
}

export function watchEscalations(folder: string): void {
  const escNew = escalationsNewPath(folder);
  const key = `esc:${folder}`;

  if (watchers.has(key)) return;
  if (!fs.existsSync(escNew)) return;

  let watcher: fs.FSWatcher;
  try {
    watcher = fs.watch(escNew, { persistent: false }, (event) => {
      if (event === 'rename') schedule(folder, escNew);
    });
  } catch (err) {
    log.warn('Escalation watcher: could not watch', { folder, err });
    return;
  }

  watcher.on('error', (err) => {
    log.warn('Escalation watcher error', { folder, err });
    stopWatchingEscalations(folder);
  });

  watchers.set(key, { watcher, timer: null, deadline: null });
  log.info('Escalation watcher started', { folder, escNew });
}

export function stopWatchingEscalations(folder: string): void {
  const key = `esc:${folder}`;
  const state = watchers.get(key);
  if (!state) return;
  if (state.timer !== null) clearTimeout(state.timer);
  state.watcher.close();
  watchers.delete(key);
}

export function startEscalationWatcher(): void {
  if (!fs.existsSync(GROUPS_DIR)) return;

  const folders = fs
    .readdirSync(GROUPS_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name);

  let count = 0;
  for (const folder of folders) {
    if (fs.existsSync(escalationsNewPath(folder))) {
      watchEscalations(folder);
      count++;
    }
  }

  if (count > 0) {
    log.info('Escalation watcher started', { watchedCount: count });
  }
}

export function stopEscalationWatcher(): void {
  for (const key of [...watchers.keys()]) {
    const folder = key.replace(/^esc:/, '');
    stopWatchingEscalations(folder);
  }
}
