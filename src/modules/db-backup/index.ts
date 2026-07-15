/**
 * Debounced session-DB backup.
 *
 * On inbound activity (onSessionActivity, fired by writeSessionMessage), a
 * per-session 30-minute debounce timer (re)starts. When it fires, both
 * inbound.db and outbound.db get snapshotted via SQLite's online backup API
 * (better-sqlite3's `db.backup()` — transaction-consistent, no torn copies
 * of a file that might be mid-write) into data/db-backups/<agentGroupId>/<sessionId>/pending/.
 *
 * A pending snapshot is unverified — it proves the file was copyable, not
 * that it's healthy. It's promoted to verified/ only once the next message
 * after it completes a full successful delivery (onMessageDelivered,
 * fired by delivery.ts): actual forward progress is the proof.
 *
 * If the host restarts before a pending snapshot gets promoted, the
 * in-memory `pending` map is lost and that snapshot just sits there
 * unverified forever, superseded by the next debounce cycle. Accepted
 * tradeoff, not a bug — an unverified copy is still strictly better than no
 * copy, and per-session backups are cheap.
 */
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

import { DATA_DIR } from '../../config.js';
import { onMessageDelivered } from '../../delivery.js';
import { log } from '../../log.js';
import { onSessionActivity, sessionDir } from '../../session-manager.js';

const DEBOUNCE_MS = 30 * 60_000;
const BACKUP_ROOT = path.join(DATA_DIR, 'db-backups');

function key(agentGroupId: string, sessionId: string): string {
  return `${agentGroupId}:${sessionId}`;
}

function backupDir(agentGroupId: string, sessionId: string, kind: 'pending' | 'verified'): string {
  return path.join(BACKUP_ROOT, agentGroupId, sessionId, kind);
}

async function snapshotFile(srcPath: string, destPath: string): Promise<void> {
  if (!fs.existsSync(srcPath)) return;
  fs.rmSync(destPath, { force: true });
  const src = new Database(srcPath, { readonly: true, fileMustExist: true });
  try {
    await src.backup(destPath);
  } finally {
    src.close();
  }
}

const debounceTimers = new Map<string, NodeJS.Timeout>();
const pending = new Map<string, { takenAt: string }>();

async function takeSnapshot(agentGroupId: string, sessionId: string): Promise<void> {
  const dir = backupDir(agentGroupId, sessionId, 'pending');
  const srcDir = sessionDir(agentGroupId, sessionId);
  try {
    fs.mkdirSync(dir, { recursive: true });
    await snapshotFile(path.join(srcDir, 'inbound.db'), path.join(dir, 'inbound.db'));
    await snapshotFile(path.join(srcDir, 'outbound.db'), path.join(dir, 'outbound.db'));
    const takenAt = new Date().toISOString();
    fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({ takenAt, verified: false }, null, 2));
    pending.set(key(agentGroupId, sessionId), { takenAt });
    log.info('db-backup: snapshot taken, awaiting verification', { agentGroupId, sessionId, dir });
  } catch (err) {
    log.error('db-backup: snapshot failed', { agentGroupId, sessionId, err });
  }
}

onSessionActivity((agentGroupId, sessionId) => {
  const k = key(agentGroupId, sessionId);
  const existing = debounceTimers.get(k);
  if (existing) clearTimeout(existing);
  debounceTimers.set(
    k,
    setTimeout(() => {
      debounceTimers.delete(k);
      takeSnapshot(agentGroupId, sessionId).catch((err) => log.error('db-backup: snapshot error', { err }));
    }, DEBOUNCE_MS),
  );
});

onMessageDelivered((agentGroupId, sessionId) => {
  const k = key(agentGroupId, sessionId);
  const entry = pending.get(k);
  if (!entry) return;

  const pendingDir = backupDir(agentGroupId, sessionId, 'pending');
  const verifiedDir = backupDir(agentGroupId, sessionId, 'verified');
  try {
    fs.rmSync(verifiedDir, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(verifiedDir), { recursive: true });
    fs.renameSync(pendingDir, verifiedDir);
    pending.delete(k);
    log.info('db-backup: snapshot verified (round-trip completed)', {
      agentGroupId,
      sessionId,
      takenAt: entry.takenAt,
    });
  } catch (err) {
    log.error('db-backup: failed to promote snapshot to verified', { agentGroupId, sessionId, err });
  }
});
