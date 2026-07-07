import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

import { resolveProviderName } from './container-runner.js';

describe('resolveProviderName', () => {
  it('prefers session over container config', () => {
    expect(resolveProviderName('codex', 'claude')).toBe('codex');
  });

  it('falls back to container config when session is null', () => {
    expect(resolveProviderName(null, 'opencode')).toBe('opencode');
  });

  it('defaults to claude when nothing is set', () => {
    expect(resolveProviderName(null, undefined)).toBe('claude');
  });

  it('lowercases the resolved name', () => {
    expect(resolveProviderName('CODEX', null)).toBe('codex');
    expect(resolveProviderName(null, 'Claude')).toBe('claude');
  });

  it('treats empty string as unset (falls through)', () => {
    expect(resolveProviderName('', 'opencode')).toBe('opencode');
    expect(resolveProviderName(null, '')).toBe('claude');
  });
});

describe('buildContainerArgs ordering invariant (structural)', () => {
  // The OneCLI gateway apply (SDK applyContainerConfig) appends credential-stub
  // mounts — e.g. the codex auth.json sentinel nested INSIDE our RW
  // /home/node/.codex mount. Docker applies binds in argument order, so the
  // stub must land AFTER its parent mount or the parent shadows it and the
  // agent silently degrades to loginless auth. Driving the real
  // buildContainerArgs needs a live gateway + container runtime, so this
  // guards the invariant structurally: the gateway apply must appear after
  // the volume-mounts loop in the source.
  it('applies the OneCLI gateway after the volume mounts', () => {
    const src = fs.readFileSync(path.join(process.cwd(), 'src', 'container-runner.ts'), 'utf-8');
    const mountsLoop = src.indexOf('for (const mount of mounts)');
    const gatewayApply = src.indexOf('applyOneCLIContainerConfig(args, onecliConfig, fileMounts)');
    expect(mountsLoop).toBeGreaterThan(-1);
    expect(gatewayApply).toBeGreaterThan(-1);
    expect(gatewayApply).toBeGreaterThan(mountsLoop);
  });
});

describe('per-container resource limits (structural)', () => {
  // CONTAINER_CPU_LIMIT / CONTAINER_MEMORY_LIMIT pass through to `docker run` as
  // --cpus / --memory, but only when set. The default is empty string → no flag →
  // today's unbounded behavior (don't OOM existing OSS workloads). Swap is not
  // managed here (a swapless host makes --memory a hard cap). buildContainerArgs
  // needs a live gateway to drive, so guard the wiring structurally: the flags
  // must be pushed, and each must be guarded by its env knob so empty emits nothing.
  it('reads both limit knobs from config', () => {
    const src = fs.readFileSync(path.join(process.cwd(), 'src', 'container-runner.ts'), 'utf-8');
    expect(src).toContain('CONTAINER_CPU_LIMIT');
    expect(src).toContain('CONTAINER_MEMORY_LIMIT');
  });

  it('guards --cpus behind a truthy CONTAINER_CPU_LIMIT', () => {
    const src = fs.readFileSync(path.join(process.cwd(), 'src', 'container-runner.ts'), 'utf-8');
    expect(src).toMatch(/if \(CONTAINER_CPU_LIMIT\)[\s\S]*?args\.push\('--cpus', CONTAINER_CPU_LIMIT\)/);
  });

  it('guards --memory behind a truthy CONTAINER_MEMORY_LIMIT (and sets no swap flag)', () => {
    const src = fs.readFileSync(path.join(process.cwd(), 'src', 'container-runner.ts'), 'utf-8');
    expect(src).toMatch(/if \(CONTAINER_MEMORY_LIMIT\) args\.push\('--memory', CONTAINER_MEMORY_LIMIT\)/);
    expect(src).not.toContain('--memory-swap');
  });

  it('defaults both knobs to empty string in config (no flag = unbounded)', () => {
    const cfg = fs.readFileSync(path.join(process.cwd(), 'src', 'config.ts'), 'utf-8');
    expect(cfg).toContain("CONTAINER_CPU_LIMIT = process.env.CONTAINER_CPU_LIMIT || ''");
    expect(cfg).toContain("CONTAINER_MEMORY_LIMIT = process.env.CONTAINER_MEMORY_LIMIT || ''");
  });
});

describe('container boot-failure tripwire (structural)', () => {
  // A container that dies at boot (unknown provider, missing CLI binary, bad
  // config) explains itself only on stderr — which logs at debug, below the
  // default level. The spawn handler must keep a stderr tail and surface it
  // at warn on a non-zero exit, or the operator sees only "exited code 1" on
  // repeat. Driving a real failing spawn needs a container runtime, so this
  // guards the wiring structurally, matching the invariant test above.
  it('surfaces the stderr tail when the container exits non-zero', () => {
    const src = fs.readFileSync(path.join(process.cwd(), 'src', 'container-runner.ts'), 'utf-8');
    expect(src).toContain('stderrTail.push(line)');
    expect(src).toMatch(/Container exited non-zero.*stderrTail/s);
  });
});

describe('inference router env injection (structural)', () => {
  // All containers must point ANTHROPIC_BASE_URL at PrefixRouter so
  // model-prefix routing works and sub-agents inherit the right endpoint.
  // NO_PROXY must accompany it so the HTTP_PROXY injected by OneCLI doesn't
  // intercept the plain-HTTP request to host.docker.internal:8787.
  // Both must be injected BEFORE per-group env overrides so the group can
  // still override if needed.
  it('injects ANTHROPIC_BASE_URL and NO_PROXY before per-group env overrides', () => {
    const src = fs.readFileSync(path.join(process.cwd(), 'src', 'container-runner.ts'), 'utf-8');
    const routerUrl = src.indexOf('ANTHROPIC_BASE_URL=http://${CONTAINER_HOST_GATEWAY}:8787');
    const noProxy = src.indexOf('NO_PROXY=${CONTAINER_HOST_GATEWAY}');
    const perGroupEnv = src.indexOf('containerConfig.env');
    expect(routerUrl).toBeGreaterThan(-1);
    expect(noProxy).toBeGreaterThan(-1);
    expect(perGroupEnv).toBeGreaterThan(-1);
    expect(routerUrl).toBeLessThan(perGroupEnv);
    expect(noProxy).toBeLessThan(perGroupEnv);
  });
});

describe('service token wiring (structural)', () => {
  // macOS Docker Desktop NATs container-to-host traffic to 127.0.0.1, so the
  // host services proxy cannot identify callers by IP. A per-container service
  // token must be generated at spawn, registered with the proxy, and injected
  // into the container env so the memsearch stub can authenticate.
  it('generates, registers, and injects a service token', () => {
    const src = fs.readFileSync(path.join(process.cwd(), 'src', 'container-runner.ts'), 'utf-8');
    expect(src).toContain("crypto.randomBytes(32).toString('base64url')");
    expect(src).toContain('registerServiceToken(serviceToken, agentGroup.id, session.id)');
    expect(src).toContain('NANOCLAW_SERVICE_TOKEN=${serviceToken}');
    expect(src).toContain('revokeServiceToken(serviceToken)');
  });
});
