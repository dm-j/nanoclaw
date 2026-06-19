/**
 * Maildir thread dispatcher.
 *
 * Watches agents/<folder>/mail/inbox/new/ for arriving RFC822 messages.
 * When files appear, debounces, then:
 *   1. Reads Thread-ID from each message's headers.
 *   2. Groups messages by Thread-ID.
 *   3. For each thread: resolves a per-thread session, copies the message
 *      into the thread's inbox, writes a maildir-wake, wakes the container.
 *   4. Messages without Thread-ID fall back to agent-shared.
 *
 * Each thread gets its own container with an isolated Claude session.
 */
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

import { GROUPS_DIR } from './config.js';
import { wakeContainer } from './container-runner.js';
import { getAgentGroupByFolder } from './db/agent-groups.js';
import { createSession } from './db/sessions.js';
import { findSessionByThread } from './db/sessions.js';
import { log } from './log.js';
import { resolveSession, writeSessionMessage, initSessionFolder } from './session-manager.js';
import type { Session } from './types.js';

const DEBOUNCE_MS = 500;
const DEBOUNCE_MAX_MS = 2000;

interface WatchState {
  watcher: fs.FSWatcher;
  timer: ReturnType<typeof setTimeout> | null;
  deadline: number | null;
}

const watchers = new Map<string, WatchState>();

function inboxNewPath(folder: string): string {
  return path.join(GROUPS_DIR, folder, 'mail', 'inbox', 'new');
}

/**
 * Parse the Thread-ID header from an RFC822 message file.
 * Reads only the header block (up to the first blank line) for efficiency.
 */
function parseThreadId(filePath: string): string | null {
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const blankLine = raw.indexOf('\n\n');
    const headerBlock = blankLine >= 0 ? raw.slice(0, blankLine) : raw;
    for (const line of headerBlock.split('\n')) {
      if (line.startsWith('Thread-ID:')) {
        return line.slice('Thread-ID:'.length).trim();
      }
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Ensure a thread's inbox Maildir exists.
 * Returns the path to the thread's inbox/new/ directory.
 */
function ensureThreadInbox(folder: string, threadId: string): string {
  const threadDir = path.join(GROUPS_DIR, folder, 'mail', 'threads', threadId, 'inbox');
  for (const sub of ['tmp', 'new', 'cur']) {
    const dir = path.join(threadDir, sub);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }
  return path.join(threadDir, 'new');
}

/**
 * Dispatch a group of messages for one thread.
 * Moves from shared inbox to cur/:2,S, copies into thread inbox, wakes.
 */
function dispatchThread(
  folder: string,
  agentGroupId: string,
  threadId: string,
  files: { name: string; fullPath: string }[],
  inboxNew: string,
): void {
  const threadInboxNew = ensureThreadInbox(folder, threadId);

  const dispatched: { name: string; content: string }[] = [];

  for (const file of files) {
    const threadNew = path.join(threadInboxNew, file.name);
    if (fs.existsSync(threadNew)) continue;

    // Read content before moving
    let content: string;
    try {
      content = fs.readFileSync(file.fullPath, 'utf-8');
    } catch {
      continue;
    }

    // Atomic rename from shared inbox to thread inbox
    try {
      fs.renameSync(file.fullPath, threadNew);
    } catch (err) {
      log.warn('Thread dispatch: failed to move to thread inbox', { file: file.name, threadId, err });
      continue;
    }

    dispatched.push({ name: file.name, content });
  }

  if (dispatched.length === 0) return;

  let session = findSessionByThread(agentGroupId, threadId);
  if (!session) {
    const id = `sess-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    session = {
      id,
      agent_group_id: agentGroupId,
      messaging_group_id: null,
      thread_id: threadId,
      agent_provider: null,
      status: 'active',
      container_status: 'stopped',
      last_active: null,
      created_at: new Date().toISOString(),
    };
    createSession(session);
    initSessionFolder(agentGroupId, id);
    log.info('Thread session created', { id, agentGroupId, threadId });
  }

  const noun = dispatched.length === 1 ? 'message' : 'messages';
  const messagesBlock = dispatched.map((d) => d.content).join('\n---\n');
  const content = JSON.stringify({
    type: 'maildir-wake',
    text: `You have ${dispatched.length} new ${noun}. Process each one and write a reply to the Response-Maildir specified in each message.\n\n${messagesBlock}`,
    inboxNew: '/workspace/mail/thread/inbox/new',
  });

  writeSessionMessage(agentGroupId, session.id, {
    id: crypto.randomUUID(),
    kind: 'maildir-wake',
    timestamp: new Date().toISOString(),
    content,
    trigger: 1,
  });

  log.info('Thread dispatch', {
    folder,
    threadId,
    agentGroupId,
    sessionId: session.id,
    count: dispatched.length,
  });

  wakeContainer(session).catch((err) => {
    log.error('Thread dispatch: container wake failed', { folder, threadId, err });
  });
}

/**
 * Dispatch messages without a Thread-ID to the agent-shared session.
 */
function dispatchUnthreaded(
  folder: string,
  agentGroupId: string,
  files: { name: string; fullPath: string }[],
  inboxNew: string,
): void {
  const { session } = resolveSession(agentGroupId, null, null, 'agent-shared');
  const inboxCur = path.join(path.dirname(inboxNew), 'cur');

  for (const file of files) {
    try {
      fs.renameSync(file.fullPath, path.join(inboxCur, `${file.name}:2,S`));
    } catch (err) {
      log.warn('Unthreaded dispatch: failed to move to cur/', { file: file.name, err });
    }
  }

  const noun = files.length === 1 ? 'message' : 'messages';
  const content = JSON.stringify({
    type: 'maildir-wake',
    text: `You have ${files.length} unread ${noun} in mail/inbox/new. Read and process them.`,
    inboxNew: '/workspace/mail/inbox/new',
  });

  writeSessionMessage(agentGroupId, session.id, {
    id: crypto.randomUUID(),
    kind: 'maildir-wake',
    timestamp: new Date().toISOString(),
    content,
    trigger: 1,
  });

  log.info('Unthreaded dispatch', { folder, agentGroupId, sessionId: session.id, count: files.length });
  wakeContainer(session).catch((err) => {
    log.error('Unthreaded dispatch: container wake failed', { folder, err });
  });
}

function fire(folder: string, inboxNew: string): void {
  const state = watchers.get(folder);
  if (state) {
    state.timer = null;
    state.deadline = null;
  }

  const agentGroup = getAgentGroupByFolder(folder);
  if (!agentGroup) {
    log.warn('Maildir wake: agent group not found for folder', { folder });
    return;
  }

  let fileNames: string[];
  try {
    fileNames = fs.readdirSync(inboxNew).filter((f) => !f.startsWith('.'));
  } catch {
    return;
  }
  if (fileNames.length === 0) return;

  // Group by Thread-ID
  const threadGroups = new Map<string, { name: string; fullPath: string }[]>();
  const unthreaded: { name: string; fullPath: string }[] = [];

  for (const name of fileNames) {
    const fullPath = path.join(inboxNew, name);
    const threadId = parseThreadId(fullPath);
    if (threadId) {
      let group = threadGroups.get(threadId);
      if (!group) {
        group = [];
        threadGroups.set(threadId, group);
      }
      group.push({ name, fullPath });
    } else {
      unthreaded.push({ name, fullPath });
    }
  }

  // Dispatch each thread group to its own session
  for (const [threadId, files] of threadGroups) {
    dispatchThread(folder, agentGroup.id, threadId, files, inboxNew);
  }

  // Fallback: unthreaded messages go to agent-shared
  if (unthreaded.length > 0) {
    dispatchUnthreaded(folder, agentGroup.id, unthreaded, inboxNew);
  }
}

function schedule(folder: string, inboxNew: string): void {
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

  state.timer = setTimeout(() => fire(folder, inboxNew), delay);
}

/** Watch a single agent group's mail/inbox/new directory. Idempotent. */
export function watchMaildir(folder: string): void {
  const inboxNew = inboxNewPath(folder);

  if (watchers.has(folder)) return;
  if (!fs.existsSync(inboxNew)) return;

  let watcher: fs.FSWatcher;
  try {
    watcher = fs.watch(inboxNew, { persistent: false }, (event) => {
      if (event === 'rename') schedule(folder, inboxNew);
    });
  } catch (err) {
    log.warn('Maildir watcher: could not watch directory', { folder, inboxNew, err });
    return;
  }

  watcher.on('error', (err) => {
    log.warn('Maildir watcher error — stopping watch for folder', { folder, err });
    stopWatchingMaildir(folder);
  });

  watchers.set(folder, { watcher, timer: null, deadline: null });
  log.info('Maildir watcher started', { folder, inboxNew });
}

/** Stop watching a single folder. */
export function stopWatchingMaildir(folder: string): void {
  const state = watchers.get(folder);
  if (!state) return;
  if (state.timer !== null) clearTimeout(state.timer);
  state.watcher.close();
  watchers.delete(folder);
}

/**
 * Start watching all agent group folders that have a mail/inbox/new directory.
 * Called from src/index.ts after DB init.
 */
export function startMaildirWatcher(): void {
  if (!fs.existsSync(GROUPS_DIR)) return;

  const folders = fs
    .readdirSync(GROUPS_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name);

  for (const folder of folders) {
    watchMaildir(folder);
  }

  log.info('Maildir watcher started', { watchedCount: watchers.size });
}

/** Stop all watchers. Called from shutdown. */
export function stopMaildirWatcher(): void {
  for (const folder of [...watchers.keys()]) {
    stopWatchingMaildir(folder);
  }
}
