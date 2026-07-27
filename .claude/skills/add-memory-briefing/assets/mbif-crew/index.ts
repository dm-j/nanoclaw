/**
 * MBIF-crew module — lets an agent hand freeform instructions to the vault's
 * own Claude Code ("Sort the inbox", "defragment my vault").
 *
 * Always holds for admin approval (unconditional guard, ./guard.ts) — the
 * container's `prompt_mbif_crew` MCP tool writes an outbound `mbif_crew_prompt`
 * system action, the registry cards the admin ("{agent} wishes to execute the
 * following instruction in the vault: {instruction}"), and on approve
 * ./apply.ts runs `claude -p` in the vault with a git checkpoint before and
 * after (rollback safety net for an ill-advised instruction).
 *
 * Silent reject: this is the one action registered via registerSilentReject
 * — a denial is never relayed to the agent, matching the "if denied, agent
 * is not notified, the command never happens" requirement. Approve is the
 * only outcome the agent ever hears about.
 *
 * Without this module: the MCP tool still writes the outbound system
 * message, but delivery logs "Unknown system action" and drops it — no card,
 * nothing changes, same fail-safe-by-omission as self-mod.
 */
import { reenterGuardedDeliveryAction, registerDeliveryAction } from '../../delivery.js';
import { deletePendingApproval, getPendingApprovalsByAction, getSession } from '../../db/sessions.js';
import { log } from '../../log.js';
import { registerApprovalHandler, registerApprovalResolvedHandler, registerSilentReject } from '../approvals/index.js';
import { finalizeReject } from '../approvals/finalize.js';
import { applyMbifCrewPrompt } from './apply.js';
import { mbifCrewPrompt } from './guard.js';
import { appendMbifCrewLog } from './log.js';
import { requestMbifCrewHold, validateMbifCrewPrompt } from './request.js';

const STALE_TIMEOUT_MS = 12 * 60 * 60 * 1000;

registerDeliveryAction('mbif_crew_prompt', applyMbifCrewPrompt, {
  guardAction: mbifCrewPrompt,
  precheck: validateMbifCrewPrompt,
  requestHold: requestMbifCrewHold,
  // No onDeny notification — see registerSilentReject below.
});

registerApprovalHandler('mbif_crew_prompt', reenterGuardedDeliveryAction('mbif_crew_prompt'));
registerSilentReject('mbif_crew_prompt');

// Denial isn't relayed to the agent (registerSilentReject above) but must
// still hit the audit log. Approval logging (with commit IDs) happens
// inline in apply.ts since that's where the commits actually happen.
registerApprovalResolvedHandler(({ approval, outcome }) => {
  if (approval.action !== 'mbif_crew_prompt' || outcome !== 'reject') return;
  const payload = JSON.parse(approval.payload) as { instruction?: string };
  appendMbifCrewLog({
    agentGroupId: approval.agent_group_id ?? '',
    instruction: payload.instruction ?? '',
    outcome: 'denied',
  });
});

/**
 * Called once per host-sweep tick (host-sweep.ts). Any prompt_mbif_crew hold
 * older than 12h is finalized as a silent deny — finalizeReject respects
 * registerSilentReject above, so the agent hears nothing; the denial still
 * lands in the audit log via the resolved-handler.
 */
export async function sweepStaleMbifCrewRequests(): Promise<void> {
  const cutoff = Date.now() - STALE_TIMEOUT_MS;
  for (const approval of getPendingApprovalsByAction('mbif_crew_prompt')) {
    if (new Date(approval.created_at).getTime() > cutoff) continue;
    const session = approval.session_id ? getSession(approval.session_id) : null;
    if (!session) {
      deletePendingApproval(approval.approval_id);
      continue;
    }
    await finalizeReject(approval, session, '');
    log.info('mbif_crew_prompt: 12h timeout elapsed, denied', { approvalId: approval.approval_id });
  }
}
