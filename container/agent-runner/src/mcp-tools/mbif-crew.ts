/**
 * MBIF-crew MCP tool: prompt_mbif_crew.
 *
 * Hands a freeform instruction to the vault's own Claude Code ("Sort the
 * inbox", "defragment my vault"). Fire-and-forget: writes an outbound
 * `mbif_crew_prompt` system action and returns immediately — this does NOT
 * wait for admin approval or for the instruction to finish running (it can
 * take minutes). The host cards the admin with an approve/deny prompt; on
 * approve it runs `claude -p` in the vault (git-checkpointed before and
 * after) and notifies you with the result. On deny, you are never told —
 * nothing happens, silently.
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

export const promptMbifCrew: McpToolDefinition = {
  tool: {
    name: 'prompt_mbif_crew',
    description:
      'Send a freeform instruction to the MBIF crew (Claude Code running directly in the vault), e.g. ' +
      '"Sort the inbox" or "defragment my vault". Requires admin approval — you will NOT get a response ' +
      "here; this just submits the request. If approved, you'll be notified with the result once it " +
      'finishes (can take minutes).',
    inputSchema: {
      type: 'object' as const,
      properties: {
        instruction: { type: 'string', description: 'The freeform instruction for the MBIF crew to act on.' },
      },
      required: ['instruction'],
    },
  },
  async handler(args) {
    const instruction = (args.instruction as string || '').trim();
    if (!instruction) return err('instruction is required');

    const requestId = generateId();
    writeMessageOut({
      id: requestId,
      kind: 'system',
      content: JSON.stringify({ action: 'mbif_crew_prompt', instruction }),
    });

    log(`prompt_mbif_crew: ${requestId} → ${instruction.slice(0, 80)}`);
    return ok('MBIF crew instruction submitted for admin approval. Not awaiting a response — you will hear back once it completes.');
  },
};

registerTools([promptMbifCrew]);
