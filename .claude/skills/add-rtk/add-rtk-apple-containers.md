# Add rtk (Apple Container variant)

Not a standalone skill — read and execute this file's steps in place of `SKILL.md` when the runtime is Apple Container. See `.claude/orientation/runtime.md`: Apple Container has **no file bind mounts**, only directory mounts, so the single-file mount used by the Docker version of this skill will be rejected by the host (`Additional mount REJECTED` in `logs/nanoclaw.error.log`) and can hang the agent turn that triggers it.

Same goal as `SKILL.md`: install rtk on the host, expose it inside the target agent group's container, wire the `PreToolUse` hook. Only Step 3 (mounting) and the `docker` commands in Verify/Troubleshooting differ.

## Step 1 — Install rtk on the host

Same as `SKILL.md` Step 1.

```bash
curl -fsSL https://raw.githubusercontent.com/rtk-ai/rtk/refs/heads/master/install.sh | sh
~/.local/bin/rtk --version
chmod +x ~/.local/bin/rtk   # if needed
```

## Step 2 — Identify the target agent group

Same as `SKILL.md` Step 2.

```bash
ncl groups list
```

## Step 3 — Mount `~/.local/bin` as a directory

Apple Container can't bind-mount `~/.local/bin/rtk` straight to `/usr/local/bin/rtk` — that's a file mount, and only directory mounts are supported. No new stub dir is needed though: check `~/.config/nanoclaw/mount-allowlist.json` first — this install already has `~/.local/bin` allowlisted (`"description": "Host CLI tools (rtk, etc.)"`), read-only, precisely for this purpose. If your install's allowlist doesn't have that entry yet, add it via the `manage-mounts` skill before continuing.

Read current mounts:

```bash
pnpm exec tsx scripts/q.ts data/v2.db \
  "SELECT additional_mounts FROM container_configs WHERE agent_group_id = '<group-id>'"
```

Merge in a **directory** mount entry pointing at `~/.local/bin` itself (drop any prior `/opt/nanoclaw-host-bin` entry first, so re-running replaces rather than duplicates):

```json
{"hostPath":"/home/<user>/.local/bin","containerPath":"/opt/nanoclaw-host-bin","readonly":true}
```

Write it back:

```bash
pnpm exec tsx scripts/q.ts data/v2.db \
  "UPDATE container_configs SET additional_mounts = '<merged-json>' WHERE agent_group_id = '<group-id>'"
```

rtk will be reachable inside the container at `/opt/nanoclaw-host-bin/rtk`.

## Step 4 — Add the PreToolUse hook to settings.json, using the full path

Container `PATH` is hardcoded in `src/container-runner.ts` (`buildContainerArgs`) and does **not** pick up arbitrary `additional_mounts` directories — only `/opt/nanoclaw-stubs` (memsearch) is wired onto it. Rather than patch that hardcoded PATH, just call rtk by its full mounted path in the hook command:

```bash
SETTINGS="data/v2-sessions/<group-id>/.claude-shared/settings.json"

jq '.hooks.PreToolUse = ((.hooks.PreToolUse // [])
      | map(select((.hooks // []) | any(.command == "/opt/nanoclaw-host-bin/rtk hook claude") | not)))
    + [{"matcher":"Bash","hooks":[{"type":"command","command":"/opt/nanoclaw-host-bin/rtk hook claude"}]}]' \
  "$SETTINGS" > /tmp/rtk-settings.json && mv /tmp/rtk-settings.json "$SETTINGS"
```

## Step 5 — Restart the container

```bash
ncl groups restart --id <group-id>
```

## Step 6 — Check for a glibc mismatch

The mounted binary is host-built and Linux arm64, but it may still be linked against a newer glibc than the container's base image ships. Confirm it actually runs before relying on it:

```bash
container exec "$(container ls -a 2>/dev/null | grep "<group-id>" | awk '{print $1}')" /opt/nanoclaw-host-bin/rtk --version
```

- **Prints a version cleanly** → continue to Verify below.
- **`Exec format error` or `GLIBC_2.XX' not found`** → this is a known incompatibility, not a config mistake. Stop here, read and execute `.claude/skills/add-rtk/add-rtk-glibc-incompatible.md`, then return to this file — that recovery bakes rtk into the image instead of mounting it, which supersedes Steps 3–6 above.

## Verify

Use the `container` CLI, not `docker` — this runtime doesn't run Docker Desktop:

```bash
container exec "$(container ls -a 2>/dev/null | grep "<group-id>" | awk '{print $1}')" /opt/nanoclaw-host-bin/rtk --version
```

Then ask the agent to run `git status` or any other supported command. rtk intercepts it silently. Check savings with:

```bash
~/.local/bin/rtk gain
```

## Troubleshooting

### `rtk: command not found` / `/opt/nanoclaw-host-bin/rtk: No such file` inside the container

Mount wasn't applied or container wasn't restarted:

```bash
pnpm exec tsx scripts/q.ts data/v2.db \
  "SELECT additional_mounts FROM container_configs WHERE agent_group_id = '<group-id>'"
# Look for the /opt/nanoclaw-host-bin directory entry
ncl groups restart --id <group-id>
```

### `Additional mount REJECTED` in logs/nanoclaw.error.log

The `hostPath` isn't under an allowed mount root. Confirm `~/.local/bin` is present in `~/.config/nanoclaw/mount-allowlist.json` (see `manage-mounts` skill to add it) and restart.

### Hook not firing

Verify the hook is in `settings.json`:

```bash
jq '.hooks.PreToolUse' data/v2-sessions/<group-id>/.claude-shared/settings.json
```

If missing, re-run Step 4.

### Binary won't execute — permission denied

```bash
chmod +x ~/.local/bin/rtk
```
