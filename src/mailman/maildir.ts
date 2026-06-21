import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

const PROJECT_ROOT = path.resolve(import.meta.dirname, '../..');
const INBOX_TMP = path.join(PROJECT_ROOT, 'mailman/inbox/tmp');
const INBOX_NEW = path.join(PROJECT_ROOT, 'mailman/inbox/new');

function maildirFilename(): string {
  const ts = Math.floor(Date.now() / 1000);
  const usec = (Date.now() % 1000) * 1000;
  const pid = process.pid;
  const host = os.hostname();
  const uniq = crypto.randomBytes(4).toString('hex');
  return `${ts}.M${usec}P${pid}Q${uniq}.${host}`;
}

export function writeToMaildir(content: string, headers: Record<string, string>): string {
  fs.mkdirSync(INBOX_TMP, { recursive: true });
  fs.mkdirSync(INBOX_NEW, { recursive: true });

  const headerLines = Object.entries(headers)
    .map(([k, v]) => `${k}: ${v}`)
    .join('\n');

  const message = headerLines + '\n' + content;

  const filename = maildirFilename();
  const tmpPath = path.join(INBOX_TMP, filename);
  const newPath = path.join(INBOX_NEW, filename);

  fs.writeFileSync(tmpPath, message);
  fs.renameSync(tmpPath, newPath);

  return filename;
}
