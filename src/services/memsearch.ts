import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { parse as parseQs } from 'querystring';

import { GROUPS_DIR } from '../config.js';
import { getAgentGroup } from '../db/agent-groups.js';
import { registerHostService } from '../host-services-proxy.js';
import { log } from '../log.js';

const MEMSEARCH_BIN = 'memsearch';

function getMemsearchDir(agentGroupId: string): string | null {
  const group = getAgentGroup(agentGroupId);
  if (!group) return null;
  const dir = path.join(GROUPS_DIR, group.folder, '.memsearch');
  fs.mkdirSync(path.join(dir, 'memory'), { recursive: true });
  return dir;
}

export function registerMemsearchService(): void {
  registerHostService('memsearch.internal', {
    access: 'all',
    async handler(req, res, agentGroupId) {
      const msDir = getMemsearchDir(agentGroupId);
      if (!msDir) {
        res.writeHead(404).end('Agent group not found');
        return;
      }

      const milvusUri = path.join(msDir, 'milvus.db');
      const memoryDir = path.join(msDir, 'memory');

      // Read the POST body
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const body = Buffer.concat(chunks).toString();
      const params = parseQs(body);
      const argsStr = (Array.isArray(params.args) ? params.args[0] : params.args) || '';
      const stdinData = (Array.isArray(params.stdin) ? params.stdin[0] : params.stdin) || '';

      // ponytail: split args string. Good enough for memsearch subcommands.
      const userArgs = argsStr.split(/\s+/).filter(Boolean);

      if (userArgs.length === 0) {
        res.writeHead(400).end('No memsearch command provided');
        return;
      }

      const subcommand = userArgs[0];

      // Build the real memsearch args with injected scoping
      const realArgs = [...userArgs, '--milvus-uri', milvusUri];

      // For index/watch commands, inject the memory directory as the path arg
      if ((subcommand === 'index' || subcommand === 'watch') && !userArgs.some((a) => a.startsWith('/'))) {
        realArgs.push(memoryDir);
      }

      log.debug('memsearch relay', { agentGroupId, subcommand, milvusUri });

      await new Promise<void>((resolve) => {
        const proc = spawn(MEMSEARCH_BIN, realArgs, { timeout: 30_000 });
        const stdout: Buffer[] = [];
        const stderr: Buffer[] = [];

        proc.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
        proc.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));

        if (stdinData) {
          proc.stdin.write(stdinData);
        }
        proc.stdin.end();

        proc.on('close', (code) => {
          const out = Buffer.concat(stdout).toString();
          const err = Buffer.concat(stderr).toString();
          if (code !== 0) {
            log.warn('memsearch failed', { agentGroupId, subcommand, stderr: err.slice(0, 300), code });
            res.writeHead(500).end(err || `exit code ${code}`);
          } else {
            res.writeHead(200, { 'Content-Type': 'text/plain' }).end(out);
          }
          resolve();
        });
      });
    },
  });

  log.info('Memsearch host service registered');
}
