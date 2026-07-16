/**
 * Container Runner v2
 * Spawns agent containers with session folder + agent group folder mounts.
 * The container runs the v2 agent-runner which polls the session DB.
 */
import { ChildProcess, exec, spawn } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { promisify } from 'util';

import os from 'os';

import {
  CONTAINER_CPU_LIMIT,
  CONTAINER_IMAGE,
  CONTAINER_IMAGE_BASE,
  CONTAINER_INSTALL_LABEL,
  CONTAINER_MEMORY_LIMIT,
  DATA_DIR,
  GROUPS_DIR,
} from './config.js';
import { materializeContainerJson } from './container-config.js';
import { getContainerConfig } from './db/container-configs.js';
import { updateContainerConfigScalars } from './db/container-configs.js';
import {
  CONTAINER_HOST_GATEWAY,
  CONTAINER_RUNTIME_BIN,
  hostGatewayArgs,
  readonlyMountArgs,
  stopContainer,
} from './container-runtime.js';
import { EGRESS_NETWORK, egressNetworkArgs, ensureEgressNetwork } from './egress-lockdown.js';
import { resolveGroupTimezone } from './group-folder.js';
import { composeGroupClaudeMd } from './claude-md-compose.js';
import { getAgentGroup } from './db/agent-groups.js';
import { getDb, hasTable } from './db/connection.js';
import { initGroupFilesystem } from './group-init.js';
import { stopTypingRefresh } from './modules/typing/index.js';
import { log } from './log.js';
import { validateAdditionalMounts } from './modules/mount-security/index.js';
// Provider host-side config barrel — each provider that needs host-side
// container setup self-registers on import.
import './providers/index.js';
import {
  getProviderContainerConfig,
  providerProvidesAgentSurfaces,
  type ProviderContainerContribution,
  type VolumeMount,
} from './providers/provider-container-registry.js';
import {
  heartbeatPath,
  markContainerRunning,
  markContainerStopped,
  sessionDir,
  writeSessionRouting,
} from './session-manager.js';
import { registerServiceToken, revokeServiceToken } from './host-services-proxy.js';
import type { AgentGroup, Session } from './types.js';

const ONECLI_LOCAL_URL = 'http://127.0.0.1:10254';

interface OneCLIContainerConfig {
  env: Record<string, string>;
  caCertificate: string;
  caCertificateContainerPath: string;
  credentialStubs?: Array<{ containerPath: string; content: string }>;
}

async function onecliEnsureAgent(name: string, identifier: string): Promise<void> {
  const url = `${ONECLI_LOCAL_URL}/api/agents`;
  const existing = await fetch(url);
  if (existing.ok) {
    const agents = (await existing.json()) as Array<{ identifier: string | null }>;
    if (agents.some((a) => a.identifier === identifier)) return;
  }
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, identifier, secretMode: 'all' }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`OneCLI ensureAgent failed (${res.status}): ${body}`);
  }
}

async function onecliGetContainerConfig(agent: string): Promise<OneCLIContainerConfig> {
  const url = `${ONECLI_LOCAL_URL}/api/container-config?agent=${encodeURIComponent(agent)}`;
  const res = await fetch(url);
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`OneCLI container-config failed (${res.status}): ${body}`);
  }
  return res.json() as Promise<OneCLIContainerConfig>;
}

const HOST_SERVICES_PROXY_PORT = 10260;

export function applyOneCLIContainerConfig(
  args: string[],
  config: OneCLIContainerConfig,
  extraFileMounts: VolumeMount[],
): void {
  for (const [key, value] of Object.entries(config.env)) {
    // Rewrite proxy URLs to point at the host services proxy instead of
    // directly at OneCLI. The proxy forwards CONNECT tunnels to OneCLI
    // and handles .internal services locally.
    if (/^https?_proxy$/i.test(key) && value.includes(':10255')) {
      // Rewrite both the port and host: containers reach the host-services-proxy
      // at CONTAINER_HOST_GATEWAY (bridge gateway for Apple Container, host.docker.internal
      // equivalent) rather than 127.0.0.1, which isn't reachable from VMs.
      // URL may carry basic-auth userinfo (http://x:token@host:port) — only
      // swap the host:port after the last '@', preserving credentials.
      const rewritten = value.replace(
        /^(https?:\/\/(?:[^@]*@)?)[^@]+:\d+/,
        `$1${CONTAINER_HOST_GATEWAY}:${HOST_SERVICES_PROXY_PORT}`,
      );
      args.push('-e', `${key}=${rewritten}`);
    } else {
      args.push('-e', `${key}=${value}`);
    }
  }

  // Apple Container only supports directory bind mounts (not file mounts).
  // Write all files (OneCLI certs, stubs, and any VolumeMount file entries)
  // into a staging dir mounted at /tmp/nanoclaw-stage/, then let entrypoint.sh
  // bind-mount each to its target path (requires root start).
  const stageDir = path.join(os.tmpdir(), `nanoclaw-stage-${Date.now()}`);
  fs.mkdirSync(stageDir, { recursive: true });
  const stageMounts: Array<{ source: string; target: string }> = [];

  // Extra file mounts (container.json, CLAUDE.md, memsearch stub, etc.)
  for (let i = 0; i < extraFileMounts.length; i++) {
    const m = extraFileMounts[i];
    const stageName = `file-${i}-${path.basename(m.hostPath)}`;
    const stagePath = path.join(stageDir, stageName);
    fs.copyFileSync(m.hostPath, stagePath);
    fs.chmodSync(stagePath, fs.statSync(m.hostPath).mode);
    stageMounts.push({ source: `/tmp/nanoclaw-stage/${stageName}`, target: m.containerPath });
  }

  const caStage = path.join(stageDir, 'onecli-ca.pem');
  fs.writeFileSync(caStage, config.caCertificate);
  stageMounts.push({ source: '/tmp/nanoclaw-stage/onecli-ca.pem', target: config.caCertificateContainerPath });

  try {
    const systemCa = fs.readFileSync('/etc/ssl/cert.pem', 'utf-8');
    const combinedStage = path.join(stageDir, 'onecli-combined-ca.pem');
    fs.writeFileSync(combinedStage, systemCa + '\n' + config.caCertificate);
    args.push('-e', 'SSL_CERT_FILE=/tmp/onecli-combined-ca.pem');
    args.push('-e', 'DENO_CERT=/tmp/onecli-combined-ca.pem');
    stageMounts.push({ source: '/tmp/nanoclaw-stage/onecli-combined-ca.pem', target: '/tmp/onecli-combined-ca.pem' });
  } catch {
    // No system CA bundle available — single cert only
  }

  if (config.credentialStubs?.length) {
    for (let i = 0; i < config.credentialStubs.length; i++) {
      const stub = config.credentialStubs[i];
      const stubName = `stub-${i}-${path.basename(stub.containerPath)}`;
      fs.writeFileSync(path.join(stageDir, stubName), stub.content);
      stageMounts.push({ source: `/tmp/nanoclaw-stage/${stubName}`, target: stub.containerPath });
    }
  }

  // Mount staging dir and pass bind-mount map to entrypoint
  args.push(...readonlyMountArgs(stageDir, '/tmp/nanoclaw-stage'));
  args.push('-e', `NANOCLAW_STAGE_MOUNTS=${JSON.stringify(stageMounts)}`);
}

/** Active containers tracked by session ID. */
const activeContainers = new Map<string, { process: ChildProcess; containerName: string; serviceToken: string }>();

/**
 * In-flight wake promises, keyed by session id. Deduplicates concurrent
 * `wakeContainer` calls while the first spawn is still mid-setup (async
 * buildContainerArgs, OneCLI gateway apply, etc.) — otherwise a second
 * wake in that window passes the `activeContainers.has` check and spawns
 * a duplicate container against the same session directory, producing
 * racy double-replies.
 */
const wakePromises = new Map<string, Promise<boolean>>();

export function getActiveContainerCount(): number {
  return activeContainers.size;
}

export function isContainerRunning(sessionId: string): boolean {
  return activeContainers.has(sessionId);
}

/** Container names this process currently tracks as live — used to protect them from a periodic orphan sweep. */
export function getTrackedContainerNames(): Set<string> {
  return new Set([...activeContainers.values()].map((c) => c.containerName));
}

/** The running container name for a session, or undefined if it isn't currently up. */
export function getContainerName(sessionId: string): string | undefined {
  return activeContainers.get(sessionId)?.containerName;
}

/**
 * Wake up a container for a session. If already running or mid-spawn, no-op
 * (the in-flight wake promise is reused).
 *
 * The container runs the v2 agent-runner which polls the session DB.
 *
 * Contract: never throws. Returns `true` on successful spawn, `false` on
 * transient spawn failure (e.g. OneCLI gateway unreachable). Callers don't
 * need to wrap — the inbound row stays pending and host-sweep retries on
 * its next tick. Callers that care (e.g. the router's typing indicator)
 * can branch on the boolean.
 */
export function wakeContainer(session: Session): Promise<boolean> {
  if (activeContainers.has(session.id)) {
    log.debug('Container already running', { sessionId: session.id });
    return Promise.resolve(true);
  }
  const existing = wakePromises.get(session.id);
  if (existing) {
    log.debug('Container wake already in-flight — joining existing promise', { sessionId: session.id });
    return existing;
  }
  const promise = spawnContainer(session)
    .then(() => true)
    .catch((err) => {
      log.warn('wakeContainer failed — host-sweep will retry', { sessionId: session.id, err });
      return false;
    })
    .finally(() => {
      wakePromises.delete(session.id);
    });
  wakePromises.set(session.id, promise);
  return promise;
}

async function spawnContainer(session: Session): Promise<void> {
  const agentGroup = getAgentGroup(session.agent_group_id);
  if (!agentGroup) {
    log.error('Agent group not found', { agentGroupId: session.agent_group_id });
    return;
  }

  // Refresh the destination map and current-thread routing so any admin
  // changes take effect on wake. Destinations come from the agent-to-agent
  // module — skip when the module isn't installed (table absent).
  if (hasTable(getDb(), 'agent_destinations')) {
    const { writeDestinations } = await import('./modules/agent-to-agent/write-destinations.js');
    writeDestinations(agentGroup.id, session.id);
  }
  writeSessionRouting(agentGroup.id, session.id);

  // Materialize container.json from DB — writes fresh file and returns
  // the config object, threaded through provider resolution, buildMounts,
  // and buildContainerArgs so we don't re-read.
  const containerConfig = materializeContainerJson(agentGroup.id);

  // Hard gate: a model's context window must be configured before its
  // container ever starts. Without this, swapping a group onto a
  // smaller-context model (e.g. Claude → a local Ollama model) silently
  // reuses whatever compact-window default the provider ships with —
  // sized for Claude's 200k window — and the agent can blow straight past
  // the real window with no compaction ever triggering. Refusing to spawn
  // is the loud failure mode; a quietly wrong default is the dangerous one.
  if (!containerConfig.contextWindow) {
    throw new Error(
      `No context window configured for agent group "${agentGroup.name}" (${agentGroup.id}), ` +
        `model "${containerConfig.model ?? '(default)'}" — refusing to spawn. Set one with: ` +
        `ncl groups config update --id ${agentGroup.id} --context-window <tokens>`,
    );
  }

  // Per-group filesystem state lives forever after first creation. Init is
  // idempotent: it only writes paths that don't already exist, so this call
  // is a no-op for groups that have spawned before. Runs before the provider
  // contribution so a surfaces-providing provider finds the group dir ready.
  const providerName = resolveProviderName(session.agent_provider, containerConfig.provider);
  initGroupFilesystem(agentGroup, { provider: providerName });

  // Resolve the effective provider + any host-side contribution it declares
  // (extra mounts, env passthrough). Computed once and threaded through both
  // buildMounts and buildContainerArgs so side effects (mkdir, etc.) fire once.
  const { provider, contribution } = resolveProviderContribution(session, agentGroup, containerConfig);

  const mounts = buildMounts(agentGroup, session, containerConfig, provider, contribution);
  const containerName = `nanoclaw-v2-${agentGroup.folder}-${Date.now()}`;
  // Per-container service token: lets the host services proxy identify this
  // container on macOS Docker Desktop, where container-to-host traffic is NATed
  // to 127.0.0.1 and IP-based identity resolution fails.
  const serviceToken = crypto.randomBytes(32).toString('base64url');
  registerServiceToken(serviceToken, agentGroup.id, session.id);
  // OneCLI agent identifier is always the agent group id — stable across
  // sessions and reversible via getAgentGroup() for approval routing.
  const agentIdentifier = agentGroup.id;
  const args = await buildContainerArgs(
    mounts,
    containerName,
    agentGroup,
    containerConfig,
    provider,
    contribution,
    agentIdentifier,
    serviceToken,
  );

  log.info('Spawning container', { sessionId: session.id, agentGroup: agentGroup.name, containerName });

  // Clear any orphan heartbeat from a previous container instance — the
  // sweep's ceiling check treats a missing file as "fresh spawn, give grace"
  // (host-sweep.ts line 87). Without this, the stale mtime can trigger an
  // immediate kill before the new container touches the file itself.
  fs.rmSync(heartbeatPath(agentGroup.id, session.id), { force: true });

  const container = spawn(CONTAINER_RUNTIME_BIN, args, { stdio: ['ignore', 'pipe', 'pipe'] });

  activeContainers.set(session.id, { process: container, containerName, serviceToken });
  markContainerRunning(session.id);

  // Log stderr. A container that dies at boot (unknown provider, missing
  // binary, bad config) explains itself only here — and debug is below the
  // default log level — so keep a tail to surface on a non-zero exit.
  const stderrTail: string[] = [];
  container.stderr?.on('data', (data) => {
    for (const line of data.toString().trim().split('\n')) {
      if (!line) continue;
      log.debug(line, { container: agentGroup.folder });
      stderrTail.push(line);
      if (stderrTail.length > 10) stderrTail.shift();
    }
  });

  // stdout is unused in v2 (all IO is via session DB)
  container.stdout?.on('data', () => {});

  // No host-side idle timeout. Stale/stuck detection is driven by the host
  // sweep reading heartbeat mtime + processing_ack claim age + container_state
  // (see src/host-sweep.ts). This avoids killing long-running legitimate work
  // on a wall-clock timer.

  container.on('close', (code) => {
    activeContainers.delete(session.id);
    markContainerStopped(session.id);
    stopTypingRefresh(session.id);
    revokeServiceToken(serviceToken);
    // code null = killed by signal (normal shutdown path), not a boot failure.
    if (code !== 0 && code !== null && stderrTail.length > 0) {
      log.warn('Container exited non-zero', { sessionId: session.id, code, containerName, stderrTail });
    } else {
      log.info('Container exited', { sessionId: session.id, code, containerName });
    }
  });

  container.on('error', (err) => {
    activeContainers.delete(session.id);
    markContainerStopped(session.id);
    stopTypingRefresh(session.id);
    revokeServiceToken(serviceToken);
    log.error('Container spawn error', { sessionId: session.id, err });
  });
}

/** Kill a container for a session. */
export function killContainer(sessionId: string, reason: string, onExit?: () => void): void {
  const entry = activeContainers.get(sessionId);
  if (!entry) return;

  if (onExit) {
    entry.process.once('close', onExit);
  }

  log.info('Killing container', { sessionId, reason, containerName: entry.containerName });
  try {
    stopContainer(entry.containerName);
  } catch {
    entry.process.kill('SIGKILL');
  }
}

/**
 * Resolve the provider name for a session:
 *
 *   sessions.agent_provider
 *     → container_configs.provider
 *     → 'claude'
 *
 * Pure so the precedence can be unit-tested without a DB or filesystem.
 */
export function resolveProviderName(
  sessionProvider: string | null | undefined,
  containerConfigProvider: string | null | undefined,
): string {
  return (sessionProvider || containerConfigProvider || 'claude').toLowerCase();
}

function resolveProviderContribution(
  session: Session,
  agentGroup: AgentGroup,
  containerConfig: import('./container-config.js').ContainerConfig,
): { provider: string; contribution: ProviderContainerContribution } {
  const provider = resolveProviderName(session.agent_provider, containerConfig.provider);
  const fn = getProviderContainerConfig(provider);
  const contribution = fn
    ? fn({
        sessionDir: sessionDir(agentGroup.id, session.id),
        agentGroupId: agentGroup.id,
        groupDir: path.resolve(GROUPS_DIR, agentGroup.folder),
        selectedSkills: selectedSkillNames(containerConfig),
        hostEnv: process.env,
      })
    : {};
  return { provider, contribution };
}

export function buildMounts(
  agentGroup: AgentGroup,
  session: Session,
  containerConfig: import('./container-config.js').ContainerConfig,
  provider: string,
  providerContribution: ProviderContainerContribution,
): VolumeMount[] {
  const projectRoot = process.cwd();

  // Default agent surfaces (composed project doc, skill links, provider state
  // dir) apply unless the provider's registration declares it provides its
  // own — a capability, never a provider name. See provider-container-registry.
  const defaultSurfaces = !providerProvidesAgentSurfaces(provider);

  const claudeDir = path.join(DATA_DIR, 'v2-sessions', agentGroup.id, '.claude-shared');
  if (defaultSurfaces) {
    // Sync skill symlinks based on container.json selection before mounting.
    syncSkillSymlinks(claudeDir, containerConfig);

    // Compose CLAUDE.md fresh every spawn from the shared base, enabled skill
    // fragments, and MCP server instructions. See `claude-md-compose.ts`.
    composeGroupClaudeMd(agentGroup);
  }

  const mounts: VolumeMount[] = [];
  const sessDir = sessionDir(agentGroup.id, session.id);
  const groupDir = path.resolve(GROUPS_DIR, agentGroup.folder);

  // Session folder at /workspace (contains inbound.db, outbound.db, outbox/, .claude/)
  mounts.push({ hostPath: sessDir, containerPath: '/workspace', readonly: false });

  // Agent group folder at /workspace/agent (RW for working files + CLAUDE.local.md)
  mounts.push({ hostPath: groupDir, containerPath: '/workspace/agent', readonly: false });

  // container.json — nested RO mount on top of RW group dir so the agent
  // can read its config but cannot modify it.
  const containerJsonPath = path.join(groupDir, 'container.json');
  if (fs.existsSync(containerJsonPath)) {
    mounts.push({ hostPath: containerJsonPath, containerPath: '/workspace/agent/container.json', readonly: true });
  }

  // Composer-managed CLAUDE.md artifacts — nested RO mounts. These are
  // regenerated from the shared base + fragments on every spawn; any
  // agent-side writes would be clobbered, so enforce read-only. Only
  // CLAUDE.local.md (per-group memory) remains RW via the group-dir mount.
  // `.claude-shared.md` is a symlink whose target (`/app/CLAUDE.md`) is
  // already RO-mounted, so writes through it fail regardless — no need for
  // a nested mount there.
  const composedClaudeMd = path.join(groupDir, 'CLAUDE.md');
  if (defaultSurfaces && fs.existsSync(composedClaudeMd)) {
    mounts.push({ hostPath: composedClaudeMd, containerPath: '/workspace/agent/CLAUDE.md', readonly: true });
  }
  const fragmentsDir = path.join(groupDir, '.claude-fragments');
  if (defaultSurfaces && fs.existsSync(fragmentsDir)) {
    mounts.push({ hostPath: fragmentsDir, containerPath: '/workspace/agent/.claude-fragments', readonly: true });
  }

  // Shared CLAUDE.md — read-only, imported by the composed entry point via
  // the `.claude-shared.md` symlink inside the group dir.
  const sharedClaudeMd = path.join(process.cwd(), 'container', 'CLAUDE.md');
  if (defaultSurfaces && fs.existsSync(sharedClaudeMd)) {
    mounts.push({ hostPath: sharedClaudeMd, containerPath: '/app/CLAUDE.md', readonly: true });
  }

  // Per-group .claude-shared at /home/node/.claude (Claude state, settings,
  // skill symlinks)
  if (defaultSurfaces) {
    mounts.push({ hostPath: claudeDir, containerPath: '/home/node/.claude', readonly: false });
  }

  // Shared agent-runner source — read-only, same code for all groups.
  const agentRunnerSrc = path.join(projectRoot, 'container', 'agent-runner', 'src');
  mounts.push({ hostPath: agentRunnerSrc, containerPath: '/app/src', readonly: true });

  // Shared skills — read-only, symlinks in .claude-shared/skills/ point here.
  const skillsSrc = path.join(projectRoot, 'container', 'skills');
  if (fs.existsSync(skillsSrc)) {
    mounts.push({ hostPath: skillsSrc, containerPath: '/app/skills', readonly: true });
  }

  // Memsearch stub — relays CLI calls to the host services proxy.
  // Mount the whole directory (Apple Container only supports dir mounts) and
  // let buildContainerArgs add it to PATH via MEMSEARCH_STUB_BIN env.
  const memsearchStubDir = path.join(projectRoot, 'container', 'memsearch-stub');
  if (fs.existsSync(memsearchStubDir)) {
    mounts.push({ hostPath: memsearchStubDir, containerPath: '/opt/nanoclaw-stubs', readonly: true });
  }

  // Memsearch ccplugin — hooks for memory capture and search
  const memsearchPlugin = path.join(projectRoot, 'container', 'plugins', 'memsearch');
  if (fs.existsSync(memsearchPlugin)) {
    mounts.push({ hostPath: memsearchPlugin, containerPath: '/app/memsearch-plugin', readonly: true });
  }

  // Additional mounts from container config
  if (containerConfig.additionalMounts && containerConfig.additionalMounts.length > 0) {
    const validated = validateAdditionalMounts(containerConfig.additionalMounts, agentGroup.name);
    mounts.push(...validated);
  }

  // Provider-contributed mounts (e.g. opencode-xdg)
  if (providerContribution.mounts) {
    mounts.push(...providerContribution.mounts);
  }

  return mounts;
}

/**
 * Sync skill symlinks in .claude-shared/skills/ to match the container.json
 * selection. Each symlink points to a container path (/app/skills/<name>)
 * so it's dangling on the host but valid inside the container.
 */
function syncSkillSymlinks(claudeDir: string, containerConfig: import('./container-config.js').ContainerConfig): void {
  const skillsDir = path.join(claudeDir, 'skills');
  if (!fs.existsSync(skillsDir)) {
    fs.mkdirSync(skillsDir, { recursive: true });
  }

  const desired = selectedSkillNames(containerConfig);
  const desiredSet = new Set(desired);

  // Remove symlinks not in the desired set
  for (const entry of fs.readdirSync(skillsDir)) {
    const entryPath = path.join(skillsDir, entry);
    let isSymlink = false;
    try {
      isSymlink = fs.lstatSync(entryPath).isSymbolicLink();
    } catch {
      continue;
    }
    if (isSymlink && !desiredSet.has(entry)) {
      fs.unlinkSync(entryPath);
    }
  }

  // Create symlinks for desired skills (container path targets)
  for (const skill of desired) {
    const linkPath = path.join(skillsDir, skill);
    let entry: fs.Stats | undefined;
    try {
      entry = fs.lstatSync(linkPath);
    } catch {
      /* missing */
    }
    if (!entry) {
      fs.symlinkSync(`/app/skills/${skill}`, linkPath);
    } else if (!entry.isSymbolicLink()) {
      // A real entry here is either a template overlay (intentional; see
      // src/group-skills.ts) or a stale pre-refactor skill copy that shadows
      // the shared skill (#3001). No marker distinguishes them yet, so
      // surface the skip instead of staying silent.
      log.warn(
        'Shared skill not symlinked: real entry occupies the path (template overlay or stale pre-refactor copy)',
        {
          skill,
          path: linkPath,
        },
      );
    }
  }
}

/**
 * Resolve the group's skill selection to concrete names — `'all'` recomputes
 * from `container/skills/` so newly-added upstream skills appear automatically.
 */
function selectedSkillNames(containerConfig: import('./container-config.js').ContainerConfig): string[] {
  if (containerConfig.skills !== 'all') return containerConfig.skills;
  const sharedSkillsDir = path.join(process.cwd(), 'container', 'skills');
  return fs.existsSync(sharedSkillsDir)
    ? fs.readdirSync(sharedSkillsDir).filter((e) => {
        try {
          return fs.statSync(path.join(sharedSkillsDir, e)).isDirectory();
        } catch {
          return false;
        }
      })
    : [];
}

async function buildContainerArgs(
  mounts: VolumeMount[],
  containerName: string,
  agentGroup: AgentGroup,
  containerConfig: import('./container-config.js').ContainerConfig,
  _provider: string,
  providerContribution: ProviderContainerContribution,
  agentIdentifier?: string,
  serviceToken?: string,
): Promise<string[]> {
  const args: string[] = ['run', '--rm', '--name', containerName, '--label', CONTAINER_INSTALL_LABEL];

  // Per-container resource caps (opt-in; empty = unbounded, today's behavior).
  // Only --memory is set. Whether that's a hard cap depends on the host having no
  // swap (a deployment concern) — on a swapless host --memory is hard and a runaway
  // is OOM-killed; we don't manage swap from here.
  if (CONTAINER_CPU_LIMIT) args.push('--cpus', CONTAINER_CPU_LIMIT);
  if (CONTAINER_MEMORY_LIMIT) args.push('--memory', CONTAINER_MEMORY_LIMIT);

  // Environment — only vars read by code we don't own.
  // Everything NanoClaw-specific is in container.json (read by runner at startup).
  // Per-group timezone override — the agent can update .timezone to handle travel.
  // Shared with host-side scheduling (recurrence.ts) via resolveGroupTimezone
  // so a cron fired "3am" per this override doesn't fire 3am UTC instead.
  args.push('-e', `TZ=${resolveGroupTimezone(agentGroup.folder)}`);

  // Service token: lets the host services proxy identify this container even
  // when Docker Desktop NATs the connection to 127.0.0.1. Never logged.
  if (serviceToken) {
    args.push('-e', `NANOCLAW_SERVICE_TOKEN=${serviceToken}`);
  }

  // Provider-contributed env vars (e.g. XDG_DATA_HOME, OPENCODE_*, NO_PROXY).
  if (providerContribution.env) {
    for (const [key, value] of Object.entries(providerContribution.env)) {
      args.push('-e', `${key}=${value}`);
    }
  }

  // Egress lockdown when enabled — throws if it can't be established, aborting
  // the spawn rather than running with open egress. Otherwise the host gateway.
  if (ensureEgressNetwork()) {
    args.push(...egressNetworkArgs());
    log.info('Egress lockdown active', { containerName, network: EGRESS_NETWORK });
  } else {
    args.push(...hostGatewayArgs());
  }

  // User mapping
  const hostUid = process.getuid?.();
  const hostGid = process.getgid?.();
  if (hostUid != null && hostUid !== 0 && hostUid !== 1000) {
    args.push('--user', `${hostUid}:${hostGid}`);
    args.push('-e', 'HOME=/home/node');
  }

  // Volume mounts — Apple Container only supports directory bind mounts.
  // File mounts are collected and routed through the staging dir instead.
  const fileMounts: VolumeMount[] = [];
  for (const mount of mounts) {
    const isDir = fs.statSync(mount.hostPath).isDirectory();
    if (isDir) {
      if (mount.readonly) {
        args.push(...readonlyMountArgs(mount.hostPath, mount.containerPath));
      } else {
        args.push('--mount', `type=bind,source=${mount.hostPath},target=${mount.containerPath}`);
      }
    } else {
      fileMounts.push(mount);
    }
  }

  // OneCLI gateway — injects HTTPS_PROXY + certs so container API calls
  // are routed through the agent vault for credential injection, and mounts
  // any credential stubs the gateway serves (e.g. a sentinel auth file).
  // Runs AFTER the volume mounts so a stub nested inside one of our mounts
  // (a parent dir mounted RW above it) lands later in the args and isn't
  // shadowed by it. Treated as a transient hard failure: if we can't wire
  // the gateway, we don't spawn. The caller (router or host-sweep) catches
  // the throw, leaves the inbound message pending, and the next sweep tick
  // retries.
  if (agentIdentifier) {
    await onecliEnsureAgent(agentGroup.name, agentIdentifier);
  }
  const onecliConfig = await onecliGetContainerConfig(agentIdentifier || '');
  applyOneCLIContainerConfig(args, onecliConfig, fileMounts);
  log.info('OneCLI gateway applied', { containerName });

  // Default inference base URL: all containers route through PrefixRouter
  // (sibling project, host port 8787), which dispatches by model-name prefix
  // (e.g. ollama/kimi-k2.6:cloud) to Ollama or Anthropic/OneCLI.
  // NO_PROXY ensures the host gateway bypasses HTTP_PROXY (injected by OneCLI)
  // so the plain-HTTP request to :8787 isn't intercepted by the host-services-proxy.
  args.push('-e', `ANTHROPIC_BASE_URL=http://${CONTAINER_HOST_GATEWAY}:8787`);
  args.push('-e', 'ANTHROPIC_API_KEY=INJECTED_BY_ONECLI');
  args.push('-e', `NO_PROXY=${CONTAINER_HOST_GATEWAY}`);
  args.push('-e', `no_proxy=${CONTAINER_HOST_GATEWAY}`);
  // Prepend stub bin dir so memsearch (and any future stubs) are in PATH.
  // /home/node/.local/bin holds the auto-generated tools/ wrappers (below) —
  // this process runs as uid 501 (non-root), which can't write /usr/local/bin.
  args.push(
    '-e',
    'PATH=/home/node/.local/bin:/opt/nanoclaw-stubs:/pnpm:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
  );

  // Per-agent-group env overrides (file-only field in container.json).
  // Applied after OneCLI so they win over proxy-injected values.
  if (containerConfig.env) {
    for (const [key, value] of Object.entries(containerConfig.env)) {
      args.push('-e', `${key}=${value}`);
    }
  }

  // Override entrypoint: run v2 entry point directly via Bun (no tsc, no stdin).
  args.push('--entrypoint', 'bash');

  // Use per-agent-group image if one has been built, otherwise base image
  const imageTag = containerConfig.imageTag || CONTAINER_IMAGE;
  args.push(imageTag);

  // This bypasses /app/entrypoint.sh entirely, which means its PATH-wrapper
  // generation for container/agent-runner/src/tools/ never runs either —
  // inlined here. It also means entrypoint.sh's own stage-mount step never
  // runs — but that step used `mount --bind` gated on `id -u = 0`, which
  // never applied anyway once buildContainerArgs sets `--user <hostUid>`
  // above (non-root from the first instruction). Without SOME staging step,
  // applyOneCLIContainerConfig's staged files (notably the combined CA
  // bundle at SSL_CERT_FILE/DENO_CERT) never land at their target path,
  // silently breaking all outbound TLS through the OneCLI-proxied path
  // (agent's own model calls still work — they bypass the proxy via
  // NO_PROXY — so this only surfaces on tool calls that reach the web).
  // A plain copy needs no privilege `mount --bind` would have required, so
  // it works under the non-root user unconditionally.
  const TOOL_WRAPPER_SETUP = `
mkdir -p /home/node/.local/bin
for f in /app/src/tools/*.ts; do
  [ -f "$f" ] || continue
  name=$(basename "$f" .ts)
  printf '#!/bin/sh\\nexec bun "%s" "$@"\\n' "$f" > "/home/node/.local/bin/$name"
  chmod +x "/home/node/.local/bin/$name"
done
for f in /app/src/tools/*; do
  [ -f "$f" ] && [ -x "$f" ] && [ "\${f##*.}" != "ts" ] && [ "\${f##*.}" != "md" ] || continue
  cp "$f" "/home/node/.local/bin/$(basename "$f")"
done
if [ -n "$NANOCLAW_STAGE_MOUNTS" ]; then
  bun -e '
    const fs = require("fs");
    const path = require("path");
    // Some targets (e.g. /app/CLAUDE.md) sit in a root-owned directory baked
    // into the image; this process runs as the host uid, not root, so those
    // copies fail with EACCES. Continue past them rather than aborting the
    // whole batch — a failure on one target (unwritable /app path) must not
    // block the rest (notably the OneCLI CA bundle under /tmp, which IS
    // writable and is load-bearing for all outbound TLS through the proxy).
    for (const m of JSON.parse(process.env.NANOCLAW_STAGE_MOUNTS)) {
      try {
        fs.mkdirSync(path.dirname(m.target), { recursive: true });
        fs.copyFileSync(m.source, m.target);
      } catch (err) {
        console.error("[stage-mount] failed to copy " + m.source + " -> " + m.target + ": " + err.message);
      }
    }
  '
fi`;

  args.push('-c', `${TOOL_WRAPPER_SETUP}\nexec bun run /app/src/index.ts`);

  return args;
}

const execAsync = promisify(exec);

/** Build a per-agent-group Docker image with custom packages. */
export async function buildAgentGroupImage(agentGroupId: string): Promise<void> {
  const agentGroup = getAgentGroup(agentGroupId);
  if (!agentGroup) throw new Error('Agent group not found');

  const configRow = getContainerConfig(agentGroup.id);
  if (!configRow) throw new Error('Container config not found');
  const aptPackages = JSON.parse(configRow.packages_apt) as string[];
  const npmPackages = JSON.parse(configRow.packages_npm) as string[];
  if (aptPackages.length === 0 && npmPackages.length === 0) {
    throw new Error('No packages to install. Use install_packages first.');
  }

  let dockerfile = `FROM ${CONTAINER_IMAGE}\nUSER root\n`;
  if (aptPackages.length > 0) {
    dockerfile += `RUN apt-get update && apt-get install -y ${aptPackages.join(' ')} && rm -rf /var/lib/apt/lists/*\n`;
  }
  if (npmPackages.length > 0) {
    // pnpm skips build scripts unless packages are allowlisted. Append each
    // to /root/.npmrc (base image sets it up for agent-browser) so packages
    // with postinstall — e.g. playwright, puppeteer, native addons — don't
    // install silently broken.
    const allowlist = npmPackages.map((p) => `echo 'only-built-dependencies[]=${p}' >> /root/.npmrc`).join(' && ');
    dockerfile += `RUN ${allowlist} && pnpm install -g ${npmPackages.join(' ')}\n`;
  }
  dockerfile += 'USER node\n';

  const imageTag = `${CONTAINER_IMAGE_BASE}:${agentGroupId}`;

  log.info('Building per-agent-group image', { agentGroupId, imageTag, apt: aptPackages, npm: npmPackages });

  // Write Dockerfile to temp file and build
  const tmpDockerfile = path.join(DATA_DIR, `Dockerfile.${agentGroupId}`);
  fs.writeFileSync(tmpDockerfile, dockerfile);
  try {
    // Awaited async exec so the single-threaded host stays responsive during
    // the build (can take minutes) instead of blocking on execSync. exec buffers
    // stdout/stderr (matching the old stdio: 'pipe') and rejects on a non-zero
    // exit, so error propagation is unchanged.
    await execAsync(`${CONTAINER_RUNTIME_BIN} build -t ${imageTag} -f ${tmpDockerfile} .`, {
      cwd: DATA_DIR,
      timeout: 900_000,
    });
  } finally {
    fs.unlinkSync(tmpDockerfile);
  }

  // Store the image tag in the DB
  updateContainerConfigScalars(agentGroup.id, { image_tag: imageTag });

  log.info('Per-agent-group image built', { agentGroupId, imageTag });
}
