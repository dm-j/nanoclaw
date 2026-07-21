/**
 * Post-turn working-memory.md maintenance, done by a dedicated subagent
 * instead of by Lumen herself.
 *
 * Why: the in-turn instruction telling Lumen to end each turn by editing
 * working-memory.md (container/agent-runner/src/providers/claude.ts) has
 * caused her to occasionally treat the file edit as the terminal act of the
 * turn and wrap the whole reply in <internal> tags, silently swallowing the
 * message (incident 2026-07-19, recurred 2026-07-20). Moving the file edit
 * to a separate host-side subagent that runs *after* delivery removes the
 * failure mode instead of just rewording around it.
 *
 * Fire-and-forget on every delivered chat reply (onMessageDelivered,
 * src/delivery.ts) for any agent group with NANOCLAW_MEMORY_WRITER enabled.
 * Never blocks delivery, never throws into the caller.
 */
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

import { onMessageDelivered } from '../../delivery.js';
import { getContainerConfig } from '../../db/container-configs.js';
import { inboundDbPath } from '../../session-manager.js';
import { openInboundDb } from '../../db/session-db.js';
import { readEnvFile } from '../../env.js';
import { log } from '../../log.js';
import type { OutboundMessage } from '../../db/session-db.js';

const env = readEnvFile([
  'MBIF_VAULT_PATH',
  'MBIF_MEMORY_WRITER_MODEL',
  'MBIF_MEMORY_WRITER_BASE_URL',
  'MBIF_BRIEFER_OAUTH_TOKEN',
  'MBIF_BRIEFER_BASE_URL',
]);
const VAULT_PATH = process.env.MBIF_VAULT_PATH || env.MBIF_VAULT_PATH;
const MEMORY_WRITER_MODEL = process.env.MBIF_MEMORY_WRITER_MODEL || env.MBIF_MEMORY_WRITER_MODEL;
// Deliberately not the container's ANTHROPIC_BASE_URL (host.docker.internal —
// only resolves inside a container, hangs from a host process). Reuses the
// briefer's host-side PrefixRouter route (localhost) unless overridden, since
// this runs from the same host daemon for the same reason.
const MEMORY_WRITER_BASE_URL =
  process.env.MBIF_MEMORY_WRITER_BASE_URL ||
  env.MBIF_MEMORY_WRITER_BASE_URL ||
  process.env.MBIF_BRIEFER_BASE_URL ||
  env.MBIF_BRIEFER_BASE_URL;
// Reuses the briefer's long-lived setup-token — see briefer.ts for why
// interactive OAuth login can't work from this launchd-run host process.
const MEMORY_WRITER_OAUTH_TOKEN = process.env.MBIF_BRIEFER_OAUTH_TOKEN || env.MBIF_BRIEFER_OAUTH_TOKEN;
const MEMORY_WRITER_TIMEOUT_MS = 60_000;
const WORKING_MEMORY_REL_PATH = 'Meta/working-memory.md';

function enabledFor(agentGroupId: string): boolean {
  const config = getContainerConfig(agentGroupId);
  if (!config?.env) return false;
  try {
    const parsedEnv = JSON.parse(config.env) as Record<string, string>;
    return parsedEnv.NANOCLAW_MEMORY_WRITER === '1' || parsedEnv.NANOCLAW_MEMORY_WRITER === 'true';
  } catch {
    return false;
  }
}

function extractText(content: string): string {
  try {
    const parsed = JSON.parse(content) as { text?: string };
    return parsed.text ?? content;
  } catch {
    return content;
  }
}

function lookupUserMessage(agentGroupId: string, sessionId: string, inReplyTo: string | null): string {
  if (!inReplyTo) return '_(no triggering user message — system/scheduled turn)_';
  try {
    const db = openInboundDb(inboundDbPath(agentGroupId, sessionId));
    try {
      const row = db.prepare('SELECT content FROM messages_in WHERE id = ?').get(inReplyTo) as
        | { content: string }
        | undefined;
      return row ? extractText(row.content) : '_(original message not found)_';
    } finally {
      db.close();
    }
  } catch (err) {
    log.warn('memory-writer: failed to look up triggering message', { err });
    return '_(failed to read triggering message)_';
  }
}

function buildPrompt(userText: string, replyText: string, current: string): string {
  return [
    'You maintain one file: working-memory.md. That is your entire job — you have no other tools.',
    '',
    '## Current working-memory.md',
    '',
    current || '_(empty)_',
    '',
    '## This turn — the user said',
    '',
    userText,
    '',
    "## This turn — Lumen's reply",
    '',
    replyText,
    '',
    '## Task',
    '',
    "Update working-memory.md to reflect Lumen's own state after this turn — what SHE is doing,",
    'thinking, discussing, tracking, or letting simmer. This is not a project tracker or a log of',
    "user requests; it is Lumen's anchor for her own continuity across turns. Only file something",
    'if it is actually hers to carry forward — a settled fact that just lives in the vault, or a',
    'task fully handed off to the user, does not belong here.',
    '',
    'The file has one overwritten line and five fixed, capped sections:',
    '',
    '- Focus (1 line, overwritten every turn, no cap): what Lumen is actively engaged with right',
    '  now, this exchange. Replace it outright — it is not a log, it is a pointer to her present',
    '  train of thought.',
    '- Now (max 2): what Lumen is actively working on or thinking through across turns — she is',
    '  the one moving it, not waiting on anyone.',
    '- Open (max 2): questions Lumen is sitting with or is blocked on — waiting on a decision or',
    '  input from the user before she can proceed.',
    "- Soon (max 2): things Lumen has committed to doing next but hasn't started — queued in her",
    '  own mind, no blocker.',
    '- Watch (max 6): things Lumen is keeping half an eye on — nothing to do unless it changes,',
    "  she'll react if it does.",
    '- Back Burner (max 6): things Lumen is letting simmer — deprioritized, parked, not urgent,',
    '  but still hers, not forgotten.',
    '',
    'If a section is already at cap, either fold the new item into an existing bullet or bump the',
    'least-relevant existing item down a tier (Now -> Open -> Soon -> Watch -> Back Burner) or drop',
    'it if settled. Never add a bullet that pushes a section over its cap. If nothing worth',
    'recording changed, leave the file as is.',
    'Edit the file directly; do not reply with commentary.',
  ].join('\n');
}

function runMemoryWriter(prompt: string): Promise<void> {
  if (!VAULT_PATH) return Promise.reject(new Error('MBIF_VAULT_PATH is not configured'));

  const args = [
    '-p',
    '--output-format',
    'json',
    '--no-session-persistence',
    '--allowedTools',
    `Write(${WORKING_MEMORY_REL_PATH}),Edit(${WORKING_MEMORY_REL_PATH})`,
    ...(MEMORY_WRITER_MODEL ? ['--model', MEMORY_WRITER_MODEL] : []),
    prompt,
  ];

  const spawnEnv = {
    ...process.env,
    ...(MEMORY_WRITER_OAUTH_TOKEN ? { CLAUDE_CODE_OAUTH_TOKEN: MEMORY_WRITER_OAUTH_TOKEN } : {}),
    ...(MEMORY_WRITER_BASE_URL ? { ANTHROPIC_BASE_URL: MEMORY_WRITER_BASE_URL } : {}),
  };

  return new Promise<void>((resolve, reject) => {
    const proc = spawn('claude', args, { cwd: VAULT_PATH, env: spawnEnv, stdio: ['ignore', 'pipe', 'pipe'] });
    const stderr: string[] = [];

    const timer = setTimeout(() => {
      proc.kill('SIGTERM');
      reject(new Error(`memory-writer timed out after ${MEMORY_WRITER_TIMEOUT_MS}ms`));
    }, MEMORY_WRITER_TIMEOUT_MS);

    proc.stderr.on('data', (chunk: Buffer) => stderr.push(chunk.toString()));
    proc.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`memory-writer exited with code ${code}: ${stderr.join('')}`));
        return;
      }
      resolve();
    });
  });
}

onMessageDelivered((agentGroupId, sessionId, msg: OutboundMessage) => {
  if (msg.kind !== 'chat' || msg.channel_type === 'agent') return;
  if (!VAULT_PATH || !enabledFor(agentGroupId)) return;

  const replyText = extractText(msg.content);
  if (!replyText.trim()) return;

  const workingMemoryPath = path.join(VAULT_PATH, WORKING_MEMORY_REL_PATH);
  let current = '';
  try {
    current = fs.readFileSync(workingMemoryPath, 'utf-8');
  } catch {
    // Missing/unreadable — subagent gets "(empty)" and creates it via Write.
  }

  const userText = lookupUserMessage(agentGroupId, sessionId, msg.in_reply_to);
  const prompt = buildPrompt(userText, replyText, current);

  runMemoryWriter(prompt).catch((err) => {
    log.warn('memory-writer failed (non-fatal, working-memory.md left as is)', { agentGroupId, sessionId, err });
  });
});
