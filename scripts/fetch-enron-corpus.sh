#!/usr/bin/env bash
# Fetches the Enron email corpus used by scripts/canary-bench.ts as a source
# of real (non-synthetic) email bodies. Not committed to the repo — ~423MB,
# and data/ is gitignored — so this script is the "include" mechanism.
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/data/enron-corpus"
URL="https://www.cs.cmu.edu/~enron/enron_mail_20150507.tar.gz"

mkdir -p "$DIR"

if [ -d "$DIR/maildir" ]; then
  echo "Already extracted at $DIR/maildir"
  exit 0
fi

echo "Fetching Enron corpus to $DIR/enron.tar.gz (~423MB, resumable)..."
curl -L -C - "$URL" -o "$DIR/enron.tar.gz"

echo "Extracting..."
tar -xzf "$DIR/enron.tar.gz" -C "$DIR"

echo "Done: $DIR/maildir ($(ls "$DIR/maildir" | wc -l | tr -d ' ') mailboxes)"
