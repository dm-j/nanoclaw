/**
 * host-shim exec — resolve a whitelisted `<name>-host` script and run it.
 *
 * The whitelist IS the filesystem: a name is allowed iff an executable file
 * named `<name>-host` exists directly inside HOST_SHIMS_DIR. No DB table, no
 * config entry — add a tool by dropping one script in, remove one by
 * deleting it. Each `-host` script does its own validation of the args it
 * receives; this layer only prevents the name from escaping the whitelist
 * directory and never runs anything through a shell.
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { HOST_SHIMS_DIR } from '../../config.js';
import { log } from '../../log.js';

const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const TIMEOUT_MS = 30_000;
const MAX_BUFFER = 1024 * 1024; // 1MB cap on captured stdout/stderr

export interface ShimResult {
  ok: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
  refusalReason?: string;
}

function refuse(reason: string): ShimResult {
  return { ok: false, exitCode: 127, stdout: '', stderr: '', refusalReason: reason };
}

/** Resolve `<name>-host` inside HOST_SHIMS_DIR, refusing anything that escapes it. */
function resolveShimPath(name: string): string | null {
  const candidate = path.join(HOST_SHIMS_DIR, `${name}-host`);
  let real: string;
  try {
    real = fs.realpathSync(candidate);
  } catch {
    return null; // doesn't exist
  }

  const realDir = fs.realpathSync(HOST_SHIMS_DIR);
  if (!real.startsWith(realDir + path.sep)) return null; // symlink escape

  try {
    fs.accessSync(real, fs.constants.X_OK);
  } catch {
    return null; // exists but not executable
  }

  return real;
}

export function execHostShim(name: string, args: string[]): Promise<ShimResult> {
  if (!NAME_RE.test(name)) {
    return Promise.resolve(refuse(`"${name}" is not a valid shim name`));
  }

  const shimPath = resolveShimPath(name);
  if (!shimPath) {
    log.warn('host-shim: no matching whitelisted script', { name });
    return Promise.resolve(refuse(`no whitelisted shim named "${name}"`));
  }

  return new Promise((resolve) => {
    execFile(
      shimPath,
      args,
      { timeout: TIMEOUT_MS, maxBuffer: MAX_BUFFER, encoding: 'utf-8' },
      (error, stdout, stderr) => {
        // execFile sets error.code to the numeric exit code on a nonzero
        // exit, or a string (e.g. 'ENOENT', 'ETIMEDOUT') if the process
        // itself failed to run — the latter has no exit code to report.
        if (error && typeof error.code !== 'number') {
          resolve({ ok: true, exitCode: 1, stdout, stderr: stderr || error.message });
          return;
        }
        const exitCode = error ? (error.code as number) : 0;
        resolve({ ok: true, exitCode, stdout, stderr });
      },
    );
  });
}
