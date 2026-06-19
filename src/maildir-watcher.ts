/**
 * Maildir inbox watcher.
 *
 * Watches agents/<folder>/mail/inbox/new/ for arriving RFC822 messages.
 * When files appear, debounces for up to DEBOUNCE_MAX_MS then:
 *   1. Resolves the agent group from the folder name.
 *   2. Resolves or creates an agent-shared session.
 *   3. Writes a synthetic maildir-wake message to inbound.db.
 *   4. Wakes the container.
 *
 * One watcher is created per agent group that has a mail/inbox/new directory.
 * Watchers are started by startMaildirWatcher() and torn down by stopMaildirWatcher().
 */
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

import { GROUPS_DIR } from './config.js';
import { wakeContainer } from './container-runner.js';
import { getAgentGroupByFolder } from './db/agent-groups.js';
import { log } from './log.js';
import { resolveSession, writeSessionMessage } from './session-manager.js';

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

function countNewMessages(inboxNew: string): number {
  try {
    return fs.readdirSync(inboxNew).filter((f) => !f.startsWith('.')).length;
  } catch {
    return 0;
  }
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

  const count = countNewMessages(inboxNew);
  if (count === 0) return;

  const { session } = resolveSession(agentGroup.id, null, null, 'agent-shared');

  const noun = count === 1 ? 'message' : 'messages';
  const content = JSON.stringify({
    type: 'maildir-wake',
    text: `You have ${count} unread ${noun} in mail/inbox/new. Read and process them.`,
    inboxNew: '/workspace/mail/inbox/new',
  });

  writeSessionMessage(agentGroup.id, session.id, {
    id: crypto.randomUUID(),
    kind: 'maildir-wake',
    timestamp: new Date().toISOString(),
    content,
    trigger: 1,
  });

  log.info('Maildir wake', { folder, agentGroupId: agentGroup.id, sessionId: session.id, count });
  wakeContainer(session).catch((err) => {
    log.error('Maildir wake: container wake failed', { folder, err });
  });
}

function schedule(folder: string, inboxNew: string): void {
  const state = watchers.get(folder);
  if (!state) return;

  const now = Date.now();

  if (state.timer === null) {
    // First event in this batch — set the deadline.
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
