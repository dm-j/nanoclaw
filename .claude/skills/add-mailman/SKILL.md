---
name: add-mailman
description: Set up the Mailman triage pipeline — configures the target agent group for notifications and the persona kernel. Run this before adding any mailman feeds (e.g. /add-mailman-gmail).
---

# Add Mailman

Sets up the Mailman email/notification triage pipeline. Mailman watches a shared Maildir inbox, triages incoming messages with cheap subagents, and notifies the main agent when something needs attention.

This skill configures the core pipeline. To add specific input feeds (Gmail, IMAP, etc.), run the corresponding `/add-mailman-*` skill after this one.

## Pre-flight

### 1. Verify the mailman source files exist

```bash
ls src/mailman/feeds.ts src/mailman/subagent.ts src/mailman/fork.ts src/mailman/notify.ts src/mailman/sanitize.ts src/mailman/spawn.ts
```

All must exist. If any are missing, the user needs to update their NanoClaw install first.

### 2. Verify OneCLI has a triage agent

```bash
onecli agents list 2>&1 | grep -i mailman
```

If no `mailman-triage` agent exists, create one:

```bash
onecli agents create --id mailman-triage --name "Mailman Triage"
onecli agents set-secret-mode --id mailman-triage --mode all
```

## Configure

### 3. Pick the target agent group

Ask the user which agent group should receive mailman notifications. This is the "main agent" that decides how to notify the user.

```bash
pnpm exec tsx scripts/q.ts data/v2.db "SELECT id, workspace FROM agent_groups"
```

Show the list and let the user pick. Store the chosen ID.

### 4. Set MAILMAN_AGENT_GROUP_ID

Check if already set:

```bash
grep MAILMAN_AGENT_GROUP_ID .env 2>/dev/null
```

If not set (or wrong), append/update:

```bash
# Use the ID the user chose in step 3
echo 'MAILMAN_AGENT_GROUP_ID=<chosen-id>' >> .env
```

### 5. Create persona kernel if absent

```bash
mkdir -p mailman/persona
```

If `mailman/persona/kernel.md` does not exist, ask the user:

> "The persona kernel tells triage agents who you are and how to prioritize. I'll create a starting template — you can edit it later. What name should I use for you?"

Then write `mailman/persona/kernel.md` with the template from `${CLAUDE_SKILL_DIR}/kernel.md.template`, substituting the user's name.

If it already exists, skip — don't overwrite.

### 6. Ensure prompt files exist

```bash
ls mailman/prompts/email_triage.md mailman/prompts/fork_eval.md
```

Both must exist. If missing, the user's install is incomplete.

### 7. Create Maildir structure

```bash
mkdir -p mailman/inbox/new mailman/inbox/cur mailman/inbox/tmp
mkdir -p mailman/feeds
```

### 8. Build and verify

```bash
pnpm run build
```

Must be clean.

## Done

Tell the user:

> Mailman core is configured. The triage pipeline will start on next service restart. To add input feeds, run `/add-mailman-gmail` (or other feed skills when available).
>
> To restart now: `launchctl kickstart -k gui/$(id -u)/com.nanoclaw`

## Trust Model

Mailman sanitizes authority headers (From, Sender, Reply-To, etc.) before they reach the triage model. Each ingress stamps what it can verify:

- `X-Mailman-Source: <feed-name>` — which feed produced this message
- `X-Mailman-Trust: <method>` — how the ingress authenticated (e.g. `gmail-api`)
- `X-Verified-From: <address>` — sender identity verified by the provider

The sanitizer rewrites raw authority headers to `Unverified-*` so the triage model can distinguish verified from unverified sender info. Future feed types (Telegram, IMAP, etc.) should stamp `X-Verified-*` for whatever they can authenticate and leave the rest to the sanitizer.

## Troubleshooting

- **"MAILMAN_AGENT_GROUP_ID not set"** in logs — step 4 was missed or .env wasn't saved
- **OneCLI errors** — verify `onecli agents list` shows `mailman-triage` with `secretMode: all`
- **No notifications arriving** — check the target agent group has an active session and a wired channel
