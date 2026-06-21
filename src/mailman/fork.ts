import fs from 'fs';
import path from 'path';

import { DATA_DIR, GROUPS_DIR } from '../config.js';
import { getAgentGroup } from '../db/agent-groups.js';
import { getContainerConfig } from '../db/container-configs.js';
import { findSessionByAgentGroup } from '../db/sessions.js';
import { readEnvFile } from '../env.js';
import { log } from '../log.js';
import { spawnMailmanContainer, parseJsonResult } from './spawn.js';

const PROJECT_ROOT = path.resolve(import.meta.dirname, '../..');
const MAILMAN_DIR = path.join(PROJECT_ROOT, 'mailman');
const STATE_DIR = path.join(MAILMAN_DIR, 'state');
const MAIN_CONTEXT_PATH = path.join(STATE_DIR, 'main-context.jsonl');

const env = readEnvFile(['ANTHROPIC_BASE_URL', 'MAILMAN_AGENT_GROUP_ID']);
const ANTHROPIC_BASE_URL = process.env.ANTHROPIC_BASE_URL || env.ANTHROPIC_BASE_URL;
const AGENT_GROUP_ID = process.env.MAILMAN_AGENT_GROUP_ID || env.MAILMAN_AGENT_GROUP_ID;

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

// ponytail: read the whole transcript, cap at 128KB. Prompt cache makes this cheap.
const MAX_TRANSCRIPT_BYTES = 128_000;

function findNewestTranscript(agentGroupId: string): string | null {
  const session = findSessionByAgentGroup(agentGroupId);
  if (!session) return null;

  const projectsDir = path.join(DATA_DIR, 'v2-sessions', agentGroupId, '.claude-shared', 'projects');

  if (!fs.existsSync(projectsDir)) return null;

  let newest: { path: string; mtime: number } | null = null;

  for (const dir of fs.readdirSync(projectsDir)) {
    const subdir = path.join(projectsDir, dir);
    if (!fs.statSync(subdir).isDirectory()) continue;

    for (const file of fs.readdirSync(subdir)) {
      if (!file.endsWith('.jsonl')) continue;
      const full = path.join(subdir, file);
      const stat = fs.statSync(full);
      if (!newest || stat.mtimeMs > newest.mtime) {
        newest = { path: full, mtime: stat.mtimeMs };
      }
    }
  }

  return newest?.path ?? null;
}

function getMainAgentContext(): { systemPrompt: string; model: string } | null {
  if (!AGENT_GROUP_ID) return null;

  const group = getAgentGroup(AGENT_GROUP_ID);
  if (!group) {
    log.warn('Fork: agent group not found', { agentGroupId: AGENT_GROUP_ID });
    return null;
  }

  // Read the agent's CLAUDE.md
  const claudeMdPath = path.join(GROUPS_DIR, group.folder, 'CLAUDE.md');
  let claudeMd = '';
  try {
    claudeMd = fs.readFileSync(claudeMdPath, 'utf-8');
  } catch {
    log.debug('Fork: no CLAUDE.md for agent group', { folder: group.folder });
  }

  // Read the most recent transcript — this IS the main agent's context
  let transcript = '';
  const transcriptPath = findNewestTranscript(AGENT_GROUP_ID);
  if (transcriptPath) {
    try {
      const raw = fs.readFileSync(transcriptPath, 'utf-8');
      // Extract user and assistant messages for context
      const lines = raw.split('\n').filter(Boolean);
      const messages: string[] = [];
      for (const line of lines) {
        try {
          const entry = JSON.parse(line);
          if (entry.type === 'user' && entry.message?.content) {
            const content =
              typeof entry.message.content === 'string' ? entry.message.content : JSON.stringify(entry.message.content);
            messages.push(`[user] ${content}`);
          } else if (entry.type === 'assistant' && entry.message?.content) {
            const text =
              typeof entry.message.content === 'string'
                ? entry.message.content
                : entry.message.content
                    .filter((b: { type: string }) => b.type === 'text')
                    .map((b: { text: string }) => b.text)
                    .join('\n');
            if (text) messages.push(`[assistant] ${text}`);
          }
        } catch {
          // skip malformed lines
        }
      }
      transcript = messages.join('\n\n');
      if (transcript.length > MAX_TRANSCRIPT_BYTES) {
        // Keep the tail — recent context matters more
        transcript = transcript.slice(-MAX_TRANSCRIPT_BYTES);
      }
    } catch (err) {
      log.debug('Fork: could not read transcript', { transcriptPath, err });
    }
  }

  const config = getContainerConfig(AGENT_GROUP_ID);
  const model = config?.model || 'claude-sonnet-4-5-20250514';

  const parts = [claudeMd];
  if (transcript) {
    parts.push('---\n\nRecent conversation context:\n' + transcript);
  }

  return { systemPrompt: parts.join('\n\n'), model };
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
  const agentContext = getMainAgentContext();

  const forkPrompt = fs.readFileSync(path.join(MAILMAN_DIR, 'prompts', 'fork_eval.md'), 'utf-8');

  let systemPrompt: string;
  let model: string;

  if (agentContext) {
    systemPrompt = agentContext.systemPrompt + '\n\n---\n\n' + forkPrompt;
    model = agentContext.model;
  } else {
    const kernelMd = fs.readFileSync(path.join(MAILMAN_DIR, 'persona', 'kernel.md'), 'utf-8');
    systemPrompt = kernelMd + '\n\n---\n\n' + forkPrompt;
    model = 'claude-haiku-4-5';
    log.warn('Fork: no main agent context available, using standalone kernel');
  }

  const userMessage = `Evaluate this escalation:\n\n${JSON.stringify(payload, null, 2)}`;

  log.info('Spawning fork evaluator', {
    source: payload.source,
    model,
    forkedFromAgent: !!agentContext,
  });

  const raw = await spawnMailmanContainer({
    systemPrompt,
    userMessage,
    model,
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
