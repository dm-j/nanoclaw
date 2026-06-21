import fs from 'fs';
import path from 'path';

import { readEnvFile } from '../env.js';
import { log } from '../log.js';
import { sanitizeEmail } from './sanitize.js';
import { spawnMailmanContainer, parseJsonResult } from './spawn.js';

const PROJECT_ROOT = path.resolve(import.meta.dirname, '../..');
const MAILMAN_DIR = path.join(PROJECT_ROOT, 'mailman');

const mailmanEnv = readEnvFile(['ANTHROPIC_BASE_URL', 'MAILMAN_MODEL']);
const ANTHROPIC_BASE_URL = process.env.ANTHROPIC_BASE_URL || mailmanEnv.ANTHROPIC_BASE_URL;
const MAILMAN_MODEL = process.env.MAILMAN_MODEL || mailmanEnv.MAILMAN_MODEL || 'claude-haiku-4-5';

export interface TriageResult {
  action: 'notify_user' | 'defer';
  summary: string;
  reasoning: string;
  sender: string;
  subject: string;
}

function extractSource(rawEmail: string): string | null {
  const match = rawEmail.match(/^X-Mailman-Source:\s*(.+)$/m);
  return match ? match[1].trim() : null;
}

function loadOptionalFile(filePath: string): string {
  if (!fs.existsSync(filePath)) return '';
  return '\n\n---\n\n' + fs.readFileSync(filePath, 'utf-8');
}

export async function spawnSubagent(rawEmail: string): Promise<TriageResult> {
  const kernelMd = fs.readFileSync(path.join(MAILMAN_DIR, 'persona', 'kernel.md'), 'utf-8');
  const triagePrompt = fs.readFileSync(path.join(MAILMAN_DIR, 'prompts', 'email_triage.md'), 'utf-8');

  const source = extractSource(rawEmail);
  const intents = loadOptionalFile(path.join(MAILMAN_DIR, 'persona', 'intents.md'));
  const feedPrompt = source ? loadOptionalFile(path.join(MAILMAN_DIR, 'feeds', source, 'prompt.md')) : '';

  const systemPrompt = `${kernelMd}${intents}\n\n---\n\n${triagePrompt}${feedPrompt}`;
  const sanitized = sanitizeEmail(rawEmail);

  const subjectMatch = rawEmail.match(/^Subject:\s*(.+)$/m);
  const fromMatch = rawEmail.match(/^From:\s*(.+)$/m);
  log.info('Spawning triage subagent', {
    sender: fromMatch?.[1]?.trim(),
    subject: subjectMatch?.[1]?.trim(),
    source: source ?? 'unknown',
  });

  const raw = await spawnMailmanContainer({
    systemPrompt,
    userMessage: `Triage this email:\n\n${sanitized}`,
    model: MAILMAN_MODEL,
    agentId: 'mailman-triage',
    containerLabel: 'triage',
    anthropicBaseUrl: ANTHROPIC_BASE_URL,
  });

  const result = parseJsonResult<TriageResult>(raw);

  if (!result.action || !['notify_user', 'defer'].includes(result.action)) {
    throw new Error(`Invalid triage action: ${result.action}`);
  }

  log.info('Triage result', { action: result.action, summary: result.summary, source });
  return result;
}
