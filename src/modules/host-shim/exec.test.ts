import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

describe('execHostShim', () => {
  let dir: string;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'host-shims-test-'));
    process.env.NANOCLAW_HOST_SHIMS_DIR = dir;
    vi.resetModules();
  });

  afterEach(() => {
    delete process.env.NANOCLAW_HOST_SHIMS_DIR;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function writeShim(name: string, script: string) {
    const p = path.join(dir, `${name}-host`);
    fs.writeFileSync(p, script);
    fs.chmodSync(p, 0o755);
  }

  it('refuses an invalid name before touching the filesystem', async () => {
    const { execHostShim } = await import('./exec.js');
    const result = await execHostShim('../etc', []);
    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(127);
  });

  it('refuses a name with no matching -host script', async () => {
    const { execHostShim } = await import('./exec.js');
    const result = await execHostShim('nonexistent', []);
    expect(result.ok).toBe(false);
    expect(result.refusalReason).toMatch(/no whitelisted shim/);
  });

  it('runs a whitelisted script and returns its output', async () => {
    writeShim('echo', '#!/bin/sh\necho "$@"\n');
    const { execHostShim } = await import('./exec.js');
    const result = await execHostShim('echo', ['hello', 'world']);
    expect(result.ok).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('hello world');
  });

  it('propagates a nonzero exit code from the script', async () => {
    writeShim('fail', '#!/bin/sh\nexit 3\n');
    const { execHostShim } = await import('./exec.js');
    const result = await execHostShim('fail', []);
    expect(result.ok).toBe(true);
    expect(result.exitCode).toBe(3);
  });

  it('refuses a symlink that escapes the whitelist directory', async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'host-shims-outside-'));
    const target = path.join(outside, 'evil.sh');
    fs.writeFileSync(target, '#!/bin/sh\necho pwned\n');
    fs.chmodSync(target, 0o755);
    fs.symlinkSync(target, path.join(dir, 'escape-host'));

    const { execHostShim } = await import('./exec.js');
    const result = await execHostShim('escape', []);
    expect(result.ok).toBe(false);

    fs.rmSync(outside, { recursive: true, force: true });
  });

  it('refuses a non-executable file', async () => {
    const p = path.join(dir, 'notexec-host');
    fs.writeFileSync(p, '#!/bin/sh\necho hi\n');
    fs.chmodSync(p, 0o644);

    const { execHostShim } = await import('./exec.js');
    const result = await execHostShim('notexec', []);
    expect(result.ok).toBe(false);
  });
});
