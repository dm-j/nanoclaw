/**
 * "Try again" card — when host-sweep gives up on a message after MAX_TRIES
 * (see host-sweep.ts resetStuckProcessingRows), tell the user instead of
 * letting it die silently, with a button that requeues it.
 *
 * ponytail: pending cards live in-memory only. A host restart drops any
 * outstanding "Try again" button (click does nothing, no crash) — fine for a
 * best-effort UX nicety; upgrade to a DB row if that turns out to matter.
 */
import { normalizeOptions, type RawOption } from '../../channels/ask-question.js';
import { getMessagingGroup } from '../../db/messaging-groups.js';
import { getSession } from '../../db/sessions.js';
import { requeueFailedMessage } from '../../db/session-db.js';
import { wakeContainer } from '../../container-runner.js';
import { getDeliveryAdapter } from '../../delivery.js';
import { log } from '../../log.js';
import { registerResponseHandler, type ResponsePayload } from '../../response-registry.js';
import { openInboundDb } from '../../session-manager.js';

const pending = new Map<string, { sessionId: string; messageId: string }>();

const OPTIONS: RawOption[] = [{ label: 'Try again', selectedLabel: '🔄 Retrying…', value: 'retry', style: 'primary' }];

/** Card the user whose message just got marked 'failed' after exhausting retries. */
export async function sendTimeoutRetryCard(sessionId: string, messageId: string): Promise<void> {
  const session = getSession(sessionId);
  const mg = session?.messaging_group_id ? getMessagingGroup(session.messaging_group_id) : null;
  const adapter = getDeliveryAdapter();
  if (!session || !mg || !adapter) return;

  const questionId = `tr-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  pending.set(questionId, { sessionId, messageId });

  try {
    await adapter.deliver(
      mg.channel_type,
      mg.platform_id,
      session.thread_id,
      'chat-sdk',
      JSON.stringify({
        type: 'ask_question',
        questionId,
        title: '⏱️ Timed out',
        question: 'That took too long and was stopped.',
        options: normalizeOptions(OPTIONS),
      }),
    );
  } catch (err) {
    pending.delete(questionId);
    log.error('Failed to deliver timeout retry card', { sessionId, messageId, err });
  }
}

async function handleRetryResponse(payload: ResponsePayload): Promise<boolean> {
  if (!payload.questionId.startsWith('tr-')) return false;
  const item = pending.get(payload.questionId);
  if (!item) return false;
  pending.delete(payload.questionId);
  if (payload.value !== 'retry') return true;

  const session = getSession(item.sessionId);
  if (!session) return true;

  const inDb = openInboundDb(session.agent_group_id, session.id);
  try {
    requeueFailedMessage(inDb, item.messageId);
  } finally {
    inDb.close();
  }
  await wakeContainer(session);
  log.info('Timeout retry requeued', { sessionId: item.sessionId, messageId: item.messageId });
  return true;
}

registerResponseHandler(handleRetryResponse);
