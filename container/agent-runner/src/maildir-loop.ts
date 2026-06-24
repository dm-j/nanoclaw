/**
 * Maildir-driven agent loop.
 *
 * Watches the thread inbox for new files via fs.watch (no DB polling).
 * When messages appear, reads them, formats a prompt, and queries the
 * provider. Each batch of messages gets its own turn.
 *
 * This replaces the inbound.db poll path for maildir-mode sessions,
 * eliminating the cross-mount SQLite corruption issue on Docker Desktop.
 */
import fs from 'fs';

import type { AgentProvider, ProviderEvent } from './providers/types.js';
import { touchHeartbeat } from './db/connection.js';

const DEBOUNCE_MS = 500;
const DEBOUNCE_MAX_MS = 2000;

function log(msg: string): void {
  console.error(`[maildir-loop] ${msg}`);
}

export interface MaildirLoopConfig {
  provider: AgentProvider;
  providerName: string;
  cwd: string;
  systemContext: { instructions: string };
  inboxNew: string;
  signal?: AbortSignal;
}

/**
 * Read all files in the inbox new/ dir, claim them to cur/:2,S,
 * and return their contents.
 */
function claimMessages(inboxNew: string): { name: string; content: string }[] {
  const curDir = inboxNew.replace(/\/new\/?$/, '/cur');
  let files: string[];
  try {
    files = fs.readdirSync(inboxNew).filter((f) => !f.startsWith('.'));
  } catch {
    return [];
  }

  const claimed: { name: string; content: string }[] = [];
  for (const name of files) {
    const src = `${inboxNew}/${name}`;
    try {
      const content = fs.readFileSync(src, 'utf-8');
      fs.renameSync(src, `${curDir}/${name}:2,S`);
      claimed.push({ name, content });
    } catch {
      // Another process claimed it, or read error — skip
    }
  }
  return claimed;
}

function formatPrompt(messages: { name: string; content: string }[]): string {
  const noun = messages.length === 1 ? 'message' : 'messages';
  const body = messages.map((m) => m.content).join('\n---\n');
  return `You have ${messages.length} new ${noun}. Process each one and write a reply to the Response-Maildir specified in each message.\n\n${body}`;
}

export async function runMaildirLoop(config: MaildirLoopConfig): Promise<void> {
  const { inboxNew } = config;

  if (!fs.existsSync(inboxNew)) {
    log(`Inbox not found: ${inboxNew} — falling back to poll loop`);
    return;
  }

  let continuation: string | undefined;

  // Process any messages already waiting
  const initial = claimMessages(inboxNew);
  if (initial.length > 0) {
    log(`Processing ${initial.length} initial message(s)`);
    continuation = await processMessages(initial, config, continuation);
  }

  // Watch for new messages
  log(`Watching ${inboxNew}`);

  let timer: ReturnType<typeof setTimeout> | null = null;
  let deadline: number | null = null;
  let processing = false;
  let pendingFire = false;

  const fire = async () => {
    timer = null;
    deadline = null;

    if (processing) {
      pendingFire = true;
      return;
    }

    const messages = claimMessages(inboxNew);
    if (messages.length === 0) return;

    processing = true;
    try {
      log(`Processing ${messages.length} message(s)`);
      continuation = await processMessages(messages, config, continuation);
    } finally {
      processing = false;
    }

    // Check for messages that arrived during processing
    if (pendingFire) {
      pendingFire = false;
      await fire();
    } else {
      // Also check in case fs.watch missed an event
      const more = claimMessages(inboxNew);
      if (more.length > 0) {
        await fire();
      }
    }
  };

  const schedule = () => {
    const now = Date.now();
    if (timer === null) {
      deadline = now + DEBOUNCE_MAX_MS;
    }
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    const remaining = deadline! - now;
    const delay = Math.min(DEBOUNCE_MS, Math.max(0, remaining));
    timer = setTimeout(() => { fire().catch((err) => log(`Error: ${err}`)); }, delay);
  };

  const watcher = fs.watch(inboxNew, { persistent: true }, (event) => {
    if (event === 'rename') schedule();
  });

  // Keep alive until aborted
  await new Promise<void>((resolve) => {
    if (config.signal) {
      config.signal.addEventListener('abort', () => {
        watcher.close();
        if (timer) clearTimeout(timer);
        resolve();
      });
    }
  });
}

async function processMessages(
  messages: { name: string; content: string }[],
  config: MaildirLoopConfig,
  continuation: string | undefined,
): Promise<string | undefined> {
  const prompt = formatPrompt(messages);

  const query = config.provider.query({
    prompt,
    continuation,
    cwd: config.cwd,
    systemContext: config.systemContext,
  });

  let newContinuation = continuation;

  try {
    for await (const event of query.events) {
      touchHeartbeat();

      if (event.type === 'init') {
        newContinuation = event.continuation;
      } else if (event.type === 'result') {
        if (event.text) {
          log(`Result: ${event.text.slice(0, 200)}`);
        } else {
          log('Result: (empty)');
        }
        query.end();
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`Query error: ${msg}`);

    if (continuation && config.provider.isSessionInvalid(err)) {
      log(`Stale session — clearing for next attempt`);
      newContinuation = undefined;
    }
  }

  return newContinuation;
}
