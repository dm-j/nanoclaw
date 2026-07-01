# Container Runtime (Apple Container)

This install uses Apple Container (`container` CLI), not Docker Desktop.

## Key Differences from Docker

- **No file bind mounts** — only directory mounts are supported
- **Host gateway** is vmnet bridge (`bridge100` / `192.168.64.1`), not `host.docker.internal`
- **Build memory**: OOM during `pnpm install` is common; set `CONTAINER_BUILD_MEMORY=8G` before running `./container/build.sh`

## File Mount Workaround (Staging Dir)

Files that need to appear at specific paths inside the container go through a staging dir:

1. `container-runner.ts` collects file mounts into `fileMounts[]` (separated from directory mounts)
2. `applyOneCLIContainerConfig(args, onecliConfig, fileMounts)` copies each file into a host temp dir with `fs.copyFileSync` + `fs.chmodSync` (chmod preserves execute bits)
3. The staging dir is bind-mounted as `/tmp/nanoclaw-stage/` (a directory — allowed)
4. `container/entrypoint.sh` runs as root, bind-mounts each staged file to its target path via python3, then drops to uid 1000 via `setpriv`

## Entrypoint

`container/entrypoint.sh` → runs as root → applies `NANOCLAW_STAGE_MOUNTS` bind mounts → `exec setpriv --reuid=1000 --regid=1000 --init-groups -- bun run /app/src/index.ts`

`util-linux` must be in the Dockerfile apt install (provides `setpriv`). No `USER node` line — the setpriv drop handles it.

## Stub Binaries (memsearch and future stubs)

Some host-side services are exposed to the container via stub scripts in `container/memsearch-stub/` (and similar dirs). The stub relays CLI calls to the host services proxy (`memsearch.internal/cli`) rather than running anything locally.

**The stub dir is mounted as a directory** (`/opt/nanoclaw-stubs/`) and PATH is explicitly set in `buildContainerArgs` to include it. This is necessary because:
- Apple Container can't file-mount the stub directly to `/usr/local/bin/memsearch`
- The staging dir workaround (for OneCLI credential files) is handled separately and isn't appropriate here

**Adding a new stub**: drop it in `container/memsearch-stub/`, make it `chmod +x`. It automatically lands in PATH on next container restart (no image rebuild needed).

## Bun vs Node Split

| Where | Runtime | Package manager |
|-------|---------|-----------------|
| Host (`src/`) | Node | pnpm |
| Container (`container/agent-runner/`) | Bun | bun (separate package tree) |

Never run `pnpm install` in `container/agent-runner/` — use `bun install`. Commit `bun.lock`.

## Runtime Detection

`src/container-runtime.ts` — set `CONTAINER_RUNTIME_BIN=container` (default). `detectHostGateway()` reads `bridge100`/`bridge0`, falls back to `192.168.64.1`.

## Rebuild

```bash
# Force clean (buildkit caches stale files across runs):
docker buildx prune   # or: container system prune
CONTAINER_BUILD_MEMORY=8G ./container/build.sh
```
