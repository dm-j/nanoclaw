/**
 * Maildir inbox watcher for Mailman.
 *
 * Watches mailman/inbox/new/ for new RFC822 files.
 * On arrival: read → triage → fork (if escalation) → move to cur/.
 */
import fs from 'fs';
import path from 'path';

import { log } from '../log.js';
import { spawnFork, type EscalationPayload } from './fork.js';
import { notifyMainAgent } from './notify.js';
import { spawnSubagent } from './subagent.js';

const PROJECT_ROOT = path.resolve(import.meta.dirname, '../..');
const INBOX_NEW = path.join(PROJECT_ROOT, 'mailman/inbox/new');
const INBOX_CUR = path.join(PROJECT_ROOT, 'mailman/inbox/cur');

let watcher: fs.FSWatcher | null = null;
let debounceTimer: ReturnType<typeof setTimeout> | null = null;
const DEBOUNCE_MS = 500;

async function processFile(filePath: string): Promise<void> {
  const filename = path.basename(filePath);
  try {
    const rawEmail = fs.readFileSync(filePath, 'utf-8');
    if (!rawEmail.trim()) {
      log.warn('Empty email file, skipping', { filename });
      return;
    }

    log.info('Processing inbox message', { filename });

    const triageResult = await spawnSubagent(rawEmail);
    let flagSuffix = '';

    if (triageResult.action === 'notify_user') {
      const escalation: EscalationPayload = {
        finding: triageResult.summary,
        evidence: [`Sender: ${triageResult.sender}`, `Subject: ${triageResult.subject}`],
        subagent_reasoning: triageResult.reasoning,
        source: 'input_subagent',
      };

      const forkResult = await spawnFork(escalation);

      if (forkResult.agree) {
        flagSuffix = ':2,F'; // F = flagged (important)
        notifyMainAgent(triageResult, forkResult);
        log.info('Escalation agreed — notification sent', { filename, summary: forkResult.summary });
      } else {
        flagSuffix = ':2,S'; // S = seen (processed, disagreed)
        log.info('Escalation disagreed — discarded', { filename });
      }
    } else {
      flagSuffix = ':2,S'; // S = seen (deferred)
    }

    // Move new/ → cur/ with Maildir flags
    const destPath = path.join(INBOX_CUR, filename + flagSuffix);
    fs.renameSync(filePath, destPath);
    log.info('Moved to cur/', { filename: filename + flagSuffix });
  } catch (err) {
    log.error('Failed to process inbox message', { filename, err });
    // Move to cur/ with error flag so we don't retry forever
    try {
      fs.renameSync(filePath, path.join(INBOX_CUR, filename + ':2,'));
    } catch {
      // If even the move fails, leave it — manual intervention needed
    }
  }
}

async function sweep(): Promise<void> {
  let files: string[];
  try {
    files = fs.readdirSync(INBOX_NEW).filter((f) => !f.startsWith('.'));
  } catch {
    return;
  }

  for (const file of files) {
    await processFile(path.join(INBOX_NEW, file));
  }
}

export function startInboxWatcher(): void {
  fs.mkdirSync(INBOX_NEW, { recursive: true });
  fs.mkdirSync(INBOX_CUR, { recursive: true });

  // Process anything already sitting in new/
  sweep().catch((err) => log.error('Initial inbox sweep failed', { err }));

  watcher = fs.watch(INBOX_NEW, (_event, filename) => {
    if (!filename || filename.startsWith('.')) return;

    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      sweep().catch((err) => log.error('Inbox sweep failed', { err }));
    }, DEBOUNCE_MS);
  });

  log.info('Mailman inbox watcher started', { path: INBOX_NEW });
}

export function stopInboxWatcher(): void {
  if (watcher) {
    watcher.close();
    watcher = null;
  }
  if (debounceTimer) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }
  log.info('Mailman inbox watcher stopped');
}
