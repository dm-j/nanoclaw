/**
 * Validation + hold-request builder for `mbif_crew_prompt`.
 *
 * The guard wraps the delivery action (see ./guard.ts — unconditional hold
 * from the container path): validation here runs as the wrapper's precheck,
 * and requestMbifCrewHold builds the approval card. On approve, the
 * continuation re-enters the wrapped action and ./apply.ts runs.
 */
import { getAgentGroup } from '../../db/agent-groups.js';
import type { Session } from '../../types.js';
import { notifyAgent, requestApproval } from '../approvals/index.js';

const MAX_INSTRUCTION_LENGTH = 4000;

export function validateMbifCrewPrompt(content: Record<string, unknown>, session: Session): boolean {
  const instruction = typeof content.instruction === 'string' ? content.instruction.trim() : '';
  if (!instruction) {
    notifyAgent(session, 'mbif_crew_prompt failed: instruction is required.');
    return false;
  }
  if (instruction.length > MAX_INSTRUCTION_LENGTH) {
    notifyAgent(session, `mbif_crew_prompt failed: instruction exceeds ${MAX_INSTRUCTION_LENGTH} characters.`);
    return false;
  }
  if (!getAgentGroup(session.agent_group_id)) {
    notifyAgent(session, 'mbif_crew_prompt failed: agent group not found.');
    return false;
  }
  return true;
}

export async function requestMbifCrewHold(content: Record<string, unknown>, session: Session): Promise<void> {
  const agentGroup = getAgentGroup(session.agent_group_id);
  if (!agentGroup) return;
  const instruction = (content.instruction as string).trim();

  await requestApproval({
    session,
    agentName: agentGroup.name,
    action: 'mbif_crew_prompt',
    payload: { instruction },
    title: 'MBIF Crew Instruction',
    question: `${agentGroup.name} wishes to execute the following instruction in the vault: ${instruction}`,
  });
}
