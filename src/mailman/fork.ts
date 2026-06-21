import fs from 'fs';
import path from 'path';

import { readEnvFile } from '../env.js';
import { log } from '../log.js';
import { spawnMailmanContainer, parseJsonResult } from './spawn.js';

const PROJECT_ROOT = path.resolve(import.meta.dirname, '../..');
const MAILMAN_DIR = path.join(PROJECT_ROOT, 'mailman');
const STATE_DIR = path.join(MAILMAN_DIR, 'state');
const MAIN_CONTEXT_PATH = path.join(STATE_DIR, 'main-context.jsonl');

const mailmanEnv = readEnvFile(['ANTHROPIC_BASE_URL', 'MAILMAN_MODEL', 'MAILMAN_FORK_MODEL']);
const ANTHROPIC_BASE_URL = process.env.ANTHROPIC_BASE_URL || mailmanEnv.ANTHROPIC_BASE_URL;
const MAILMAN_MODEL = process.env.MAILMAN_MODEL || mailmanEnv.MAILMAN_MODEL || 'claude-haiku-4-5';
const MAILMAN_FORK_MODEL = process.env.MAILMAN_FORK_MODEL || mailmanEnv.MAILMAN_FORK_MODEL || MAILMAN_MODEL;

export interface EscalationPayload {
  finding: string;
  evidence: string[];
  subagent_reasoning: string;
  source: 'input_subagent' | 'digest_sweep';
}

export interface ForkResult {
  agree: boolean;
  summary: string;
  reasoning: string;
}

function getMainContext(): string {
  if (!fs.existsSync(MAIN_CONTEXT_PATH)) return '';
  return fs.readFileSync(MAIN_CONTEXT_PATH, 'utf-8').trim();
}

function appendToMainContext(summary: string): void {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  const entry = JSON.stringify({
    timestamp: new Date().toISOString(),
    type: 'agreed_escalation',
    summary,
  });
  fs.appendFileSync(MAIN_CONTEXT_PATH, entry + '\n');
}

export async function spawnFork(payload: EscalationPayload): Promise<ForkResult> {
  const kernelMd = fs.readFileSync(path.join(MAILMAN_DIR, 'persona', 'kernel.md'), 'utf-8');
  const forkPrompt = fs.readFileSync(path.join(MAILMAN_DIR, 'prompts', 'fork_eval.md'), 'utf-8');

  const mainContext = getMainContext();
  const contextSection = mainContext
    ? `\n\n---\n\nPrior agreed escalations (your accumulated context):\n${mainContext}`
    : '';

  const systemPrompt = `${kernelMd}\n\n---\n\n${forkPrompt}${contextSection}`;
  const userMessage = `Evaluate this escalation:\n\n${JSON.stringify(payload, null, 2)}`;

  log.info('Spawning fork evaluator', { source: payload.source, model: MAILMAN_FORK_MODEL });

  const raw = await spawnMailmanContainer({
    systemPrompt,
    userMessage,
    model: MAILMAN_FORK_MODEL,
    agentId: 'mailman-triage',
    containerLabel: 'fork',
    anthropicBaseUrl: ANTHROPIC_BASE_URL,
  });

  const result = parseJsonResult<ForkResult>(raw);

  if (typeof result.agree !== 'boolean') {
    throw new Error(`Invalid fork result: agree must be boolean, got ${typeof result.agree}`);
  }

  log.info('Fork result', { agree: result.agree, reasoning: result.reasoning });

  if (result.agree && result.summary) {
    appendToMainContext(result.summary);
    log.info('Agreed escalation appended to main context', { summary: result.summary });
  }

  return result;
}
