/**
 * scripts/render-context.ts — render conversation context from a leaf message.
 *
 * Usage:
 *   pnpm exec tsx scripts/render-context.ts <message-path> [--budget 12000] [--renderer generic]
 *
 * Starts from a leaf message, reads its Thread-ID, finds all messages with
 * the same Thread-ID across inbox and outbox Maildirs, sorts by Date, and
 * renders a Markdown transcript.
 *
 * The --renderer flag selects the rendering strategy. Only "generic" ships
 * today; adaptor-specific renderers (email, discord, etc.) can be added
 * as separate modules that implement the Renderer interface.
 */
import fs from 'fs';
import path from 'path';

// ---------------------------------------------------------------------------
// Renderer interface — adaptors implement this to customize rendering
// ---------------------------------------------------------------------------

interface ParsedMessage {
  path: string;
  headers: Map<string, string[]>;
  body: string;
}

interface Renderer {
  render(messages: ParsedMessage[], budget: number): string;
}

// ---------------------------------------------------------------------------
// RFC822 parsing
// ---------------------------------------------------------------------------

function parseMessage(filePath: string): ParsedMessage | null {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf-8');
  } catch {
    return null;
  }

  const blankLine = raw.indexOf('\n\n');
  const headerBlock = blankLine >= 0 ? raw.slice(0, blankLine) : raw;
  const body = blankLine >= 0 ? raw.slice(blankLine + 2) : '';

  const headers = new Map<string, string[]>();
  for (const line of headerBlock.split('\n')) {
    const colonIdx = line.indexOf(':');
    if (colonIdx <= 0) continue;
    const key = line.slice(0, colonIdx).trim();
    const value = line.slice(colonIdx + 1).trim();
    const existing = headers.get(key);
    if (existing) {
      existing.push(value);
    } else {
      headers.set(key, [value]);
    }
  }

  return { path: filePath, headers, body: body.trimEnd() };
}

function getHeader(msg: ParsedMessage, key: string): string | undefined {
  return msg.headers.get(key)?.[0];
}

// ---------------------------------------------------------------------------
// Message discovery — find all messages matching a Thread-ID
// ---------------------------------------------------------------------------

function findMaildirFiles(dir: string): string[] {
  const results: string[] = [];

  function walkMaildir(d: string): void {
    for (const sub of ['new', 'cur']) {
      const subDir = path.join(d, sub);
      if (!fs.existsSync(subDir)) continue;
      for (const file of fs.readdirSync(subDir)) {
        if (file.startsWith('.')) continue;
        results.push(path.join(subDir, file));
      }
    }
  }

  function walk(d: string): void {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }

    const hasTmp = entries.some((e) => e.isDirectory() && e.name === 'tmp');
    const hasNewOrCur = entries.some((e) => e.isDirectory() && (e.name === 'new' || e.name === 'cur'));

    if (hasTmp && hasNewOrCur) {
      walkMaildir(d);
    }

    for (const e of entries) {
      if (e.isDirectory() && e.name !== 'tmp' && e.name !== 'new' && e.name !== 'cur') {
        walk(path.join(d, e.name));
      }
    }
  }

  walk(dir);
  return results;
}

function findByThreadId(mailRoot: string, threadId: string): ParsedMessage[] {
  const allFiles = findMaildirFiles(mailRoot);
  const matches: ParsedMessage[] = [];

  for (const filePath of allFiles) {
    const msg = parseMessage(filePath);
    if (!msg) continue;
    if (getHeader(msg, 'Thread-ID') === threadId) {
      matches.push(msg);
    }
  }

  matches.sort((a, b) => {
    const da = getHeader(a, 'Date') || '';
    const db = getHeader(b, 'Date') || '';
    return da.localeCompare(db);
  });

  return matches;
}

// ---------------------------------------------------------------------------
// Generic renderer
// ---------------------------------------------------------------------------

const genericRenderer: Renderer = {
  render(messages: ParsedMessage[], budget: number): string {
    const parts: string[] = [];
    let charCount = 0;

    if (messages.length === 0) {
      return '(no messages found for this thread)';
    }

    const threadId = getHeader(messages[0], 'Thread-ID') || 'unknown';
    const header = `# Thread: ${threadId}\n\n`;
    parts.push(header);
    charCount += header.length;

    for (const msg of messages) {
      const from = getHeader(msg, 'From') || 'unknown';
      const date = getHeader(msg, 'Date') || 'unknown';
      const messageId = getHeader(msg, 'Message-ID') || '';

      const entry =
        `---\n**${from}** — ${date}` +
        (messageId ? ` (${messageId})` : '') +
        `\n\n${msg.body}\n\n`;

      if (budget > 0 && charCount + entry.length > budget) {
        parts.push(`\n---\n*Context truncated at budget (${budget} chars). ${messages.length - parts.length + 1} earlier messages omitted.*\n`);
        break;
      }

      parts.push(entry);
      charCount += entry.length;
    }

    return parts.join('');
  },
};

// ---------------------------------------------------------------------------
// Renderer registry
// ---------------------------------------------------------------------------

const renderers: Record<string, Renderer> = {
  generic: genericRenderer,
};

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function main(): void {
  const args = process.argv.slice(2);
  const messagePath = args[0];

  if (!messagePath) {
    console.error('Usage: render-context <message-path> [--budget N] [--renderer name]');
    process.exit(1);
  }

  let budget = 0;
  let rendererName = 'generic';

  for (let i = 1; i < args.length; i++) {
    if (args[i] === '--budget' && i + 1 < args.length) budget = parseInt(args[++i], 10);
    else if (args[i] === '--renderer' && i + 1 < args.length) rendererName = args[++i];
  }

  const renderer = renderers[rendererName];
  if (!renderer) {
    console.error(`Unknown renderer: ${rendererName}. Available: ${Object.keys(renderers).join(', ')}`);
    process.exit(1);
  }

  const leaf = parseMessage(path.resolve(messagePath));
  if (!leaf) {
    console.error(`Cannot read message: ${messagePath}`);
    process.exit(1);
  }

  const threadId = getHeader(leaf, 'Thread-ID');
  if (!threadId) {
    console.error(`Message has no Thread-ID header: ${messagePath}`);
    process.exit(1);
  }

  // Walk up from the message to find the agent's mail root.
  // Expected structure: .../mail/{inbox,out}/.../{new,cur}/filename
  // The mail root is the directory containing inbox/ and out/.
  let mailRoot = path.dirname(path.resolve(messagePath));
  while (mailRoot !== '/' && path.basename(mailRoot) !== 'mail') {
    mailRoot = path.dirname(mailRoot);
  }

  if (path.basename(mailRoot) !== 'mail') {
    console.error(`Cannot determine mail root from path: ${messagePath}`);
    console.error('Expected message to be inside a .../mail/... directory tree');
    process.exit(1);
  }

  const messages = findByThreadId(mailRoot, threadId);
  const output = renderer.render(messages, budget);
  console.log(output);
}

main();
