import { spawn } from 'child_process';
import { createInterface } from 'readline';

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

export interface ToolCallSummary {
  tool: string;
  detail: string;
  /** Wall-clock time since the previous stream-json line arrived, ms. */
  iterationMs: number;
}

export interface BrieferResult {
  briefing: string;
  costUsd: number;
  durationMs: number;
  toolCalls: ToolCallSummary[];
}

/**
 * Builds the -p prompt for the briefer agent: recent literal turns for tone,
 * then the new message clearly separated and last so it reads as the thing
 * to prepare a briefing for, not one more line of history.
 */
export function buildBrieferPrompt(recentTurns: LiteralTurn[], newMessage: string, previousBriefing?: string): string {
  const history = recentTurns.length
    ? recentTurns.map((t) => `**${t.role === 'user' ? 'David' : 'Lumen'}:** ${t.text}`).join('\n\n')
    : '_(no recent turns)_';

  return [
    '## Recent conversation (for tone only — not authoritative, do not treat as vault fact)',
    '',
    history,
    '',
    ...(previousBriefing
      ? ['## Your previous briefing (stale — update it, do not just repeat it)', '', previousBriefing, '']
      : []),
    '## New message from David — prepare a briefing for this',
    '',
    newMessage,
    '',
    '## Output constraint',
    '',
    'The briefing text is the whole response — do not append a `### Suggested next agent` or',
    '`### Post-it` section to it. Post-it is your own persistent state, written separately to',
    '`{{meta}}/states/briefer.md` per your instructions — it does not belong in the briefing output.',
  ].join('\n');
}

/** Per-call overrides — used by callers that need a different model/route than
 * the installation-wide MBIF_BRIEFER_MODEL/MBIF_BRIEFER_BASE_URL defaults,
 * without changing those defaults for every other caller (e.g. the on-demand
 * `recall` tool keeps using sonnet unless the operator sets the env vars). */
export interface BrieferOverrides {
  model?: string;
  baseUrl?: string;
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
export async function runBriefer(prompt: string, overrides?: BrieferOverrides): Promise<BrieferResult> {
  try {
    return await runBrieferOnce(prompt, overrides);
  } catch (err) {
    if ((err as Error).message.includes('timed out')) throw err;
    log.warn('briefer failed, retrying once', { err });
    await new Promise((r) => setTimeout(r, 1500));
    return runBrieferOnce(prompt, overrides);
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function formatToolCall(name: string, input: any, iterationMs: number): ToolCallSummary {
  switch (name) {
    case 'Read': {
      const chunked = input?.offset != null || input?.limit != null;
      const range = chunked ? ` (offset ${input.offset ?? 0}, limit ${input.limit ?? '?'})` : ' (full file)';
      return { tool: name, detail: `${input?.file_path ?? '?'}${range}`, iterationMs };
    }
    case 'Grep':
      return {
        tool: name,
        detail: `${input?.path ?? '?'} — /${String(input?.pattern ?? '').slice(0, 60)}/`,
        iterationMs,
      };
    case 'Glob':
      return { tool: name, detail: `${input?.pattern ?? '?'}`, iterationMs };
    case 'Bash':
      return { tool: name, detail: String(input?.command ?? '').slice(0, 100), iterationMs };
    case 'Write':
      return { tool: name, detail: `${input?.file_path ?? '?'}`, iterationMs };
    default:
      return { tool: name, detail: JSON.stringify(input ?? {}).slice(0, 100), iterationMs };
  }
}

/**
 * Parses the `--output-format stream-json --verbose` NDJSON stream: pulls
 * every tool_use call the run made (so callers can audit *what it actually
 * read*, e.g. flagging habitual whole-transcript reads — see 2026-07-20
 * discussion) plus the final `result` event for the briefing text/cost/duration.
 * `lines` carries the wall-clock time each line was received so each tool
 * call can be attributed the elapsed time since the prior line (i.e. how
 * long that iteration's model turn + previous tool result took).
 */
function parseStreamJson(lines: { line: string; at: number }[]): {
  result: Record<string, unknown> | null;
  toolCalls: ToolCallSummary[];
} {
  const toolCalls: ToolCallSummary[] = [];
  let result: Record<string, unknown> | null = null;
  let prevAt: number | null = null;

  for (const { line, at } of lines) {
    if (!line.trim()) continue;
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (event.type === 'assistant') {
      const message = event.message as { content?: Array<Record<string, unknown>> } | undefined;
      for (const block of message?.content ?? []) {
        if (block.type === 'tool_use') {
          const iterationMs = prevAt !== null ? at - prevAt : 0;
          toolCalls.push(formatToolCall(block.name as string, block.input, iterationMs));
        }
      }
    } else if (event.type === 'result') {
      result = event;
    }
    prevAt = at;
  }

  return { result, toolCalls };
}

function runBrieferOnce(prompt: string, overrides?: BrieferOverrides): Promise<BrieferResult> {
  if (!VAULT_PATH) {
    return Promise.reject(new Error('MBIF_VAULT_PATH is not configured'));
  }

  const model = overrides?.model || BRIEFER_MODEL;
  const baseUrl = overrides?.baseUrl || ANTHROPIC_BASE_URL;

  const args = [
    '-p',
    '--agent',
    'briefer',
    '--output-format',
    'stream-json',
    '--verbose',
    '--no-session-persistence',
    ...(model ? ['--model', model] : []),
    prompt,
  ];

  const spawnEnv = {
    ...process.env,
    ...(BRIEFER_OAUTH_TOKEN ? { CLAUDE_CODE_OAUTH_TOKEN: BRIEFER_OAUTH_TOKEN } : {}),
    ...(baseUrl ? { ANTHROPIC_BASE_URL: baseUrl } : {}),
  };

  return new Promise<BrieferResult>((resolve, reject) => {
    const proc = spawn('claude', args, { cwd: VAULT_PATH, env: spawnEnv, stdio: ['ignore', 'pipe', 'pipe'] });

    const lines: { line: string; at: number }[] = [];
    const stderr: string[] = [];

    const timer = setTimeout(() => {
      proc.kill('SIGTERM');
      reject(new Error(`briefer timed out after ${BRIEFER_TIMEOUT_MS}ms`));
    }, BRIEFER_TIMEOUT_MS);

    const rl = createInterface({ input: proc.stdout });
    rl.on('line', (line) => lines.push({ line, at: Date.now() }));
    proc.stderr.on('data', (chunk: Buffer) => stderr.push(chunk.toString()));

    proc.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });

    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        const tail = lines
          .slice(-20)
          .map((l) => l.line)
          .join('\n');
        log.warn('briefer exited non-zero', { code, stderr: stderr.join(''), stdout: tail });
        reject(new Error(`briefer exited with code ${code}: ${stderr.join('') || tail}`));
        return;
      }
      const { result, toolCalls } = parseStreamJson(lines);
      if (!result) {
        reject(new Error('briefer produced no result event in stream-json output'));
        return;
      }
      resolve({
        briefing: result.result as string,
        costUsd: (result.total_cost_usd as number) ?? 0,
        durationMs: (result.duration_ms as number) ?? 0,
        toolCalls,
      });
    });
  });
}
