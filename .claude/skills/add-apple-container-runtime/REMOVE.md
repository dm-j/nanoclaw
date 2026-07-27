# Remove Apple Container Runtime

Reverts to Docker. This is a full runtime swap back, not a toggle — every running container must be recreated under the other runtime.

## 1. Revert the three files

```bash
git show upstream/main:src/container-runtime.ts > src/container-runtime.ts
git show upstream/main:src/container-runner.ts  > src/container-runner.ts
git show upstream/main:container/entrypoint.sh  > container/entrypoint.sh
```

If your fork's versions of these files have other local changes layered on top of the Apple Container swap, diff against upstream instead of overwriting, and hand-remove only the Apple-Container-specific hunks (staging-dir mount logic, `setpriv` drop, `CONTAINER_RUNTIME_BIN` binary name).

## 2. Revert the Dockerfile hunks

Remove `python3-minimal`/`util-linux` from the apt-get block and the `setpriv`-based entrypoint changes, restoring the Docker-style `USER node` + setuid-stripping block. Leave any `add-rtk` Dockerfile hunks alone if that skill is still applied — they're independent.

## 3. Rebuild and restart

```bash
./container/build.sh
pnpm run build
source setup/lib/install-slug.sh
launchctl kickstart -k gui/$(id -u)/$(launchd_label)   # macOS
systemctl --user restart $(systemd_unit)               # Linux
```

## 4. Clean up orphaned Apple containers

```bash
container ls
container stop <name>   # for any still running
```

Docker won't see these — they're a different runtime's containers and need cleaning up through `container`, not `docker`, even after this skill is removed.
