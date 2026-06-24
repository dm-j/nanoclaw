#!/usr/bin/env bun
/**
 * List available agent tools in /app/src/tools/.
 */

import fs from 'fs';
import path from 'path';

const TOOLS_DIR = '/app/src/tools';
const args = process.argv.slice(2);
const showDesc = args.includes('--description') || args.includes('-d');

let files: string[];
try {
  files = fs.readdirSync(TOOLS_DIR).filter((f) => f.endsWith('.ts')).sort();
} catch {
  console.error(`Tools directory not found: ${TOOLS_DIR}`);
  process.exit(1);
}

for (const file of files) {
  const name = file.replace(/\.ts$/, '');
  if (!showDesc) {
    console.log(name);
    continue;
  }

  const src = fs.readFileSync(path.join(TOOLS_DIR, file), 'utf-8');
  const lines = src.split('\n');

  // Skip shebang, then collect first contiguous comment block
  const desc: string[] = [];
  let inComment = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('#!')) continue;
    if (!inComment && trimmed === '') continue;

    if (trimmed.startsWith('/**') || trimmed.startsWith('/*')) {
      inComment = true;
      const content = trimmed.replace(/^\/\*\*?\s?/, '').replace(/\*\/\s*$/, '').trim();
      if (content) desc.push(content);
      if (trimmed.endsWith('*/')) break;
      continue;
    }
    if (inComment) {
      if (trimmed.endsWith('*/')) {
        const content = trimmed.replace(/\*\/\s*$/, '').replace(/^\*\s?/, '').trim();
        if (content) desc.push(content);
        break;
      }
      const content = trimmed.replace(/^\*\s?/, '').trim();
      if (content) desc.push(content);
      continue;
    }
    if (trimmed.startsWith('//')) {
      desc.push(trimmed.replace(/^\/\/\s?/, ''));
      continue;
    }
    break;
  }

  console.log(`${name}: ${desc.join(' ') || '(no description)'}`);
}
