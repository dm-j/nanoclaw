/**
 * scripts/mail-write.ts — write an RFC822 message into a Maildir atomically.
 *
 * Usage:
 *   pnpm exec tsx scripts/mail-write.ts <maildir> [--header Key: Value]... [--body "text"]
 *   pnpm exec tsx scripts/mail-write.ts <maildir> --stdin
 *
 * Examples:
 *   # Minimal test message
 *   pnpm exec tsx scripts/mail-write.ts groups/lumen/mail/inbox \
 *     --header "From: dmj@direct.telegram" \
 *     --header "To: lumen@agents.local" \
 *     --header "Thread-ID: telegram:direct:dmj" \
 *     --header "Response-Expected: true" \
 *     --header "Response-Maildir: mail/out/telegram/direct/dmj" \
 *     --header "Provider: telegram" \
 *     --header "Content-Type: text/plain; charset=utf-8" \
 *     --body "Hello from the boop tool"
 *
 *   # Pipe a complete RFC822 message from stdin
 *   cat message.eml | pnpm exec tsx scripts/mail-write.ts groups/lumen/mail/inbox --stdin
 *
 * Writes to tmp/ first, then atomically renames into new/.
 * Auto-generates Message-ID and Date headers if not provided.
 * Uses standard Maildir filename: <timestamp>.M<usec>P<pid>.<hostname>
 */
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

function maildirFilename(): string {
  const now = Date.now();
  const sec = Math.floor(now / 1000);
  const usec = (now % 1000) * 1000;
  return `${sec}.M${usec}P${process.pid}.${os.hostname()}`;
}

function parseArgs(args: string[]): { maildir: string; headers: string[]; body: string; stdin: boolean } {
  const maildir = args[0];
  if (!maildir) {
    console.error('Usage: mail-write <maildir> [--header "Key: Value"]... [--body "text"] | --stdin');
    process.exit(1);
  }

  const headers: string[] = [];
  let body = '';
  let stdin = false;

  for (let i = 1; i < args.length; i++) {
    if (args[i] === '--header' && i + 1 < args.length) {
      headers.push(args[++i]);
    } else if (args[i] === '--body' && i + 1 < args.length) {
      body = args[++i];
    } else if (args[i] === '--stdin') {
      stdin = true;
    }
  }

  return { maildir, headers, body, stdin };
}

function buildMessage(headers: string[], body: string): string {
  const headerMap = new Map<string, string>();
  for (const h of headers) {
    const colonIdx = h.indexOf(':');
    if (colonIdx > 0) {
      headerMap.set(h.substring(0, colonIdx).trim().toLowerCase(), h);
    }
  }

  const allHeaders = [...headers];

  if (!headerMap.has('message-id')) {
    allHeaders.push(`Message-ID: <${crypto.randomUUID()}>`);
  }
  if (!headerMap.has('date')) {
    allHeaders.push(`Date: ${new Date().toISOString()}`);
  }
  if (!headerMap.has('content-type')) {
    allHeaders.push('Content-Type: text/plain; charset=utf-8');
  }

  return allHeaders.join('\n') + '\n\n' + body + '\n';
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf-8');
}

async function main(): Promise<void> {
  const { maildir, headers, body, stdin } = parseArgs(process.argv.slice(2));

  const maildirPath = path.resolve(maildir);
  const tmpDir = path.join(maildirPath, 'tmp');
  const newDir = path.join(maildirPath, 'new');

  if (!fs.existsSync(tmpDir) || !fs.existsSync(newDir)) {
    console.error(`Not a Maildir: ${maildirPath} (missing tmp/ or new/)`);
    process.exit(1);
  }

  let content: string;
  if (stdin) {
    content = await readStdin();
  } else {
    if (headers.length === 0) {
      console.error('No headers provided. Use --header "Key: Value" or --stdin.');
      process.exit(1);
    }
    content = buildMessage(headers, body);
  }

  const filename = maildirFilename();
  const tmpPath = path.join(tmpDir, filename);
  const newPath = path.join(newDir, filename);

  fs.writeFileSync(tmpPath, content);
  fs.renameSync(tmpPath, newPath);

  console.log(newPath);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
