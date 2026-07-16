/**
 * Memory-briefing MCP tools: recall, remember.
 *
 * recall is fire-and-forget, same shape as create_agent: the container can't
 * reach the vault filesystem or the `claude` CLI's working directory, so it
 * can't run the `briefer` subagent itself. It writes an outbound system
 * action; the host-side handler (src/modules/memory-briefing) shells out to
 * `briefer` via src/memory-briefing/briefer.ts (which has MBIF_VAULT_PATH)
 * and delivers the result back as a normal inbound chat message, waking the
 * container.
 *
 * remember is different: it only needs to drop a file, not search or
 * synthesize anything, and the vault is mounted straight into the container
 * (see each group's container.json additionalMounts) at VAULT_INBOX_PATH.
 * So it writes directly, no host round-trip — the vault's own `sorter`
 * agent picks the note up on its next triage pass.
 */
import fs from 'fs';
import path from 'path';

import { writeMessageOut } from '../db/messages-out.js';
import { registerTools } from './server.js';
import type { McpToolDefinition } from './types.js';

function log(msg: string): void {
  console.error(`[mcp-tools] ${msg}`);
}

function generateId(): string {
  return `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function ok(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

function err(text: string) {
  return { content: [{ type: 'text' as const, text: `Error: ${text}` }], isError: true };
}

export const recall: McpToolDefinition = {
  tool: {
    name: 'recall',
    description: 'Search the vault for information on a particular topic - digests, transcripts, entities, and projects.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        topic: {
          type: 'string',
          description: 'What to search for — a topic, question, or the message you are about to respond to.',
        },
      },
      required: ['topic'],
    },
  },
  async handler(args) {
    const topic = args.topic as string;
    if (!topic) return err('topic is required');

    const requestId = generateId();
    writeMessageOut({
      id: requestId,
      kind: 'system',
      content: JSON.stringify({
        action: 'recall',
        requestId,
        topic,
      }),
    });

    log(`recall: ${requestId} → "${topic.slice(0, 80)}"`);
    return ok('Searching the vault. Results will arrive as a follow-up message.');
  },
};

// The vault mounts at /workspace/vault (see additionalMounts in the group's
// container.json) — not under /workspace/agent, which is the group folder
// mount. Point straight at the real mount; no need to go through the
// vault-inbox symlink some group folders also carry for convenience.
const VAULT_INBOX_PATH = process.env.VAULT_INBOX_PATH || '/workspace/vault/00-Inbox';
const IMPORTANCE_VALUES = ['low', 'medium', 'high'];
const CONFIDENCE_VALUES = ['low', 'medium', 'high'];

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')
    .slice(0, 60);
}

function yamlScalar(v: string): string {
  return /[:#]/.test(v) ? JSON.stringify(v) : v;
}

export const remember: McpToolDefinition = {
  tool: {
    name: 'remember',
    description:
      'Write a fact into the MBIF knowledge vault for durable, cross-session memory. Use when the user shares something worth recalling later — a preference, a decision, a date, a project fact.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        content: { type: 'string', description: 'The fact, in plain markdown. One fact per note, short.' },
        title: { type: 'string', description: 'Short title, used for the filename. Defaults to the first few words of content.' },
        importance: { type: 'string', enum: IMPORTANCE_VALUES, description: 'Default: medium.' },
        confidence: {
          type: 'string',
          enum: CONFIDENCE_VALUES,
          description: 'How sure you are this is accurate and not stale. Default: high.',
        },
        validFrom: { type: 'string', description: 'ISO date this became true. Default: today. Backdate if describing something already in effect.' },
        source: {
          type: 'string',
          description:
            'How you know this: "stated" (the user told you directly), "inferred" (you concluded it), "observed" (you saw it happen/in data), or any other free text. Default: stated.',
        },
        duration: {
          type: 'string',
          description:
            'How long this holds: "permanent", "temporary", "until superseded", or a bound like "2026-08" or "until the Q3 launch". Default: until superseded.',
        },
        tags: { type: 'array', items: { type: 'string' }, description: 'Optional freeform tags.' },
      },
      required: ['content'],
    },
  },
  async handler(args) {
    const content = args.content as string;
    if (!content) return err('content is required');
    if (!fs.existsSync(VAULT_INBOX_PATH)) return err('Vault inbox is not mounted for this agent group — remember is unavailable here.');

    const importance = (args.importance as string) || 'medium';
    if (!IMPORTANCE_VALUES.includes(importance)) return err(`importance must be one of: ${IMPORTANCE_VALUES.join(', ')}`);
    const confidence = (args.confidence as string) || 'high';
    if (!CONFIDENCE_VALUES.includes(confidence)) return err(`confidence must be one of: ${CONFIDENCE_VALUES.join(', ')}`);

    // Local date, not UTC -- a note remembered late in the evening (e.g.
    // 23:48 America/Chicago = 04:48 UTC the next day) must not be dated
    // tomorrow. Same bug class as memory-capture.ts's day-bucketing fix.
    const today = new Date().toLocaleDateString('en-CA', { timeZone: process.env.TZ || 'UTC' });
    const validFrom = (args.validFrom as string) || today;
    const source = (args.source as string) || 'stated';
    const duration = (args.duration as string) || 'until superseded';
    const tags = Array.isArray(args.tags) ? (args.tags as string[]) : [];
    const title = ((args.title as string) || content).slice(0, 60);
    const slug = slugify(title) || 'note';

    const frontmatter = [
      '---',
      'type: fact',
      'status: inbox',
      `date: ${today}`,
      'origin: Lumen',
      `importance: ${importance}`,
      `confidence: ${confidence}`,
      `valid-from: ${validFrom}`,
      `source: ${yamlScalar(source)}`,
      `duration: ${yamlScalar(duration)}`,
      `tags: [${tags.map(yamlScalar).join(', ')}]`,
      '---',
      '',
      content.trim(),
      '',
    ].join('\n');

    let filename = `${today} — remember — ${slug}.md`;
    let filePath = path.join(VAULT_INBOX_PATH, filename);
    let n = 2;
    while (fs.existsSync(filePath)) {
      filename = `${today} — remember — ${slug}-${n}.md`;
      filePath = path.join(VAULT_INBOX_PATH, filename);
      n++;
    }
    fs.writeFileSync(filePath, frontmatter);

    log(`remember: wrote ${filename}`);
    return ok(`Remembered. Filed to the vault inbox as "${filename}"; the sorter will pick it up on its next pass.`);
  },
};

registerTools([recall, remember]);
