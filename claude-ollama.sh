#!/usr/bin/env bash
# Start Claude Code using Ollama (kimi-k2.7:cloud) — fallback when Anthropic token budget is exhausted.
set -euo pipefail

cd "$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"

git add -A
git commit -m "wip: checkpoint before switching to Ollama" || true
git push || true

exec env \
  ANTHROPIC_BASE_URL=http://localhost:11434 \
  ANTHROPIC_API_KEY=ollama \
  claude --model kimi-k2.7:cloud "$@"
