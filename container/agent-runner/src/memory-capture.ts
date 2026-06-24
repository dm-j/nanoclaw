import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

const MEMORY_DIR = '/workspace/agent/.memsearch/memory';
const MILVUS_URI = '/workspace/agent/.memsearch/milvus.db';

interface TranscriptEntry {
  type?: string;
  uuid?: string;
  isMeta?: boolean;
  timestamp?: string;
  message?: {
    role?: string;
    content?: string | Array<{ type: string; text?: string }>;
  };
}


function stripXmlWrapper(text: string): string {
  // Strip <context timezone="..." /> and extract inner text from <message>... contents
  return text
    .replace(/<context\s+timezone="[^"]*"\s*\/?>\s*/gi, '')
    .replace(/<message\b[^>]*>[\s\S]*?<\/message>/gi, (m) => {
      const inner = m.replace(/<message\b[^>]*>\s*/, '').replace(/\s*<\/message>\s*$/, '');
      return inner;
    })
    .trim();
}

function extractText(content: unknown): string {
  let raw = '';
  if (typeof content === 'string') {
    raw = content;
  } else if (Array.isArray(content)) {
    raw = content
      .filter((c) => c.type === 'text' && typeof c.text === 'string')
      .map((c) => c.text)
      .join('\n');
  }
  return stripXmlWrapper(raw);
}

function extractToolText(entry: TranscriptEntry): string | null {
  if (entry.type !== 'assistant') return null;
  const content = entry.message?.content;
  if (!Array.isArray(content)) return null;

  const parts: string[] = [];
  for (const block of content) {
    if (block.type === 'tool_use') {
      const name = block.name as string | undefined;
      const input = (block.input ?? {}) as Record<string, unknown>;

      if (name?.includes('send_message') && typeof input.text === 'string') {
        parts.push(input.text);
      } else if (name?.includes('send_file')) {
        const filePath = typeof input.filePath === 'string' ? input.filePath : undefined;
        const fileName = typeof input.fileName === 'string' ? input.fileName : filePath ? path.basename(filePath) : 'file';
        parts.push(`(sent file: ${fileName})`);
      }
    }
  }

  return parts.length > 0 ? parts.join('\n') : null;
}

function parseTranscriptForMemory(content: string): { user: string; assistant: string; sessionId?: string } | null {
  const lines = content.split('\n').filter((l) => l.trim());
  const entries: TranscriptEntry[] = [];
  for (const line of lines) {
    try {
      entries.push(JSON.parse(line));
    } catch {
      // skip unparseable
    }
  }

  const sessionId = entries.find((e) => e.sessionId)?.sessionId;

  // Find last real user message (not meta, not tool_result)
  let startIdx = -1;
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (e.type === 'user' && !e.isMeta) {
      const text = extractText(e.message?.content);
      if (text.trim()) {
        startIdx = i;
        break;
      }
    }
  }
  if (startIdx < 0) return null;

  const user = extractText(entries[startIdx].message?.content).trim();
  const assistantParts: string[] = [];

  for (let i = startIdx + 1; i < entries.length; i++) {
    const e = entries[i];
    if (e.type === 'assistant') {
      const toolText = extractToolText(e);
      if (toolText) {
        assistantParts.push(toolText);
        continue;
      }
      const text = extractText(e.message?.content).trim();
      if (text && text !== 'No response requested.') {
        assistantParts.push(text);
      }
    }
  }

  if (assistantParts.length === 0) return null;

  return { user, assistant: assistantParts.join('\n\n'), sessionId };
}

function findTranscriptPath(sessionId: string): string | null {
  const base = process.env.CLAUDE_CONFIG_DIR || path.join(process.env.HOME || '/home/node', '.claude');
  const projects = path.join(base, 'projects');
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

/**
 * Capture the last exchange from the Claude transcript into the agent's
 * memsearch memory directory, then spawn an async re-index.
 *
 * Best-effort: logs failures, never throws.
 */
export function captureMemoryTurn(sessionId: string | undefined, assistantName = 'Assistant'): void {
  if (!sessionId) return;

  const transcriptPath = findTranscriptPath(sessionId);
  if (!transcriptPath) return;

  let content: string;
  try {
    content = fs.readFileSync(transcriptPath, 'utf-8');
  } catch (err) {
    log(`captureMemory: failed to read transcript: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }

  const turn = parseTranscriptForMemory(content);
  if (!turn) return;

  const date = new Date().toISOString().split('T')[0];
  const time = new Date().toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: process.env.TZ || 'UTC',
  });

  try {
    fs.mkdirSync(MEMORY_DIR, { recursive: true });
    const file = path.join(MEMORY_DIR, `${date}.md`);
    const entry = `## Session ${time}\n**User**: ${turn.user}\n**${assistantName}**: ${turn.assistant.replace(/\n/g, '\n  ')}\n\n`;
    fs.appendFileSync(file, entry);
    log(`captureMemory: wrote ${file}`);
  } catch (err) {
    log(`captureMemory: failed to write memory: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }

  // Re-index in the background. Use --force because we just appended new content.
  // Failures are logged but don't block the turn.
  try {
    const proc = spawn('memsearch', ['index', MEMORY_DIR, '--milvus-uri', MILVUS_URI, '--force'], {
      stdio: 'ignore',
      detached: true,
    });
    proc.on('error', (err) => log(`captureMemory: index spawn error: ${err.message}`));
    proc.unref();
  } catch (err) {
    log(`captureMemory: failed to spawn index: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function log(msg: string): void {
  console.error(`[memory-capture] ${msg}`);
}
