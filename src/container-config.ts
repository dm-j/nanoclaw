/**
 * Container config types and materialization.
 *
 * Source of truth is the `container_configs` table in the central DB.
 * This module provides:
 *   - Type definitions for the file shape (read by the container runner)
 *   - `materializeContainerJson()` — writes `groups/<folder>/container.json`
 *     from the DB at spawn time
 *   - `configFromDb()` — builds a `ContainerConfig` from a DB row + agent group
 */
import fs from 'fs';
import path from 'path';

import { GROUPS_DIR, TIMEZONE } from './config.js';
import { getContainerConfig } from './db/container-configs.js';
import { getAgentGroup } from './db/agent-groups.js';
import { isValidTimezone } from './timezone.js';
import type { AgentGroup, ContainerConfigRow } from './types.js';

export interface McpServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  instructions?: string;
}

export interface AdditionalMountConfig {
  hostPath: string;
  containerPath: string;
  readonly?: boolean;
}

/** Shape of the materialized `container.json` file read by the container runner. */
export interface ContainerConfig {
  mcpServers: Record<string, McpServerConfig>;
  packages: { apt: string[]; npm: string[] };
  imageTag?: string;
  additionalMounts: AdditionalMountConfig[];
  skills: string[] | 'all';
  provider?: string;
  groupName?: string;
  assistantName?: string;
  agentGroupId?: string;
  maxMessagesPerPrompt?: number;
  model?: string;
  effort?: string;
  env?: Record<string, string>;
  /** Active model's real context window, in tokens. Required — see container-runner.ts spawnContainer(). */
  contextWindow?: number;
  timezone?: string;
}

/**
 * DB-only effective timezone for an agent group: `container_configs.timezone`
 * → install global. Used by callers with no filesystem access to the group's
 * `.timezone` live-override file (e.g. `ncl tasks` CLI resources). Recurrence
 * processing (`modules/scheduling/recurrence.ts`) uses the fuller resolution
 * chain in `group-folder.ts`'s `resolveGroupTimezone` instead — file override
 * first, this DB value as its fallback, then global — since it must agree
 * with the container's own TZ env, which does have filesystem access.
 * An invalid hand-edited DB value falls back to the global tz, same as no override.
 */
export function resolveGroupTimezone(agentGroupId: string): string {
  const tz = getContainerConfig(agentGroupId)?.timezone;
  return tz && isValidTimezone(tz) ? tz : TIMEZONE;
}

/** Build a `ContainerConfig` from a DB row + agent group identity. */
export function configFromDb(row: ContainerConfigRow, group: AgentGroup): ContainerConfig {
  const env = JSON.parse(row.env) as Record<string, string>;
  return {
    mcpServers: JSON.parse(row.mcp_servers) as Record<string, McpServerConfig>,
    packages: {
      apt: JSON.parse(row.packages_apt) as string[],
      npm: JSON.parse(row.packages_npm) as string[],
    },
    imageTag: row.image_tag ?? undefined,
    additionalMounts: JSON.parse(row.additional_mounts) as AdditionalMountConfig[],
    skills: JSON.parse(row.skills) as string[] | 'all',
    provider: row.provider ?? undefined,
    groupName: group.name,
    assistantName: row.assistant_name ?? group.name,
    agentGroupId: group.id,
    maxMessagesPerPrompt: row.max_messages_per_prompt ?? undefined,
    model: row.model ?? undefined,
    effort: row.effort ?? undefined,
    env: Object.keys(env).length > 0 ? env : undefined,
    contextWindow: row.context_window ?? undefined,
    timezone: row.timezone && isValidTimezone(row.timezone) ? row.timezone : undefined,
  };
}

/**
 * Materialize `container.json` from the DB. Called at spawn time so the
 * container always sees fresh config. Returns the `ContainerConfig` for
 * use by the caller (buildMounts, buildContainerArgs, etc.).
 */
export function materializeContainerJson(agentGroupId: string): ContainerConfig {
  const group = getAgentGroup(agentGroupId);
  if (!group) throw new Error(`Agent group not found: ${agentGroupId}`);

  const row = getContainerConfig(agentGroupId);
  if (!row) throw new Error(`Container config not found for agent group: ${agentGroupId}`);

  const config = configFromDb(row, group);

  const p = path.join(GROUPS_DIR, group.folder, 'container.json');
  const dir = path.dirname(p);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  fs.writeFileSync(p, JSON.stringify(config, null, 2) + '\n');

  return config;
}
