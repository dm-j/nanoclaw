/**
 * Generic self-repair engine. A "trigger" is a whitelisted failure condition
 * with a two-tier fix script attached to it; this module owns the shared
 * plumbing (approval cards, container-exec, breakfix branching, host
 * restart) so registering a new trigger is just describing the condition and
 * the two prompts, not re-implementing the flow.
 *
 * Tier 1 (structured): runs `claude -p --dangerously-skip-permissions`
 * *inside the target session's own already-running container*, prompted with
 * the trigger's structured fix script. Narrow blast radius — only reaches
 * what's already bind-mounted into that container.
 *
 * Tier 2 (freeform, only offered if tier 1 didn't fix it): the condition may
 * be a code bug, not just bad state, so it needs the actual repo. Cuts a
 * breakfix branch first (stash outstanding changes, branch off whatever HEAD
 * currently is) so an autonomous host-level agent never commits over main
 * directly, runs `claude -p --dangerously-skip-permissions` on the HOST with
 * the repo as cwd and a freeform "go fix it" prompt, and on success rebuilds
 * + restarts the whole host service so the fix is actually live. The repo
 * stays on the breakfix branch either way for the operator to review before
 * merging to main.
 *
 * Every step requires an explicit admin approval-card click — nothing here
 * is automatic. Whitelisting is the first gate (only registered triggers can
 * fire at all); the approval click is the second.
 *
 * Tier 2 is a GLOBAL one-shot, not per-trigger or per-session, and it is NOT
 * enforced by this file. It can't be: this file's own compiled output is
 * exactly what a tier-2 turn could rewrite, and the flow rebuilds + restarts
 * the host on success — off the very branch that turn just edited. A gate
 * living here would let one compromised "fix" re-arm itself forever.
 *
 * So the real gate is external, in every sense this app's code paths don't
 * reach:
 *   - ~/.nanoclaw-repair-agent/<install-slug>/run-tier2.sh — a shell script
 *     OUTSIDE the git repo, installed once (create-if-missing, chmod 0500 —
 *     not writable even by its own owner without an explicit chmod first)
 *     and NEVER overwritten by this module again. The first-ever install is
 *     the only one that ever runs from repo-tracked source.
 *   - ~/.nanoclaw-repair-agent/<install-slug>/tier2.available — a credit
 *     token. Its mere EXISTENCE is the "one autonomous turn" grant. To
 *     claim it, the script atomically `mv`s it to a unique tier2.used-<ts>
 *     path — POSIX rename(2), no TOCTOU window. Crucially the safe state is
 *     the DEFAULT one: if the token is missing for any reason at all — the
 *     one legitimate claim, an accidental `rm`, a half-corrupted volume, a
 *     permissions problem, someone fat-fingering the directory — `mv` simply
 *     fails and the script refuses. There is no failure mode that silently
 *     re-arms the grant; every failure mode we could think of (deleted
 *     token, deleted dir, unreadable fs, wrong perms) fails on the side of
 *     "no autonomous work", never the other way. Compare to a "lock file
 *     that must NOT exist to proceed": losing that file re-arms the gate,
 *     which is exactly backwards for something this sensitive.
 * Node still does its own pre-check for a fast, friendly refusal message —
 * but that's UX, not the gate. The gate is the script's mv.
 *
 * Caveat, stated plainly rather than overclaimed: this raises the bar, it
 * doesn't guarantee isolation. The tier-2 turn runs as the same OS user as
 * this script, so a sufficiently deliberate agent could still `chmod` the
 * script or the token file before touching them. Real isolation needs a
 * separate, less-privileged OS user for the repair turn — out of scope for
 * a single-user dev box, worth doing if this ever runs somewhere shared.
 */
import { execFile, execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { promisify } from 'util';

import { getContainerName } from '../../container-runner.js';
import { CONTAINER_HOST_GATEWAY, CONTAINER_RUNTIME_BIN } from '../../container-runtime.js';
import { INSTALL_SLUG } from '../../config.js';
import { getSession } from '../../db/sessions.js';
import { getDeliveryAdapter } from '../../delivery.js';
import { log } from '../../log.js';
import { ensureUserDm } from '../permissions/user-dm.js';
import { registerApprovalHandler, requestApproval, type ApprovalHandlerContext } from './primitive.js';
import type { Session } from '../../types.js';

const execFileAsync = promisify(execFile);
const REPAIR_TIMEOUT_MS = 5 * 60_000;
const REBUILD_TIMEOUT_MS = 5 * 60_000;

const GATE_ROOT = path.join(os.homedir(), '.nanoclaw-repair-agent', INSTALL_SLUG);
const GATEKEEPER_SCRIPT = path.join(GATE_ROOT, 'run-tier2.sh');
const AVAILABLE_FILE = path.join(GATE_ROOT, 'tier2.available');
const TIER2_LOCKED_EXIT_CODE = 17;

const GATEKEEPER_SCRIPT_SOURCE = `#!/usr/bin/env bash
# nanoclaw repair-agent tier-2 gatekeeper. Lives outside the git repo,
# installed once, never overwritten. See repair-agent.ts for why.
#
# The credit token's existence IS the grant. Claiming it is an atomic mv —
# if that fails for ANY reason (missing, already claimed, fs trouble,
# permissions), we refuse. Fails safe by construction: every way this can
# go wrong lands on "no autonomous work", never "run anyway".
set -euo pipefail
AVAILABLE_FILE="$1"; USED_FILE="$2"; REPO_DIR="$3"; TRIGGER_ID="$4"; BRANCH="$5"; PROMPT_FILE="$6"

if ! mv "$AVAILABLE_FILE" "$USED_FILE" 2>/dev/null; then
  echo "GATEKEEPER: could not claim the tier-2 credit (missing, already used, or filesystem problem) — refusing" >&2
  exit ${TIER2_LOCKED_EXIT_CODE}
fi
printf '{"usedAt":"%s","triggerId":"%s","branch":"%s"}\\n' \\
  "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$TRIGGER_ID" "$BRANCH" >> "$USED_FILE"

cd "$REPO_DIR"
exec claude -p "$(cat "$PROMPT_FILE")" --dangerously-skip-permissions
`;

/**
 * Installs the gatekeeper script AND seeds the one-time credit token, but
 * only together, only if the script doesn't already exist. This is the one
 * and only place the token is ever created — a missing token later (used,
 * deleted, whatever) is never recreated automatically. Manual reset means
 * manually recreating the file, deliberately, after reviewing what happened.
 */
function ensureGatekeeperInstalled(): void {
  fs.mkdirSync(GATE_ROOT, { recursive: true, mode: 0o700 });
  fs.chmodSync(GATE_ROOT, 0o700);
  if (fs.existsSync(GATEKEEPER_SCRIPT)) return;
  fs.writeFileSync(GATEKEEPER_SCRIPT, GATEKEEPER_SCRIPT_SOURCE, { mode: 0o500 });
  fs.chmodSync(GATEKEEPER_SCRIPT, 0o500);
  fs.writeFileSync(AVAILABLE_FILE, `granted ${new Date().toISOString()}\n`, { mode: 0o600 });
  log.info('repair-agent: gatekeeper installed, tier-2 credit granted', { path: GATEKEEPER_SCRIPT });
}
ensureGatekeeperInstalled();

interface Tier2LockoutInfo {
  usedAt: string;
  triggerId: string;
  branch: string;
}

/** UX-only pre-check — the real gate is the gatekeeper script's atomic mv. */
function tier2Lockout(): Tier2LockoutInfo | null {
  if (fs.existsSync(AVAILABLE_FILE)) return null;
  try {
    const usedFiles = fs.readdirSync(GATE_ROOT).filter((f) => f.startsWith('tier2.used-'));
    const latest = usedFiles.sort().at(-1);
    if (latest) {
      const content = fs.readFileSync(path.join(GATE_ROOT, latest), 'utf-8');
      const jsonLine = content.split('\n').find((l) => l.trim().startsWith('{'));
      if (jsonLine) return JSON.parse(jsonLine) as Tier2LockoutInfo;
    }
  } catch {
    // fall through to the generic message below
  }
  return { usedAt: 'unknown', triggerId: 'unknown', branch: 'unknown' };
}

export interface RepairContext {
  sessionId: string;
  agentGroupId: string;
  /** Free-form details for the approval card + prompts — whatever the trigger needs to describe itself. */
  detail: Record<string, unknown>;
}

export interface RepairTrigger {
  /** Stable id, used as the approval-handler action namespace. Keep short, kebab-case. */
  id: string;
  /** Card title for the initial "authorize tier 1" approval. */
  title: string;
  /** One-line-per-item summary of the condition, shown on the initial card (kept short — Telegram card limits). */
  summarize(ctx: RepairContext): string[];
  /** Tier 1: structured prompt anchored to the specific known-broken thing. */
  structuredPrompt(ctx: RepairContext): string;
  /** Tier 2: freeform prompt, given tier 1's report for context. */
  freeformPrompt(ctx: RepairContext, previousReport: string): string;
  /** Re-checks the condition. Returns true if still broken. Called after both tiers. */
  stillBroken(ctx: RepairContext): boolean;
  /** Called once the condition verifies fixed, after either tier. E.g. restart the affected containers. */
  onRecovered(ctx: RepairContext): void;
}

const triggers = new Map<string, RepairTrigger>();

/** Register a whitelisted repair trigger. Only registered triggers can ever reach an approval card. */
export function registerRepairTrigger(trigger: RepairTrigger): void {
  if (triggers.has(trigger.id)) {
    log.warn('Repair trigger re-registered (overwriting)', { id: trigger.id });
  }
  triggers.set(trigger.id, trigger);

  registerApprovalHandler(step1Action(trigger.id), async (approvalCtx) => {
    const ctx = approvalCtx.payload as unknown as RepairContext;
    const report = await runContainerRepairTurn(approvalCtx.session, trigger.structuredPrompt(ctx));
    await dmApprover(approvalCtx.userId, `[${trigger.id}] Repair attempt report:\n\n${report}`);

    if (!trigger.stillBroken(ctx)) {
      await dmApprover(approvalCtx.userId, `[${trigger.id}] ✅ Verified fixed. Recovering…`);
      trigger.onRecovered(ctx);
      return;
    }

    const lockout = tier2Lockout();
    if (lockout) {
      await dmApprover(
        approvalCtx.userId,
        `[${trigger.id}] Still broken, but autonomous repair was already used once ` +
          `(${lockout.usedAt}, trigger \`${lockout.triggerId}\`, branch \`${lockout.branch}\`) and is locked out. ` +
          `Needs manual intervention — review that branch and delete data/repair-agent-tier2-used.json to reset.`,
      );
      return;
    }

    await requestApproval({
      session: approvalCtx.session,
      agentName: `repair-agent:${trigger.id}`,
      action: step2Action(trigger.id),
      payload: { ...ctx, previousReport: report } as unknown as Record<string, unknown>,
      title: `[${trigger.id}] First repair attempt failed`,
      question: `Still broken after the structured attempt. Authorize an open-ended autonomous repair turn (full repo access, on a fresh breakfix branch)? This is a one-time grant — refused automatically after this until manually reset.\n\nPrevious report:\n${report}`,
      approverUserId: approvalCtx.userId,
    });
  });

  registerApprovalHandler(step2Action(trigger.id), async (approvalCtx) => {
    const payload = approvalCtx.payload as unknown as RepairContext & { previousReport: string };
    const ctx: RepairContext = {
      sessionId: payload.sessionId,
      agentGroupId: payload.agentGroupId,
      detail: payload.detail,
    };

    const lockout = tier2Lockout();
    if (lockout) {
      await dmApprover(
        approvalCtx.userId,
        `[${trigger.id}] Autonomous repair is locked out (already used ${lockout.usedAt} by \`${lockout.triggerId}\`, ` +
          `branch \`${lockout.branch}\`). Refusing to run a second one. Review that branch, then deliberately recreate ` +
          `${AVAILABLE_FILE} to grant another credit.`,
      );
      return;
    }

    const branch = prepareBreakfixBranch(ctx.sessionId);
    await dmApprover(
      approvalCtx.userId,
      `[${trigger.id}] Repo prep before autonomous repair: started on \`${branch.startedOn}\`, ` +
        `${branch.stashed ? 'stashed outstanding changes, ' : 'no outstanding changes to stash, '}` +
        `now on \`${branch.name}\`. The system will keep running off this branch until you review and merge.`,
    );

    const prompt =
      trigger.freeformPrompt(ctx, payload.previousReport) +
      `\n\nYou are on git branch \`${branch.name}\`, a breakfix branch cut for this repair — do not push or merge it yourself.`;
    const report = await runGatekeptRepairTurn(prompt, trigger.id, branch.name);

    if (report === TIER2_LOCKED_SENTINEL) {
      await dmApprover(
        approvalCtx.userId,
        `[${trigger.id}] Gatekeeper refused — tier 2 was already used by another concurrent request. No turn ran.`,
      );
      return;
    }

    const stillBroken = trigger.stillBroken(ctx);
    const status = stillBroken ? '❌ Still broken — needs manual intervention.' : '✅ Verified fixed.';
    await dmApprover(approvalCtx.userId, `[${trigger.id}] Autonomous repair report:\n\n${report}\n\n${status}`);

    if (!stillBroken) {
      await dmApprover(approvalCtx.userId, `[${trigger.id}] Rebuilding and restarting the host service…`);
      trigger.onRecovered(ctx);
      rebuildAndRestartHost();
    }
  });
}

/**
 * Entry point for any code path that catches an error and wants to check it
 * against the whitelist. No-op if nothing matches — callers don't need to
 * guard the call themselves.
 */
export function offerRepairIfWhitelisted(triggerId: string, ctx: RepairContext): void {
  const trigger = triggers.get(triggerId);
  if (!trigger) return;

  const session = getSession(ctx.sessionId);
  if (!session) return;

  requestApproval({
    session,
    agentName: `repair-agent:${trigger.id}`,
    action: step1Action(trigger.id),
    payload: ctx as unknown as Record<string, unknown>,
    title: trigger.title,
    question: `${trigger.summarize(ctx).slice(0, 5).join('\n')}\n\nAuthorize an automated repair turn (Claude Code, scoped to this session's container)?`,
  }).catch((err) => log.error('repair-agent: failed to offer repair', { triggerId, err }));
}

function step1Action(triggerId: string): string {
  return `repair_${triggerId}_step1`;
}
function step2Action(triggerId: string): string {
  return `repair_${triggerId}_step2`;
}

async function runContainerRepairTurn(session: Session, prompt: string): Promise<string> {
  const containerName = getContainerName(session.id);
  if (!containerName) return '(no report — session container is not running)';

  try {
    const { stdout } = await execFileAsync(
      CONTAINER_RUNTIME_BIN,
      [
        'exec',
        '-w',
        '/workspace',
        '-e',
        `ANTHROPIC_BASE_URL=http://${CONTAINER_HOST_GATEWAY}:8787`,
        '-e',
        'ANTHROPIC_API_KEY=INJECTED_BY_ONECLI',
        containerName,
        'claude',
        '-p',
        prompt,
        '--dangerously-skip-permissions',
      ],
      { timeout: REPAIR_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 },
    );
    return stdout.trim() || '(repair turn produced no output)';
  } catch (err) {
    log.error('repair-agent: container repair turn failed', { sessionId: session.id, err });
    const message = err instanceof Error ? err.message : String(err);
    return `(repair turn errored: ${message.slice(0, 2000)})`;
  }
}

const TIER2_LOCKED_SENTINEL = '\0TIER2_LOCKED\0';

/**
 * Runs tier 2 through the external gatekeeper script — Node never calls
 * `claude --dangerously-skip-permissions` directly for tier 2. The prompt is
 * written to a temp file outside the repo (avoids arg-length/shell-escaping
 * issues) and passed by path.
 */
async function runGatekeptRepairTurn(prompt: string, triggerId: string, branch: string): Promise<string> {
  const promptFile = path.join(GATE_ROOT, `tier2-prompt-${Date.now()}.txt`);
  const usedFile = path.join(GATE_ROOT, `tier2.used-${Date.now()}`);
  try {
    fs.writeFileSync(promptFile, prompt, { mode: 0o600 });
    const { stdout } = await execFileAsync(
      'bash',
      [GATEKEEPER_SCRIPT, AVAILABLE_FILE, usedFile, process.cwd(), triggerId, branch, promptFile],
      { timeout: REPAIR_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 },
    );
    return stdout.trim() || '(repair turn produced no output)';
  } catch (err) {
    const code = (err as { code?: number }).code;
    if (code === TIER2_LOCKED_EXIT_CODE) return TIER2_LOCKED_SENTINEL;
    log.error('repair-agent: gatekept repair turn failed', { err });
    const message = err instanceof Error ? err.message : String(err);
    return `(repair turn errored: ${message.slice(0, 2000)})`;
  } finally {
    fs.rmSync(promptFile, { force: true });
  }
}

interface BreakfixBranch {
  name: string;
  startedOn: string;
  stashed: boolean;
}

function prepareBreakfixBranch(sessionId: string): BreakfixBranch {
  const cwd = process.cwd();
  const git = (args: string[]): string =>
    execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();

  const startedOn = git(['rev-parse', '--abbrev-ref', 'HEAD']);
  const dirty = git(['status', '--porcelain']).length > 0;
  let stashed = false;
  if (dirty) {
    git(['stash', 'push', '-u', '-m', `auto-stash before breakfix (session ${sessionId})`]);
    stashed = true;
  }
  const name = `breakfix/${sessionId}-${Date.now()}`;
  git(['checkout', '-b', name]);
  return { name, startedOn, stashed };
}

/** Rebuilds dist/ (in case the repair touched source, not just data) and restarts the host service via
 *  setup/lib/restart.sh (cross-platform: launchd on macOS, systemd on Linux). Fire-and-forget on the restart —
 *  this process is about to be SIGTERM'd by it. */
function rebuildAndRestartHost(): void {
  try {
    execFileSync('pnpm', ['run', 'build'], { cwd: process.cwd(), stdio: 'pipe', timeout: REBUILD_TIMEOUT_MS });
  } catch (err) {
    log.error('repair-agent: rebuild before restart failed', { err });
  }
  execFile('bash', [path.join('setup', 'lib', 'restart.sh')], { cwd: process.cwd() });
}

async function dmApprover(userId: string, text: string): Promise<void> {
  const adapter = getDeliveryAdapter();
  if (!adapter) return;
  const mg = await ensureUserDm(userId);
  if (!mg) return;
  await adapter.deliver(mg.channel_type, mg.platform_id, null, 'chat-sdk', JSON.stringify({ text }));
}
