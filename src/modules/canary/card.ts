/**
 * Delivery + resolution for canary-flagged content. Own id namespace
 * (`qc-...`, see quarantine.ts) and own response handler — parallel to, but
 * independent of, pending_approvals/pending_questions. Never touches the
 * flagged text in a log line (see quarantine.ts's header for why).
 */
import { normalizeOptions, type RawOption } from '../../channels/ask-question.js';
import { getSession } from '../../db/sessions.js';
import { wakeContainer } from '../../container-runner.js';
import { getDeliveryAdapter } from '../../delivery.js';
import { log } from '../../log.js';
import { registerResponseHandler, type ResponsePayload } from '../../response-registry.js';
import { writeSessionMessage } from '../../session-manager.js';
import { pickApprovalDelivery, pickApprover } from '../approvals/primitive.js';
import {
  createQuarantineItem,
  deferQuarantineItem,
  deleteQuarantineItem,
  getQuarantineItem,
  sendToOubliette,
  type QuarantineMessage,
} from './quarantine.js';

async function notifyOwner(text: string): Promise<void> {
  const target = await pickApprovalDelivery(pickApprover(null), '');
  const adapter = getDeliveryAdapter();
  if (!target || !adapter) {
    log.error('Canary notify: no reachable owner or no delivery adapter set');
    return;
  }
  await adapter.deliver(
    target.messagingGroup.channel_type,
    target.messagingGroup.platform_id,
    null,
    'chat-sdk',
    JSON.stringify({ text }),
  );
}

const OPTIONS: RawOption[] = [
  { label: 'Approve', selectedLabel: '✅ Approved — sent through', value: 'approve', style: 'primary' },
  { label: 'Flag for extra scrutiny', selectedLabel: '🚩 Flagged', value: 'flag' },
  { label: 'Defer 1h', selectedLabel: '⏳ Deferred 1h', value: 'defer' },
  { label: 'Drop', selectedLabel: '🗑️ Dropped', value: 'drop', style: 'danger' },
];

async function deliverCard(item: { id: string }, reason: string, preview: string): Promise<void> {
  const approvers = pickApprover(null); // owners/global admins only — this never goes to a scoped agent-group admin
  const target = await pickApprovalDelivery(approvers, '');
  if (!target) {
    log.error('Canary card: no reachable owner/admin to deliver to', { itemId: item.id });
    return;
  }

  const adapter = getDeliveryAdapter();
  if (!adapter) {
    log.error('Canary card: no delivery adapter set', { itemId: item.id });
    return;
  }

  await adapter.deliver(
    target.messagingGroup.channel_type,
    target.messagingGroup.platform_id,
    null,
    'chat-sdk',
    JSON.stringify({
      type: 'ask_question',
      questionId: item.id,
      title: '🐤 Canary tripped',
      question:
        `The canary check flagged an incoming message (${reason}). It is being held out of Lumen's ` +
        `session and out of any log Lumen can read until you decide.\n\n---\n${preview}\n---`,
      options: normalizeOptions(OPTIONS),
    }),
  );
}

export interface QuarantineRequest {
  agentGroupId: string;
  sessionId: string;
  message: QuarantineMessage;
  reason: string;
  /** Plain text shown on the card. Caller's responsibility to keep it reasonably short. */
  preview: string;
}

/** Quarantine a flagged ("soft fail") message and card the owner for a decision. */
export async function quarantineAndCard(req: QuarantineRequest): Promise<void> {
  const item = createQuarantineItem({
    agentGroupId: req.agentGroupId,
    sessionId: req.sessionId,
    message: req.message,
    reason: req.reason,
  });
  await deliverCard(item, req.reason, req.preview);
}

export interface GuillotineRequest extends QuarantineRequest {
  trapTool: string;
}

/**
 * Guillotine path — a trap tool was invoked, treated as confirmed malicious
 * content. No card, no decision, no path back to the session: straight to
 * the oubliette (write-only audit trail) plus a plain notification. The
 * message text never reaches Lumen's session or any log she can read.
 */
export async function dropToOubliette(req: GuillotineRequest): Promise<void> {
  sendToOubliette({
    agentGroupId: req.agentGroupId,
    sessionId: req.sessionId,
    message: req.message,
    reason: req.reason,
    trapTool: req.trapTool,
  });
  await notifyOwner(
    `🔪 Canary guillotine — a message was caught invoking the trap tool "${req.trapTool}" and dropped. ` +
      `Treated as confirmed malicious content, no longer recoverable through the normal flow. ` +
      `Preview: ${req.preview}`,
  );
  log.error('Canary guillotine executed', { trapTool: req.trapTool, agentGroupId: req.agentGroupId });
}

async function handleCanaryResponse(payload: ResponsePayload): Promise<boolean> {
  if (!payload.questionId.startsWith('qc-')) return false;
  const item = getQuarantineItem(payload.questionId);
  if (!item) return false;

  switch (payload.value) {
    case 'approve':
    case 'flag': {
      const session = getSession(item.sessionId);
      if (session) {
        let content = item.message.content;
        if (payload.value === 'flag') {
          try {
            content = JSON.stringify({ ...JSON.parse(content), canaryFlagged: true });
          } catch {
            // Non-JSON content (shouldn't happen for 'chat' messages) — flag by leaving content as-is.
          }
        }
        writeSessionMessage(item.agentGroupId, item.sessionId, { ...item.message, content });
        await wakeContainer(session);
      } else {
        log.warn('Canary release: session gone', { itemId: item.id });
      }
      deleteQuarantineItem(item.id);
      break;
    }
    case 'defer':
      deferQuarantineItem(item.id, 1);
      // Re-carding on the deferred-due sweep is the caller's responsibility (see quarantine.ts's dueDeferredIds).
      break;
    case 'drop':
      deleteQuarantineItem(item.id);
      break;
    default:
      return false;
  }

  log.info('Canary item resolved', { itemId: item.id, decision: payload.value });
  return true;
}

registerResponseHandler(handleCanaryResponse);
