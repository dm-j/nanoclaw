/**
 * scripts/fake-egress.ts — watch an agent's outbox Maildirs and log messages.
 *
 * Usage:
 *   pnpm exec tsx scripts/fake-egress.ts <agent-folder>
 *   pnpm exec tsx scripts/fake-egress.ts <agent-folder> --maildir mail/out/fake/direct/test
 *
 * Watches for new files in the outbox Maildir's new/ directory. When a message
 * arrives, prints it to stdout and moves it to cur/ with the S (seen) and
 * P (passed/delivered) flags.
 *
 * Without --maildir, watches all Maildirs under mail/out/ recursively.
 */
import fs from 'fs';
import path from 'path';

const GROUPS_DIR = path.resolve(process.cwd(), 'groups');

function findOutboxNewDirs(baseDir: string): string[] {
  const results: string[] = [];

  function walk(dir: string): void {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const full = path.join(dir, e.name);
      if (e.name === 'new' && fs.existsSync(path.join(dir, 'tmp'))) {
        results.push(full);
      } else {
        walk(full);
      }
    }
  }

  walk(baseDir);
  return results;
}

function processMessage(filePath: string): void {
  const content = fs.readFileSync(filePath, 'utf-8');
  const filename = path.basename(filePath);
  const curDir = path.join(path.dirname(filePath), '..', 'cur');

  console.log('─'.repeat(60));
  console.log(`Delivered: ${filePath}`);
  console.log('─'.repeat(60));
  console.log(content);
  console.log('─'.repeat(60));

  // Move to cur/ with Seen + Passed flags.
  const curPath = path.join(curDir, `${filename}:2,SP`);
  fs.renameSync(filePath, curPath);
  console.log(`Moved to: ${curPath}`);
  console.log('');
}

function drainExisting(newDir: string): void {
  const files = fs.readdirSync(newDir).filter((f) => !f.startsWith('.'));
  for (const f of files) {
    processMessage(path.join(newDir, f));
  }
}

function main(): void {
  const args = process.argv.slice(2);
  const folder = args[0];

  if (!folder) {
    console.error('Usage: fake-egress <agent-folder> [--maildir path]');
    process.exit(1);
  }

  const groupDir = path.join(GROUPS_DIR, folder);
  if (!fs.existsSync(groupDir)) {
    console.error(`Agent folder not found: ${groupDir}`);
    process.exit(1);
  }

  let watchDirs: string[];

  const maildirIdx = args.indexOf('--maildir');
  if (maildirIdx >= 0 && maildirIdx + 1 < args.length) {
    const specific = path.join(groupDir, args[maildirIdx + 1], 'new');
    if (!fs.existsSync(specific)) {
      console.error(`Maildir not found: ${specific}`);
      process.exit(1);
    }
    watchDirs = [specific];
  } else {
    const outDir = path.join(groupDir, 'mail', 'out');
    if (!fs.existsSync(outDir)) {
      console.error(`No outbox directory: ${outDir}`);
      process.exit(1);
    }
    watchDirs = findOutboxNewDirs(outDir);
  }

  if (watchDirs.length === 0) {
    console.error('No outbox Maildirs found.');
    process.exit(1);
  }

  console.log(`Watching ${watchDirs.length} outbox Maildir(s):`);
  for (const d of watchDirs) {
    console.log(`  ${d}`);
  }
  console.log('');

  // Drain any existing messages.
  for (const d of watchDirs) {
    drainExisting(d);
  }

  // Watch for new messages.
  for (const dir of watchDirs) {
    fs.watch(dir, (event, filename) => {
      if (event !== 'rename' || !filename || filename.startsWith('.')) return;
      const filePath = path.join(dir, filename);
      if (!fs.existsSync(filePath)) return;
      processMessage(filePath);
    });
  }

  console.log('Waiting for outbound messages... (Ctrl+C to stop)');
}

main();
