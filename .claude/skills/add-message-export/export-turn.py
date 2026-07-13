#!/usr/bin/env python3
"""
Stop hook: export each completed conversation turn to two places:
  1. WORKSPACE/inbox/  — per-message markdown files (transient; consumed by MBIF triage)
  2. WORKSPACE/sessions/ — per-session running log (persistent IR for compaction)

Reads the Claude Code hook JSON payload from stdin (provides transcript_path).
Tracks last-exported position via sessions/.last-exported-uuid to avoid duplicates.

Configuration via environment variables:
  AGENT_NAME          Display name of the agent      (default: Lumen)
  USER_DISPLAY_NAME   Display name of the human user (default: David)
  USER_SLUG           Filename slug for the user     (default: david)
  WORKSPACE_DIR       Base workspace path            (default: /workspace/agent)
"""
import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------
workspace    = Path(os.environ.get('WORKSPACE_DIR', '/workspace/agent'))
inbox_dir    = workspace / 'inbox'
sessions_dir = workspace / 'sessions'
marker_file  = sessions_dir / '.last-exported-uuid'

agent_name = os.environ.get('AGENT_NAME', 'Lumen')
user_name  = os.environ.get('USER_DISPLAY_NAME', 'David')
user_slug  = os.environ.get('USER_SLUG', 'david')
user_tz    = ZoneInfo(os.environ.get('USER_TIMEZONE', 'America/Chicago'))
agent_slug = agent_name.lower()

inbox_dir.mkdir(parents=True, exist_ok=True)
sessions_dir.mkdir(parents=True, exist_ok=True)

# ---------------------------------------------------------------------------
# Find transcript
# ---------------------------------------------------------------------------
try:
    payload = json.loads(sys.stdin.read())
except Exception:
    payload = {}

transcript_path = payload.get('transcript_path', '')
if not transcript_path or not Path(transcript_path).exists():
    sys.exit(0)

# ---------------------------------------------------------------------------
# Parse JSONL — collect all records, extract messages since last export
# ---------------------------------------------------------------------------
last_uuid = marker_file.read_text().strip() if marker_file.exists() else None

records = []
for line in Path(transcript_path).read_text(errors='ignore').splitlines():
    try:
        records.append(json.loads(line))
    except Exception:
        continue

session_id       = None
session_start_ts = None
found_start      = (last_uuid is None)
last_seen_uuid   = last_uuid
new_messages     = []

for rec in records:
    if session_id is None:
        session_id = rec.get('sessionId') or rec.get('session_id')

    # Compact boundary resets the export cursor (pre-compaction content is gone)
    if rec.get('type') == 'system' and rec.get('subtype') == 'compact_boundary':
        found_start = True
        last_uuid   = None
        continue

    msg  = rec.get('message', {})
    role = msg.get('role')
    if role not in ('user', 'assistant'):
        continue

    rec_uuid = rec.get('uuid', '')
    ts       = rec.get('timestamp')

    if session_start_ts is None and ts:
        session_start_ts = ts

    if not found_start:
        if rec_uuid == last_uuid:
            found_start = True
        continue

    # Extract plain text only — skip tool_use / tool_result / thinking blocks
    text_parts = []
    content = msg.get('content', '')
    if isinstance(content, str):
        text_parts.append(content)
    elif isinstance(content, list):
        for block in content:
            if isinstance(block, str):
                text_parts.append(block)
            elif isinstance(block, dict) and block.get('type') == 'text':
                t = block.get('text', '').strip()
                if t:
                    text_parts.append(t)

    text = '\n\n'.join(text_parts).strip()

    # Skip empty messages and injected compaction summaries
    if not text:
        continue
    if text.startswith('This session is being continued from a previous conversation'):
        continue

    new_messages.append({
        'uuid':       rec_uuid,
        'role':       role,
        'text':       text,
        'timestamp':  ts or datetime.now(timezone.utc).isoformat(),
        'session_id': session_id or 'unknown',
    })
    last_seen_uuid = rec_uuid

if not new_messages:
    sys.exit(0)

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
def parse_ts(ts: str):
    try:
        return datetime.fromisoformat(ts.replace('Z', '+00:00'))
    except Exception:
        return datetime.now(timezone.utc)

def ts_slug(ts: str) -> str:
    return parse_ts(ts).strftime('%Y-%m-%dT%H%M%SZ')

def ts_display(ts: str) -> str:
    return parse_ts(ts).strftime('%Y-%m-%dT%H:%M:%SZ')

def speaker(role: str) -> str:
    return agent_name if role == 'assistant' else user_name

def slug(role: str) -> str:
    return agent_slug if role == 'assistant' else user_slug

def ts_local(ts: str) -> str:
    """Local time + UTC offset, e.g. '2026-07-12T12:43:18-05:00' — human-facing header timestamp."""
    return parse_ts(ts).astimezone(user_tz).isoformat(timespec='seconds')

# ---------------------------------------------------------------------------
# Resolve session log file
# ---------------------------------------------------------------------------
sid_short = (session_id or 'unknown')[:8]
existing  = list(sessions_dir.glob(f'*{sid_short}*.md'))

if existing:
    session_file = existing[0]
else:
    start_slug   = ts_slug(session_start_ts) if session_start_ts else \
                   datetime.now(timezone.utc).strftime('%Y-%m-%dT%H%M%SZ')
    session_file = sessions_dir / f'{start_slug}-{sid_short}.md'
    session_file.write_text(
        f'---\nsession_id: {session_id}\nstarted: {session_start_ts}\n---\n\n'
    )

# ---------------------------------------------------------------------------
# Write inbox files + accumulate session log entries
# ---------------------------------------------------------------------------
log_entries = []

for msg in new_messages:
    spk  = speaker(msg['role'])
    slg  = slug(msg['role'])
    tsd  = ts_display(msg['timestamp'])
    tss  = ts_slug(msg['timestamp'])

    # Inbox: one file per message, consumed by MBIF triage
    inbox_file = inbox_dir / f'{tss}-{slg}.md'
    inbox_file.write_text(
        f'---\n'
        f'timestamp: {tsd}\n'
        f'speaker: {slg}\n'
        f'display_name: {spk}\n'
        f'session_id: {msg["session_id"]}\n'
        f'uuid: {msg["uuid"]}\n'
        f'---\n\n'
        f'{msg["text"]}\n'
    )

    # Session log: lightweight IR entry
    log_entries.append(f'## {spk} — {ts_local(msg["timestamp"])}\n{msg["text"]}')

# Append all entries to session log in one write
with open(session_file, 'a') as f:
    f.write('\n' + '\n\n'.join(log_entries) + '\n')

# Update export cursor
if last_seen_uuid:
    marker_file.write_text(last_seen_uuid)

print(f'export-turn: {len(new_messages)} message(s) → inbox + {session_file.name}')
