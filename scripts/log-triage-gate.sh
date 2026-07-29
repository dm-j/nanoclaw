#!/usr/bin/env bash
# Pre-task gate for the daily "log triage" ncl task (agent group: Lumen).
# Rotates NanoClaw host logs + the Obsidian vault's cron-job logs once a day
# (copytruncate -- safe for the long-lived launchd-redirected nanoclaw.log/
# .error.log since launchd opens them O_APPEND, and trivially safe for the
# short-lived vault cron logs), greps the day's slice for WARN/ERROR-level
# (NanoClaw) or failure-shaped (vault, unleveled prose) lines, and checks
# recent cron mail -- the librarian --agent bug on 2026-07-27 produced NO
# log-file trace at all, only a cron mail, so that mailbox is load-bearing
# here too. Wakes the agent only if it found something; a clean run costs
# zero tokens.
set -euo pipefail

NANOCLAW_LOGS="/Users/lumen/Projects/nanoclaw/logs"
VAULT_LOGS="/Users/lumen/Projects/obsidian/lumen-data/lumen-data/Meta/scripts/logs"
MAILBOX="/var/mail/lumen"
TODAY="$(date +%Y-%m-%d)"
RETENTION_DAYS=13

strip_ansi() { sed -E 's/\x1b\[[0-9;]*m//g'; }

# Copytruncate one log file: archive today's slice, truncate in place (same
# inode -- an O_APPEND writer just keeps appending from the new offset 0),
# then prune archives older than RETENTION_DAYS.
rotate() {
  local file="$1"
  [ -s "$file" ] || return 0
  local base dir archive
  dir="$(dirname "$file")"
  base="$(basename "${file%.log}")"
  archive="$dir/${base}-${TODAY}.log"
  [ -f "$archive" ] && return 0
  cp "$file" "$archive"
  : > "$file"
  find "$dir" -maxdepth 1 -name "${base}-*.log" -mtime "+${RETENTION_DAYS}" -delete
}

collect() {
  # $1 = grep -aiE pattern, remaining args = files to scan
  local pattern="$1"; shift
  for f in "$@"; do
    [ -f "$f" ] || continue
    strip_ansi < "$f" | grep -aiE "$pattern" || true
  done
}

sample() { printf '%s\n' "$1" | grep . | head -5 | cut -c1-200; }
count() { printf '%s\n' "$1" | grep -c . || true; }

# --- NanoClaw host logs (pino, colorized) ---
nc_files=("$NANOCLAW_LOGS/nanoclaw.log" "$NANOCLAW_LOGS/nanoclaw.error.log")
nc_hits="$(collect '\bWARN\b|\bERROR\b' "${nc_files[@]}")"

# --- Vault cron-job logs (plain agent prose, no levels -- keyword grep).
# Exclude already-rotated dated archives so they don't get re-scanned forever.
vault_files=()
if [ -d "$VAULT_LOGS" ]; then
  while IFS= read -r f; do vault_files+=("$f"); done < <(
    find "$VAULT_LOGS" -maxdepth 1 -name '*.log' \
      ! -name '*-[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9].log'
  )
fi
vault_hits=""
[ "${#vault_files[@]}" -gt 0 ] && vault_hits="$(collect 'error|fail(ed|s)?|not found|denied|fatal|broken|corrupt' "${vault_files[@]}")"

# --- cron mail (mbox). No reliable per-run 24h date parsing here (mbox Date
# headers are cheap to get wrong); this task fires daily, so scanning the
# whole mailbox for known failure shapes each run and relying on daily cadence
# is close enough and far less fragile.
mail_hits=""
[ -r "$MAILBOX" ] && mail_hits="$(grep -aE 'not found|Permission denied|fatal:|Errno|Traceback' "$MAILBOX" 2>/dev/null || true)"

# Rotate after reading, so today's read covers the full slice since last rotation.
for f in "${nc_files[@]}" "${vault_files[@]}"; do rotate "$f"; done

n_nc="$(count "$nc_hits")"
n_vault="$(count "$vault_hits")"
n_mail="$(count "$mail_hits")"
total=$((n_nc + n_vault + n_mail))

if [ "$total" -eq 0 ]; then
  echo '{"wakeAgent": false}'
  exit 0
fi

jq -n \
  --arg nc_count "$n_nc" --arg vault_count "$n_vault" --arg mail_count "$n_mail" \
  --arg nc_sample "$(sample "$nc_hits")" \
  --arg vault_sample "$(sample "$vault_hits")" \
  --arg mail_sample "$(sample "$mail_hits")" \
  '{wakeAgent: true, data: {
      nanoclaw_warn_error: {count: ($nc_count|tonumber), sample: $nc_sample},
      vault_logs: {count: ($vault_count|tonumber), sample: $vault_sample},
      cron_mail: {count: ($mail_count|tonumber), sample: $mail_sample}
    }}'
