import { spawn } from 'child_process';
import fs from 'fs';
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
// (see runBrieferWithWikilinkCache). Folded into the prompt as plain text
// (see injectPromptFiles) — briefer.md's own "read user-profile.md first"
// instruction sometimes re-reads a file already handed over this way
// (confirmed 2026-07-21), but that's just an ordinary extra Read, not a
// correctness problem. Simpler than the fake-resumed-session trick this
// replaced, which broke outright (see injectPromptFiles's docstring).
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

/** Strips `[[...]]`, an `|alias`, and a `#anchor`, preserving case (unlike the
 * lowercased normalizeWikilinkTarget in wikilink-cache.ts, which is only a
 * matching key, never a real filesystem path). */
export function wikilinkToVaultRelPath(raw: string): string {
  let target = raw.trim();
  if (target.startsWith('[[') && target.endsWith(']]')) target = target.slice(2, -2);
  const pipeIdx = target.indexOf('|');
  if (pipeIdx !== -1) target = target.slice(0, pipeIdx);
  target = target.trim();
  const hashIdx = target.indexOf('#');
  if (hashIdx !== -1) target = target.slice(0, hashIdx).trim();
  return target.toLowerCase().endsWith('.md') ? target : `${target}.md`;
}

interface BashHint {
  command: string;
  output: string;
}

/**
 * The wikilink cache hint gives Briefer a shortlist of past-cited links, but
 * it's still framed as unverified ("check, don't assume" — see
 * runBrieferWithWikilinkCache). Faking one real look at the top-ranked link
 * (via the actual obsidian-readonly command Briefer would run) nudges it
 * toward treating the hint as worth following up, not just decoration.
 * `obsidian-readonly` — not `Read` — since that's the tool briefer.md's own
 * instructions point at for wikilink-driven lookups (see specialist-tools-
 * readonly.md), so the fake matches what a real cache-hint follow-up would
 * look like. Best-effort: unresolvable link -> no hint, not an error.
 */
function buildCachedWikilinkHint(vaultPath: string, rawWikilink: string): BashHint | null {
  const relPath = wikilinkToVaultRelPath(rawWikilink);
  try {
    const output = fs.readFileSync(path.join(vaultPath, relPath), 'utf-8');
    return { command: `obsidian-readonly read path=${relPath}`, output };
  } catch {
    return null;
  }
}

/**
 * Folds the always-read files (briefer's own post-it, user-profile, and
 * working-memory when given) and the cached-wikilink follow-up straight into
 * the prompt text, instead of faking a resumed session with completed Read
 * tool_use entries. That skeleton-resume trick (see git history) saved a
 * round trip when it worked, but broke silently sometime after 2026-07-28
 * 16:13 — `--resume` against the fabricated transcript started rejecting
 * with a client-side ("model":"<synthetic>") "Credit balance is too low"
 * error, never reaching the API at all. Only Lumen's own synthetic context
 * (container/agent-runner/src/providers/claude.ts) actually needs session
 * resume — it mirrors a real, growing transcript. Briefer fires cold every
 * time anyway, so plain text is simpler and no less correct: if it re-reads
 * a file it's already been handed, that's just an ordinary Read, no harm.
 */
function injectPromptFiles(prompt: string, files: InjectedFile[], bashHint?: BashHint | null): string {
  if (files.length === 0 && !bashHint) return prompt;
  const sections = files.map((f) => `### ${f.vaultPath}\n\n${f.content}`);
  if (bashHint) sections.push(`### ${bashHint.command}\n\n${bashHint.output}`);
  return ['## Reference files (already read for you — do not re-read)', '', ...sections, '', prompt].join('\n');
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
  /** Set when this call happened inside a dispatched Task subagent, not the
   * top-level briefer loop — the describing label of the Task call that spawned it. */
  parentTask?: string;
}

export interface BrieferResult {
  briefing: string;
  costUsd: number;
  durationMs: number;
  toolCalls: ToolCallSummary[];
  /** The full -p prompt actually sent (after injectPromptFiles), for debug logging. */
  prompt: string;
}

/**
 * Builds the -p prompt for the briefer agent: recent literal turns for tone,
 * then the new message clearly separated and last so it reads as the thing
 * to prepare a briefing for, not one more line of history. briefer.md,
 * user-profile.md, and working-memory.md are NOT injected here — runBrieferOnce
 * prepends them via injectPromptFiles instead, right before spawning.
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
    '## Inciting message — what you are preparing a briefing to answer',
    '',
    newMessage,
    '',
    '## Output constraint',
    '',
    'The briefing text is the whole response — do not append a `### Suggested next agent` or',
    '`### Post-it` section to it. Post-it is your own persistent state, written separately to',
    '`{{meta}}/states/briefer.md` per your instructions — it does not belong in the briefing output.',
    'Your job is to surface vault material, not to restate or elaborate on the inciting message',
    'above — every bullet must trace to something actually read from the vault. Pick one primary',
    'subject, zero or one secondary subject, and zero or one additional subject from the material.',
    'Dispatch a subagent for the primary and secondary subjects only. Primary subject: up to 6',
    'bullets, preferably one sentence each. Secondary subject: up to 4 curt single-sentence bullets.',
    'Additional subject: not dispatched — one bullet naming the topic with a single point-of-entry',
    'citation. Every bullet in every subject is tagged with a confidence estimate (CERTAIN/',
    'CONFIDENT/SPECULATIVE/DISPUTED/UNCLEAR/DOUBTFUL) and cited as a wikilink. If a subject has no',
    'vault material, say so in its bullet instead of restating the inciting message.',
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
 * briefer.md/user-profile.md as a third file folded into the prompt (see
 * injectPromptFiles) — passed separately since it's per-call content, not a
 * static vault file. `firstCachedWikilink`, if given (the top-ranked link
 * from a wikilink cache hit), becomes a fourth section: the actual content of
 * that link, nudging Briefer to follow the cache hint rather than just note it.
 *
 * Retries once on a non-timeout failure, as cheap insurance against any
 * remaining transient failure (network blip, etc).
 */
export async function runBriefer(
  prompt: string,
  overrides?: BrieferOverrides,
  workingMemory?: string,
  firstCachedWikilink?: string,
): Promise<BrieferResult> {
  try {
    return await runBrieferOnce(prompt, overrides, workingMemory, firstCachedWikilink);
  } catch (err) {
    if ((err as Error).message.includes('timed out')) throw err;
    log.warn('briefer failed, retrying once', { err });
    await new Promise((r) => setTimeout(r, 1500));
    return runBrieferOnce(prompt, overrides, workingMemory, firstCachedWikilink);
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function formatToolCall(name: string, input: any, iterationMs: number, parentTask?: string): ToolCallSummary {
  switch (name) {
    case 'Read': {
      const chunked = input?.offset != null || input?.limit != null;
      const range = chunked ? ` (offset ${input.offset ?? 0}, limit ${input.limit ?? '?'})` : ' (full file)';
      return { tool: name, detail: `${input?.file_path ?? '?'}${range}`, iterationMs, parentTask };
    }
    case 'Grep':
      return {
        tool: name,
        detail: `${input?.path ?? '?'} — /${String(input?.pattern ?? '').slice(0, 60)}/`,
        iterationMs,
        parentTask,
      };
    case 'Glob':
      return { tool: name, detail: `${input?.pattern ?? '?'}`, iterationMs, parentTask };
    case 'Bash':
      return { tool: name, detail: String(input?.command ?? '').slice(0, 100), iterationMs, parentTask };
    case 'Write':
      return { tool: name, detail: `${input?.file_path ?? '?'}`, iterationMs, parentTask };
    case 'Task':
      return {
        tool: name,
        detail: String(input?.description ?? input?.prompt ?? '?').slice(0, 100),
        iterationMs,
        parentTask,
      };
    default:
      return { tool: name, detail: JSON.stringify(input ?? {}).slice(0, 100), iterationMs, parentTask };
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
 *
 * With `--forward-subagent-text` (see runBrieferOnce), a dispatched Task
 * subagent's own assistant/user messages appear in this same stream, tagged
 * with `parent_tool_use_id` pointing at the `Task` tool_use call that spawned
 * them — this is how per-subject tool timing (added for the multi-subject
 * briefing format) gets attributed instead of collapsing into one opaque
 * `Task` entry. Only tool_use blocks are extracted, same as the top-level
 * loop; subagent free-text commentary is deliberately never captured here —
 * it exists only for host-side timing/audit, never reaches `result.briefing`
 * (which is exclusively the top-level agent's own final `result` event) or
 * any file Lumen's context is built from.
 */
function parseStreamJson(lines: { line: string; at: number }[]): {
  result: Record<string, unknown> | null;
  toolCalls: ToolCallSummary[];
} {
  const toolCalls: ToolCallSummary[] = [];
  let result: Record<string, unknown> | null = null;
  let prevAt: number | null = null;
  // tool_use id of a top-level Task call -> its description, so nested
  // subagent tool calls (tagged with matching parent_tool_use_id) can be
  // attributed to the subject they were dispatched for.
  const taskLabels = new Map<string, string>();

  for (const { line, at } of lines) {
    if (!line.trim()) continue;
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    const parentToolUseId = event.parent_tool_use_id as string | null | undefined;
    if (event.type === 'assistant') {
      const message = event.message as { content?: Array<Record<string, unknown>> } | undefined;
      for (const block of message?.content ?? []) {
        if (block.type === 'tool_use') {
          const iterationMs = prevAt !== null ? at - prevAt : 0;
          const id = block.id as string | undefined;
          const name = block.name as string;
          const parentTask = parentToolUseId ? taskLabels.get(parentToolUseId) : undefined;
          if (!parentToolUseId && name === 'Task' && id) {
            const input = block.input as Record<string, unknown> | undefined;
            taskLabels.set(id, String(input?.description ?? input?.prompt ?? id).slice(0, 60));
          }
          toolCalls.push(formatToolCall(name, block.input, iterationMs, parentTask));
        }
      }
    } else if (event.type === 'result' && !parentToolUseId) {
      result = event;
    }
    prevAt = at;
  }

  return { result, toolCalls };
}

function runBrieferOnce(
  prompt: string,
  overrides?: BrieferOverrides,
  workingMemory?: string,
  firstCachedWikilink?: string,
): Promise<BrieferResult> {
  if (!VAULT_PATH) {
    return Promise.reject(new Error('MBIF_VAULT_PATH is not configured'));
  }

  const model = overrides?.model || BRIEFER_MODEL;
  // When a caller passes an overrides object at all, its baseUrl is the whole
  // answer — even undefined, meaning "no proxy" — not just a preference that
  // falls through to the installation-wide default. Only a caller that passes
  // no overrides object at all (the on-demand `recall` tool) gets the
  // ANTHROPIC_BASE_URL/MBIF_BRIEFER_BASE_URL default. Confirmed 2026-07-29:
  // the `||` version silently routed synthetic-context's plain sonnet calls
  // through PrefixRouter (MBIF_BRIEFER_BASE_URL) despite briefing-cache.ts's
  // own overrides object deliberately omitting baseUrl to avoid exactly that —
  // and PrefixRouter's backing Anthropic account was out of credit, so every
  // briefing failed with a misleading "Credit balance is too low".
  const baseUrl = overrides ? overrides.baseUrl : ANTHROPIC_BASE_URL;

  const injectedFiles = readAlwaysFiles();
  if (workingMemory) {
    injectedFiles.push({
      vaultPath: 'Meta/working-memory.md',
      absPath: path.join(VAULT_PATH, 'Meta', 'working-memory.md'),
      content: workingMemory,
    });
  }
  const bashHint = firstCachedWikilink ? buildCachedWikilinkHint(VAULT_PATH, firstCachedWikilink) : null;
  const fullPrompt = injectPromptFiles(prompt, injectedFiles, bashHint);

  const args = [
    '-p',
    '--agent',
    'briefer',
    '--output-format',
    'stream-json',
    '--verbose',
    // Surfaces a dispatched Task subagent's own tool_use/tool_result events in
    // this same stream (tagged with parent_tool_use_id), instead of the
    // subagent collapsing into one opaque Task entry — needed for per-subject
    // timing now that briefer.md dispatches a subagent per briefing subject.
    // Only tool_use blocks are read out of these (see parseStreamJson);
    // subagent free-text is never captured, so it can't reach result.briefing
    // or leak into Lumen's context. Requires CLI >= 2.1.211.
    '--forward-subagent-text',
    // Headless -p has no TTY to prompt for approval, so without this every
    // Edit/Write call (e.g. Briefer updating its own Meta/states/briefer.md
    // post-it, or working-memory.md) was denied outright rather than
    // actually asked — confirmed 2026-07-21 via Briefer's own briefing text
    // reporting the block. protect-system-files.sh (vault .claude/hooks/)
    // still gates dispatcher/core-agent/skill/reference files regardless.
    '--permission-mode',
    'bypassPermissions',
    '--no-session-persistence',
    ...(model ? ['--model', model] : []),
    fullPrompt,
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
        prompt: fullPrompt,
      });
    });
  });
}
