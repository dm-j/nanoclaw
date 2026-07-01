#!/bin/bash
# Preserve Lumen's context, lower compaction threshold, force compaction.
# Intended to run once at 2am Chicago time.

set -e
cd "$(dirname "$0")/.."

JSONL="data/v2-sessions/ag-1781738004490-2axf9a/.claude-shared/projects/-workspace-agent/7e3d2cf3-bb98-422a-8d2a-3ccce9e134cf.jsonl"
SETTINGS="data/v2-sessions/ag-1781738004490-2axf9a/.claude-shared/settings.json"
BACKUP_DIR="data/v2-sessions/ag-1781738004490-2axf9a/.claude-shared/context-backups"

mkdir -p "$BACKUP_DIR"

# 1. Preserve current context
STAMP=$(date -u '+%Y-%m-%dT%H%M%SZ')
BACKUP="$BACKUP_DIR/${STAMP}-context.jsonl"
cp "$JSONL" "$BACKUP"
echo "[lumen-compact] Context preserved → $BACKUP ($(wc -l < "$BACKUP") lines, $(du -h "$BACKUP" | cut -f1))"

# 2. Lower autoCompactThreshold
jq '. + {"autoCompactThreshold": 0.5}' "$SETTINGS" > /tmp/lumen-settings.json \
  && mv /tmp/lumen-settings.json "$SETTINGS"
echo "[lumen-compact] autoCompactThreshold set to 0.5"

# 3. Force compaction via inbound DB on_wake message
SESSION_DB=$(ls data/v2-sessions/ag-1781738004490-2axf9a/*/inbound.db 2>/dev/null | head -1)
if [ -z "$SESSION_DB" ]; then
  echo "[lumen-compact] No active session DB found — compaction message not sent" >&2
else
  SEQ=$(node -e "
    const Database = require('better-sqlite3');
    const db = new Database('$SESSION_DB');
    const row = db.prepare('SELECT MAX(seq) as m FROM messages_in').get();
    // Host uses even seq numbers
    const next = ((row.m ?? -1) + 2);
    console.log(next % 2 === 0 ? next : next + 1);
    db.close();
  " 2>/dev/null || echo "")

  if [ -n "$SEQ" ]; then
    node -e "
      const Database = require('better-sqlite3');
      const db = new Database('$SESSION_DB');
      const id = 'compact-' + Date.now();
      const ts = new Date().toISOString();
      db.prepare(\`INSERT INTO messages_in (id, seq, kind, timestamp, content, on_wake)
                  VALUES (?, ?, 'chat', ?, '/compact', 1)\`)
        .run(id, $SEQ, ts);
      db.close();
      console.log('[lumen-compact] /compact written to inbound DB as on_wake message (seq=$SEQ)');
    " || echo "[lumen-compact] Failed to write /compact to inbound DB" >&2
  fi
fi

echo "[lumen-compact] Done at $(date)"

# One-shot: remove this crontab entry after running
( crontab -l 2>/dev/null | grep -v 'lumen-compact.sh' ) | crontab -
echo "[lumen-compact] Crontab entry removed"
