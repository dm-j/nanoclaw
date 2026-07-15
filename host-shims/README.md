# Host Shims

Whitelist folder for the host-shim relay (`src/modules/host-shim/`,
`container/agent-runner/src/tools/host-shim.ts`). This lets a containerized agent invoke a
host-only executable by name — the agent has no shell access to the host, so this is the
one narrow, explicit door.

## The whitelist IS the filesystem

To allow the agent to call `foo`, drop an executable script named `foo-host` directly in
this directory (`chmod +x`). To revoke it, delete the script. There is no config entry, no
DB table — presence of the file is the whole authorization.

From inside the container, the agent runs `host-shim foo <args...>`. The host resolves
`host-shims/foo-host`, execs it with `<args...>` as a plain argv array (never through a
shell — no injection surface from arg content), and returns stdout/stderr/exit code.

## Writing a `-host` script

- It receives argv exactly as the agent typed it after the tool name.
- It's responsible for its own arg validation/sanitization — the relay only checks that the
  tool *name* can't escape this directory; it does not vet the args your script receives.
- Keep it fast — calls are synchronous from the agent's point of view (default 30s timeout).
- A script can hardcode context the agent shouldn't have to supply every time. For example,
  `obsidian-host` (first tool, not yet written) should hardcode the leading `vault <path>`
  argument pointing at David's actual vault, so the agent just calls
  `host-shim obsidian <rest of the real obsidian-cli args>` without needing to know or be
  able to override which vault it's operating on.

## Security notes

- Scripts here run with the host user's real permissions — write ones that touch real state
  (files, the vault, credentials) carefully.
- This directory is gitignored (`.gitignore`: `host-shims/*`) — these are host-specific and
  potentially sensitive. Only this README and `.gitkeep` are tracked.
