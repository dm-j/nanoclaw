/**
 * Memory-briefing module — host-side handler for the container's `recall`
 * MCP tool.
 *
 * The container can't reach the vault filesystem or a `claude` CLI pointed at
 * it, so `recall` just writes an outbound system action (see
 * container/agent-runner/src/mcp-tools/briefing.ts). This module runs the
 * actual `briefer` subagent host-side (src/memory-briefing/briefer.ts, which
 * has MBIF_VAULT_PATH) and delivers the result back as a normal inbound chat
 * message, waking the container so the agent sees it.
 */
import { buildBrieferPrompt, runBriefer } from '../../memory-briefing/briefer.js';
import { log } from '../../log.js';
import { wakeContainer } from '../../container-runner.js';
import { getSession } from '../../db/sessions.js';
import { writeSessionMessage } from '../../session-manager.js';
import type { Session } from '../../types.js';
import { registerDeliveryAction } from '../../delivery.js';

function notifyAgent(session: Session, text: string): void {
  writeSessionMessage(session.agent_group_id, session.id, {
    id: `sys-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    kind: 'chat',
    timestamp: new Date().toISOString(),
    platformId: session.agent_group_id,
    channelType: 'agent',
    threadId: null,
    content: JSON.stringify({ text, sender: 'system', senderId: 'system' }),
  });
  const fresh = getSession(session.id);
  if (fresh) {
    wakeContainer(fresh).catch((err) => log.error('Failed to wake container after recall', { err }));
  }
}

async function handleRecall(content: Record<string, unknown>, session: Session): Promise<void> {
  const topic = typeof content.topic === 'string' ? content.topic : '';
  if (!topic) {
    notifyAgent(session, 'recall failed: topic is required.');
    return;
  }

  try {
    // No recent-turns window here — this is the on-demand ask-for-it-yourself
    // path, not the always-on per-turn packet. Lumen supplies whatever context
    // she thinks briefer needs directly in `topic`.
    const result = await runBriefer(buildBrieferPrompt([], topic));
    notifyAgent(session, result.briefing);
  } catch (err) {
    log.warn('recall failed', { err, topic });
    notifyAgent(session, `Recall failed: ${(err as Error).message}`);
  }
}

registerDeliveryAction('recall', handleRecall);
