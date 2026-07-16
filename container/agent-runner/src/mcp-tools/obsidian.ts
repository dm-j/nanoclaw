/**
 * Obsidian MCP tools: open_obsidian_wikilink.
 *
 * The container has no GUI and no host shell access — opening a note in the
 * real Obsidian app can only happen on the host. This goes through the
 * host-shim relay (docs/host-shims.md): write a `host_shim_exec` system
 * message, poll inbound.db for the matching `host_shim_response`, same
 * round trip `host-shim` (the CLI binary) does — reimplemented here as a
 * typed MCP tool instead of requiring the agent to shell out via Bash.
 *
 * `obsidian-host` (host-shims/obsidian-host) hardcodes the vault, so the
 * agent can never target a different one through this path.
 */
import { openInboundDb } from '../db/connection.js';
import { markCompleted } from '../db/messages-in.js';
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface HostShimResponse {
  requestId: string;
  ok: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
  refusalReason?: string;
}

/**
 * Strip wikilink brackets and any `|display text` alias, leaving the raw
 * target. Accepts `[[Note]]`, `[[folder/Note]]`, `[[Note|Alias]]`, or a
 * bare title/path (no brackets required).
 */
function parseWikilinkTarget(raw: string): string {
  let target = raw.trim();
  if (target.startsWith('[[') && target.endsWith(']]')) {
    target = target.slice(2, -2);
  }
  const pipeIdx = target.indexOf('|');
  if (pipeIdx !== -1) target = target.slice(0, pipeIdx);
  return target.trim();
}

function pollHostShimResponse(requestId: string, timeoutMs: number): Promise<HostShimResponse | null> {
  const deadline = Date.now() + timeoutMs;

  return (async () => {
    while (Date.now() < deadline) {
      const db = openInboundDb();
      let row: { id: string; content: string } | undefined;
      try {
        row = db
          .prepare("SELECT id, content FROM messages_in WHERE status = 'pending' AND content LIKE ?")
          .get(`%"requestId":"${requestId}"%`) as { id: string; content: string } | undefined;
      } finally {
        db.close();
      }

      if (row) {
        markCompleted([row.id]);
        const parsed = JSON.parse(row.content);
        return parsed.response as HostShimResponse;
      }

      await sleep(500);
    }
    return null;
  })();
}

const HOST_SHIM_TIMEOUT_MS = 30_000;

export const openObsidianWikilink: McpToolDefinition = {
  tool: {
    name: 'open_obsidian_wikilink',
    description:
      "Open a note in the user's real Obsidian app on the host (brings the note up on screen there — this does not return the note's content, use `recall` for that). " +
      'Accepts a wikilink (`[[Note Title]]`, `[[folder/Note Title]]`, `[[Note Title|Alias]]`) or a bare title/path.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        wikilink: {
          type: 'string',
          description: 'The wikilink or note title/path to open, e.g. "[[Project Plan]]" or "05-Entities/Roy".',
        },
      },
      required: ['wikilink'],
    },
  },
  async handler(args) {
    const raw = args.wikilink as string;
    if (!raw) return err('wikilink is required');

    const target = parseWikilinkTarget(raw);
    if (!target) return err('wikilink resolved to an empty target');

    // "file=" fuzzy-matches by basename (same resolution wikilinks use in
    // Obsidian itself); "path=" requires an exact vault-relative path. A
    // target containing "/" reads as a folder-qualified path, so prefer the
    // exact match there — otherwise fuzzy name resolution is more forgiving.
    const arg = target.includes('/') ? `path=${target}` : `file=${target}`;

    const requestId = generateId();
    writeMessageOut({
      id: requestId,
      kind: 'system',
      content: JSON.stringify({ action: 'host_shim_exec', requestId, name: 'obsidian', args: ['open', arg] }),
    });

    log(`open_obsidian_wikilink: ${requestId} → open ${arg}`);

    const resp = await pollHostShimResponse(requestId, HOST_SHIM_TIMEOUT_MS);
    if (!resp) return err(`Timed out after ${HOST_SHIM_TIMEOUT_MS / 1000}s waiting for the host to open the note`);
    if (!resp.ok) return err(resp.refusalReason ?? 'Host refused the request');
    if (resp.exitCode !== 0) return err(resp.stderr || `obsidian CLI exited ${resp.exitCode}`);

    log(`open_obsidian_wikilink: opened ${target}`);
    return ok(`Opened "${target}" in Obsidian.`);
  },
};

registerTools([openObsidianWikilink]);
