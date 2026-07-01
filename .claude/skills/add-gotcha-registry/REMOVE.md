# Remove Gotcha Registry

Idempotent — safe to run even if some steps were never applied.

## 1. Remove the PreCompact hook from `.claude/settings.json`

```bash
jq 'del(.hooks.PreCompact)' .claude/settings.json \
  > /tmp/gotcha-remove.json && mv /tmp/gotcha-remove.json .claude/settings.json
```

If other `PreCompact` hooks exist alongside this one, remove only this entry:

```bash
jq '.hooks.PreCompact = ((.hooks.PreCompact // [])
      | map(select((.hooks // []) | any(.command == ".claude/hooks/precompact-gotcha.sh") | not)))' \
  .claude/settings.json > /tmp/gotcha-remove.json && mv /tmp/gotcha-remove.json .claude/settings.json
```

## 2. Remove the hook script

```bash
rm -f .claude/hooks/precompact-gotcha.sh
```

If `.claude/hooks/` is now empty and no other hooks live there:

```bash
rmdir .claude/hooks 2>/dev/null || true
```

## 3. Remove the @include from CLAUDE.md

Delete the line `@.claude/orientation/index.md` from `CLAUDE.md`:

```bash
grep -n '@.claude/orientation/index.md' CLAUDE.md  # find the line number
# Then delete it with your editor, or:
sed -i '' '/@\.claude\/orientation\/index\.md/d' CLAUDE.md  # macOS
# sed -i '/@\.claude\/orientation\/index\.md/d' CLAUDE.md  # Linux
```

## 4. Remove the orientation directory (optional)

The orientation files contain knowledge you've accumulated. Consider keeping them even if removing the automation:

```bash
# Only if you want to discard all accumulated gotchas:
rm -rf .claude/orientation/
```
