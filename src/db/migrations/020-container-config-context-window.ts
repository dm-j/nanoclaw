import type { Migration } from './index.js';

/**
 * `context_window` on `container_configs`: the active model's real context
 * window in tokens, per agent group. Nullable — spawnContainer() in
 * container-runner.ts refuses to start a container until this is set for
 * the group's active model, so a model swap (e.g. Claude → a small local
 * Ollama model) can't silently blow past a smaller window before Claude
 * Code's own auto-compact ever triggers.
 */
export const migration020: Migration = {
  version: 20,
  name: 'container-config-context-window',
  up(db) {
    db.exec(`ALTER TABLE container_configs ADD COLUMN context_window INTEGER;`);
  },
};
