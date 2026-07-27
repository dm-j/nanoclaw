import fs from 'fs';
import path from 'path';

import { DATA_DIR, DEFAULT_AGENT_PROVIDER, GROUPS_DIR } from './config.js';
import { ensureContainerConfig } from './db/container-configs.js';
import { stageGroupPersona } from './group-persona.js';
import { log } from './log.js';
import { providerProvidesAgentSurfaces } from './providers/provider-container-registry.js';
import type { AgentGroup } from './types.js';

const DEFAULT_SETTINGS_JSON =
  JSON.stringify(
    {
      env: {
        CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD: '1',
        CLAUDE_CODE_DISABLE_AUTO_MEMORY: '0',
        MEMSEARCH_DIR: '/workspace/agent/.memsearch',
      },
      hooks: {
        PreCompact: [
          {
            hooks: [
              {
                type: 'command',
                command: 'bun /app/src/compact-instructions.ts',
              },
            ],
          },
        ],
        SessionStart: [
          {
            hooks: [
              {
                type: 'command',
                command: 'bash /app/memsearch-plugin/hooks/session-start.sh',
                timeout: 10,
              },
            ],
          },
        ],
      },
    },
    null,
    2,
  ) + '\n';

/**
 * Initialize the on-disk filesystem state for an agent group. Idempotent —
 * every step is gated on the target not already existing, so re-running on
 * an already-initialized group is a no-op.
 *
 * Called once per group lifetime at creation, or defensively from
 * `buildMounts()` for groups that pre-date this code path.
 *
 * Source code and skills are shared RO mounts — not copied per-group.
 * Skill symlinks are synced at spawn time by container-runner.ts.
 *
 * The provider project document is regenerated on every spawn. Initial
 * standing instructions are staged once in the provider-neutral prepend file.
 */
export function initGroupFilesystem(
  group: AgentGroup,
  opts?: { instructions?: string; provider?: string | null },
): void {
  const initialized: string[] = [];

  // `opts.provider` absent means "caller has no provider opinion" — for a
  // brand-new group that resolves to the instance default, so the scaffold and
  // the stamped config row both match it. A caller that knows the provider
  // (subagent → parent's, spawn → resolved, setup → operator's pick) passes it
  // explicitly — including `claude` — which pins the group and skips the
  // default. ensureContainerConfig is INSERT OR IGNORE, so this only stamps a
  // genuinely new group; existing rows are never touched.
  const providerHint = (opts?.provider ?? DEFAULT_AGENT_PROVIDER).toLowerCase();

  // Default agent surfaces apply unless the provider declares (at registration)
  // that it provides its own.
  const defaultSurfaces = !providerProvidesAgentSurfaces(providerHint);

  // 1. groups/<folder>/ — group memory + working dir
  const groupDir = path.resolve(GROUPS_DIR, group.folder);
  if (!fs.existsSync(groupDir)) {
    fs.mkdirSync(groupDir, { recursive: true });
    initialized.push('groupDir');
  }

  if (opts?.instructions && stageGroupPersona(groupDir, opts.instructions)) {
    initialized.push('instructions.prepend.md');
  }

  // Ensure container_configs row exists in the DB. Idempotent — no-op if
  // the row already exists (e.g. created by backfill or group creation). On a
  // fresh row, stamp the resolved provider hint so a new group is created on
  // the instance default (or the caller's explicit pick).
  ensureContainerConfig(group.id, providerHint);
  initialized.push('container_configs');

  // 2. data/v2-sessions/<id>/.claude-shared/ — Claude state + per-group skills
  if (defaultSurfaces) {
    const claudeDir = path.join(DATA_DIR, 'v2-sessions', group.id, '.claude-shared');
    if (!fs.existsSync(claudeDir)) {
      fs.mkdirSync(claudeDir, { recursive: true });
      initialized.push('.claude-shared');
    }

    const settingsFile = path.join(claudeDir, 'settings.json');
    if (!fs.existsSync(settingsFile)) {
      fs.writeFileSync(settingsFile, DEFAULT_SETTINGS_JSON);
      initialized.push('settings.json');
    }
    // NOTE: upstream's migrateClaudeMemorySettings() (src/migrate-claude-memory-settings.ts)
    // is deliberately NOT called here — it forces autoMemoryEnabled=false and
    // CLAUDE_CODE_DISABLE_AUTO_MEMORY='1' on every existing group, which would silently
    // undo this fork's declined-scaffold decision (see docs/memory-decision-upstream-declined.md).
    // Lumen's own memsearch/working-memory system is the memory substrate here instead.
    ensureMemsearchHooks(settingsFile, initialized);
    ensureRtkHook(settingsFile, initialized);

    // Skills directory — created empty here; symlinks are synced at spawn
    // time by container-runner.ts based on container.json skills selection.
    const skillsDst = path.join(claudeDir, 'skills');
    if (!fs.existsSync(skillsDst)) {
      fs.mkdirSync(skillsDst, { recursive: true });
      initialized.push('skills/');
    }
  }

  if (initialized.length > 0) {
    log.info('Initialized group filesystem', {
      group: group.name,
      folder: group.folder,
      id: group.id,
      steps: initialized,
    });
  }
}

const RTK_HOOK_COMMAND = 'rtk hook claude';

const PRE_COMPACT_COMMAND = 'bun /app/src/compact-instructions.ts';
const MEMSEARCH_STOP_COMMAND = 'bash /app/memsearch-plugin/hooks/stop.sh';
const MEMSEARCH_SESSION_START_COMMAND = 'bash /app/memsearch-plugin/hooks/session-start.sh';

/**
 * Patch an existing settings.json to add the PreCompact hook if missing.
 * Runs on every group init so pre-existing groups pick up the hook.
 */
function ensurePreCompactHook(settingsFile: string, initialized: string[]): void {
  try {
    const raw = fs.readFileSync(settingsFile, 'utf-8');
    const settings = JSON.parse(raw);

    // Check if there's already a PreCompact hook with our command.
    const existing = settings.hooks?.PreCompact as unknown[] | undefined;
    if (existing && JSON.stringify(existing).includes(PRE_COMPACT_COMMAND)) return;

    // Add the hook, preserving existing hooks.
    if (!settings.hooks) settings.hooks = {};
    if (!settings.hooks.PreCompact) settings.hooks.PreCompact = [];
    settings.hooks.PreCompact.push({
      hooks: [{ type: 'command', command: PRE_COMPACT_COMMAND }],
    });

    fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2) + '\n');
    initialized.push('settings.json (added PreCompact hook)');
  } catch {
    // Don't break init if settings.json is malformed — it'll use whatever's there.
  }
}

function ensureMemsearchHooks(settingsFile: string, initialized: string[]): void {
  try {
    const raw = fs.readFileSync(settingsFile, 'utf-8');
    const settings = JSON.parse(raw);
    let changed = false;

    if (!settings.hooks) settings.hooks = {};
    if (!settings.env) settings.env = {};

    // MEMSEARCH_DIR env var — scopes hooks to the agent group's memory
    if (!settings.env.MEMSEARCH_DIR) {
      settings.env.MEMSEARCH_DIR = '/workspace/agent/.memsearch';
      changed = true;
    }

    // Stop hook removed — agent-runner now captures memory directly after each exchange.
    // Remove any stale Stop hook pointing at the plugin stop.sh so it doesn't write
    // empty session headings.
    if (settings.hooks.Stop) {
      const before = settings.hooks.Stop.length;
      settings.hooks.Stop = settings.hooks.Stop.filter((h: unknown) => {
        const s = JSON.stringify(h);
        return !s.includes(MEMSEARCH_STOP_COMMAND);
      });
      if (settings.hooks.Stop.length !== before) {
        if (settings.hooks.Stop.length === 0) delete settings.hooks.Stop;
        changed = true;
      }
    }

    // SessionStart hook — search for relevant context
    if (!JSON.stringify(settings.hooks.SessionStart ?? []).includes(MEMSEARCH_SESSION_START_COMMAND)) {
      if (!settings.hooks.SessionStart) settings.hooks.SessionStart = [];
      settings.hooks.SessionStart.push({
        hooks: [{ type: 'command', command: MEMSEARCH_SESSION_START_COMMAND, timeout: 10 }],
      });
      changed = true;
    }

    if (changed) {
      fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2) + '\n');
      initialized.push('settings.json (added memsearch hooks)');
    }
  } catch {
    // Don't break init if settings.json is malformed
  }
}

/**
 * Ensure the rtk PreToolUse hook is present in settings.json. rtk itself is
 * baked into the image at /usr/local/bin/rtk (container/Dockerfile) — no
 * mount needed; a mount-based approach was tried and reverted (see
 * .claude/skills/add-rtk/add-rtk-glibc-incompatible.md) since Apple
 * Container has no file bind mounts and the host-built binary's glibc
 * didn't match the container's base image anyway. Called on every group
 * init so all new and existing groups pick it up automatically.
 */
function ensureRtkHook(settingsFile: string, initialized: string[]): void {
  try {
    const raw = fs.readFileSync(settingsFile, 'utf-8');
    const settings = JSON.parse(raw);
    const serialized = JSON.stringify(settings.hooks?.PreToolUse ?? []);
    if (!serialized.includes(RTK_HOOK_COMMAND)) {
      if (!settings.hooks) settings.hooks = {};
      if (!settings.hooks.PreToolUse) settings.hooks.PreToolUse = [];
      settings.hooks.PreToolUse.push({ matcher: 'Bash', hooks: [{ type: 'command', command: RTK_HOOK_COMMAND }] });
      fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2) + '\n');
      initialized.push('settings.json (added rtk PreToolUse hook)');
    }
  } catch {
    // Don't break init on malformed settings.json
  }
}
