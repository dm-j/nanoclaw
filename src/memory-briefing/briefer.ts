import { randomUUID } from 'crypto';
import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
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

// Every briefing log to date shows Briefer reading these two files first,
// every single time (see logs/briefings/*.md) — its own post-it and the
// user profile. working-memory.md joins them as a third per-call addition
// (see runBrieferWithWikilinkCache). Handing all three over via a fake
// completed Read history (see buildBrieferSkeletonSession below) saves the
// round trip far more reliably than dumping their content as plain prompt
// text did — a plain-text injection competes with briefer.md's own explicit
// "read user-profile.md first" instruction and gets re-read anyway roughly
// as often as not (confirmed 2026-07-21). A fake Read tool_use/tool_result
// pair in real session history is the same signal the model uses to decide
// not to repeat any other tool call it can see it already made.
const ALWAYS_READ_VAULT_PATHS = ['Meta/states/briefer.md', 'Meta/user-profile.md'];

interface InjectedFile {
  vaultPath: string;
  absPath: string;
  content: string;
}

function readAlwaysFiles(): InjectedFile[] {
  if (!VAULT_PATH) return [];
  return ALWAYS_READ_VAULT_PATHS.flatMap((vaultPath) => {
    const absPath = path.join(VAULT_PATH, vaultPath);
    try {
      return [{ vaultPath, absPath, content: fs.readFileSync(absPath, 'utf-8') }];
    } catch {
      return [];
    }
  });
}

function claudeProjectsDir(): string {
  const base = process.env.CLAUDE_CONFIG_DIR || path.join(process.env.HOME || os.homedir(), '.claude');
  return path.join(base, 'projects');
}

/** Mirrors the CLI's own cwd -> project-dir mangling: every `/` becomes `-`. */
function mangleCwd(cwd: string): string {
  return cwd.replace(/\//g, '-');
}

/**
 * Builds a disposable session transcript — one throwaway id per call, never
 * appended to or reused — containing a fake, already-completed Read call for
 * each injected file, then resumes it via `--resume` instead of `-p`'s usual
 * cold start. Same trick container/agent-runner/src/providers/claude.ts uses
 * for Lumen's synthetic context, adapted for a real `Read` tool (Briefer has
 * no custom no-op MCP tools of its own to fake calls against) instead of the
 * stub `load_*` tools that back Lumen's version. If Briefer doesn't trust the
 * fake history and re-reads anyway, that's just an ordinary Read — no
 * correctness risk, just none of the savings this exists for.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function buildBrieferSkeletonEntries(files: InjectedFile[]): any[] {
  const now = () => new Date().toISOString();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const entries: any[] = [];
  const promptId = randomUUID();
  const common = { userType: 'external', entrypoint: 'sdk-cli', version: '2.1.212', gitBranch: 'HEAD' };

  const kickoff =
    `For this session only: read ${files.map((f) => f.vaultPath).join(', then ')}, ` +
    'once each, in that order. Read each exactly once. After all reads complete, reply with just "done" and nothing else.';
  let prevUuid: string | null = null;
  const userUuid = randomUUID();
  entries.push({
    parentUuid: null,
    isSidechain: false,
    promptId,
    type: 'user',
    message: { role: 'user', content: kickoff },
    uuid: userUuid,
    timestamp: now(),
    permissionMode: 'default',
    promptSource: 'sdk',
    ...common,
  });
  prevUuid = userUuid;

  for (const file of files) {
    const callId = `call_${randomUUID().replace(/-/g, '').slice(0, 24)}`;
    const assistantUuid = randomUUID();
    entries.push({
      parentUuid: prevUuid,
      isSidechain: false,
      message: {
        id: `msg_${randomUUID().replace(/-/g, '')}`,
        type: 'message',
        role: 'assistant',
        content: [{ type: 'tool_use', id: callId, name: 'Read', input: { file_path: file.absPath } }],
        usage: { input_tokens: 0, output_tokens: 0 },
      },
      type: 'assistant',
      uuid: assistantUuid,
      timestamp: now(),
      ...common,
    });
    const toolResultUuid = randomUUID();
    entries.push({
      parentUuid: assistantUuid,
      isSidechain: false,
      promptId,
      type: 'user',
      message: {
        role: 'user',
        content: [{ tool_use_id: callId, type: 'tool_result', content: [{ type: 'text', text: file.content }] }],
      },
      uuid: toolResultUuid,
      timestamp: now(),
      toolUseResult: [{ type: 'text', text: file.content }],
      sourceToolAssistantUUID: assistantUuid,
      ...common,
    });
    prevUuid = toolResultUuid;
  }

  entries.push({
    parentUuid: prevUuid,
    isSidechain: false,
    message: {
      id: `msg_${randomUUID().replace(/-/g, '')}`,
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text', text: 'done' }],
      usage: { input_tokens: 0, output_tokens: 0 },
      stop_reason: 'end_turn',
    },
    type: 'assistant',
    uuid: randomUUID(),
    timestamp: now(),
    ...common,
  });

  return entries;
}

/** Writes the skeleton to the project dir the CLI checks on `--resume`, returning the session id to resume. */
function buildBrieferSkeletonSession(vaultPath: string, files: InjectedFile[]): string | null {
  if (files.length === 0) return null;
  const entries = buildBrieferSkeletonEntries(files);
  const ephemeralId = randomUUID();
  for (const e of entries) {
    e.cwd = vaultPath;
    e.sessionId = ephemeralId;
  }

  const projectsDir = path.join(claudeProjectsDir(), mangleCwd(vaultPath));
  try {
    fs.mkdirSync(projectsDir, { recursive: true });
    fs.writeFileSync(
      path.join(projectsDir, `${ephemeralId}.jsonl`),
      entries.map((e) => JSON.stringify(e)).join('\n') + '\n',
    );
  } catch (err) {
    log.warn('briefer skeleton session write failed (falling back to cold start)', { err });
    return null;
  }
  return ephemeralId;
}

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
 * to prepare a briefing for, not one more line of history. briefer.md,
 * user-profile.md, and working-memory.md are NOT injected here — they're
 * delivered via a fake completed Read history instead (see
 * buildBrieferSkeletonSession), which holds up more reliably than plain
 * prompt text competing with briefer.md's own "read this first" instructions.
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
 * markdown from the agent's `result` field. `workingMemory`, if given, joins
 * briefer.md/user-profile.md as a third fake pre-completed Read (see
 * buildBrieferSkeletonSession) — passed separately from the prompt since it's
 * per-call content, not a static vault file.
 *
 * Retries once on a non-timeout failure, as cheap insurance against any
 * remaining transient failure (network blip, etc).
 */
export async function runBriefer(
  prompt: string,
  overrides?: BrieferOverrides,
  workingMemory?: string,
): Promise<BrieferResult> {
  try {
    return await runBrieferOnce(prompt, overrides, workingMemory);
  } catch (err) {
    if ((err as Error).message.includes('timed out')) throw err;
    log.warn('briefer failed, retrying once', { err });
    await new Promise((r) => setTimeout(r, 1500));
    return runBrieferOnce(prompt, overrides, workingMemory);
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

function runBrieferOnce(prompt: string, overrides?: BrieferOverrides, workingMemory?: string): Promise<BrieferResult> {
  if (!VAULT_PATH) {
    return Promise.reject(new Error('MBIF_VAULT_PATH is not configured'));
  }

  const model = overrides?.model || BRIEFER_MODEL;
  const baseUrl = overrides?.baseUrl || ANTHROPIC_BASE_URL;

  const injectedFiles = readAlwaysFiles();
  if (workingMemory) {
    injectedFiles.push({
      vaultPath: 'Meta/working-memory.md',
      absPath: path.join(VAULT_PATH, 'Meta', 'working-memory.md'),
      content: workingMemory,
    });
  }
  const skeletonSessionId = buildBrieferSkeletonSession(VAULT_PATH, injectedFiles);

  const args = [
    '-p',
    '--agent',
    'briefer',
    '--output-format',
    'stream-json',
    '--verbose',
    ...(skeletonSessionId ? ['--resume', skeletonSessionId] : ['--no-session-persistence']),
    ...(model ? ['--model', model] : []),
    prompt,
  ];

  const spawnEnv = {
    ...process.env,
    ...(BRIEFER_OAUTH_TOKEN ? { CLAUDE_CODE_OAUTH_TOKEN: BRIEFER_OAUTH_TOKEN } : {}),
    ...(baseUrl ? { ANTHROPIC_BASE_URL: baseUrl } : {}),
  };

  // Disposable — built fresh per call and never resumed again, so nothing
  // reads it after this process exits. Deleted in `close` below; Lumen's
  // equivalent skeleton is left on disk (see claude.ts) because it's mirrored
  // back onto a canonical transcript and fires once per user turn, but
  // Briefer fires far more often (every message and every task wake), so
  // leaving these around would accumulate unbounded.
  const skeletonPath = skeletonSessionId
    ? path.join(claudeProjectsDir(), mangleCwd(VAULT_PATH), `${skeletonSessionId}.jsonl`)
    : null;
  const cleanupSkeleton = (): void => {
    if (!skeletonPath) return;
    fs.unlink(skeletonPath, (err) => {
      if (err) log.warn('briefer skeleton cleanup failed (non-fatal)', { err });
    });
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
      cleanupSkeleton();
      reject(err);
    });

    proc.on('close', (code) => {
      clearTimeout(timer);
      cleanupSkeleton();
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
