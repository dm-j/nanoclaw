import type { Migration } from './index.js';

/**
 * `env` on `container_configs`: per-agent-group env var overrides, DB-backed
 * instead of the old file-only container.json field that materializeContainerJson
 * had to hand-preserve across regenerations.
 */
export const migration019: Migration = {
  version: 19,
  name: 'container-config-env',
  up(db) {
    db.exec(`ALTER TABLE container_configs ADD COLUMN env TEXT NOT NULL DEFAULT '{}';`);
  },
};
