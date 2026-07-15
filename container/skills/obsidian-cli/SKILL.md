---
name: obsidian-cli
description: Use the `obsidian` command for vault-content operations (note create/move/rename/append/property edits, search, wikilinks, daily notes). Use when asked to read, edit, move, rename, or search notes in the Obsidian vault, or to check/fix wikilinks and backlinks.
---

# Obsidian CLI

You have no shell access to the host — but a real Obsidian instance runs there and understands
this vault the way Obsidian itself does (wikilink resolution, vault structure), unlike raw
`Bash`/`Write`/`Edit` on the mounted `/workspace/vault` files. Reach it with:

```bash
obsidian <command> [options]
```

This runs the real `obsidian` CLI on the host (via a relay you don't need to think about) and
returns its stdout/stderr/exit code. It runs headlessly — the Obsidian app doesn't need to be
open.

## The vault is already fixed — never pass `vault=`

Which vault every call targets is hardcoded on the host side. **Never pass a `vault=`
argument** — there is only ever one vault reachable this way, you cannot select or switch to a
different one, and passing `vault=` yourself will conflict with the fixed value rather than
override it. Every example below omits it because it's already handled.

## Treat this as a restricted, single-command, unpipelined CLI

Every `obsidian ...` call is **one full round trip through a relay**, not a live shell:

- **One command per call.** Don't chain with `&&`, `;`, or a host-side `|` — there is no
  persistent host-side process to chain against. If you need output from one call to decide
  the next, make the first call, read its result, then make the second call.
- **No cross-call piping.** `obsidian search query="foo" format=json | jq ...` is fine — the
  pipe runs entirely in *your* container, only `obsidian search ...` itself is relayed.
  Piping the output of one `obsidian` call into another `obsidian` call isn't possible.
- **Unconditional.** There's no host-side branching or interactivity. All decision-making
  (what to do based on a result) happens in your own reasoning after the call returns, never
  inside the command itself.

## Commands

Prefer these over raw filesystem operations for anything vault-content-shaped — they resolve
notes the way Obsidian does and keep wikilinks intact on move/rename:

```
obsidian read path="folder/note.md"
obsidian create path="folder/note" content="..."
obsidian append path="note.md" content="..."      # end of file
obsidian prepend path="note.md" content="..."     # after frontmatter
obsidian move path="old.md" to="new.md"           # vault-aware move/rename, fixes wikilinks
obsidian rename path="note.md" name="new-name"    # filename only
obsidian delete path="note.md" [permanent]
obsidian properties path="note.md" | property:read | property:set | property:remove
obsidian backlinks path="note.md" [counts]
obsidian links path="note.md"
obsidian unresolved                                # broken/blind wikilinks vault-wide
obsidian orphans | deadends
obsidian search query="..." [path=] [limit=] [format=json] [total]
obsidian tags [counts] [sort=count] | obsidian tag name="..."
obsidian daily | daily:read | daily:append | daily:prepend | daily:path
```

Full command reference (options run through the same relay, vault targeting still N/A):
https://github.com/pablo-mano/Obsidian-CLI-skill/blob/main/plugins%2Fobsidian-cli%2Fskills%2Fobsidian-cli%2Freferences%2Fcommand-reference.md

### `search` is ranked and typo-tolerant

`obsidian search query="..."` is not a plain substring match — results are ranked by
relevance (best match first) and tolerant of typos, and may surface hits inside PDFs/images if
the vault has document indexing enabled, not just markdown notes. Default output (`format=text`,
one result per line) is now
`<path>\t<excerpt>` — the excerpt is a short snippet showing *why* it matched, useful for
picking the right result without a follow-up `read`. `format=json` returns
`[{path, score, excerpt}, ...]`, highest `score` first. Results are capped at 20 by default —
pass `limit=` to change that; `total` is unaffected by the cap and reports the real match count.
`path=` still filters to a folder. If the query has no results in a folder-filtered search,
empty output is a real "no match," not an error.

## Refusals

If `obsidian ...` fails with something like `no whitelisted shim named "obsidian"`, the
host-side relay script is missing or was removed — this is an infrastructure problem, not
something to route around with raw filesystem edits. Report it rather than silently falling
back to `Write`/`Edit` on `/workspace/vault`.

## Keep raw tools for what has no CLI equivalent

`Bash`/`Write`/`Edit` on `/workspace/vault` are still fine for things the CLI doesn't cover:
directory listing for non-vault purposes, or files/operations with no command above. For
note content and structure, prefer the CLI.
