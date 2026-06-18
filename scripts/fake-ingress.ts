/**
 * scripts/fake-ingress.ts — drop a test message into an agent's inbox Maildir.
 *
 * Usage:
 *   pnpm exec tsx scripts/fake-ingress.ts <agent-folder> "message text"
 *   pnpm exec tsx scripts/fake-ingress.ts <agent-folder> "message text" --from user@test --thread test:thread:1
 *
 * Writes a complete RFC822 message to groups/<folder>/mail/inbox/new/ with
 * sensible defaults. The response Maildir defaults to mail/out/fake/direct/test
 * (created automatically if missing).
 */
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

const GROUPS_DIR = path.resolve(process.cwd(), 'groups');

function maildirFilename(): string {
  const now = Date.now();
  const sec = Math.floor(now / 1000);
  const usec = (now % 1000) * 1000;
  return `${sec}.M${usec}P${process.pid}.${os.hostname()}`;
}

function ensureMaildir(dir: string): void {
  for (const sub of ['tmp', 'new', 'cur']) {
    fs.mkdirSync(path.join(dir, sub), { recursive: true });
  }
}

function main(): void {
  const args = process.argv.slice(2);
  const folder = args[0];
  const body = args[1];

  if (!folder || !body) {
    console.error('Usage: fake-ingress <agent-folder> "message text" [--from addr] [--thread id]');
    process.exit(1);
  }

  let from = 'tester@fake.local';
  let threadId = 'fake:test:default';
  let responseMaildir = 'mail/out/fake/direct/test';

  for (let i = 2; i < args.length; i++) {
    if (args[i] === '--from' && i + 1 < args.length) from = args[++i];
    else if (args[i] === '--thread' && i + 1 < args.length) threadId = args[++i];
    else if (args[i] === '--response-maildir' && i + 1 < args.length) responseMaildir = args[++i];
  }

  const groupDir = path.join(GROUPS_DIR, folder);
  if (!fs.existsSync(groupDir)) {
    console.error(`Agent folder not found: ${groupDir}`);
    process.exit(1);
  }

  const inboxDir = path.join(groupDir, 'mail', 'inbox');
  ensureMaildir(inboxDir);

  // Ensure the response outbox exists so the agent has somewhere to write.
  const outboxDir = path.join(groupDir, responseMaildir);
  ensureMaildir(outboxDir);

  const messageId = `<fake:${crypto.randomUUID()}>`;
  const date = new Date().toISOString();

  const message = [
    `From: ${from}`,
    `To: ${folder}@agents.local`,
    `Date: ${date}`,
    `Message-ID: ${messageId}`,
    `Thread-ID: ${threadId}`,
    `Response-Expected: true`,
    `Response-Maildir: ${responseMaildir}`,
    `Provider: fake`,
    `Content-Type: text/plain; charset=utf-8`,
    '',
    body,
    '',
  ].join('\n');

  const filename = maildirFilename();
  const tmpPath = path.join(inboxDir, 'tmp', filename);
  const newPath = path.join(inboxDir, 'new', filename);

  fs.writeFileSync(tmpPath, message);
  fs.renameSync(tmpPath, newPath);

  console.log(`Message written: ${newPath}`);
  console.log(`Message-ID: ${messageId}`);
  console.log(`Thread-ID: ${threadId}`);
  console.log(`Response-Maildir: ${responseMaildir}`);
}

main();
