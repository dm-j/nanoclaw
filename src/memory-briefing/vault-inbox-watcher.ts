/**
 * Vault inbox watcher — watches the MBIF vault's 00-Inbox/ on the host and
 * invokes the vault's own /inbox-triage skill (headless `claude -p`) after a
 * 30-minute debounce, so a burst of drops (e.g. from the `remember` MCP
 * tool, or the user filing things by hand) only triggers one triage pass.
 *
 * Loop avoidance: triage moves files OUT of 00-Inbox, which fires more fs
 * events. Those just set `pendingDuringRun` and get folded into a fresh
 * 30-minute debounce window once the run finishes — never an immediate
 * re-trigger — and the empty-inbox check below means a window that closes
 * after triage already cleared the folder is a no-op, not another run.
 */
import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';

import { readEnvFile } from '../env.js';
import { log } from '../log.js';

const env = readEnvFile(['MBIF_VAULT_PATH', 'MBIF_BRIEFER_MODEL', 'MBIF_BRIEFER_OAUTH_TOKEN', 'MBIF_BRIEFER_BASE_URL']);

const VAULT_PATH = process.env.MBIF_VAULT_PATH || env.MBIF_VAULT_PATH;
const BRIEFER_MODEL = process.env.MBIF_BRIEFER_MODEL || env.MBIF_BRIEFER_MODEL;
const BRIEFER_OAUTH_TOKEN = process.env.MBIF_BRIEFER_OAUTH_TOKEN || env.MBIF_BRIEFER_OAUTH_TOKEN;
const ANTHROPIC_BASE_URL = process.env.MBIF_BRIEFER_BASE_URL || env.MBIF_BRIEFER_BASE_URL;

const DEBOUNCE_MS = 30 * 60 * 1000;
const TRIAGE_TIMEOUT_MS = 10 * 60 * 1000;

let watcher: fs.FSWatcher | null = null;
let debounceTimer: ReturnType<typeof setTimeout> | null = null;
let triageInFlight = false;
let pendingDuringRun = false;

function inboxDir(): string | undefined {
  return VAULT_PATH ? path.join(VAULT_PATH, '00-Inbox') : undefined;
}

function inboxHasFiles(dir: string): boolean {
  try {
    return fs.readdirSync(dir).some((f) => !f.startsWith('.'));
  } catch {
    return false;
  }
}

function runInboxTriage(): Promise<void> {
  return new Promise((resolve, reject) => {
    const args = [
      '-p',
      '--output-format',
      'json',
      '--no-session-persistence',
      ...(BRIEFER_MODEL ? ['--model', BRIEFER_MODEL] : []),
      '/inbox-triage',
    ];
    const spawnEnv = {
      ...process.env,
      ...(BRIEFER_OAUTH_TOKEN ? { CLAUDE_CODE_OAUTH_TOKEN: BRIEFER_OAUTH_TOKEN } : {}),
      ...(ANTHROPIC_BASE_URL ? { ANTHROPIC_BASE_URL } : {}),
    };

    const proc = spawn('claude', args, { cwd: VAULT_PATH, env: spawnEnv, stdio: ['ignore', 'pipe', 'pipe'] });
    const stderr: string[] = [];

    const timer = setTimeout(() => {
      proc.kill('SIGTERM');
      reject(new Error(`inbox-triage timed out after ${TRIAGE_TIMEOUT_MS}ms`));
    }, TRIAGE_TIMEOUT_MS);

    proc.stderr.on('data', (chunk: Buffer) => stderr.push(chunk.toString()));
    proc.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`inbox-triage exited with code ${code}: ${stderr.join('')}`));
        return;
      }
      resolve();
    });
  });
}

function scheduleTriage(): void {
  // Suppressed while a run is in flight — the sorter's own moves inside
  // 00-Inbox fire more fs events here, and re-arming the debounce off those
  // would just be racing the run that's already handling them. The
  // post-run check below picks back up once the run settles.
  if (triageInFlight) return;
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    fireTriage();
  }, DEBOUNCE_MS);
}

async function fireTriage(): Promise<void> {
  const dir = inboxDir();
  if (!dir || !inboxHasFiles(dir)) return;

  triageInFlight = true;
  try {
    log.info('Vault inbox triage starting');
    await runInboxTriage();
    log.info('Vault inbox triage finished');
  } catch (err) {
    log.error('Vault inbox triage failed', { err });
  } finally {
    triageInFlight = false;
    // Re-check the folder directly rather than trust a "something happened
    // mid-run" flag — covers coalesced/missed fs events too. Empty means
    // the run cleared it: stop. Non-empty (leftovers the sorter couldn't
    // file, or a genuinely new drop) gets one fresh debounce window.
    if (dir && inboxHasFiles(dir)) scheduleTriage();
  }
}

export function startVaultInboxWatcher(): void {
  const dir = inboxDir();
  if (!dir) {
    log.warn('MBIF_VAULT_PATH not configured, vault inbox watcher disabled');
    return;
  }
  fs.mkdirSync(dir, { recursive: true });

  watcher = fs.watch(dir, (_event, filename) => {
    if (!filename || filename.startsWith('.')) return;
    scheduleTriage();
  });

  log.info('Vault inbox watcher started', { path: dir });
}

export function stopVaultInboxWatcher(): void {
  if (watcher) {
    watcher.close();
    watcher = null;
  }
  if (debounceTimer) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }
  log.info('Vault inbox watcher stopped');
}
