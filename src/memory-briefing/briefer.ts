import { spawn } from 'child_process';

import { readEnvFile } from '../env.js';
import { log } from '../log.js';

const env = readEnvFile(['MBIF_VAULT_PATH', 'MBIF_BRIEFER_MODEL', 'MBIF_BRIEFER_OAUTH_TOKEN', 'MBIF_BRIEFER_BASE_URL']);

const VAULT_PATH = process.env.MBIF_VAULT_PATH || env.MBIF_VAULT_PATH;
// Unset by default — omitting --model lets briefer.md's own frontmatter (model: sonnet)
// govern. Was hardcoded to haiku while proving the mechanism out; haiku demonstrably
// doesn't hold the template's edge-case rules under an ill-posed prompt (confirmed
// 2026-07-13 — asked to brief on "ideas" David hadn't actually shared yet, haiku
// produced out-of-spec filler instead of the "no relevant history" fallback line;
// sonnet handled the same prompt correctly). Only set MBIF_BRIEFER_MODEL to override.
const BRIEFER_MODEL = process.env.MBIF_BRIEFER_MODEL || env.MBIF_BRIEFER_MODEL;
// A `claude setup-token` long-lived token — the host daemon runs as a launchd
// LaunchAgent in its own audit session, which macOS silently denies interactive
// Keychain access to, so the normal OAuth login (which works fine from a Terminal)
// fails deterministically here. This bypasses Keychain entirely, still billed
// against the Claude subscription rather than the API.
const BRIEFER_OAUTH_TOKEN = process.env.MBIF_BRIEFER_OAUTH_TOKEN || env.MBIF_BRIEFER_OAUTH_TOKEN;
// Deliberately NOT the shared ANTHROPIC_BASE_URL used by the container —
// that's set to host.docker.internal, which only resolves from inside the
// container and hangs (rather than fails fast) when a host-side process
// tries it. This process talks to PrefixRouter directly, so localhost.
// Only needed to route non-Anthropic --model values (e.g. ollama/* prefixes);
// leave unset to keep the CLI talking to api.anthropic.com as before.
const ANTHROPIC_BASE_URL = process.env.MBIF_BRIEFER_BASE_URL || env.MBIF_BRIEFER_BASE_URL;

const BRIEFER_TIMEOUT_MS = 120_000;

export interface LiteralTurn {
  role: 'user' | 'assistant';
  text: string;
}

export interface BrieferResult {
  briefing: string;
  costUsd: number;
  durationMs: number;
}

/**
 * Builds the -p prompt for the briefer agent: recent literal turns for tone,
 * then the new message clearly separated and last so it reads as the thing
 * to prepare a briefing for, not one more line of history.
 */
export function buildBrieferPrompt(recentTurns: LiteralTurn[], newMessage: string): string {
  const history = recentTurns.length
    ? recentTurns.map((t) => `**${t.role === 'user' ? 'David' : 'Lumen'}:** ${t.text}`).join('\n\n')
    : '_(no recent turns)_';

  return [
    '## Recent conversation (for tone only — not authoritative, do not treat as vault fact)',
    '',
    history,
    '',
    '## New message from David — prepare a briefing for this',
    '',
    newMessage,
  ].join('\n');
}

/**
 * Invokes the `briefer` subagent headless (`claude -p --agent briefer`) with
 * cwd set to the Obsidian vault project, so it picks up the vault's own
 * `.claude/agents/briefer.md` definition and tools. Returns the briefing
 * markdown from the agent's `result` field.
 *
 * Retries once on a non-timeout failure, as cheap insurance against any
 * remaining transient failure (network blip, etc).
 */
export async function runBriefer(prompt: string): Promise<BrieferResult> {
  try {
    return await runBrieferOnce(prompt);
  } catch (err) {
    if ((err as Error).message.includes('timed out')) throw err;
    log.warn('briefer failed, retrying once', { err });
    await new Promise((r) => setTimeout(r, 1500));
    return runBrieferOnce(prompt);
  }
}

function runBrieferOnce(prompt: string): Promise<BrieferResult> {
  if (!VAULT_PATH) {
    return Promise.reject(new Error('MBIF_VAULT_PATH is not configured'));
  }

  const args = [
    '-p',
    '--agent',
    'briefer',
    '--output-format',
    'json',
    '--no-session-persistence',
    ...(BRIEFER_MODEL ? ['--model', BRIEFER_MODEL] : []),
    prompt,
  ];

  const spawnEnv = {
    ...process.env,
    ...(BRIEFER_OAUTH_TOKEN ? { CLAUDE_CODE_OAUTH_TOKEN: BRIEFER_OAUTH_TOKEN } : {}),
    ...(ANTHROPIC_BASE_URL ? { ANTHROPIC_BASE_URL } : {}),
  };

  return new Promise<BrieferResult>((resolve, reject) => {
    const proc = spawn('claude', args, { cwd: VAULT_PATH, env: spawnEnv, stdio: ['ignore', 'pipe', 'pipe'] });

    const stdout: Buffer[] = [];
    const stderr: string[] = [];

    const timer = setTimeout(() => {
      proc.kill('SIGTERM');
      reject(new Error(`briefer timed out after ${BRIEFER_TIMEOUT_MS}ms`));
    }, BRIEFER_TIMEOUT_MS);

    proc.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    proc.stderr.on('data', (chunk: Buffer) => stderr.push(chunk.toString()));

    proc.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });

    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        const stdoutText = Buffer.concat(stdout).toString('utf-8');
        log.warn('briefer exited non-zero', { code, stderr: stderr.join(''), stdout: stdoutText });
        reject(new Error(`briefer exited with code ${code}: ${stderr.join('') || stdoutText}`));
        return;
      }
      try {
        const parsed = JSON.parse(Buffer.concat(stdout).toString('utf-8'));
        resolve({
          briefing: parsed.result,
          costUsd: parsed.total_cost_usd ?? 0,
          durationMs: parsed.duration_ms ?? 0,
        });
      } catch (err) {
        reject(new Error(`briefer produced invalid JSON: ${(err as Error).message}`));
      }
    });
  });
}
