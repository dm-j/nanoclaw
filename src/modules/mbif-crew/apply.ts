/**
 * Guarded handler body for `mbif_crew_prompt`.
 *
 * Runs on approve only (the delivery registry's guard wrapper — see
 * ./guard.ts). Invokes the real `claude` CLI headless, cwd set to the vault,
 * so it picks up the vault's own MBIF-crew `.claude/agents/` and CLAUDE.md —
 * no --model / ANTHROPIC_BASE_URL override, this runs as the vault's own
 * Claude Code, same as if David ran it from a terminal there.
 *
 * Fire-and-forget from the requesting agent's perspective (the MCP tool
 * already returned "submitted" before this ever runs) — the agent is
 * notified only once this resolves, success or failure.
 */
import { spawn } from 'child_process';

import { readEnvFile } from '../../env.js';
import { log } from '../../log.js';
import type { Session } from '../../types.js';
import { notifyAgent } from '../approvals/index.js';
import { appendMbifCrewLog } from './log.js';

const env = readEnvFile(['MBIF_VAULT_PATH', 'MBIF_BRIEFER_OAUTH_TOKEN']);
const VAULT_PATH = process.env.MBIF_VAULT_PATH || env.MBIF_VAULT_PATH;
// Same launchd/Keychain workaround as the Briefer (see memory-briefing/briefer.ts) —
// this also spawns `claude` from the host daemon's own audit session.
const OAUTH_TOKEN = process.env.MBIF_BRIEFER_OAUTH_TOKEN || env.MBIF_BRIEFER_OAUTH_TOKEN;

const MBIF_CREW_TIMEOUT_MS = 10 * 60_000;

const RESPONSE_SUFFIX =
  "\n\nRespond as concisely as possible, using bullet points if appropriate. A simple 'OK' " +
  'is acceptable as a confirmation for a successful command that does not require elaboration in its answer.';

// Serializes agent-initiated vault actions — never let two run concurrently,
// so each instruction's pre/post git checkpoint brackets exactly its own
// changes (a concurrent run would interleave commits and break rollback).
// Briefer/wikilink-cache vault reads are unaffected — this lock is scoped to
// this module only.
let vaultLock: Promise<void> = Promise.resolve();

export async function applyMbifCrewPrompt(payload: Record<string, unknown>, session: Session): Promise<void> {
  const instruction = typeof payload.instruction === 'string' ? payload.instruction : '';
  if (!instruction) return; // precheck already answered the requester

  if (!VAULT_PATH) {
    notifyAgent(session, 'mbif_crew_prompt approved but MBIF_VAULT_PATH is not configured.');
    return;
  }

  const run = vaultLock.then(async () => {
    log.info('mbif_crew_prompt approved, running', { agentGroupId: session.agent_group_id });
    let preCommit: string | undefined;
    let postCommit: string | undefined;
    try {
      await gitCommit('mbif-crew: pre-instruction checkpoint');
      preCommit = await gitHead();
      const result = await runClaudeCode(instruction + RESPONSE_SUFFIX);
      await gitCommit(`mbif-crew: ${instruction.slice(0, 72)}`);
      postCommit = await gitHead();
      appendMbifCrewLog({
        agentGroupId: session.agent_group_id,
        instruction,
        outcome: 'approved',
        preCommit,
        postCommit,
      });
      notifyAgent(session, `MBIF crew instruction complete:\n\n${result}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      appendMbifCrewLog({
        agentGroupId: session.agent_group_id,
        instruction,
        outcome: 'approved',
        preCommit,
        postCommit,
        error: message,
      });
      notifyAgent(session, `MBIF crew instruction failed: ${message}`);
    }
  });
  // Swallow so one failed run doesn't wedge the lock for the next queued one.
  vaultLock = run.catch(() => {});
  await run;
}

/** Best-effort — "nothing to commit" (no changes) is expected and not an error. */
function gitCommit(message: string): Promise<void> {
  return new Promise((resolve) => {
    const proc = spawn('git', ['add', '-A'], { cwd: VAULT_PATH, stdio: 'ignore' });
    proc.on('close', () => {
      const commit = spawn('git', ['commit', '-m', message], { cwd: VAULT_PATH, stdio: 'ignore' });
      commit.on('close', () => resolve());
      commit.on('error', (err) => {
        log.warn('mbif-crew git commit failed (non-fatal)', { err });
        resolve();
      });
    });
    proc.on('error', (err) => {
      log.warn('mbif-crew git add failed (non-fatal)', { err });
      resolve();
    });
  });
}

function gitHead(): Promise<string | undefined> {
  return new Promise((resolve) => {
    const proc = spawn('git', ['rev-parse', 'HEAD'], { cwd: VAULT_PATH, stdio: ['ignore', 'pipe', 'ignore'] });
    const stdout: Buffer[] = [];
    proc.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    proc.on('close', (code) => resolve(code === 0 ? Buffer.concat(stdout).toString('utf-8').trim() : undefined));
    proc.on('error', () => resolve(undefined));
  });
}

function runClaudeCode(prompt: string): Promise<string> {
  const spawnEnv = { ...process.env, ...(OAUTH_TOKEN ? { CLAUDE_CODE_OAUTH_TOKEN: OAUTH_TOKEN } : {}) };
  const args = ['-p', '--output-format', 'json', '--no-session-persistence', prompt];

  return new Promise<string>((resolve, reject) => {
    const proc = spawn('claude', args, { cwd: VAULT_PATH, env: spawnEnv, stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout: Buffer[] = [];
    const stderr: string[] = [];

    const timer = setTimeout(() => {
      proc.kill('SIGTERM');
      reject(new Error(`mbif crew instruction timed out after ${MBIF_CREW_TIMEOUT_MS}ms`));
    }, MBIF_CREW_TIMEOUT_MS);

    proc.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    proc.stderr.on('data', (chunk: Buffer) => stderr.push(chunk.toString()));
    proc.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`claude exited ${code}: ${stderr.join('') || Buffer.concat(stdout).toString('utf-8')}`));
        return;
      }
      try {
        const parsed = JSON.parse(Buffer.concat(stdout).toString('utf-8'));
        resolve(parsed.result ?? '(no result text)');
      } catch (err) {
        reject(new Error(`claude produced invalid JSON: ${(err as Error).message}`));
      }
    });
  });
}
