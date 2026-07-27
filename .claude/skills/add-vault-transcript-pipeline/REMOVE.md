# Remove Vault Transcript Pipeline

Reverses [SKILL.md](SKILL.md). Runs against the vault, not this repo.

## 1. Remove cron entries

```bash
V="${MBIF_VAULT_PATH:?set MBIF_VAULT_PATH first}"
crontab -l 2>/dev/null | grep -v "$V/Meta/scripts/assemble-transcript" | crontab -
crontab -l | grep -c assemble-transcript   # expect 0
```

Remove the corresponding rows from the vault's own `Meta/scheduled-jobs.md` inventory.

## 2. Delete the installed scripts

```bash
rm -f "$V/Meta/scripts/assemble-transcript" "$V/Meta/scripts/memsearch-to-transcript"
```

Leave `$V/07-Daily/Transcripts-readonly/` and `Digests-readonly/` alone — those are accumulated vault content, not something this skill owns.

## 3. Remove the bootstrap doc

```bash
rm -f "$V/Meta/nanoclaw-integration.md"
```

## 4. Note the downstream effect

Once removed, `add-message-export`'s `inbox/` output will accumulate with nothing consuming it into `07-Daily/Transcripts-readonly/`, which means `digester` has nothing new to process either. If the intent is only to stop the vault-side assembly (not the whole memory pipeline), confirm that's actually what's wanted before removing — this breaks the transcript half of `docs/vault-memory-pipeline.md`'s loop, not just this skill's own footprint.
