/**
 * Host-shim module — lets a container agent invoke a whitelisted host-side
 * executable by name (e.g. the Obsidian CLI, which needs the real Obsidian
 * app running on the host).
 *
 * Container writes a `host_shim_exec` system message (see
 * container/agent-runner/src/tools/host-shim.ts); this module runs the
 * matching `<name>-host` script (./exec.ts, the actual whitelist check) and
 * writes the result back as a `host_shim_response` system message with
 * trigger=0 so it's an inline reply to the tool call, not a wake.
 *
 * Guard always allows (./guard.ts) — the whitelist-file check is the real
 * security boundary, not a human approval gate.
 */
import { registerDeliveryAction } from '../../delivery.js';
import { writeSessionMessage } from '../../session-manager.js';
import { log } from '../../log.js';
import { execHostShim } from './exec.js';
import { hostShimExec } from './guard.js';

registerDeliveryAction(
  'host_shim_exec',
  async (content, session) => {
    const requestId = content.requestId as string;
    const name = content.name as string;
    const args = Array.isArray(content.args) ? (content.args as unknown[]).map(String) : [];

    if (!requestId || !name) {
      log.warn('host_shim_exec missing requestId or name', { sessionId: session.id });
      return;
    }

    log.info('host-shim request', { requestId, name, sessionId: session.id });
    const response = await execHostShim(name, args);

    writeSessionMessage(session.agent_group_id, session.id, {
      id: `shim-resp-${requestId}`,
      kind: 'system',
      timestamp: new Date().toISOString(),
      content: JSON.stringify({
        type: 'host_shim_response',
        requestId,
        response: { requestId, ...response },
      }),
      trigger: 0,
    });

    log.info('host-shim response written', { requestId, name, ok: response.ok, sessionId: session.id });
  },
  {
    guardAction: hostShimExec,
    requestHold: async () => {
      // Unreachable: hostShimExec's decide() always returns ALLOW.
      log.error('host_shim_exec guard unexpectedly requested a hold');
    },
  },
);
