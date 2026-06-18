/**
 * Maildir egress — watches agent outbox Maildirs for new messages and
 * delivers them via the appropriate channel adapter.
 *
 * Each outbox dir has a `.binding` file with routing metadata (Channel-Type,
 * Chat-ID, etc.). When a file appears in `new/`, we read it, extract the
 * body, deliver via the channel adapter, and move to `cur/` with `:2,SP`.
 */
import fs from 'fs';
import path from 'path';

import { getChannelAdapter } from './channels/channel-registry.js';
import { GROUPS_DIR } from './config.js';
import { log } from './log.js';

const DEBOUNCE_MS = 300;
const DEBOUNCE_MAX_MS = 1500;

interface OutboxWatch {
  watcher: fs.FSWatcher;
  timer: ReturnType<typeof setTimeout> | null;
  deadline: number | null;
  binding: OutboxBinding;
  newDir: string;
}

interface OutboxBinding {
  channelType: string;
  chatId: string;
  platformId: string;
  displayName?: string;
  isGroup?: boolean;
}

function parseBinding(bindingPath: string): OutboxBinding | null {
  try {
    const raw = fs.readFileSync(bindingPath, 'utf-8');
    const headers: Record<string, string> = {};
    for (const line of raw.split('\n')) {
      const colon = line.indexOf(':');
      if (colon < 0) continue;
      headers[line.slice(0, colon).trim()] = line.slice(colon + 1).trim();
    }
    if (!headers['Channel-Type'] || !headers['Chat-ID']) return null;
    return {
      channelType: headers['Channel-Type'],
      chatId: headers['Chat-ID'],
      platformId: headers['Platform-ID'] ?? `${headers['Channel-Type']}:${headers['Chat-ID']}`,
      displayName: headers['Display-Name'],
      isGroup: headers['Is-Group'] === 'true',
    };
  } catch {
    return null;
  }
}

function parseRfc822Body(filePath: string): string | null {
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const blankLine = raw.indexOf('\n\n');
    if (blankLine < 0) return raw.trim();
    return raw.slice(blankLine + 2).trim();
  } catch {
    return null;
  }
}

function moveToRead(filePath: string): void {
  const dir = path.dirname(filePath);
  const parent = path.dirname(dir);
  const curDir = path.join(parent, 'cur');
  const basename = path.basename(filePath);
  const dest = path.join(curDir, `${basename}:2,SP`);
  try {
    fs.renameSync(filePath, dest);
  } catch (err) {
    log.warn('Maildir egress: failed to move to cur/', { filePath, err });
  }
}

function moveToFailed(filePath: string): void {
  const dir = path.dirname(filePath);
  const parent = path.dirname(dir);
  const curDir = path.join(parent, 'cur');
  const basename = path.basename(filePath);
  const dest = path.join(curDir, `${basename}:2,F`);
  try {
    fs.renameSync(filePath, dest);
  } catch (err) {
    log.warn('Maildir egress: failed to move failed message to cur/', { filePath, err });
  }
}

async function processOutbox(newDir: string, binding: OutboxBinding): Promise<void> {
  let files: string[];
  try {
    files = fs.readdirSync(newDir).filter((f) => !f.startsWith('.'));
  } catch {
    return;
  }

  if (files.length === 0) return;

  const adapter = getChannelAdapter(binding.channelType);
  if (!adapter) {
    log.warn('Maildir egress: no adapter for channel type', { channelType: binding.channelType });
    return;
  }

  for (const file of files) {
    const filePath = path.join(newDir, file);
    const body = parseRfc822Body(filePath);
    if (!body) {
      log.warn('Maildir egress: could not parse message', { filePath });
      moveToFailed(filePath);
      continue;
    }

    try {
      await adapter.deliver(binding.platformId, null, {
        kind: 'chat',
        content: { text: body },
      });
      moveToRead(filePath);
      log.debug('Maildir egress delivered', {
        channelType: binding.channelType,
        chatId: binding.chatId,
        file,
      });
    } catch (err) {
      log.error('Maildir egress delivery failed', { filePath, err });
      moveToFailed(filePath);
    }
  }
}

const watches = new Map<string, OutboxWatch>();

function scheduleProcess(key: string): void {
  const state = watches.get(key);
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

  state.timer = setTimeout(() => {
    state.timer = null;
    state.deadline = null;
    processOutbox(state.newDir, state.binding).catch((err) => {
      log.error('Maildir egress: processOutbox threw', { key, err });
    });
  }, delay);
}

function watchOutbox(newDir: string, binding: OutboxBinding): void {
  if (watches.has(newDir)) return;

  let watcher: fs.FSWatcher;
  try {
    watcher = fs.watch(newDir, { persistent: false }, (event) => {
      if (event === 'rename') scheduleProcess(newDir);
    });
  } catch (err) {
    log.warn('Maildir egress: could not watch outbox', { newDir, err });
    return;
  }

  watcher.on('error', (err) => {
    log.warn('Maildir egress watcher error', { newDir, err });
    stopWatchingOutbox(newDir);
  });

  watches.set(newDir, { watcher, timer: null, deadline: null, binding, newDir });
  log.info('Maildir egress watcher started', { newDir, channelType: binding.channelType });
}

function stopWatchingOutbox(key: string): void {
  const state = watches.get(key);
  if (!state) return;
  if (state.timer !== null) clearTimeout(state.timer);
  state.watcher.close();
  watches.delete(key);
}

/**
 * Discover all outbox Maildirs across all agent groups and start watching
 * their `new/` directories. Called from `src/index.ts` at startup.
 */
export function startMaildirEgress(): void {
  if (!fs.existsSync(GROUPS_DIR)) return;

  const folders = fs
    .readdirSync(GROUPS_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name);

  let watchedCount = 0;
  for (const folder of folders) {
    const outDir = path.join(GROUPS_DIR, folder, 'mail', 'out');
    if (!fs.existsSync(outDir)) continue;

    // Walk out/<channel>/<address>/ looking for .binding files.
    for (const channel of fs.readdirSync(outDir, { withFileTypes: true })) {
      if (!channel.isDirectory()) continue;
      const channelDir = path.join(outDir, channel.name);
      discoverOutboxesIn(channelDir);
    }
  }

  // Count after discovery.
  watchedCount = watches.size;
  if (watchedCount > 0) {
    log.info('Maildir egress started', { watchedCount });
  }
}

function discoverOutboxesIn(dir: string): void {
  // Check if this dir itself has a .binding.
  const bindingFile = path.join(dir, '.binding');
  if (fs.existsSync(bindingFile)) {
    const binding = parseBinding(bindingFile);
    if (binding) {
      const newDir = path.join(dir, 'new');
      if (fs.existsSync(newDir)) {
        watchOutbox(newDir, binding);
      }
    }
    return;
  }

  // Recurse into subdirs (handles nested address paths like direct/dmj).
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory() && !['tmp', 'new', 'cur'].includes(entry.name)) {
        discoverOutboxesIn(path.join(dir, entry.name));
      }
    }
  } catch {
    // ignore
  }
}

/**
 * Watch a newly created outbox. Called by maildir-ingress when it scaffolds
 * an outbox on first message.
 */
export function watchNewOutbox(folder: string, channelType: string, addressPath: string): void {
  const outboxDir = path.join(GROUPS_DIR, folder, 'mail', 'out', channelType, addressPath);
  const bindingFile = path.join(outboxDir, '.binding');
  const binding = parseBinding(bindingFile);
  if (!binding) return;
  const newDir = path.join(outboxDir, 'new');
  if (fs.existsSync(newDir)) {
    watchOutbox(newDir, binding);
  }
}

/** Stop all egress watchers. Called from shutdown. */
export function stopMaildirEgress(): void {
  for (const key of [...watches.keys()]) {
    stopWatchingOutbox(key);
  }
}
