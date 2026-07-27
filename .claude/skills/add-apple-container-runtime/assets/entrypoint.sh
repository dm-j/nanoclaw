#!/bin/bash
# NanoClaw agent container entrypoint.
#
# Starts as root so it can bind-mount individual files from the staging dir
# (Apple Container only supports directory bind mounts, not file mounts).
# After staging mounts are applied, drops to the node user via setpriv.
#
# NANOCLAW_STAGE_MOUNTS — JSON array of {source, target} pairs to bind-mount
# from /tmp/nanoclaw-stage/ to their target paths inside the container.
# Only processed when running as root (Apple Container path).

set -e

# Apply staging bind mounts if provided (Apple Container: files arrive via dir
# mount at /tmp/nanoclaw-stage/; bind-mount each to its expected container path).
if [ "$(id -u)" = "0" ] && [ -n "$NANOCLAW_STAGE_MOUNTS" ]; then
  echo "$NANOCLAW_STAGE_MOUNTS" | python3 -c "
import sys, json, os, subprocess
mounts = json.load(sys.stdin)
for m in mounts:
    target = m['target']
    os.makedirs(os.path.dirname(target), exist_ok=True)
    if not os.path.exists(target):
        open(target, 'w').close()
    subprocess.run(['mount', '--bind', m['source'], target], check=True)
"
fi

cat > /tmp/input.json

# Auto-generate CLI wrappers for any .ts tools in the mounted source
for f in /app/src/tools/*.ts; do
  [ -f "$f" ] || continue
  name=$(basename "$f" .ts)
  printf '#!/bin/sh\nexec bun "%s" "$@"\n' "$f" > "/usr/local/bin/$name"
  chmod +x "/usr/local/bin/$name"
done

# Link shell scripts from tools folder directly onto PATH
for f in /app/src/tools/*; do
  [ -f "$f" ] && [ -x "$f" ] && [ "${f##*.}" != "ts" ] && [ "${f##*.}" != "md" ] || continue
  cp "$f" "/usr/local/bin/$(basename "$f")"
done

# Drop to node user if running as root (Apple Container path).
# setpriv replaces the root process with bun running as uid/gid 1000 (node).
if [ "$(id -u)" = "0" ]; then
  exec setpriv --reuid=1000 --regid=1000 --init-groups -- \
    bun run /app/src/index.ts < /tmp/input.json
fi

exec bun run /app/src/index.ts < /tmp/input.json
