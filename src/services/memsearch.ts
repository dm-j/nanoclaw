import { execFile } from 'child_process';
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

      // ponytail: split args string. Good enough for memsearch subcommands.
      // Doesn't handle quoted strings with spaces — upgrade if that matters.
      const userArgs = argsStr.split(/\s+/).filter(Boolean);

      if (userArgs.length === 0) {
        res.writeHead(400).end('No memsearch command provided');
        return;
      }

      const subcommand = userArgs[0];

      // Build the real memsearch args with injected scoping
      const realArgs = [...userArgs, '--milvus-uri', milvusUri];

      // For index/watch commands, inject the memory directory as the path arg
      // if no path was provided
      if ((subcommand === 'index' || subcommand === 'watch') && !userArgs.some((a) => a.startsWith('/'))) {
        realArgs.push(memoryDir);
      }

      log.debug('memsearch relay', { agentGroupId, subcommand, milvusUri });

      await new Promise<void>((resolve) => {
        execFile(MEMSEARCH_BIN, realArgs, { timeout: 30_000 }, (err, stdout, stderr) => {
          if (err) {
            log.warn('memsearch failed', { agentGroupId, subcommand, stderr: stderr?.slice(0, 300), code: err.code });
            res.writeHead(500).end(stderr || err.message);
          } else {
            res.writeHead(200, { 'Content-Type': 'text/plain' }).end(stdout);
          }
          resolve();
        });
      });
    },
  });

  log.info('Memsearch host service registered');
}
