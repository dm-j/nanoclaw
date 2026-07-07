/**
 * Container runtime abstraction for NanoClaw — Apple Container implementation.
 * All runtime-specific logic lives here so swapping runtimes means changing one file.
 *
 * Apple Container uses a vmnet bridge network; containers reach the host via the
 * bridge gateway (bridge100, typically 192.168.64.1). The `container` CLI uses
 * --mount syntax instead of Docker's -v shorthand, and `container ls --format json`
 * instead of `docker ps --filter`.
 */
import { execSync } from 'child_process';
import os from 'os';

import { CONTAINER_INSTALL_LABEL } from './config.js';
import { log } from './log.js';

/** The container runtime binary name. */
export const CONTAINER_RUNTIME_BIN = 'container';

/**
 * Detect the host gateway address as seen from Apple Container VMs.
 * Apple Container on macOS: containers reach the host via the bridge network gateway.
 * bridge100 only exists while containers are running, so we probe at startup
 * and fall back to 192.168.64.1 (Apple Container's default vmnet gateway).
 */
export function detectHostGateway(): string {
  const ifaces = os.networkInterfaces();
  const bridge = ifaces['bridge100'] || ifaces['bridge0'];
  if (bridge) {
    const ipv4 = bridge.find((a) => a.family === 'IPv4');
    if (ipv4) return ipv4.address;
  }
  // ponytail: falls back to Apple Container's documented default gateway
  return '192.168.64.1';
}

export const CONTAINER_HOST_GATEWAY = detectHostGateway();

/** CLI args needed for the container to resolve the host gateway. Not needed for Apple Container. */
export function hostGatewayArgs(): string[] {
  return [];
}

/** Returns CLI args for a readonly bind mount (Apple Container --mount syntax). */
export function readonlyMountArgs(hostPath: string, containerPath: string): string[] {
  return ['--mount', `type=bind,source=${hostPath},target=${containerPath},readonly`];
}

/** Stop a container by name. Uses execFileSync to avoid shell injection. */
export function stopContainer(name: string): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(name)) {
    throw new Error(`Invalid container name: ${name}`);
  }
  execSync(`${CONTAINER_RUNTIME_BIN} stop ${name}`, { stdio: 'pipe' });
}

/** Ensure the container runtime is running, starting it if needed. */
export function ensureContainerRuntimeRunning(): void {
  try {
    execSync(`${CONTAINER_RUNTIME_BIN} system status`, {
      stdio: 'pipe',
      timeout: 10000,
    });
    log.debug('Container runtime already running');
  } catch {
    log.debug('Container runtime not running, attempting to start...');
    try {
      execSync(`${CONTAINER_RUNTIME_BIN} system start`, {
        stdio: 'pipe',
        timeout: 30000,
      });
      log.debug('Container runtime started');
    } catch (startErr) {
      log.error('Failed to start container runtime', { err: startErr });
      console.error('\n╔════════════════════════════════════════════════════════════════╗');
      console.error('║  FATAL: Container runtime failed to start                      ║');
      console.error('║                                                                ║');
      console.error('║  Agents cannot run without a container runtime. To fix:        ║');
      console.error('║  1. Ensure Apple Container is installed (container --version)  ║');
      console.error('║  2. Run: container system start                                ║');
      console.error('║  3. Restart NanoClaw                                           ║');
      console.error('╚════════════════════════════════════════════════════════════════╝\n');
      throw new Error('Container runtime is required but failed to start', {
        cause: startErr,
      });
    }
  }
}

/**
 * Kill orphaned NanoClaw containers from THIS install's previous runs.
 *
 * Apple Container: `container ls --format json` returns a JSON array.
 * Scoped by label `nanoclaw-install=<slug>` so a crash-looping peer install
 * cannot reap our containers, and we cannot reap theirs.
 */
export function cleanupOrphans(): void {
  try {
    const output = execSync(`${CONTAINER_RUNTIME_BIN} ls --format json`, {
      stdio: ['pipe', 'pipe', 'pipe'],
      encoding: 'utf-8',
    });

    // `container ls --format json` nests labels under `configuration.labels`
    // and has no top-level `name` — the container's name is its `id`.
    type ContainerEntry = { id?: string; configuration?: { labels?: Record<string, string> } };
    let containers: ContainerEntry[] = [];
    try {
      containers = JSON.parse(output.trim() || '[]') as ContainerEntry[];
    } catch {
      // empty or malformed output — nothing to clean up
      return;
    }

    const [labelKey, labelValue] = CONTAINER_INSTALL_LABEL.split('=');
    const orphans = containers
      .filter((c) => c.configuration?.labels?.[labelKey] === labelValue)
      .map((c) => c.id)
      .filter((id): id is string => !!id);

    for (const name of orphans) {
      try {
        stopContainer(name);
      } catch {
        /* already stopped */
      }
    }
    if (orphans.length > 0) {
      log.info('Stopped orphaned containers', { count: orphans.length, names: orphans });
    }
  } catch (err) {
    log.warn('Failed to clean up orphaned containers', { err });
  }
}
