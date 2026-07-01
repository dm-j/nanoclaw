#!/bin/bash
# PreCompact hook: extract gotchas from the session transcript before compaction.
#
# Claude Code passes a JSON payload on stdin with (at minimum) transcript_path.
# This script feeds recent transcript content to Haiku, which compares it against
# existing orientation files and returns any new gotchas to append.
# Always exits 0 — compaction is never blocked.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
ORIENTATION_DIR="$PROJECT_ROOT/.claude/orientation"
SCRATCH=$(mktemp -d)
trap 'rm -rf "$SCRATCH"' EXIT

# --- 1. Find the transcript ---------------------------------------------------

STDIN=$(cat)
TRANSCRIPT=$(echo "$STDIN" | python3 -c \
  "import sys,json; d=json.load(sys.stdin); print(d.get('transcript_path',''))" \
  2>/dev/null || true)

if [ -z "$TRANSCRIPT" ] || [ ! -f "$TRANSCRIPT" ]; then
  # Fall back: most recently modified JSONL for this project's sanitised CWD.
  # Sanitisation: replace / with - (matching Claude Code's own convention).
  SANITISED=$(echo "$PROJECT_ROOT" | sed 's|/|-|g')
  TRANSCRIPT=$(ls -t "$HOME/.claude/projects/${SANITISED}/"*.jsonl 2>/dev/null | head -1)
fi

if [ -z "$TRANSCRIPT" ] || [ ! -f "$TRANSCRIPT" ]; then
  echo "precompact-gotcha: no transcript found, skipping" >&2
  exit 0
fi

# --- 2. Collect existing orientation content ----------------------------------

if [ ! -d "$ORIENTATION_DIR" ]; then
  echo "precompact-gotcha: orientation dir not found at $ORIENTATION_DIR, skipping" >&2
  exit 0
fi

# Concatenate all .md files in the orientation dir (except index.md — it's the table of contents)
find "$ORIENTATION_DIR" -maxdepth 1 -name "*.md" ! -name "index.md" \
  | sort | xargs cat 2>/dev/null > "$SCRATCH/existing.md" || true

# --- 3. Build the prompt ------------------------------------------------------

cat > "$SCRATCH/prompt.txt" <<'PROMPT'
You are reviewing a Claude Code session transcript. Your job: extract NEW "gotchas" — things that burned the developer, corrected wrong assumptions, or had to be looked up repeatedly — and suggest additions to the project's orientation files.

A gotcha is:
- Something that surprised the developer or went differently than expected
- A correction to what trained intuition would suggest
- Something that came up more than once and had to be re-derived

A gotcha is NOT:
- General documentation or how-things-work explanations
- Things already in the existing orientation content below
- Obvious things any developer would know

EXISTING ORIENTATION CONTENT (do not repeat anything already here):
PROMPT

cat "$SCRATCH/existing.md" >> "$SCRATCH/prompt.txt"

cat >> "$SCRATCH/prompt.txt" <<'PROMPT'

SESSION TRANSCRIPT (recent portion, JSONL — assistant entries contain tool calls and reasoning):
PROMPT

# Last 3000 lines covers a typical session without blowing context
tail -3000 "$TRANSCRIPT" >> "$SCRATCH/prompt.txt"

cat >> "$SCRATCH/prompt.txt" <<'PROMPT'

Respond with a JSON object. The keys are the basenames (without .md) of the orientation files you want to append to. Use only files that already exist (listed in EXISTING ORIENTATION CONTENT above). Values are markdown strings to append, or empty string if nothing new for that file.

Also include a "summary" key: one sentence describing what was added, or "nothing new" if all values are empty.

Example shape (adapt keys to match actual orientation files):
{
  "gotchas": "- Foo: turns out bar, not baz\n- Widget init must happen before quux or it silently fails",
  "summary": "Added two gotchas: foo/bar confusion and widget init ordering"
}

Output ONLY the JSON object. No markdown fences, no other text.
PROMPT

# --- 4. Call Haiku ------------------------------------------------------------

if ! command -v claude &>/dev/null; then
  echo "precompact-gotcha: claude CLI not found, skipping" >&2
  exit 0
fi

claude --model claude-haiku-4-5-20251001 -p "$(cat "$SCRATCH/prompt.txt")" \
  > "$SCRATCH/response.json" 2>/dev/null || true

if [ ! -s "$SCRATCH/response.json" ]; then
  echo "precompact-gotcha: no response from Haiku, skipping" >&2
  exit 0
fi

# --- 5. Append new content to orientation files -------------------------------

python3 - "$SCRATCH/response.json" "$ORIENTATION_DIR" <<'PYEOF'
import json, sys, os

response_file, orientation = sys.argv[1], sys.argv[2]

try:
    with open(response_file) as f:
        raw = f.read().strip()
    # Strip markdown fences if Haiku added them despite instructions
    if raw.startswith("```"):
        raw = "\n".join(raw.splitlines()[1:])
    if raw.endswith("```"):
        raw = "\n".join(raw.splitlines()[:-1])
    data = json.loads(raw)
except Exception as e:
    print(f"precompact-gotcha: JSON parse error: {e}", file=sys.stderr)
    sys.exit(0)

added = []
for key, content in data.items():
    if key == "summary":
        continue
    if not isinstance(content, str) or not content.strip():
        continue
    path = os.path.join(orientation, f"{key}.md")
    if not os.path.exists(path):
        continue  # only append to files that exist
    with open(path, "a") as f:
        f.write("\n\n" + content.strip())
    added.append(key)

summary = data.get("summary", "")
if added:
    print(f"precompact-gotcha: updated {', '.join(added)} — {summary}")
else:
    print(f"precompact-gotcha: {summary or 'no new gotchas found'}")
PYEOF

exit 0
