---
name: add-mailman-rss
description: Add an RSS/Atom feed to Mailman. Polls for new items, optionally fetches article content. Run /add-mailman first.
---

# Add RSS Feed to Mailman

Adds an RSS or Atom feed as an input for the Mailman triage pipeline. New items are fetched, deduplicated, and sent through the triage subagent.

By default, the handler fetches the full article content from each item's URL (regex HTML strip, capped at 8KB). Set `fetch_content: false` to use only the RSS description/snippet.

Each invocation creates one feed — run multiple times for multiple feeds.

## Pre-flight

### 1. Verify Mailman core is set up

```bash
grep MAILMAN_AGENT_GROUP_ID .env
ls src/mailman/feeds.ts mailman/persona/kernel.md
```

If any fail, tell the user to run `/add-mailman` first and stop.

### 2. Update mailman source for RSS support

```bash
git fetch origin mailman
git show origin/mailman:src/mailman/rss-feed.ts  > src/mailman/rss-feed.ts
git show origin/mailman:src/mailman/maildir.ts   > src/mailman/maildir.ts
git show origin/mailman:src/mailman/feeds.ts     > src/mailman/feeds.ts
```

### 3. Install the RSS parser

```bash
pnpm install rss-parser@3.13.0
pnpm run build
```

Build must be clean.

### 4. Choose a feed name

Ask the user: **"What should this RSS feed be called?"**

Suggest names based on the feed's purpose:
- `rss-hackernews` — Hacker News
- `rss-company-blog` — company engineering blog
- `rss-sec-advisories` — security advisory feed
- `rss-<topic>` — any topic-specific feed

Rules:
- Lowercase alphanumeric + hyphens only
- Must be unique across `mailman/feeds/`

## Configure

### 5. Get the RSS/Atom URL

Ask the user: **"What's the RSS or Atom feed URL?"**

Tips:
- Most blogs have `/feed`, `/rss`, or `/atom.xml` at the root
- For sites without an obvious feed, try adding `/feed` to the URL
- YouTube channels: `https://www.youtube.com/feeds/videos.xml?channel_id=<ID>`
- Reddit: append `.rss` to any subreddit URL (e.g. `https://www.reddit.com/r/netsec/.rss`)
- GitHub releases: `https://github.com/<owner>/<repo>/releases.atom`

### 6. Test the URL

```bash
curl -s "<rss-url>" | head -5
```

Should show XML starting with `<rss`, `<feed`, or `<?xml`. If it returns HTML, it's not an RSS feed.

### 7. Create the feed directory

```bash
mkdir -p "mailman/feeds/<feed-name>"
```

### 8. Write feed.json

Ask the user about their preferences:

> **Poll interval:** How often to check (default: 30 minutes). High-volume feeds might want 15 minutes; slow blogs could use 2-4 hours.
>
> **Fetch content:** Whether to fetch the full article from each link (default: true). Set to false for feeds with good descriptions or when you just want titles.
>
> **Max items:** How many items to process per poll (default: 10). Prevents a large backlog on first run.

```bash
cat > "mailman/feeds/<feed-name>/feed.json" <<'EOF'
{
  "type": "rss",
  "url": "<rss-url>",
  "poll_interval_s": 1800,
  "fetch_content": true,
  "max_items": 10
}
EOF
```

Note: `agent_id` is not needed — RSS feeds use plain HTTP, no OAuth.

### 9. Optionally create a feed-specific triage prompt

Ask the user: **"Should this feed have special triage rules?"**

Examples:
- **Security advisories:** "Escalate any advisory affecting our stack (Node.js, Docker, Linux kernel). Defer advisories for platforms we don't use."
- **Industry news:** "Only escalate breaking news or items about our direct competitors. Defer everything else."
- **GitHub releases:** "Escalate releases for packages we depend on. Defer everything else."

If yes, write `mailman/feeds/<feed-name>/prompt.md`.

### 10. Verify

```bash
pnpm run build
cat "mailman/feeds/<feed-name>/feed.json"
```

Build must be clean. Show the user their feed config for confirmation.

## Done

Tell the user:

> RSS feed "**<feed-name>**" is configured. It will start polling on next service restart.
>
> To restart now: `launchctl kickstart -k gui/$(id -u)/com.nanoclaw`
>
> Seen items are tracked in `mailman/state/rss-seen-<feed-name>.json` (capped at 2000 entries). Delete this file to re-process all items.
>
> To add another RSS feed, run `/add-mailman-rss` again with a different feed name.

## Troubleshooting

- **"RSS fetch failed"** — check the URL returns valid RSS/Atom XML
- **Empty content** — if `fetch_content: true` and articles show `[fetch failed]`, the site may block automated requests. Try `fetch_content: false` to use RSS descriptions instead.
- **Too many items on first run** — reduce `max_items` in `feed.json`
- **Stale items** — delete `mailman/state/rss-seen-<feed-name>.json` to reset

## Future: Summarization

The current implementation sends raw extracted text to the triage subagent. A future upgrade path: add an optional `summarize` step in the feed handler that passes article content through a local model (Ollama) or cheap cloud inference before triage. This would improve triage quality for long articles while keeping costs low. The `feed.json` would gain a `summarize_model` field.
