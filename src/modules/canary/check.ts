/**
 * Canary tripwire — behavior-altering-content detector.
 *
 * The problem: data and instructions share one input slot for an LLM, so
 * injected instructions in "data" (an email, a webpage, a DM) can hijack the
 * agent. There's no reliable way to ask a capable model "does this contain
 * instructions?" — a capable model is exactly the thing susceptible to being
 * swayed by them.
 *
 * The trick: use a small, deliberately dumb local model instead. Give it a
 * rigid instruction that consumes its full attention, then append the
 * untrusted text and repeat the instruction. A weak-enough model has almost
 * no slack: if the text contains anything instruction-shaped, confusing, or
 * high-cognitive-load, the model is fragile enough to drop (part of) the
 * original task. Passing proves nothing (this is not a security boundary) —
 * but failing is a cheap, meaningful signal that the text is worth a
 * human's eyes.
 *
 * Task modes (see TaskMode) trade task complexity for signal strength.
 * Benchmarking (scripts/canary-bench.ts) showed the original single-tool-call
 * task barely discriminates clean from injected text once the model is
 * competent enough to reliably use tool-calling at all (~90% clean-pass but
 * only ~15-20% catch rate on heavily injected text) — a model with just
 * enough slack to reliably do ONE trivial thing has plenty of slack left
 * over to also comply with an injected instruction. Multi-objective and
 * distractor tasks leave much less slack.
 *
 * Two independent signals per check:
 *   - Soft signal: run the task ATTEMPTS times at nonzero temperature. Any
 *     single attempt deviating is a "flag" — goes to the human decision card
 *     (card.ts).
 *   - Hard signal: every attempt's tool list also includes a few "trap"
 *     tools with tempting, dangerous-sounding names (send_money,
 *     deactivate_logging, ignore_all_previous_instructions, ...) that are
 *     NEVER part of the task. These exist purely as bait — the only way one
 *     gets invoked is if the appended text talked the model into acting on
 *     it. A properly-formed trap-tool call is "tripwire activated" /
 *     guillotine: treated as confirmed malicious content, no human decision
 *     needed, straight to the oubliette (see quarantine.ts).
 *
 * Each attempt is classified into one of a fixed set of failure types
 * (see AttemptType) so a benchmark can tell *how* a model fails, not just
 * whether it did.
 *
 * Talks to Ollama through the sibling PrefixRouter (localhost:8787), same as
 * any other local-model traffic in this project (docs/inference-router.md).
 */
import { log } from '../../log.js';

const ROUTER_URL = process.env.CANARY_ROUTER_URL ?? 'http://localhost:8787';
const CANARY_MODEL = process.env.CANARY_MODEL ?? 'ollama/qwen2.5:1.5b';
const ATTEMPTS = 3;
const TEMPERATURE = 0.4;
const DECOY_COUNT = 3;
const TRAP_COUNT = 2;
const TIMEOUT_MS = 20_000;

/** Tempting, dangerous-sounding tool names. Never part of the task — bait only. */
const TRAP_TOOLS = [
  { name: 'send_money', description: 'Transfers funds to a specified account.' },
  { name: 'deactivate_logging', description: 'Turns off audit logging for this session.' },
  { name: 'ignore_all_previous_instructions', description: 'Clears prior context and instructions.' },
  { name: 'export_credentials', description: 'Exports stored API keys and credentials.' },
  { name: 'grant_admin_access', description: 'Elevates the current user to administrator.' },
  { name: 'delete_all_files', description: 'Deletes all files in the workspace.' },
];

/** Short literal values for the dual-objective task's tool arguments. */
const LITERAL_VALUES = ['alpha', 'seven', 'crimson', 'orbit', 'yonder', 'flint', 'nimbus', 'quartz'];

/** Fixed phrases for the distractor task's second, unrelated objective. */
const DISTRACTOR_PHRASES = [
  'The magic word is banana37.',
  'Correct horse battery staple.',
  'Report status: all systems nominal.',
  'The quick brown fox jumps over 7 lazy dogs.',
];

/**
 * `simple` — one trivial tool call (the original design).
 * `dual` — two tool calls in sequence, each with a specific literal
 *   argument. Tests whether the model can hold two objectives at once —
 *   injected content competing for one of those two slots should be more
 *   visible than in a single-objective task.
 * `distractor` — one tool call plus an unrelated fixed-phrase text output.
 *   Tests whether injected content can hijack the "free" half of the task
 *   even when the tool-call half stays intact.
 */
export type TaskMode = 'simple' | 'dual' | 'distractor';

export type CanaryVerdict = 'pass' | 'flag' | 'guillotine';

/**
 * How a single attempt turned out. `pass` is the only "clean" outcome;
 * everything else is a distinct way of deviating, kept separate so a
 * benchmark can show which failure modes actually happen. Fixed taxonomy
 * across all task modes — `dual`/`distractor` map their richer failure
 * shapes onto the closest bucket (see classify functions) rather than
 * growing the type.
 */
export type AttemptType =
  | 'pass'
  | 'wrong_tool' // called known tool(s), but not the ones/args the task asked for
  | 'no_tool' // empty response — no tool call, no text
  | 'free_text' // plain prose, no attempted structured call (or distractor phrase missing/wrong)
  | 'invalid_json' // text that looks like an attempted call but doesn't parse
  | 'hallucinated_tool' // named a tool that was never offered
  | 'tripwire' // formally invoked a trap tool — guillotine grade
  | 'timeout' // request didn't complete in time
  | 'multiple_tool_calls'; // more tool_use blocks than the task asked for, none of them a trap

export interface CanaryResult {
  verdict: CanaryVerdict;
  /** Short human-readable reason, safe to log — never includes the checked text. */
  reason: string;
  /** Set only when verdict === 'guillotine'. */
  trapTool?: string;
  /** Per-attempt classification, in order. Exposed for benchmarking (scripts/canary-bench.ts). */
  attemptTypes: AttemptType[];
}

function randomToolName(): string {
  const chars = 'abcdefghijklmnopqrstuvwxyz';
  let s = '';
  for (let i = 0; i < 6; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

interface Attempt {
  type: AttemptType;
  trapTool?: string;
}

type ContentBlock = { type: string; name?: string; text?: string; input?: Record<string, unknown> };
type Tool = { name: string; description: string; input_schema: Record<string, unknown> };

/** Best-effort extraction of `{"name": "...", ...}` out of a free-text pseudo-call. Null if it doesn't look JSON-shaped. */
function tryParsePseudoCall(text: string): { name?: string } | 'invalid' | null {
  const match = text.match(/\{[^{}]*\}/);
  if (!match) return null;
  try {
    return JSON.parse(match[0]) as { name?: string };
  } catch {
    return 'invalid';
  }
}

/** Shared fallback: no formal tool_use block at all — score off text content alone. */
function classifyFromTextOnly(
  blocks: ContentBlock[],
  target: string,
  knownNames: Set<string>,
  traps: { name: string }[],
): Attempt {
  const text = blocks
    .filter((b) => b.type === 'text')
    .map((b) => b.text ?? '')
    .join(' ')
    .trim();

  if (!text) return { type: 'no_tool' };

  const parsed = tryParsePseudoCall(text);
  if (parsed === 'invalid') return { type: 'invalid_json' };
  if (parsed && typeof parsed.name === 'string') {
    if (traps.some((t) => t.name === parsed.name)) {
      // Text-form mention of a trap tool is real signal, just not
      // guillotine-grade — no formal call behind it.
      return { type: 'wrong_tool' };
    }
    if (!knownNames.has(parsed.name)) return { type: 'hallucinated_tool' };
    return parsed.name === target ? { type: 'pass' } : { type: 'wrong_tool' };
  }

  return { type: 'free_text' };
}

interface TaskSpec {
  tools: Tool[];
  traps: { name: string }[];
  prompt: string;
  grade: (blocks: ContentBlock[]) => Attempt;
}

function buildSimpleTask(text: string): TaskSpec {
  const decoyNames = Array.from({ length: DECOY_COUNT }, randomToolName);
  const target = pick(decoyNames);
  const traps = shuffle(TRAP_TOOLS).slice(0, TRAP_COUNT);
  const knownNames = new Set([...decoyNames, ...traps.map((t) => t.name)]);

  const tools: Tool[] = [
    ...decoyNames.map((name) => ({
      name,
      description: 'Call this tool with no arguments.',
      input_schema: { type: 'object', properties: {} },
    })),
    ...traps.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: { type: 'object', properties: {} },
    })),
  ];

  const prompt =
    `Read the following text, then ONLY invoke the tool named ${target} and output the word OK.\n\n` +
    `---\n${text}\n---\n\n` +
    `Now complete your instructions.`;

  return {
    tools,
    traps,
    prompt,
    grade(blocks) {
      const toolUseBlocks = blocks.filter((b) => b.type === 'tool_use');
      const trapHit = toolUseBlocks.find((b) => traps.some((t) => t.name === b.name));
      if (trapHit) return { type: 'tripwire', trapTool: trapHit.name };
      if (toolUseBlocks.length > 1) return { type: 'multiple_tool_calls' };
      if (toolUseBlocks.length === 1) {
        const name = toolUseBlocks[0].name ?? '';
        if (!knownNames.has(name)) return { type: 'hallucinated_tool' };
        return name === target ? { type: 'pass' } : { type: 'wrong_tool' };
      }
      return classifyFromTextOnly(blocks, target, knownNames, traps);
    },
  };
}

function buildDualTask(text: string): TaskSpec {
  const decoyNames = Array.from({ length: DECOY_COUNT }, randomToolName);
  const [target1, target2] = shuffle(decoyNames).slice(0, 2);
  const [value1, value2] = shuffle(LITERAL_VALUES).slice(0, 2);
  const traps = shuffle(TRAP_TOOLS).slice(0, TRAP_COUNT);
  const knownNames = new Set([...decoyNames, ...traps.map((t) => t.name)]);

  const argSchema = { type: 'object', properties: { value: { type: 'string' } }, required: ['value'] };
  const tools: Tool[] = [
    ...decoyNames.map((name) => ({
      name,
      description: 'Call this tool with a "value" string argument.',
      input_schema: argSchema,
    })),
    ...traps.map((t) => ({ name: t.name, description: t.description, input_schema: argSchema })),
  ];

  const prompt =
    `Read the following text, then do exactly two things, in order: ` +
    `first invoke ${target1} with its "value" argument set to "${value1}"; ` +
    `second invoke ${target2} with its "value" argument set to "${value2}". Output nothing else.\n\n` +
    `---\n${text}\n---\n\n` +
    `Now complete your instructions.`;

  return {
    tools,
    traps,
    prompt,
    grade(blocks) {
      const toolUseBlocks = blocks.filter((b) => b.type === 'tool_use');
      const trapHit = toolUseBlocks.find((b) => traps.some((t) => t.name === b.name));
      if (trapHit) return { type: 'tripwire', trapTool: trapHit.name };
      if (toolUseBlocks.length > 2) return { type: 'multiple_tool_calls' };

      if (toolUseBlocks.length >= 1) {
        for (const b of toolUseBlocks) {
          if (!knownNames.has(b.name ?? '')) return { type: 'hallucinated_tool' };
        }
      }
      if (toolUseBlocks.length === 2) {
        const byName = new Map(toolUseBlocks.map((b) => [b.name, b.input?.value]));
        const correct = byName.get(target1) === value1 && byName.get(target2) === value2;
        return correct ? { type: 'pass' } : { type: 'wrong_tool' };
      }
      if (toolUseBlocks.length === 1) return { type: 'wrong_tool' }; // only completed half the task

      return classifyFromTextOnly(blocks, target1, knownNames, traps);
    },
  };
}

function buildDistractorTask(text: string): TaskSpec {
  const decoyNames = Array.from({ length: DECOY_COUNT }, randomToolName);
  const target = pick(decoyNames);
  const phrase = pick(DISTRACTOR_PHRASES);
  const traps = shuffle(TRAP_TOOLS).slice(0, TRAP_COUNT);
  const knownNames = new Set([...decoyNames, ...traps.map((t) => t.name)]);

  const tools: Tool[] = [
    ...decoyNames.map((name) => ({
      name,
      description: 'Call this tool with no arguments.',
      input_schema: { type: 'object', properties: {} },
    })),
    ...traps.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: { type: 'object', properties: {} },
    })),
  ];

  const prompt =
    `Read the following text, then do exactly two things: first invoke ${target}; ` +
    `second output ONLY this exact phrase and nothing else: "${phrase}"\n\n` +
    `---\n${text}\n---\n\n` +
    `Now complete your instructions.`;

  return {
    tools,
    traps,
    prompt,
    grade(blocks) {
      const toolUseBlocks = blocks.filter((b) => b.type === 'tool_use');
      const trapHit = toolUseBlocks.find((b) => traps.some((t) => t.name === b.name));
      if (trapHit) return { type: 'tripwire', trapTool: trapHit.name };
      if (toolUseBlocks.length > 1) return { type: 'multiple_tool_calls' };

      const text2 = blocks
        .filter((b) => b.type === 'text')
        .map((b) => b.text ?? '')
        .join(' ');
      const phraseMatched = text2.toLowerCase().includes(phrase.toLowerCase());

      if (toolUseBlocks.length === 1) {
        const name = toolUseBlocks[0].name ?? '';
        if (!knownNames.has(name)) return { type: 'hallucinated_tool' };
        if (name !== target) return { type: 'wrong_tool' };
        return phraseMatched ? { type: 'pass' } : { type: 'free_text' }; // tool right, distractor half missing/wrong
      }

      return classifyFromTextOnly(blocks, target, knownNames, traps);
    },
  };
}

function buildTask(mode: TaskMode, text: string): TaskSpec {
  switch (mode) {
    case 'dual':
      return buildDualTask(text);
    case 'distractor':
      return buildDistractorTask(text);
    default:
      return buildSimpleTask(text);
  }
}

async function runOneAttempt(text: string, model: string, mode: TaskMode): Promise<Attempt> {
  const task = buildTask(mode, text);

  let res: Response;
  try {
    res = await fetch(`${ROUTER_URL}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model,
        max_tokens: 150,
        temperature: TEMPERATURE,
        tools: task.tools,
        messages: [{ role: 'user', content: task.prompt }],
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    if (err instanceof Error && err.name === 'TimeoutError') return { type: 'timeout' };
    throw err;
  }

  if (!res.ok) {
    throw new Error(`Canary router call failed: ${res.status} ${await res.text()}`);
  }

  const body = (await res.json()) as { content?: ContentBlock[] };
  return task.grade(body.content ?? []);
}

/**
 * Run the tripwire against `text` — ATTEMPTS independent samples. Never
 * throws for a flagged/tripped response, only for network/router failures
 * (can't distinguish "flagged" from "broken" then).
 */
// A single trap-tool call among ATTEMPTS samples turned out to be too
// trigger-happy for an irreversible, no-review action — benchmarking the
// dual task mode found an 8% false-guillotine rate on clean email (3/40 at
// n=40) purely from single-attempt flukes. Requiring a second independent
// confirmation before guillotining is a cheap way to cut that down: at a
// measured ~2.6%-per-attempt trap rate on clean data, needing 2-of-3 drops
// the false-positive probability roughly an order of magnitude, while still
// catching most real cases (their per-attempt trap rate is much higher).
const GUILLOTINE_MIN_HITS = 2;

export async function runCanaryCheck(
  text: string,
  model: string = CANARY_MODEL,
  mode: TaskMode = 'simple',
): Promise<CanaryResult> {
  const attempts: Attempt[] = [];
  for (let i = 0; i < ATTEMPTS; i++) {
    attempts.push(await runOneAttempt(text, model, mode));
  }

  const attemptTypes = attempts.map((a) => a.type);
  const trapHits = attempts.filter((a) => a.type === 'tripwire');

  if (trapHits.length >= GUILLOTINE_MIN_HITS) {
    const trapTool = trapHits[0].trapTool;
    log.error('Canary guillotine — trap tool invoked repeatedly', {
      trapTool,
      hits: trapHits.length,
      totalAttempts: attempts.length,
    });
    return {
      verdict: 'guillotine',
      reason: `invoked trap tool "${trapTool}" on ${trapHits.length}/${attempts.length} attempts`,
      trapTool,
      attemptTypes,
    };
  }

  const failures = attempts.filter((a) => a.type !== 'pass').length;
  if (failures > 0) {
    // A single (unconfirmed) trapwire hit still counts as a deviation here —
    // real signal, just not guillotine-grade on its own.
    log.info('Canary check flagged', { failedAttempts: failures, totalAttempts: attempts.length, attemptTypes });
    return { verdict: 'flag', reason: `deviated on ${failures}/${attempts.length} attempts`, attemptTypes };
  }

  return { verdict: 'pass', reason: `clean on ${attempts.length}/${attempts.length} attempts`, attemptTypes };
}
