/**
 * Obsidian MCP tools: load_obsidian_wikilink.
 *
 * Loads a note's content into the agent's own context (not: opens the note
 * on the user's screen — that was the old behavior of this tool, replaced
 * because the agent, not the human at the keyboard, is the one who needs
 * the content). Goes through the host-shim relay (docs/host-shims.md):
 * write a `host_shim_exec` system message, poll inbound.db for the matching
 * `host_shim_response`, same round trip `host-shim` (the CLI binary) does —
 * reimplemented here as a typed MCP tool instead of requiring the agent to
 * shell out via Bash. Real Obsidian CLI (relayed via `obsidian-host`) does
 * the actual file resolution (path=/file=), so this stays correct for
 * however the vault's real fuzzy-match behaves — heading-section slicing is
 * the only vault-content parsing that happens here.
 *
 * `obsidian-host` (host-shims/obsidian-host) hardcodes the vault, so the
 * agent can never target a different one through this path.
 */
import { openInboundDb } from '../db/connection.js';
import { markCompleted } from '../db/messages-in.js';
import { writeMessageOut } from '../db/messages-out.js';
import { registerTools } from './server.js';
import type { McpToolDefinition } from './types.js';
import { withUsageLog } from './usage-log.js';

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

interface ParsedWikilink {
  target: string;
  heading?: string;
}

/**
 * Tolerates every wikilink shape the vault actually uses, so this is hard
 * to get wrong:
 *   [[Note]]  [[folder/Note]]  [[Note|Alias]]  [[Note#Heading]]
 *   [[Note#Heading|Alias]]  [[Note.md]]  Note  folder/Note#Heading
 *   [Alias](Note)  [Alias](folder/Note.md#Heading)   (parentheses form)
 */
function parseWikilink(raw: string): ParsedWikilink {
  let target = raw.trim();

  const mdLink = target.match(/^\[([^\]]*)\]\(([^)]+)\)$/);
  if (mdLink) {
    target = decodeURIComponent(mdLink[2]).trim();
  } else if (target.startsWith('[[') && target.endsWith(']]')) {
    target = target.slice(2, -2);
  }

  const pipeIdx = target.indexOf('|');
  if (pipeIdx !== -1) target = target.slice(0, pipeIdx);
  target = target.trim();

  let heading: string | undefined;
  const hashIdx = target.indexOf('#');
  if (hashIdx !== -1) {
    heading = target.slice(hashIdx + 1).trim() || undefined;
    target = target.slice(0, hashIdx).trim();
  }

  if (target.toLowerCase().endsWith('.md')) target = target.slice(0, -3);

  return { target, heading };
}

/**
 * Slices `content` down to the section starting at a heading matching
 * `heading` (case-insensitive, `#` markers ignored), through the line
 * before the next heading of equal or greater rank (same or fewer `#`s —
 * i.e. a heading that outranks or ties the section heading closes it).
 * Returns null if no heading in the note matches.
 */
function extractHeadingSection(content: string, heading: string): string | null {
  const lines = content.split('\n');
  const wanted = heading.trim().toLowerCase();
  let startIdx = -1;
  let level = 0;

  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(#{1,6})\s+(.*)$/);
    if (m && m[2].trim().toLowerCase() === wanted) {
      startIdx = i;
      level = m[1].length;
      break;
    }
  }
  if (startIdx === -1) return null;

  let endIdx = lines.length;
  for (let i = startIdx + 1; i < lines.length; i++) {
    const m = lines[i].match(/^(#{1,6})\s+/);
    if (m && m[1].length <= level) {
      endIdx = i;
      break;
    }
  }
  return lines.slice(startIdx, endIdx).join('\n').trim();
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

/**
 * Fire-and-forget: a successful load is treated as Lumen endorsing that note
 * (see src/modules/synthetic-context/wikilink-endorsements.ts, host-side).
 * Never blocks or fails the tool response — this is ranking bookkeeping, not
 * part of what the agent asked for.
 */
function endorseWikilink(target: string): void {
  writeMessageOut({
    id: generateId(),
    kind: 'system',
    content: JSON.stringify({ action: 'wikilink_endorse', target: target.toLowerCase() }),
  });
}

export const loadObsidianWikilink: McpToolDefinition = {
  tool: {
    name: 'load_obsidian_wikilink',
    description:
      "Load a note's content from the vault, for you to read (not the user's screen — use this " +
      'whenever a wikilink needs following, not `recall` for that specific note). Tolerates ' +
      '`[[Note]]`, `[[folder/Note]]`, `[[Note|Alias]]`, `[[Note#Heading]]`, `[[Note#Heading|Alias]]`, ' +
      'a bare title/path with or without `.md`, and Markdown-style `[Alias](Note)` links. If the ' +
      'link targets a heading, returns just that section (down through the line before the next ' +
      'heading of equal or greater rank), not the whole note.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        wikilink: {
          type: 'string',
          description:
            'The wikilink or note title/path to load, e.g. "[[Project Plan#Status]]", "05-Entities/Roy", or "[Roy](05-Entities/Roy)".',
        },
      },
      required: ['wikilink'],
    },
  },
  async handler(args) {
    const raw = args.wikilink as string;
    if (!raw) return err('wikilink is required');

    const { target, heading } = parseWikilink(raw);
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
      content: JSON.stringify({ action: 'host_shim_exec', requestId, name: 'obsidian', args: ['read', arg] }),
    });

    log(`load_obsidian_wikilink: ${requestId} → read ${arg}${heading ? ` #${heading}` : ''}`);

    const resp = await pollHostShimResponse(requestId, HOST_SHIM_TIMEOUT_MS);
    if (!resp) return err(`Timed out after ${HOST_SHIM_TIMEOUT_MS / 1000}s waiting for the host to load the note`);
    if (!resp.ok) return err(resp.refusalReason ?? 'Host refused the request');
    if (resp.exitCode !== 0) return err(resp.stderr || `obsidian CLI exited ${resp.exitCode}`);

    const content = resp.stdout;
    if (!heading) {
      endorseWikilink(target);
      return ok(content);
    }

    const section = extractHeadingSection(content, heading);
    if (section === null) return err(`No heading "${heading}" found in "${target}".`);
    endorseWikilink(target);
    return ok(section);
  },
};

registerTools([loadObsidianWikilink].map(withUsageLog));
