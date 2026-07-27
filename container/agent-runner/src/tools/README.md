# Agent Tools

Drop a `.ts` file in this directory to create a new CLI tool available to all agents.

## Requirements

1. **Shebang line:** `#!/usr/bin/env bun`
2. **Doc comment:** First comment block after the shebang becomes the description shown by `tools --description`
3. **Self-contained:** Import from `fs`, `path`, `os`, etc. — no project-relative imports. The tool runs standalone via `bun`.
4. **Exit codes:** 0 = success, 1 = error. Write errors to stderr.
5. **No build step:** The file is used directly. Keep the `.ts` extension.

## How it works

At container startup, `entrypoint.sh` generates a shell wrapper in `/usr/local/bin/` for each `.ts` file here. The wrapper calls `bun /app/src/tools/<name>.ts "$@"`. The tool is then callable by its filename without the extension.

## Template

```typescript
#!/usr/bin/env bun
/**
 * mytool — one-line description of what it does.
 */

const args = process.argv.slice(2);

if (!args[0] || args[0] === '--help') {
  console.log('Usage: mytool <arg>');
  process.exit(0);
}

// Do the thing
console.log(`Result: ${args[0]}`);
```

## Environment

- `TZ` — the agent's timezone (DB-configured `container_configs.timezone`, set via `setlocaltimezone`/`ncl groups config update --timezone`)
- `MEMSEARCH_DIR` — path to the agent's memsearch memory directory
- Standard container env (HOME, PATH, etc.)

## Existing tools

Run `tools --description` to see what's already available.
