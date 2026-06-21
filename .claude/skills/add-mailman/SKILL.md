---
name: add-mailman
description: Add the Mailman triage pipeline — email/notification triage with cheap subagents and fork evaluation. Run this before adding any feeds (e.g. /add-mailman-gmail).
---

# Add Mailman

Adds the Mailman triage pipeline. Mailman watches a shared Maildir inbox, triages incoming messages with cheap containerised subagents, and notifies the main agent when something needs attention.

NanoClaw doesn't ship Mailman in trunk. This skill copies the code in from the `mailman` branch.

## Install

### Pre-flight (idempotent)

Skip to **Configure** if all of these are already in place:

- `src/mailman/subagent.ts` exists
- `src/mailman/feeds.ts` exists
- `src/mailman/notify.ts` exists
- `mailman/prompts/email_triage.md` exists
- `src/index.ts` contains `import './mailman/feeds.js';` (via the mailman barrel)

Otherwise continue. Every step below is safe to re-run.

### 1. Fetch the mailman branch

```bash
git fetch origin mailman
```

### 2. Copy the source files

```bash
mkdir -p src/mailman mailman/prompts mailman/persona mailman/test-emails mailman/state mailman/inbox/new mailman/inbox/cur mailman/inbox/tmp mailman/feeds

# Core pipeline
git show origin/mailman:src/mailman/spawn.ts        > src/mailman/spawn.ts
git show origin/mailman:src/mailman/sanitize.ts      > src/mailman/sanitize.ts
git show origin/mailman:src/mailman/subagent.ts      > src/mailman/subagent.ts
git show origin/mailman:src/mailman/fork.ts          > src/mailman/fork.ts
git show origin/mailman:src/mailman/notify.ts        > src/mailman/notify.ts
git show origin/mailman:src/mailman/inbox-watcher.ts > src/mailman/inbox-watcher.ts
git show origin/mailman:src/mailman/webhook.ts       > src/mailman/webhook.ts

# Feed system
git show origin/mailman:src/mailman/feeds.ts         > src/mailman/feeds.ts
git show origin/mailman:src/mailman/gmail-api.ts     > src/mailman/gmail-api.ts

# Prompts and persona
git show origin/mailman:mailman/prompts/email_triage.md > mailman/prompts/email_triage.md
git show origin/mailman:mailman/prompts/fork_eval.md    > mailman/prompts/fork_eval.md
git show origin/mailman:mailman/persona/intents.md      > mailman/persona/intents.md

# Test emails
git show origin/mailman:mailman/test-emails/newsletter.eml            > mailman/test-emails/newsletter.eml
git show origin/mailman:mailman/test-emails/shipping-delay.eml         > mailman/test-emails/shipping-delay.eml
git show origin/mailman:mailman/test-emails/urgent-from-known-sender.eml > mailman/test-emails/urgent-from-known-sender.eml

# CLI script
git show origin/mailman:scripts/mailman-triage.ts > scripts/mailman-triage.ts

# Design docs (optional, for reference)
git show origin/mailman:docs/mailman-design.md    > docs/mailman-design.md
git show origin/mailman:docs/mailman-prototype.md > docs/mailman-prototype.md
```

### 3. Wire into src/index.ts

Add these imports near the other imports at the top of `src/index.ts` (skip if already present):

```typescript
import { startFeeds, stopFeeds } from './mailman/feeds.js';
import { startInboxWatcher, stopInboxWatcher } from './mailman/inbox-watcher.js';
import { registerMailmanWebhook } from './mailman/webhook.js';
```

Add startup calls at the end of the `main()` function, before `log.info('NanoClaw running')`:

```typescript
  // 8. Mailman triage pipeline — inbox watcher + feed ingresses + webhook.
  startInboxWatcher();
  startFeeds();
  registerMailmanWebhook();
```

Add shutdown calls in the `shutdown()` function, near the other stop calls:

```typescript
  stopInboxWatcher();
  stopFeeds();
```

### 4. Build and validate

```bash
pnpm run build
```

Must be clean before proceeding.

## Configure

### 5. Verify OneCLI has a triage agent

```bash
onecli agents list 2>&1 | grep -i mailman
```

If no `mailman-triage` agent exists, create one:

```bash
onecli agents create --id mailman-triage --name "Mailman Triage"
onecli agents set-secret-mode --id mailman-triage --mode all
```

### 6. Pick the target agent group

Ask the user which agent group should receive mailman notifications. This is the "main agent" that decides how to notify the user.

```bash
pnpm exec tsx scripts/q.ts data/v2.db "SELECT id, workspace FROM agent_groups"
```

Show the list and let the user pick. Store the chosen ID.

### 7. Set MAILMAN_AGENT_GROUP_ID

Check if already set:

```bash
grep MAILMAN_AGENT_GROUP_ID .env 2>/dev/null
```

If not set (or wrong), append/update:

```bash
echo 'MAILMAN_AGENT_GROUP_ID=<chosen-id>' >> .env
```

### 8. Create persona kernel if absent

If `mailman/persona/kernel.md` does not exist, ask the user:

> "The persona kernel tells triage agents who you are and how to prioritize. I'll create a starting template — you can edit it later. What name should I use for you?"

Then write `mailman/persona/kernel.md` with the template from `${CLAUDE_SKILL_DIR}/kernel.md.template`, substituting the user's name.

If it already exists, skip — don't overwrite.

### 9. Teach the main agent about intents.md

Append the following to the main agent group's `CLAUDE.local.md` (at `groups/<folder>/CLAUDE.local.md`, using the folder from the agent group chosen in step 6). Skip if the block is already present:

```markdown

## Mailman Intents

You can steer email triage by editing `mailman/persona/intents.md`. This file is injected into every triage subagent's prompt. Add directives like:

- "Notify about all package shipping updates"
- "Emails from @company.co are always from known senders"
- "Ignore all LinkedIn notifications"

Changes take effect on the next triage — no restart needed.
```

## Trust Model

Mailman sanitizes authority headers (From, Sender, Reply-To, etc.) before they reach the triage model. Each ingress stamps what it can verify:

- `X-Mailman-Source: <feed-name>` — which feed produced this message
- `X-Mailman-Trust: <method>` — how the ingress authenticated (e.g. `gmail-api`)
- `X-Verified-From: <address>` — sender identity verified by the provider

The sanitizer rewrites raw authority headers to `Unverified-*` so the triage model can distinguish verified from unverified sender info. Future feed types should stamp `X-Verified-*` for whatever they can authenticate and leave the rest to the sanitizer.

## Done

Tell the user:

> Mailman core is installed and configured. The triage pipeline will start on next service restart. To add input feeds, run `/add-mailman-gmail` (or other feed skills when available).
>
> To restart now: `launchctl kickstart -k gui/$(id -u)/com.nanoclaw`

## Troubleshooting

- **"MAILMAN_AGENT_GROUP_ID not set"** in logs — step 7 was missed or .env wasn't saved
- **OneCLI errors** — verify `onecli agents list` shows `mailman-triage` with `secretMode: all`
- **No notifications arriving** — check the target agent group has an active session and a wired channel
- **Build fails on missing imports** — verify step 3 added all three imports and both startup/shutdown blocks
