/**
 * SQLite session-DB corruption, registered as a repair-agent trigger (see
 * repair-agent.ts for the shared two-tier approval/exec/breakfix engine).
 * Fired from delivery.ts's onSessionDbCorrupted event, which already ran
 * integrity_check and knows exactly which file and session — so this trigger
 * skips the generic whitelist match and calls offerRepairIfWhitelisted
 * directly with the trigger id.
 */
import { onSessionDbCorrupted, type SessionDbCorruptedEvent } from '../../delivery.js';
import { restartAgentGroupContainers } from '../../container-restart.js';
import { openInboundDb, openOutboundDb } from '../../session-manager.js';
import { offerRepairIfWhitelisted, registerRepairTrigger, type RepairContext } from './repair-agent.js';

const TRIGGER_ID = 'sqlite-corruption';

registerRepairTrigger({
  id: TRIGGER_ID,
  title: 'Session DB corrupted',
  summarize: (ctx) => (ctx.detail.integrityCheck as string[]).slice(0, 5),
  structuredPrompt: (ctx) => {
    const db = ctx.detail.db as string;
    const integrityCheck = ctx.detail.integrityCheck as string[];
    return (
      `SQLite database /workspace/${db}.db failed pragma integrity_check with:\n` +
      integrityCheck.join('\n') +
      `\n\nBack it up first (copy to /workspace/${db}.db.corrupt-backup-<timestamp>), then repair it via ` +
      `\`sqlite3 /workspace/${db}.db ".recover"\` piped into a fresh database file, verify the recovered file ` +
      `passes integrity_check, and if so replace the original with it (keep journal_mode=DELETE). ` +
      `Do not touch any other file. Report concisely: what you did, whether verification passed, and if not, ` +
      `what specifically didn't work — a competent person picking this up next needs to know where you left off.`
    );
  },
  freeformPrompt: (ctx, previousReport) => {
    const db = ctx.detail.db as string;
    const integrityCheck = ctx.detail.integrityCheck as string[];
    return (
      `SQLite database at data/v2-sessions/${ctx.agentGroupId}/${ctx.sessionId}/${db}.db is still failing ` +
      `pragma integrity_check after a first repair attempt (which ran scoped to that file only, inside the ` +
      `session's container at /workspace/${db}.db — same file, different path).\n\n` +
      `Original integrity_check output:\n${integrityCheck.join('\n')}\n\n` +
      `Previous attempt's report:\n${previousReport}\n\n` +
      `Go fix it — diagnose why the previous attempt didn't fully resolve the corruption. This may be a bug in ` +
      `how nanoclaw writes this DB (see docs/db-session.md, src/delivery.ts, container/agent-runner/src/db/) ` +
      `rather than just bad bytes — you have the full repo, fix it at whichever layer is actually broken. ` +
      `Report what you did and the final integrity_check result.`
    );
  },
  stillBroken: (ctx) => {
    const db = ctx.detail.db as 'inbound' | 'outbound';
    try {
      const conn =
        db === 'outbound'
          ? openOutboundDb(ctx.agentGroupId, ctx.sessionId)
          : openInboundDb(ctx.agentGroupId, ctx.sessionId);
      try {
        const rows = conn.pragma('integrity_check') as Array<{ integrity_check: string }>;
        return !(rows.length === 1 && rows[0].integrity_check === 'ok');
      } finally {
        conn.close();
      }
    } catch {
      return true;
    }
  },
  onRecovered: (ctx) => {
    restartAgentGroupContainers(
      ctx.agentGroupId,
      'db self-repair',
      'Recovered from database corrupted state — possible session state data loss.',
    );
  },
});

onSessionDbCorrupted((event: SessionDbCorruptedEvent) => {
  const ctx: RepairContext = {
    sessionId: event.sessionId,
    agentGroupId: event.agentGroupId,
    detail: { db: event.db, integrityCheck: event.integrityCheck },
  };
  offerRepairIfWhitelisted(TRIGGER_ID, ctx);
});
