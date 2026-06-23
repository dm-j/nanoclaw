import { readEnvFile } from '../env.js';
import { log } from '../log.js';
import { wakeContainer } from '../container-runner.js';
import { resolveSession, writeSessionMessage } from '../session-manager.js';
import { getSession } from '../db/sessions.js';
import type { TriageResult } from './subagent.js';
import type { ForkResult } from './fork.js';

const env = readEnvFile(['MAILMAN_AGENT_GROUP_ID']);
const AGENT_GROUP_ID = process.env.MAILMAN_AGENT_GROUP_ID || env.MAILMAN_AGENT_GROUP_ID;

export function notifyMainAgent(triage: TriageResult, fork: ForkResult): void {
  if (!AGENT_GROUP_ID) {
    log.warn('MAILMAN_AGENT_GROUP_ID not set — skipping notification delivery');
    return;
  }

  try {
    const { session } = resolveSession(AGENT_GROUP_ID, null, null, 'agent-shared');

    const msgId = `mailman-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    writeSessionMessage(AGENT_GROUP_ID, session.id, {
      id: msgId,
      kind: 'chat',
      timestamp: new Date().toISOString(),
      platformId: AGENT_GROUP_ID,
      channelType: 'agent',
      threadId: null,
      content: JSON.stringify({
        text: [
          `[Mailman] Email requires attention:`,
          `From: ${triage.sender}`,
          `Subject: ${triage.subject}`,
          `Summary: ${triage.summary}`,
          `Reasoning: ${fork.reasoning}`,
        ].join('\n'),
        sender: 'mailman',
        senderId: 'mailman',
      }),
    });

    const fresh = getSession(session.id);
    if (fresh) {
      wakeContainer(fresh).catch((err) => log.error('Failed to wake container for mailman notification', { err }));
    }

    log.info('Notification delivered to main agent', { agentGroupId: AGENT_GROUP_ID, sessionId: session.id });
  } catch (err) {
    log.error('Failed to deliver mailman notification', { agentGroupId: AGENT_GROUP_ID, err });
  }
}
