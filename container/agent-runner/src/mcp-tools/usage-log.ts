/**
 * Per-tool usage logging: wraps a handler to append a JSONL record
 * (timestamp, tool name, truncated args, duration ms) to
 * /workspace/agent/mcp-usage.jsonl. Args are truncated to keep large
 * inputs (note content, transcripts) from blowing up the log file.
 */
import fs from 'fs';

import type { McpToolDefinition } from './types.js';

const LOG_PATH = '/workspace/agent/mcp-usage.jsonl';
const MAX_ARG_LEN = 120;

function truncate(v: unknown): string {
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return s.length > MAX_ARG_LEN ? `${s.slice(0, MAX_ARG_LEN)}…` : s;
}

export function withUsageLog(def: McpToolDefinition): McpToolDefinition {
  return {
    tool: def.tool,
    async handler(args) {
      const start = Date.now();
      try {
        return await def.handler(args);
      } finally {
        const line = JSON.stringify({
          ts: new Date().toISOString(),
          tool: def.tool.name,
          args: Object.fromEntries(Object.entries(args ?? {}).map(([k, v]) => [k, truncate(v)])),
          ms: Date.now() - start,
        });
        // ponytail: best-effort — a logging failure must never surface as a tool error
        try {
          fs.appendFileSync(LOG_PATH, line + '\n');
        } catch {
          /* ignore */
        }
      }
    },
  };
}
