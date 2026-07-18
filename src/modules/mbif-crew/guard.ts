/**
 * MBIF-crew guard adapter — unconditional hold from the container path.
 *
 * Same shape as self-mod/guard.ts: invoking Claude Code freeform against the
 * live vault (rename/move/delete files, rewrite notes) is a privileged,
 * effectively-unbounded host-side operation, so there is no "trusted" tier
 * that skips approval — every request from the container holds for the
 * user's admin chain.
 */
import { DENY, HOLD, defineGuardedAction, type GuardInput } from '../../guard/index.js';

function mbifCrewDecide(input: GuardInput) {
  if (input.actor.kind !== 'agent') {
    return DENY('mbif_crew_prompt is a container-originated action.');
  }
  return HOLD('mbif_crew_prompt always requires admin approval from the container path');
}

export const mbifCrewPrompt = defineGuardedAction({
  action: 'mbif_crew.prompt',
  grantActionName: 'mbif_crew_prompt',
  decide: mbifCrewDecide,
});
