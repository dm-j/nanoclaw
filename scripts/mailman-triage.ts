#!/usr/bin/env tsx
/**
 * CLI entry point for manual Mailman triage testing.
 *
 * Usage:
 *   pnpm exec tsx scripts/mailman-triage.ts mailman/test-emails/shipping-delay.eml
 *   echo '{"from":"x@y.com","subject":"hi","body":"..."}' | pnpm exec tsx scripts/mailman-triage.ts
 */
import fs from 'fs';

import { spawnSubagent, type TriageInput } from '../src/mailman/subagent.js';

async function main(): Promise<void> {
  let raw: string;

  const filePath = process.argv[2];
  if (filePath) {
    if (!fs.existsSync(filePath)) {
      console.error(`File not found: ${filePath}`);
      process.exit(1);
    }
    raw = fs.readFileSync(filePath, 'utf-8');
  } else {
    // Read from stdin
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) {
      chunks.push(chunk);
    }
    raw = Buffer.concat(chunks).toString();
  }

  let input: TriageInput;
  try {
    input = JSON.parse(raw);
  } catch {
    console.error('Invalid JSON input. Expected: {"from":"...","subject":"...","body":"..."}');
    process.exit(1);
  }

  if (!input.from || !input.subject || !input.body) {
    console.error('Missing required fields: from, subject, body');
    process.exit(1);
  }

  console.log(`Triaging email from ${input.from}: ${input.subject}`);
  console.log('---');

  try {
    const result = await spawnSubagent(input);
    console.log(JSON.stringify(result, null, 2));
  } catch (err) {
    console.error('Triage failed:', (err as Error).message);
    process.exit(1);
  }
}

main();
