/**
 * Memory-briefing MCP tool: recall.
 *
 * Fire-and-forget, same shape as create_agent: the container can't reach the
 * vault filesystem or the `claude` CLI's working directory, so it can't run
 * the `briefer` subagent itself. It writes an outbound system action; the
 * host-side handler (src/modules/memory-briefing) shells out to `briefer` via
 * src/memory-briefing/briefer.ts (which has MBIF_VAULT_PATH) and delivers the
 * result back as a normal inbound chat message, waking the container.
 */
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

registerTools([recall]);
