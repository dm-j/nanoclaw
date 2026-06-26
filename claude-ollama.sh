#!/usr/bin/env bash
# Start Claude Code using Ollama (kimi-k2.7:cloud) — fallback when Anthropic token budget is exhausted.
exec env \
  ANTHROPIC_BASE_URL=http://localhost:11434 \
  ANTHROPIC_API_KEY=ollama \
  claude --model kimi-k2.7:cloud "$@"
