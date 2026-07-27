import { randomUUID } from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { query as sdkQuery, type HookCallback, type PreCompactHookInput } from '@anthropic-ai/claude-agent-sdk';

import { clearContainerToolInFlight, setContainerToolInFlight } from '../db/connection.js';
import { captureMemoryTurn } from '../memory-capture.js';
import { exportTurnToInbox } from '../transcript-export.js';
import type { MemorySessionHookRegistration } from '../memory/session-hook.js';
import { TIMEZONE, formatLocalStamp } from '../timezone.js';
import { registerProvider } from './provider-registry.js';
import type {
  AgentProvider,
  AgentQuery,
  McpServerConfig,
  ProviderEvent,
  ProviderOptions,
  QueryInput,
} from './types.js';

function log(msg: string): void {
  console.error(`[claude-provider] ${msg}`);
}

export interface SdkRateLimitInfo {
  status?: string;
  resetsAt?: number;
  rateLimitType?: string;
  utilization?: number;
  errorCode?: string;
  overageDisabledReason?: string;
}

/**
 * Map an SDK `rate_limit_event` to a provider event — or to NOTHING.
 *
 * The SDK emits this "when rate limit info changes": it is TELEMETRY, and
 * `status` is usually 'allowed' (here's your remaining headroom). We used to
 * treat every one as a terminal quota error: on a stock install that logged a
 * spurious "Rate limit (retryable: false, quota)" on perfectly healthy turns
 * (#3016), and any consumer acting on the classification aborted those turns
 * outright. **Only 'rejected' is an actual block.**
 *
 * When it IS rejected the SDK tells us WHY, so we distinguish properly instead
 * of guessing: `errorCode: 'credits_required'` / `overageDisabledReason:
 * 'out_of_credits'` means genuinely out of credits (billing); anything else is a
 * transient window limit that resets (`resetsAt`, `rateLimitType`).
 *
 * Returns null when the event is informational (do not disturb the turn).
 */
export function classifyRateLimitEvent(
  info: SdkRateLimitInfo | undefined,
): { message: string; classification: 'rate_limit' | 'quota' } | null {
  if (info?.status !== 'rejected') return null;
  const outOfCredits = info.errorCode === 'credits_required' || info.overageDisabledReason === 'out_of_credits';
  let detail = '';
  if (typeof info.resetsAt === 'number' && Number.isFinite(info.resetsAt)) {
    const ms = info.resetsAt < 1e12 ? info.resetsAt * 1000 : info.resetsAt;
    detail = ` (resets ${new Date(ms).toISOString()})`;
  }
  const window = info.rateLimitType ? ` [${info.rateLimitType}]` : '';
  return {
    message: `${outOfCredits ? 'Out of credits' : 'Rate limit'}${window}${detail}`,
    classification: outOfCredits ? 'quota' : 'rate_limit',
  };
}

// Deferred SDK builtins that either sidestep nanoclaw's own scheduling or
// don't fit our async message-passing model (they're designed for Claude
// Code's interactive UI and would hang here).
//
// - CronCreate / CronDelete / CronList / ScheduleWakeup: we have durable
//   scheduling via `ncl tasks`.
// - AskUserQuestion: SDK returns a placeholder instead of blocking on a
//   real answer — we have mcp__nanoclaw__ask_user_question that persists
//   the question and blocks on the real reply.
// - EnterPlanMode / ExitPlanMode / EnterWorktree / ExitWorktree: Claude
//   Code UI affordances; in a headless container they'd appear stuck.
// - DesignSync: desktop design-tool integration — nothing to sync with in a
//   headless container (~9.3KB/turn schema).
// - ReportFindings: code-review-reporting UI affordance with no headless
//   host surface to receive it (~1.9KB/turn schema).
const SDK_DISALLOWED_TOOLS = [
  'CronCreate',
  'CronDelete',
  'CronList',
  'ScheduleWakeup',
  'AskUserQuestion',
  'EnterPlanMode',
  'ExitPlanMode',
  'EnterWorktree',
  'ExitWorktree',
  'DesignSync',
  'ReportFindings',
];

// Tool allowlist for NanoClaw agent containers. MCP-tool entries are derived
// at the call site from the registered `mcpServers` map so that any server
// added via `add_mcp_server` (or wired in container.json directly) is
// reachable to the agent — without this, the SDK's allowedTools filter
// silently drops every MCP namespace not listed here.
const TOOL_ALLOWLIST = [
  'Bash',
  'Read',
  'Write',
  'Edit',
  'Glob',
  'Grep',
  'WebSearch',
  'WebFetch',
  'Task',
  'TaskOutput',
  'TaskStop',
  'TeamCreate',
  'TeamDelete',
  'SendMessage',
  'TodoWrite',
  'ToolSearch',
  'Skill',
  'NotebookEdit',
];

// MCP server names are sanitized by the SDK when forming tool prefixes:
// any character outside [A-Za-z0-9_-] becomes '_'. Mirror that here so our
// allowlist patterns match what the SDK actually exposes.
function mcpAllowPattern(serverName: string): string {
  return `mcp__${serverName.replace(/[^a-zA-Z0-9_-]/g, '_')}__*`;
}

interface SDKUserMessage {
  type: 'user';
  message: { role: 'user'; content: string };
  parent_tool_use_id: null;
  session_id: string;
}

/**
 * Push-based async iterable for streaming user messages to the Claude SDK.
 */
class MessageStream {
  private queue: SDKUserMessage[] = [];
  private waiting: (() => void) | null = null;
  private done = false;

  push(text: string): void {
    this.queue.push({
      type: 'user',
      message: { role: 'user', content: text },
      parent_tool_use_id: null,
      session_id: '',
    });
    this.waiting?.();
  }

  end(): void {
    this.done = true;
    this.waiting?.();
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<SDKUserMessage> {
    while (true) {
      while (this.queue.length > 0) {
        yield this.queue.shift()!;
      }
      if (this.done) return;
      await new Promise<void>((r) => {
        this.waiting = r;
      });
      this.waiting = null;
    }
  }
}

// ── Transcript archiving (PreCompact hook) ──

interface ParsedMessage {
  role: 'user' | 'assistant';
  content: string;
}

function parseTranscript(content: string): ParsedMessage[] {
  const messages: ParsedMessage[] = [];
  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (entry.type === 'user' && entry.message?.content) {
        const text =
          typeof entry.message.content === 'string'
            ? entry.message.content
            : entry.message.content.map((c: { text?: string }) => c.text || '').join('');
        if (text) messages.push({ role: 'user', content: text });
      } else if (entry.type === 'assistant' && entry.message?.content) {
        const parts: string[] = [];
        for (const block of entry.message.content) {
          if (block.type === 'text' && block.text) {
            parts.push(block.text);
          } else if (block.type === 'tool_use' && block.name) {
            const input = block.input ?? {};
            if (block.name.includes('send_message') && typeof input.text === 'string') {
              parts.push(input.text);
            } else if (block.name.includes('send_file')) {
              const fileName = typeof input.fileName === 'string' ? input.fileName : typeof input.filePath === 'string' ? path.basename(input.filePath) : 'file';
              parts.push(`(sent file: ${fileName})`);
            }
          }
        }
        const text = parts.join('\n');
        if (text) messages.push({ role: 'assistant', content: text });
      }
    } catch {
      /* skip unparseable lines */
    }
  }
  return messages;
}

function formatTranscriptMarkdown(messages: ParsedMessage[], title?: string | null, assistantName?: string): string {
  const now = new Date();
  const dateStr = now.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
  const lines = [`# ${title || 'Conversation'}`, '', `Archived: ${dateStr}`, '', '---', ''];
  for (const msg of messages) {
    const sender = msg.role === 'user' ? 'User' : assistantName || 'Assistant';
    const content = msg.content.length > 2000 ? msg.content.slice(0, 2000) + '...' : msg.content;
    lines.push(`**${sender}**: ${content}`, '');
  }
  return lines.join('\n');
}

/**
 * PreToolUse hook: record the current tool + its declared timeout so the host
 * sweep can widen its stuck tolerance while Bash is running a long-declared
 * script. Defense-in-depth: if SDK_DISALLOWED_TOOLS slips through somehow,
 * block the call here instead of letting the agent hang.
 */
const preToolUseHook: HookCallback = async (input) => {
  const i = input as { tool_name?: string; tool_input?: Record<string, unknown> };
  const toolName = i.tool_name ?? '';
  if (SDK_DISALLOWED_TOOLS.includes(toolName)) {
    return {
      decision: 'block',
      stopReason: `Tool '${toolName}' is not available in this environment — use the nanoclaw equivalent.`,
    } as unknown as ReturnType<HookCallback>;
  }
  // Bash exposes its timeout via the tool_input.timeout field (ms). Any other
  // tool: no declared timeout.
  const declaredTimeoutMs =
    toolName === 'Bash' && typeof i.tool_input?.timeout === 'number' ? (i.tool_input.timeout as number) : null;
  try {
    setContainerToolInFlight(toolName, declaredTimeoutMs);
  } catch (err) {
    log(`PreToolUse: failed to record container_state: ${err instanceof Error ? err.message : String(err)}`);
  }
  return { continue: true };
};

/** Clear in-flight tool on PostToolUse / PostToolUseFailure. */
const postToolUseHook: HookCallback = async () => {
  try {
    clearContainerToolInFlight();
  } catch (err) {
    log(`PostToolUse: failed to clear container_state: ${err instanceof Error ? err.message : String(err)}`);
  }
  return { continue: true };
};

/**
 * Read a Claude transcript .jsonl, render a markdown summary, and drop it into
 * the agent's `conversations/` folder so context survives a compaction or a
 * session rotation. Best-effort: returns false (and logs) on any failure.
 */
function archiveTranscriptFile(
  transcriptPath: string | undefined,
  sessionId: string | undefined,
  assistantName?: string,
): boolean {
  if (!transcriptPath || !fs.existsSync(transcriptPath)) {
    log('No transcript found for archiving');
    return false;
  }

  try {
    const content = fs.readFileSync(transcriptPath, 'utf-8');
    const messages = parseTranscript(content);
    if (messages.length === 0) return false;

    // Try to get summary from sessions index
    let summary: string | undefined;
    const indexPath = path.join(path.dirname(transcriptPath), 'sessions-index.json');
    if (fs.existsSync(indexPath)) {
      try {
        const index = JSON.parse(fs.readFileSync(indexPath, 'utf-8'));
        summary = index.entries?.find(
          (e: { sessionId: string; summary?: string }) => e.sessionId === sessionId,
        )?.summary;
      } catch {
        /* ignore */
      }
    }

    const name = summary
      ? summary
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/^-+|-+$/g, '')
          .slice(0, 50)
      : `conversation-${new Date().getHours().toString().padStart(2, '0')}${new Date().getMinutes().toString().padStart(2, '0')}`;

    const conversationsDir = process.env.NANOCLAW_CONVERSATIONS_DIR || '/workspace/agent/conversations';
    fs.mkdirSync(conversationsDir, { recursive: true });
    // Local calendar date — the fallback `name` above already uses local
    // hours, and the agent navigates conversations/ by these date prefixes.
    const filename = `${formatLocalStamp(new Date(), TIMEZONE).slice(0, 10)}-${name}.md`;
    fs.writeFileSync(path.join(conversationsDir, filename), formatTranscriptMarkdown(messages, summary, assistantName));
    log(`Archived conversation to ${filename}`);
    return true;
  } catch (err) {
    log(`Failed to archive transcript: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

function createPreCompactHook(assistantName?: string): HookCallback {
  return async (input) => {
    const preCompact = input as PreCompactHookInput;
    archiveTranscriptFile(preCompact.transcript_path, preCompact.session_id, assistantName);
    return {};
  };
}

// ── Continuation rotation (cold-resume guard) ──

/**
 * Resume cost is dominated by transcript size. Past this many bytes a fresh
 * cold container can't reload the .jsonl before the host's 30-min idle ceiling
 * fires, so the session is dropped and started clean. Operator-overridable.
 */
function transcriptRotateBytes(): number {
  return Number(process.env.CLAUDE_TRANSCRIPT_ROTATE_BYTES) || 12 * 1024 * 1024;
}

/**
 * Secondary age trigger, measured from the transcript's first entry. 0 (or a
 * non-positive value) disables the age check; size alone then governs.
 */
function transcriptRotateAgeMs(): number {
  const raw = process.env.CLAUDE_TRANSCRIPT_ROTATE_AGE_DAYS;
  if (raw === undefined || raw.trim() === '') return 14 * 86_400_000;
  const days = Number(raw);
  if (!Number.isFinite(days)) return 14 * 86_400_000;
  // Explicit non-positive override disables the age check; size alone governs.
  return days > 0 ? days * 86_400_000 : Infinity;
}

// ── Synthetic context (see docs/synthetic-context.md) — A/B toggle, off by
// default. When enabled, `query()` resumes a small reusable skeleton
// (synthetic-context-skeleton.jsonl — a real, once-captured transcript: one
// user message, two tool_use/tool_result pairs, real ids/uuid/parentUuid
// chain) with content substituted into every slot fresh each turn: the
// opening user-message slot gets the last real user message, the first tool
// pair (load_transcript) gets recent literal history, the second
// (load_briefing) gets the briefing payload. Real content appended past a
// transcript's own original length gets silently dropped on resume
// (confirmed 2026-07-17, see vault "Synthetic Context Delivery" project) —
// substituting content into an already-existing, correctly-shaped skeleton
// sidesteps that entirely, since nothing is ever appended. New turns produced
// live still get mirrored back onto the canonical file so it keeps
// accumulating and auto-compacting exactly as it does today. Flip
// NANOCLAW_SYNTHETIC_CONTEXT off to revert to today's behavior with zero
// other changes -- the canonical session is always there, untouched.

function syntheticContextEnabled(): boolean {
  return process.env.NANOCLAW_SYNTHETIC_CONTEXT === '1' || process.env.NANOCLAW_SYNTHETIC_CONTEXT === 'true';
}

function syntheticContextTurnWindow(): number {
  return Number(process.env.NANOCLAW_SYNTHETIC_CONTEXT_LINES) || 40;
}

/** Mirrors the SDK's own cwd -> project-dir mangling: every `/` becomes `-`. */
function mangleCwd(cwd: string): string {
  return cwd.replace(/\//g, '-');
}

function canonicalMarkerPath(cwd: string): string {
  return path.join(cwd, '.canonical-session-id');
}

/** Non-content marker/summary lines that shouldn't be treated as real turns. */
const TRANSCRIPT_MARKER_TYPES = new Set(['last-prompt', 'summary']);

const SKELETON_TEMPLATE_PATH = path.join(import.meta.dir, 'synthetic-context-skeleton.jsonl');

interface SkeletonResume {
  ephemeralId: string;
  ephemeralPath: string;
  skeletonEntryCount: number;
}

/**
 * Loads the reusable 6-entry skeleton fresh each call (cheap — six short
 * lines) so callers mutating entries in place never share state across
 * turns. Shape: [0] user message, [1] tool_use load_transcript, [2]
 * tool_result, [3] tool_use load_briefing, [4] tool_result, [5] assistant
 * "done" ack. Captured once from a real disposable session 2026-07-17 (see
 * docs/synthetic-context.md) — real ids/uuid/parentUuid chain throughout,
 * env-specific attachment/listing noise stripped and the gap re-chained.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function loadSkeletonEntries(): any[] {
  const raw = fs.readFileSync(SKELETON_TEMPLATE_PATH, 'utf-8');
  return raw
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function setToolResultText(entry: any, text: string): void {
  entry.message.content[0].content[0].text = text;
  entry.toolUseResult[0].text = text;
}

/**
 * The captured template's uuid/parentUuid chain, promptId, message.id, and
 * tool_use id fields are all literal fixed strings — loadSkeletonEntries()
 * re-parses the same static file every call and buildSkeletonTranscript only
 * ever overwrote sessionId. That meant every skeleton-based request, for
 * every turn, for every user, sent byte-identical ids on the wire (2026-07-21
 * discussion — suspected of confusing whatever request-level dedup/caching
 * Ollama Cloud does internally, though never confirmed as root cause). Fresh
 * random ids per build, chained the same way the template's were, removes
 * the collision regardless of whether it was ever actually the culprit.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function randomizeSkeletonIds(entries: any[]): void {
  const promptId = randomUUID();
  let pendingToolUseId: string | null = null;

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const prevUuid: string | null = i === 0 ? null : entries[i - 1].uuid;
    entry.uuid = randomUUID();
    entry.parentUuid = prevUuid;
    if ('promptId' in entry) entry.promptId = promptId;

    const content = entry.message?.content;
    if (Array.isArray(content) && content[0]?.type === 'tool_use') {
      const msgId = `msg_${randomUUID().replace(/-/g, '')}`;
      const callId = `call_${randomUUID().replace(/-/g, '').slice(0, 24)}`;
      entry.message.id = msgId;
      content[0].id = callId;
      pendingToolUseId = callId;
    } else if (Array.isArray(content) && content[0]?.type === 'tool_result') {
      content[0].tool_use_id = pendingToolUseId;
      if ('sourceToolAssistantUUID' in entry) entry.sourceToolAssistantUUID = prevUuid;
      pendingToolUseId = null;
    } else if (entry.message?.id) {
      entry.message.id = `msg_${randomUUID().replace(/-/g, '')}`;
    }
  }
}

/**
 * Substitutes the skeleton's four content slots and writes it into the
 * project dir the CLI will actually check on `resume` (mangled from `cwd`,
 * not `findTranscriptPath`'s scan-all-dirs convenience, which is a
 * NanoClaw-side reading shortcut, not how the real CLI resolves `resume`).
 */
function buildSkeletonTranscript(
  cwd: string,
  lastUserMessage: string,
  literalHistoryMarkdown: string,
  briefingMarkdown: string,
  workingMemoryMarkdown: string,
): SkeletonResume {
  const entries = loadSkeletonEntries();
  randomizeSkeletonIds(entries);
  entries[0].message.content = lastUserMessage;
  setToolResultText(entries[2], literalHistoryMarkdown);
  setToolResultText(entries[4], briefingMarkdown);
  setToolResultText(entries[6], workingMemoryMarkdown);

  const ephemeralId = randomUUID();
  for (const e of entries) e.sessionId = ephemeralId;

  const projectsDir = path.join(claudeProjectsDir(), mangleCwd(cwd));
  fs.mkdirSync(projectsDir, { recursive: true });
  const ephemeralPath = path.join(projectsDir, `${ephemeralId}.jsonl`);
  fs.writeFileSync(ephemeralPath, entries.map((e) => JSON.stringify(e)).join('\n') + '\n');

  return { ephemeralId, ephemeralPath, skeletonEntryCount: entries.length };
}

/** Renders the last `window` real messages as markdown, reusing the same parse/format pair archiveTranscriptFile uses for conversation exports. */
function buildLiteralHistoryMarkdown(canonicalPath: string, window: number, assistantName?: string): string {
  const raw = fs.readFileSync(canonicalPath, 'utf-8');
  const messages = parseTranscript(raw).slice(-window);
  if (messages.length === 0) return '_(no recent conversation)_';
  return formatTranscriptMarkdown(messages, null, assistantName);
}

/**
 * The most recent real user-role message, for the skeleton's opening slot —
 * literally "the last message" at the point the skeleton is built, since
 * this turn's live prompt hasn't been added to the transcript yet (it's
 * pushed separately via the live MessageStream after resume, same as always
 * — the skeleton primes context, it doesn't replace the live turn).
 */
function lastRealUserMessage(canonicalPath: string): string {
  const raw = fs.readFileSync(canonicalPath, 'utf-8');
  const messages = parseTranscript(raw);
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user') return messages[i].content;
  }
  return '(no prior message)';
}

function lastRealUuid(canonicalPath: string): string | null {
  const raw = fs.readFileSync(canonicalPath, 'utf-8');
  const lines = raw.split('\n').filter((l) => l.trim());
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const d = JSON.parse(lines[i]);
      if (d.uuid) return d.uuid;
    } catch {
      /* skip unparseable lines */
    }
  }
  return null;
}

/**
 * After a skeleton turn completes, appends whatever new entries the SDK
 * wrote onto the ephemeral copy back onto the canonical transcript, with
 * sessionId rewritten to canonical. Unlike the old truncated-copy approach,
 * the skeleton's own uuids have no structural relationship to canonical's
 * chain, so the first newly-generated entry's parentUuid is repointed onto
 * canonical's real last uuid before appending — everything after that
 * chains off the model's own freshly-generated uuids as normal.
 */
function mirrorSkeletonTurnToCanonical(canonicalId: string, canonicalPath: string, skeleton: SkeletonResume): void {
  let raw: string;
  try {
    raw = fs.readFileSync(skeleton.ephemeralPath, 'utf-8');
  } catch (err) {
    log(`mirrorSkeletonTurnToCanonical: failed to read ephemeral transcript: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }
  const lines = raw.split('\n').filter((l) => l.trim());
  const newLines = lines.slice(skeleton.skeletonEntryCount);
  if (newLines.length === 0) return;

  const canonicalLeaf = lastRealUuid(canonicalPath);
  const toAppend: string[] = [];
  newLines.forEach((line, i) => {
    try {
      const d = JSON.parse(line);
      if (TRANSCRIPT_MARKER_TYPES.has(d.type)) return;
      d.sessionId = canonicalId;
      if (i === 0) d.parentUuid = canonicalLeaf;
      toAppend.push(JSON.stringify(d));
    } catch {
      /* skip unparseable lines */
    }
  });
  if (toAppend.length === 0) return;
  try {
    fs.appendFileSync(canonicalPath, toAppend.join('\n') + '\n');
  } catch (err) {
    log(`mirrorSkeletonTurnToCanonical: failed to append to canonical transcript: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function claudeProjectsDir(): string {
  return path.join(claudeConfigDir(), 'projects');
}

function claudeConfigDir(): string {
  return process.env.CLAUDE_CONFIG_DIR || path.join(process.env.HOME || os.homedir(), '.claude');
}

function writeMemorySessionHook(hook: MemorySessionHookRegistration): void {
  const configDir = claudeConfigDir();
  const settingsFile = path.join(configDir, 'settings.json');
  fs.mkdirSync(configDir, { recursive: true });

  const parsed: unknown = fs.existsSync(settingsFile) ? JSON.parse(fs.readFileSync(settingsFile, 'utf-8')) : {};
  if (!isRecord(parsed)) throw new Error(`${settingsFile} must contain a JSON object`);

  const hooks = parsed.hooks === undefined ? {} : parsed.hooks;
  if (!isRecord(hooks)) throw new Error(`${settingsFile} hooks must be a JSON object`);

  const sessionStart = hooks.SessionStart === undefined ? [] : hooks.SessionStart;
  if (!Array.isArray(sessionStart)) throw new Error(`${settingsFile} hooks.SessionStart must be an array`);

  const memoryCommands = new Set([hook.command, ...hook.legacyCommands]);
  const nextSessionStart = sessionStart
    .map((entry) => removeMemoryCommands(entry, memoryCommands))
    .filter((entry) => entry !== undefined);
  nextSessionStart.push({
    matcher: hook.sources.join('|'),
    hooks: [{ type: 'command', command: hook.command, timeout: 10 }],
  });

  hooks.SessionStart = nextSessionStart;
  parsed.hooks = hooks;
  fs.writeFileSync(settingsFile, JSON.stringify(parsed, null, 2) + '\n');
}

function removeMemoryCommands(value: unknown, commands: ReadonlySet<string>): unknown {
  if (!isRecord(value) || !Array.isArray(value.hooks)) return value;
  const hooks = value.hooks.filter((hook) => {
    if (!isRecord(hook)) return true;
    return typeof hook.command !== 'string' || !commands.has(hook.command);
  });
  return hooks.length > 0 ? { ...value, hooks } : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Locate the .jsonl backing a session id. The SDK names project dirs by a
 * mangled cwd; rather than reproduce that convention we scan project dirs for
 * `<sessionId>.jsonl` (session ids are UUIDs, so this is unambiguous).
 */
function findTranscriptPath(sessionId: string): string | null {
  const projects = claudeProjectsDir();
  let dirs: string[];
  try {
    dirs = fs.readdirSync(projects);
  } catch {
    return null;
  }
  for (const dir of dirs) {
    const candidate = path.join(projects, dir, `${sessionId}.jsonl`);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

/** Epoch-ms of the first transcript entry, or null if unreadable. */
function transcriptStartMs(transcriptPath: string): number | null {
  try {
    const fd = fs.openSync(transcriptPath, 'r');
    try {
      const buf = Buffer.alloc(4096);
      const n = fs.readSync(fd, buf, 0, buf.length, 0);
      const firstLine = buf.toString('utf-8', 0, n).split('\n', 1)[0];
      const ts = JSON.parse(firstLine)?.timestamp;
      const ms = ts ? Date.parse(ts) : NaN;
      return Number.isNaN(ms) ? null : ms;
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
}

// ── Provider ──

/**
 * Fraction of the model's real context window reserved as headroom before
 * Claude Code auto-compacts. Matches the ratio of the old hardcoded default
 * (165000 / 200000 = 0.825) so behavior on Claude models is unchanged;
 * scales down automatically for smaller-context models instead of silently
 * reusing a Claude-sized number.
 */
const AUTO_COMPACT_HEADROOM_RATIO = 0.825;

/**
 * Claude Code auto-compacts context at this window (tokens), derived from
 * the active model's real context window (`contextWindow`, required — see
 * container-runner.ts's spawn-time gate). Kept here so the generic bootstrap
 * doesn't need to know about Claude-specific env vars.
 *
 * Operator override: set CLAUDE_CODE_AUTO_COMPACT_WINDOW in the host env to
 * raise or lower the threshold without editing source — useful when running
 * with a 1M-context model variant or when emergency-tuning a deployment.
 */
function resolveAutoCompactWindow(contextWindow: number | undefined): string {
  if (process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW) return process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW;
  if (!contextWindow) {
    // Should be unreachable — container-runner.ts refuses to spawn without
    // a configured context window. Fail loudly rather than silently reusing
    // a Claude-200k-shaped default that could be wrong for the active model.
    throw new Error(
      'ClaudeProvider: no contextWindow configured — refusing to guess an auto-compact window. ' +
        'Set one via `ncl groups config update --context-window <tokens>`.',
    );
  }
  return String(Math.floor(contextWindow * AUTO_COMPACT_HEADROOM_RATIO));
}

/**
 * Stale-session detection. Matches Claude Code's error text when a
 * resumed session can't be found — missing transcript .jsonl, unknown
 * session ID, etc.
 */
const STALE_SESSION_RE = /no conversation found|ENOENT.*\.jsonl|session.*not found/i;

export class ClaudeProvider implements AgentProvider {
  readonly supportsNativeSlashCommands = true;

  private assistantName?: string;
  private mcpServers: Record<string, McpServerConfig>;
  private env: Record<string, string | undefined>;
  private additionalDirectories?: string[];
  private model?: string;
  private effort?: string;
  private memorySessionHook?: MemorySessionHookRegistration;

  constructor(options: ProviderOptions = {}) {
    this.assistantName = options.assistantName;
    this.mcpServers = options.mcpServers ?? {};
    this.additionalDirectories = options.additionalDirectories;
    this.model = options.model;
    this.effort = options.effort;
    this.env = {
      ...(options.env ?? {}),
      CLAUDE_CODE_AUTO_COMPACT_WINDOW: resolveAutoCompactWindow(options.contextWindow),
      // NOT set here: CLAUDE_CODE_DISABLE_AUTO_MEMORY — upstream's memory
      // scaffold hardcodes this to '1' unconditionally; this fork keeps
      // group-init.ts's '0' (memsearch + working-memory.md instead). See
      // docs/memory-decision-upstream-declined.md.
    };
  }

  registerMemorySessionHook(hook: MemorySessionHookRegistration): void {
    writeMemorySessionHook(hook);
    this.memorySessionHook = hook;
  }

  isSessionInvalid(err: unknown): boolean {
    const msg = err instanceof Error ? err.message : String(err);
    return STALE_SESSION_RE.test(msg);
  }

  maybeRotateContinuation(continuation: string): string | null {
    const transcriptPath = findTranscriptPath(continuation);
    if (!transcriptPath) return null;

    let size: number;
    try {
      size = fs.statSync(transcriptPath).size;
    } catch {
      return null;
    }

    const maxBytes = transcriptRotateBytes();
    const startMs = transcriptStartMs(transcriptPath);
    const ageMs = startMs === null ? 0 : Date.now() - startMs;
    const maxAgeMs = transcriptRotateAgeMs();

    let reason: string | null = null;
    if (size > maxBytes) {
      reason = `transcript ${(size / 1_048_576).toFixed(1)}MB > ${(maxBytes / 1_048_576).toFixed(0)}MB cap`;
    } else if (startMs !== null && ageMs > maxAgeMs) {
      reason = `transcript ${(ageMs / 86_400_000).toFixed(1)}d old > ${(maxAgeMs / 86_400_000).toFixed(0)}d cap`;
    }
    if (!reason) return null;

    // Preserve a readable summary, then move the heavy .jsonl out of the
    // resume path so the SDK starts a fresh session and the disk is reclaimed.
    archiveTranscriptFile(transcriptPath, continuation, this.assistantName);
    try {
      fs.renameSync(transcriptPath, `${transcriptPath}.rotated-${Date.now()}`);
    } catch (err) {
      log(`Failed to move rotated transcript aside: ${err instanceof Error ? err.message : String(err)}`);
    }
    return reason;
  }

  onExchangeComplete(exchange: import('./types.js').ProviderExchange): void {
    if (exchange.status === 'error') return;
    captureMemoryTurn(exchange.continuation, this.assistantName);
    exportTurnToInbox(exchange.continuation, this.assistantName);
  }

  query(input: QueryInput): AgentQuery {
    // NOTE: upstream requires registerMemorySessionHook() to have been called
    // before any query, throwing otherwise — but this fork deliberately never
    // calls it (see index.ts's NOTE and docs/memory-decision-upstream-declined.md).
    // `this.memorySessionHook` staying unset here is expected, not an error.
    const stream = new MessageStream();
    stream.push(input.prompt);

    let instructions = input.systemContext?.instructions;

    // working-memory.md is read fresh every turn and folded into the system
    // prompt rather than pushed as a message — systemPrompt.append is an SDK
    // option, not part of the conversation stream, so it never enters the
    // resumable transcript `resume` replays. That gives always-current
    // content with zero turn-over-turn accumulation, for free, with no new
    // mechanism needed (see 01-Projects/Synthetic Context Delivery for the
    // fancier synthetic-tool-call alternative this deliberately sidesteps).
    const workingMemoryPath = path.join(input.cwd, 'working-memory.md');
    const WORKING_MEMORY_SOFT_CAP_LINES = 40;
    const WORKING_MEMORY_HARD_CAP_LINES = 60; // 50% over the file's own documented soft cap
    let raw = '';
    try {
      raw = fs.readFileSync(workingMemoryPath, 'utf-8');
    } catch {
      // ENOENT — leave raw empty, handled below same as an empty file.
    }
    if (!raw.trim()) {
      // Missing or blank — a single empty turn is otherwise enough to make
      // Lumen forget the scratchpad exists at all. Rather than making her
      // jump through hoops to recreate it from an instruction, just seed it
      // from the template (same copy-if-missing pattern as memory-scaffold.ts)
      // so this turn already has a populated file to inject.
      const template = fs.readFileSync(path.join(import.meta.dir, '../memory-templates/working-memory.md'), 'utf-8');
      fs.writeFileSync(workingMemoryPath, template);
      raw = template;
    }
    const workingMemory = raw.trim();
    const workingMemoryLines = workingMemory.split('\n').length;
    let workingMemoryOverflowNote = '';
    if (workingMemoryLines > WORKING_MEMORY_HARD_CAP_LINES) {
      workingMemoryOverflowNote = `\n\n<system>working-memory.md is ${workingMemoryLines} lines, well past its ${WORKING_MEMORY_SOFT_CAP_LINES}-line soft cap. Offload settled/historical items into the vault (remember, or a proper note) and trim this file back down — it's a scratchpad, not an archive, and it's eating context you need for thinking.</system>`;
    }
    // Line count of the actual on-disk file (not the trimmed display copy) —
    // this is what a line-numbered edit tool (sed, patch-by-line) needs to
    // target the real last line, so it must match `raw`, not `workingMemory`.
    const workingMemoryEndMarker = `\n\n--- ${workingMemoryPath} ends at line ${raw.split('\n').length}`;
    // Delivery mode decided further down, once we know whether a synthetic
    // context skeleton was actually built this turn — 'system' (default, or
    // synthetic mode with no canonical transcript yet) folds it into the
    // system prompt right here; synthetic mode with a built skeleton delivers
    // it via the skeleton's load_briefing slot instead, no system-prompt
    // fallback text at all this turn.

    // One correlation ID per turn (per `.query()` call, not per provider
    // instance -- the provider is long-lived across many turns). Every
    // request the SDK's underlying CLI makes during this turn's tool-use
    // loop carries the same ID via ANTHROPIC_CUSTOM_HEADERS, which the SDK's
    // bundled Anthropic client parses (newline-separated "Header: value"
    // pairs) into request headers -- confirmed in node_modules/@anthropic-ai/
    // claude-agent-sdk/sdk.mjs, no public SDK option exposes this directly.
    // PrefixRouter records it as sender-correlation-id, letting us group all
    // sequential requests from one turn in its logs.
    const turnCorrelationId = randomUUID();
    log(`turn correlation id: ${turnCorrelationId}`);

    // ── Synthetic context (A/B, off by default — see helpers above) ──
    const syntheticMode = syntheticContextEnabled();
    let canonicalId: string | undefined = input.continuation;
    let skeleton: SkeletonResume | null = null;
    let resumeTarget = input.continuation;
    if (syntheticMode) {
      try {
        const marked = fs.readFileSync(canonicalMarkerPath(input.cwd), 'utf-8').trim();
        if (marked) canonicalId = marked;
      } catch {
        // No marker yet — canonicalId stays input.continuation (undefined on a brand-new session).
      }
      const canonicalPath = canonicalId ? findTranscriptPath(canonicalId) : null;
      if (canonicalPath) {
        const literalHistory = buildLiteralHistoryMarkdown(canonicalPath, syntheticContextTurnWindow(), this.assistantName);
        const lastUserMessage = lastRealUserMessage(canonicalPath);
        // Real Briefer content, async + one-turn-behind (see
        // docs/synthetic-context.md): the host kicks off a Briefer call on
        // message arrival (src/modules/synthetic-context/briefing-cache.ts)
        // and writes the result here once it resolves ~30-45s later — too
        // slow to block this turn on, so THIS turn sees whatever was
        // computed for the *previous* message. Working-memory.md gets its
        // own dedicated skeleton slot below — it no longer doubles as the
        // briefing fallback, since that conflated two different kinds of
        // content and meant the working-memory content wasn't reliably in
        // the same place turn over turn (bad for prefix stability too).
        let briefingContent: string;
        try {
          briefingContent = fs.readFileSync(path.join(input.cwd, '.briefing-cache.md'), 'utf-8');
        } catch {
          briefingContent = '_(no briefing available yet — brand-new session or first round hasn\'t completed)_';
        }
        const workingMemoryContent = `${workingMemory}${workingMemoryEndMarker}${workingMemoryOverflowNote}`;
        skeleton = buildSkeletonTranscript(input.cwd, lastUserMessage, literalHistory, briefingContent, workingMemoryContent);
        resumeTarget = skeleton.ephemeralId;
        log(`synthetic context: resuming skeleton ${skeleton.ephemeralId} (${skeleton.skeletonEntryCount} entries) of canonical ${canonicalId}`);
      }
    }
    // Working-memory delivery: content goes via the skeleton's own
    // load_working_memory slot when one was built this turn; system-prompt
    // fallback otherwise (mode is off, or this is a brand-new session with
    // no canonical transcript yet to build a skeleton from — next turn's
    // canonical marker will exist). The maintenance instruction below is NOT
    // part of that content split — it must reach every turn regardless of
    // delivery path, since a skeleton's tool-result slots are substituted
    // content, not a place to append a standing instruction.
    const workingMemoryInstruction = `\n\n# Your working notes for this conversation\n\nAfter you have finished your tasks and finished responding to the user, update the file at ${workingMemoryPath} to reflect any changes or decisions or open questions that remain. This file is how you anchor yourself and maintain continuity across turns.`;
    instructions = skeleton
      ? `${instructions ?? ''}${workingMemoryInstruction}`
      : `${instructions ?? ''}${workingMemoryInstruction}\n\n${workingMemory}${workingMemoryEndMarker}${workingMemoryOverflowNote}`;

    const sdkResult = sdkQuery({
      prompt: stream,
      options: {
        cwd: input.cwd,
        additionalDirectories: this.additionalDirectories,
        resume: resumeTarget,
        pathToClaudeCodeExecutable: '/pnpm/claude',
        systemPrompt: instructions
          ? { type: 'preset' as const, preset: 'claude_code' as const, append: instructions }
          : undefined,
        allowedTools: [...TOOL_ALLOWLIST, ...Object.keys(this.mcpServers).map(mcpAllowPattern)],
        disallowedTools: SDK_DISALLOWED_TOOLS,
        env: { ...this.env, ANTHROPIC_CUSTOM_HEADERS: `x-correlation-id: ${turnCorrelationId}` },
        model: this.model,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        effort: this.effort as any,
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        settingSources: ['project', 'user', 'local'],
        mcpServers: this.mcpServers,
        hooks: {
          PreToolUse: [{ hooks: [preToolUseHook] }],
          PostToolUse: [{ hooks: [postToolUseHook] }],
          PostToolUseFailure: [{ hooks: [postToolUseHook] }],
          PreCompact: [{ hooks: [createPreCompactHook(this.assistantName)] }],
        },
      },
    });

    let aborted = false;
    let sessionId: string | undefined;
    let replyText: string | null = null;

    const memoryWriterEnabled = this.env.NANOCLAW_MEMORY_WRITER === '1' || this.env.NANOCLAW_MEMORY_WRITER === 'true';
    const runMemoryWriterFollowUp = this.runMemoryWriterFollowUp.bind(this);

    async function* translateEvents(): AsyncGenerator<ProviderEvent> {
      let messageCount = 0;
      for await (const message of sdkResult) {
        if (aborted) return;
        messageCount++;

        // Yield activity for every SDK event so the poll loop knows the agent is working
        yield { type: 'activity' };

        if (message.type === 'system' && message.subtype === 'init') {
          if (syntheticMode) {
            // First-ever turn for this session: nothing existed to truncate,
            // so the SDK's own fresh session becomes canonical going forward.
            if (!canonicalId) canonicalId = message.session_id;
            sessionId = canonicalId;
            try {
              fs.writeFileSync(canonicalMarkerPath(input.cwd), canonicalId);
            } catch (err) {
              log(`Failed to write canonical session marker: ${err instanceof Error ? err.message : String(err)}`);
            }
            yield { type: 'init', continuation: canonicalId };
          } else {
            sessionId = message.session_id;
            yield { type: 'init', continuation: message.session_id };
          }
        } else if (message.type === 'result') {
          // `result` text exists only on subtype:"success"; error subtypes
          // (e.g. a non-retryable 403 billing_error) carry their message in
          // `errors[]` instead. Surface either so the poll-loop can deliver a
          // billing/quota notice to the user rather than dropping the turn.
          const m = message as { result?: string; is_error?: boolean; errors?: string[] };
          const text = m.result ?? (m.errors && m.errors.length > 0 ? m.errors.join('\n') : null);
          replyText = text;
          yield { type: 'result', text, isError: m.is_error === true };
        } else if (message.type === 'system' && (message as { subtype?: string }).subtype === 'api_retry') {
          yield { type: 'error', message: 'API retry', retryable: true };
        } else if (message.type === 'rate_limit_event') {
          // The SDK emits this "when rate limit info CHANGES" — it is telemetry,
          // not necessarily an error. `rate_limit_info.status` is usually
          // 'allowed' (here's your remaining headroom). Treating every one of
          // these as a terminal quota error logged a spurious rate-limit line
          // on healthy turns (#3016) — and aborted them outright wherever the
          // classification is acted on. ONLY 'rejected' is an actual block.
          //
          // When it IS rejected the SDK tells us WHY, so we can finally
          // distinguish the two cases properly instead of guessing:
          //   errorCode 'credits_required' / overageDisabledReason
          //   'out_of_credits'  → genuinely out of credits (billing)
          //   otherwise         → a transient window limit that resets.
          const info = (message as { rate_limit_info?: SdkRateLimitInfo }).rate_limit_info;
          const blocked = classifyRateLimitEvent(info);
          if (!blocked) {
            // Informational ('allowed' / 'allowed_warning') — never kill the turn.
            if (info?.status === 'allowed_warning') {
              log(
                `rate-limit warning: ${info.rateLimitType ?? 'window'} at ${
                  info.utilization != null ? `${Math.round(info.utilization * 100)}%` : 'high'
                } utilization`,
              );
            }
          } else {
            yield { type: 'error', message: blocked.message, retryable: false, classification: blocked.classification };
          }
        } else if (message.type === 'system' && (message as { subtype?: string }).subtype === 'compact_boundary') {
          const meta = (message as { compact_metadata?: { pre_tokens?: number } }).compact_metadata;
          const detail = meta?.pre_tokens ? ` (${meta.pre_tokens.toLocaleString()} tokens compacted)` : '';
          // Not a `result`: the poll loop treats result text as the agent's turn
          // output — a synthetic "Context compacted." result has no <message>
          // block, so it triggers the "response was not delivered — please
          // re-send" nudge and the agent duplicates its previous message.
          // Compaction is bookkeeping: log it, count it as activity only.
          log(`Context compacted${detail}.`);
          yield { type: 'activity' };
        } else if (message.type === 'system' && (message as { subtype?: string }).subtype === 'task_notification') {
          const tn = message as { summary?: string };
          yield { type: 'progress', message: tn.summary || 'Task notification' };
        }
      }
      if (skeleton && canonicalId) {
        const canonicalPath = findTranscriptPath(canonicalId);
        if (canonicalPath) {
          mirrorSkeletonTurnToCanonical(canonicalId, canonicalPath, skeleton);
        } else {
          log(`synthetic context: canonical transcript ${canonicalId} vanished, could not mirror new turns`);
        }
      }
      log(`Query completed after ${messageCount} SDK messages`);

      // Runs sequentially after the primary call fully drains (not
      // concurrently with it) — deliberately, since two live processes
      // resumed against the same session transcript is the exact hazard the
      // sdk-hang-abort workaround above exists to prevent. The user-facing
      // reply is already delivered by now (poll-loop reacts to the 'result'
      // event as it's yielded, above); this only delays how soon poll-loop
      // considers the turn fully finished, not the reply itself.
      if (memoryWriterEnabled && !aborted && sessionId && replyText) {
        try {
          await runMemoryWriterFollowUp(input.cwd, sessionId, instructions, turnCorrelationId);
        } catch (err) {
          log(`memory-writer follow-up failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }

    return {
      push: (msg) => stream.push(msg),
      end: () => stream.end(),
      events: translateEvents(),
      // ===== WORKAROUND: claude-agent-sdk (tag: sdk-hang-abort) =====
      // See ORIENTATION.md (or .claude/orientation/) "external-workarounds"
      // entry with this same tag for the full incident writeup. Short
      // version: query.abort() previously only stopped OUR OWN consumption
      // of sdkResult and our own input stream -- it never actually
      // terminated the underlying CLI subprocess. On a genuine hang (the
      // subprocess goes silent and never exits -- a known, still-open
      // upstream bug, see anthropics/claude-code#28482 and
      // anthropics/claude-agent-sdk-python#701), that left a wedged process
      // alive, resumed against the same session id, while the next
      // poll-loop iteration immediately spawned a SECOND sdkQuery() resumed
      // against the SAME session -- two processes with a live claim on one
      // resumed transcript file. If the wedged one ever woke up on its own
      // it could write to that file concurrently with the new one, or
      // flush a stale buffered tool call (e.g. a duplicate send_message)
      // well after the fact.
      //
      // interrupt() is the SDK's real control-channel teardown: per its own
      // spawnClaudeCodeProcess doc comment, it does stdin-EOF, waits ~2s
      // grace, then force-kills via signal if the process hasn't exited
      // cleanly by then -- bounded and eventually forceful even if the
      // process isn't cooperating, not "ask nicely and hope." abort() now
      // awaits it and only resolves once that's done, so callers that await
      // abort() (poll-loop.ts's processQuery) can guarantee the old process
      // is gone before starting a new one.
      //
      // DO NOT casually refactor or delete this block when touching this
      // file for something else -- if/when Anthropic fixes the underlying
      // hang, this whole workaround (this block, the matching await-abort
      // plumbing in poll-loop.ts, and HANG_ABORT_MS) should be revertable as
      // one clean, isolated change. Keep it that way: don't interleave
      // unrelated edits into these lines.
      abort: async () => {
        aborted = true;
        stream.end();
        const interruptStartedAt = Date.now();
        try {
          await sdkResult.interrupt();
          log(`interrupt() completed after ${Date.now() - interruptStartedAt}ms`);
        } catch (err) {
          log(`interrupt() failed after ${Date.now() - interruptStartedAt}ms: ${err instanceof Error ? err.message : String(err)}`);
        }
      },
      // ===== END WORKAROUND: claude-agent-sdk (tag: sdk-hang-abort) =====
    };
  }

  /**
   * Post-reply working-memory.md maintenance, run in-container as a second
   * turn resumed on the same session Lumen just answered in — not a
   * separate host-side process. Deliberately reuses the exact same
   * mcpServers/allowedTools/disallowedTools/systemPrompt as her real call
   * (see query() above): different tool defs would produce a different
   * request prefix, defeating the whole point of running this here instead
   * of from the host (see 2026-07-21 discussion — Ollama's implicit prefix
   * caching needs byte-identical leading tokens, not just "close enough").
   * Replaces the old host-side src/modules/memory-writer (removed).
   */
  private async runMemoryWriterFollowUp(cwd: string, resumeId: string, instructions: string | undefined, correlationId: string): Promise<void> {
    const workingMemoryPath = path.join(cwd, 'working-memory.md');
    const prompt = [
      `Now update the file at ${workingMemoryPath} to reflect your own state after this turn —`,
      'what you are doing, thinking, discussing, tracking, or letting simmer. Not a project',
      'tracker or a log of user requests; your own anchor for continuity across turns. Only file',
      'something if it is actually yours to carry forward.',
      '',
      'Remember that anything not saved will be lost. If it is meaningful across turns, put it in',
      'working-memory.md.',
      '',
      'One overwritten line, then five fixed, capped sections:',
      '- Focus (1 line, overwritten every turn, no cap): what you are actively engaged with right',
      '  now, this exchange.',
      '- Now (max 2): what you are actively working on or thinking through across turns.',
      '- Open (max 2): questions you are sitting with or blocked on, waiting on the user.',
      "- Soon (max 2): committed next steps, not yet started.",
      '- Watch (max 6): things you are keeping half an eye on.',
      '- Back Burner (max 6): things you are letting simmer — deprioritized, not forgotten.',
      '',
      'If a section is at cap, fold the new item into an existing bullet, bump the least-relevant',
      'item down a tier, or drop it if settled. Never push a section over its cap. If nothing worth',
      'recording changed, leave the file as is. Edit the file directly; reply with just "done".',
    ].join('\n');

    const followUpStream = new MessageStream();
    followUpStream.push(prompt);
    followUpStream.end();

    const result = sdkQuery({
      prompt: followUpStream,
      options: {
        cwd,
        additionalDirectories: this.additionalDirectories,
        resume: resumeId,
        pathToClaudeCodeExecutable: '/pnpm/claude',
        systemPrompt: instructions ? { type: 'preset' as const, preset: 'claude_code' as const, append: instructions } : undefined,
        allowedTools: [...TOOL_ALLOWLIST, ...Object.keys(this.mcpServers).map(mcpAllowPattern)],
        disallowedTools: SDK_DISALLOWED_TOOLS,
        env: { ...this.env, ANTHROPIC_CUSTOM_HEADERS: `x-correlation-id: ${correlationId}` },
        model: this.model,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        effort: this.effort as any,
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        settingSources: ['project', 'user', 'local'],
        mcpServers: this.mcpServers,
      },
    });

    let messageCount = 0;
    for await (const _message of result) {
      messageCount++;
    }
    log(`memory-writer follow-up completed after ${messageCount} SDK messages`);
  }
}

registerProvider('claude', (opts) => new ClaudeProvider(opts));
