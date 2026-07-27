# Remove Message Export

Idempotent — safe to run even if some steps were never applied.

**Check for a downstream consumer first.** If `add-vault-transcript-pipeline` is applied, its vault-side `assemble-transcript` script reads this skill's `inbox/` output as its sole source of truth (see [docs/vault-memory-pipeline.md](../../../docs/vault-memory-pipeline.md)). Removing this skill without also removing or updating that pipeline leaves it silently assembling empty transcripts.

## 1. Remove the Stop hook

```bash
SETTINGS="data/v2-sessions/<group-id>/.claude-shared/settings.json"

jq '.hooks.Stop = ((.hooks.Stop // [])
      | map(select((.hooks // []) | any(.command == "python3 /workspace/.hooks/message-export/export-turn.py") | not)))' \
  "$SETTINGS" > /tmp/msg-export-remove.json && mv /tmp/msg-export-remove.json "$SETTINGS"
```

## 2. Remove the mount

Read current mounts, drop the entry with `containerPath` `/workspace/.hooks/message-export`, write back:

```bash
pnpm exec tsx scripts/q.ts data/v2.db \
  "SELECT additional_mounts FROM container_configs WHERE agent_group_id = '<group-id>'"

# Edit the JSON to remove the message-export entry, then:
pnpm exec tsx scripts/q.ts data/v2.db \
  "UPDATE container_configs SET additional_mounts = '<filtered-json>' \
   WHERE agent_group_id = '<group-id>'"
```

## 3. Remove env vars (optional)

```bash
ncl groups config update --id <group-id> \
  --unset-env AGENT_NAME \
  --unset-env USER_DISPLAY_NAME \
  --unset-env USER_SLUG
```

## 4. Restart

```bash
ncl groups restart --id <group-id>
```

## 5. Clean up workspace files (optional)

Inbox and session files remain in the workspace after removal.
Delete only if you no longer need the history:

```bash
# Host-side path — confirm before deleting
rm -rf data/v2-sessions/<group-id>/workspace/inbox/
rm -rf data/v2-sessions/<group-id>/workspace/sessions/
```
