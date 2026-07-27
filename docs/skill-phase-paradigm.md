# Skill phase paradigm

How `add-*` (and similar) `SKILL.md` files sequence their apply steps. [skill-guidelines.md](skill-guidelines.md) is the authoritative checklist for *what* makes a skill conformant (integration points, tests, REMOVE.md); this doc is the narrower "how do I structure the steps" convention it assumes. Not every skill needs every phase — instruction-only or single-step skills can skip straight to what applies.

## The phases

1. **Pre-flight** — idempotent checks before touching anything. Verify external prerequisites (credential connected, stub files exist, mount allowlist covers the path, secret mode set). Each check ends in either "skip to Phase X" (already satisfied) or a concrete fix. Never assume a clean slate; a re-run must detect prior state and skip past it.
2. **Apply code changes** — starts with a one-line "already applied?" guard (grep for a marker like a version ARG). Then the actual diffs: pinned versions, exact file edits, copying in the skill's structural test guards. Ends with a build step (e.g. `./container/build.sh`) if the change touches the image.
3. **Wire per-agent-group** (or equivalent config step) — persist config through the sanctioned path (`ncl`, a DB helper), never by hand-editing a generated file (e.g. `groups/<folder>/container.json` — regenerated from the DB on every spawn, so hand edits silently vanish).
4. **Build, validate, restart** — typecheck, run the copied tests, then restart the service/container so the change takes effect. All must be clean before moving on; this phase is a gate, not a formality.
5. **Verify** — a concrete user-facing action to confirm it worked, plus a log-grep triage table mapping specific error strings to specific causes. There is no separate `VERIFY.md` — this phase (backed by the Phase 4 tests) *is* the verification.

Trailing sections, not numbered phases:

- **Removal** — pointer to `REMOVE.md`, which reverses every phase above (deleted, not commented out).
- **Notes** — scope boundaries: what this skill deliberately does not do.
- **Credits & references** — provenance of any third-party package or pattern.

## Invariants that make the sequencing safe

- **Idempotent at every phase.** Re-running the skill (e.g. on upgrade) must detect existing state and skip rather than redo or double-apply.
- **Pinned versions**, never `latest`, for anything installed into the container image.
- **DB is the source of truth** over any materialized/generated file.
- **OneCLI is the sole credential path** — stub files with `onecli-managed` placeholders, never raw secrets in the container or on disk.
- **Present-tense DO steps only** — no "earlier versions did X" framing; a skill reads as a standalone artifact.

## Reference example

`.claude/skills/add-gmail-tool/SKILL.md` is a clean instance of all five phases plus REMOVE.md, Notes, and Credits. Use it as the template when drafting a new skill in this shape.
