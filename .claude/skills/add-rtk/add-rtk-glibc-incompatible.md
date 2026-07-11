# rtk glibc mismatch — recovery

Not a standalone skill — read and execute this file's steps when the glibc check in `SKILL.md` or `add-rtk-apple-containers.md` fails, then return to whichever file sent you here.

## Why this happens

rtk's only Linux arm64 release (`rtk-aarch64-unknown-linux-gnu.tar.gz`) is dynamically linked against a glibc newer than many container base images ship (e.g. Debian 12/bookworm has glibc 2.36; that rtk build has needed 2.39+). There is no arm64 musl (statically-linked) release to fall back to. A mismatch shows up as either:

- `Exec format error` — wrong OS/arch entirely (e.g. a macOS binary mounted into a Linux container — check you didn't accidentally point at the host's `~/.local/bin/rtk` on macOS)
- `` `/usr/local/bin/rtk: /lib/.../libc.so.6: version 'GLIBC_2.XX' not found` `` — right arch, base image's glibc is older than the binary needs

Neither is fixable by mounting a different prebuilt binary — none exists for this combination. The binary must be compiled from source against the container's own base image.

## Recovery: compile rtk from source into the image

Add a multi-stage build step to `container/Dockerfile`: a temporary `rust:1-slim-bookworm` builder stage compiles rtk from source (matching the final image's glibc exactly since both are Debian bookworm-based), then the final stage copies out just the binary. No mount, no `additional_mounts` entry, no allowlist change, no host-side stub directory — rtk ships baked into the image like any other CLI tool.

### Step 1 — Undo any mount-based rtk wiring already in place

If a prior attempt added an `additional_mounts` entry or allowlist root for rtk, remove them — they're unnecessary once rtk is baked in and one of them (a stray `containerPath: /usr/local/bin/rtk` entry) will otherwise shadow the baked-in binary.

```bash
pnpm exec tsx scripts/q.ts data/v2.db \
  "SELECT additional_mounts FROM container_configs WHERE agent_group_id = '<group-id>'"
# Manually drop any entry whose containerPath references rtk, keep the rest,
# then write the merged array back:
pnpm exec tsx scripts/q.ts data/v2.db \
  "UPDATE container_configs SET additional_mounts = '<merged-json>' WHERE agent_group_id = '<group-id>'"
```

Check `~/.config/nanoclaw/mount-allowlist.json` for any root added solely for rtk (e.g. a `container/rtk-stub` entry) and remove it — leave a pre-existing `~/.local/bin` entry alone if other tools rely on it.

### Step 2 — Add the builder stage to `container/Dockerfile`

Insert before the main `FROM node:22-slim` line:

```dockerfile
# ---- rtk builder --------------------------------------------------------------
# rtk ships no linux-arm64 build compatible with this base image's glibc.
# Compile from source against this exact base so the binary always matches.
FROM rust:1-slim-bookworm AS rtk-builder
ARG RTK_VERSION=0.43.0
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*
RUN curl -fsSL "https://github.com/rtk-ai/rtk/archive/refs/tags/v${RTK_VERSION}.tar.gz" -o /tmp/rtk-src.tar.gz \
    && mkdir /build && tar xzf /tmp/rtk-src.tar.gz -C /build --strip-components=1 \
    && cd /build && cargo build --release --locked
```

Pin `RTK_VERSION` to the version installed on the host (`rtk --version`), or check the latest tag at `https://github.com/rtk-ai/rtk/releases` — bump deliberately, don't leave it floating.

Then, somewhere after `WORKDIR /app` in the main stage (near the other global-tool installs is fine):

```dockerfile
# ---- rtk (token-compression proxy) --------------------------------------------
COPY --from=rtk-builder /build/target/release/rtk /usr/local/bin/rtk
```

### Step 3 — Rebuild and restart

```bash
CONTAINER_BUILD_MEMORY=8G ./container/build.sh
ncl groups restart --id <group-id>
```

### Step 4 — Verify

```bash
container exec "$(container ls -a 2>/dev/null | grep "<group-id>" | awk '{print $1}')" rtk --version
```

If this prints a version cleanly, rtk is resolved on `PATH` at its normal location — the `PreToolUse` hook can use the plain `rtk hook claude` command (no full-path workaround needed).

---

**Recovery complete. Return to the file you were sent from** — skip any remaining rtk mount steps there (Step 3 in `add-rtk-apple-containers.md`, or the mount step in `SKILL.md`), since rtk is now baked into the image rather than mounted. Continue from the `PreToolUse` hook step onward using the plain `rtk hook claude` command.
