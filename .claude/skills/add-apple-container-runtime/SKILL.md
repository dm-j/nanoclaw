---
name: add-apple-container-runtime
description: Swap NanoClaw's container runtime from Docker to Apple's `container` CLI — macOS-native, no Docker Desktop dependency. Replaces src/container-runtime.ts, src/container-runner.ts, container/entrypoint.sh, and the relevant Dockerfile hunks (staging-dir file mounts, setpriv-based privilege drop). macOS only.
---

# Add Apple Container Runtime

Unlike most `add-*` skills, this one is a **patch**, not a pure addition — it replaces the Docker-specific implementation of three files wholesale rather than inserting a call. This is the acknowledged "patch behavior" archetype from [docs/skill-guidelines.md](../../../docs/skill-guidelines.md)'s testing section: the guard here is a behavior test of the changed behavior (does `container ls` actually get called, does a spawned agent container actually start), not a structural diff test.

Full rationale and gotchas: [.claude/orientation/runtime.md](../../../.claude/orientation/runtime.md) (also copied to this skill's `assets/runtime.md` for reference during apply).

**macOS only.** Apple's `container` CLI has no Linux equivalent — do not apply this on a Linux install.

**Dockerfile note:** if this fork also has `add-rtk` applied, the Dockerfile diff you'll see mixes both features (rtk adds a Rust builder stage; Apple Container adds `python3-minimal`/`util-linux` + a `setpriv`-based entrypoint). They don't conflict, but apply/diff carefully — see Phase 2.

## Phase 1: Pre-flight

```bash
uname -s | grep -q Darwin && echo "OK: macOS" || echo "STOP — Apple Container is macOS-only"
which container >/dev/null 2>&1 && container --version && echo "OK: Apple Container CLI installed" || echo "MISSING — install via: xcode-select --install (bundles container CLI on recent macOS), or see https://github.com/apple/container"
```

### Check if already applied

```bash
grep -q "CONTAINER_RUNTIME_BIN = 'container'" src/container-runtime.ts && echo "ALREADY APPLIED — skip to Phase 4"
```

## Phase 2: Apply code changes

### Copy the replacement files

```bash
S=.claude/skills/add-apple-container-runtime/assets
cp "$S/container-runtime.ts" src/container-runtime.ts
cp "$S/container-runner.ts"  src/container-runner.ts
cp "$S/entrypoint.sh"        container/entrypoint.sh
```

Alternative acquisition path (registry-branch style):

```bash
git fetch origin apple-container-runtime
git show origin/apple-container-runtime:src/container-runtime.ts > src/container-runtime.ts
git show origin/apple-container-runtime:src/container-runner.ts  > src/container-runner.ts
git show origin/apple-container-runtime:container/entrypoint.sh  > container/entrypoint.sh
```

If your fork's `container-runner.ts` has other local edits (unrelated to the runtime swap), diff instead of overwriting:

```bash
git show origin/apple-container-runtime:src/container-runner.ts > /tmp/reference-container-runner.ts
diff src/container-runner.ts /tmp/reference-container-runner.ts
```

### Edit the Dockerfile

Apple Container needs the file-mount staging-dir pattern (its bind-mount model differs from Docker's — see `assets/runtime.md` "Apple Container's file-mount model") plus a `setpriv`-based entrypoint so the container starts as root (to stage mounts) and drops to `node` before running the agent. Concretely, add:

1. `python3-minimal` and `util-linux` to the apt-get install block (staging-dir script + `setpriv`).
2. Replace the Docker-style `USER node` + setuid-stripping block with the `chmod 777 /home/node && chmod 777 /app` + root-stays-as-PID-1-for-entrypoint pattern — `entrypoint.sh` itself does the `setpriv` drop to `node`, not the Dockerfile's `USER` directive.

**If `add-rtk` is also applied or being applied around the same time**, its Dockerfile changes (a `rtk-builder` stage + `COPY --from=rtk-builder`) are independent of the above — apply both sets of hunks, neither depends on the other. Diff against the reference branch to see a fork that has both, if useful:

```bash
git show origin/apple-container-runtime:container/Dockerfile > /tmp/reference-dockerfile
diff container/Dockerfile /tmp/reference-dockerfile
```

### Rebuild the image

```bash
./container/build.sh
```

If a prior build is cached and something looks stale, prune the builder first (see CLAUDE.md "Container Build Cache").

## Phase 3: Wire

No per-agent-group config — this is a host-wide runtime swap, not an opt-in toggle. If any agent group's `container.json` has Docker-specific mount syntax, review it against `assets/runtime.md`'s file-mount section; Apple Container's mount model differs (bind-mounts vs. Docker volumes) and pre-existing mount configs may need adjusting.

## Phase 4: Build, validate, restart

```bash
pnpm run build
pnpm test -- src/container-runtime src/container-runner
```

Behavior check (this skill's actual guard, per the patch-behavior testing archetype — there's no meaningful structural test for "which runtime binary got called"):

```bash
container ls   # never `docker ps` — see CLAUDE.md Platform section
```

Restart the service so new sessions spawn through the new runtime:

```bash
source setup/lib/install-slug.sh
launchctl kickstart -k gui/$(id -u)/$(launchd_label)
```

## Phase 5: Verify

Tell the user:

> Send a message to any agent group. Then run `container ls` — you should see a running container for that group's session, not a Docker container.

```bash
container ls
tail -50 logs/nanoclaw.log | grep -i "container"
```

Common signals:
- `container: command not found` → Apple Container CLI isn't installed; Phase 1 pre-flight should have caught this.
- Container spawns but the agent never responds → check `entrypoint.sh` actually ran the `setpriv` drop correctly; a permissions error there fails silently from the host's view.
- Mount-related errors (`ENOENT`, permission denied inside container) → re-check `assets/runtime.md`'s file-mount section; Apple Container's staging-dir mechanism is not a drop-in Docker bind-mount replacement.

## Removal

See [REMOVE.md](REMOVE.md).

## Notes

- **This is a full runtime replacement, not an additive feature.** There is no "off switch" short of reverting the three files and the Dockerfile hunks back to Docker's version.
- **`container ls`, never `docker ps`** — `docker ps` silently reports nothing even when a container is genuinely live under this runtime. This is the single most common mistake when debugging an install with this skill applied.
- Host-gateway IP and networking differences from Docker are covered in `.claude/orientation/networking.md`, not duplicated here.

## Credits & references

- Full design/gotchas: [.claude/orientation/runtime.md](../../../.claude/orientation/runtime.md).
- Skill pattern: [docs/skill-phase-paradigm.md](../../../docs/skill-phase-paradigm.md).
