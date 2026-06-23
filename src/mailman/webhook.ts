/**
 * Mailman webhook handler.
 *
 * Accepts raw RFC822 email via POST to /webhook/mailman.
 * Two-stage flow: triage → fork evaluation (if escalation).
 */
import { registerWebhookHandler } from '../webhook-server.js';
import { log } from '../log.js';
import { spawnFork, type EscalationPayload } from './fork.js';
import { notifyMainAgent } from './notify.js';
import { spawnSubagent } from './subagent.js';

export function registerMailmanWebhook(): void {
  registerWebhookHandler('mailman', async (req, res) => {
    if (req.method !== 'POST') {
      res.writeHead(405, { 'Content-Type': 'text/plain' });
      res.end('Method not allowed');
      return;
    }

    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(chunk as Buffer);
    }

    const rawEmail = Buffer.concat(chunks).toString();
    if (!rawEmail.trim()) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Empty body — expected RFC822 email' }));
      return;
    }

    try {
      const triageResult = await spawnSubagent(rawEmail);

      if (triageResult.action !== 'notify_user') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ stage: 'triage', outcome: 'deferred', triage: triageResult }, null, 2));
        return;
      }

      const escalation: EscalationPayload = {
        finding: triageResult.summary,
        evidence: [`Sender: ${triageResult.sender}`, `Subject: ${triageResult.subject}`],
        subagent_reasoning: triageResult.reasoning,
        source: 'input_subagent',
      };

      const forkResult = await spawnFork(escalation);

      if (forkResult.agree) {
        notifyMainAgent(triageResult, forkResult);
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify(
          {
            stage: 'fork',
            outcome: forkResult.agree ? 'notify' : 'discarded',
            triage: triageResult,
            fork: forkResult,
          },
          null,
          2,
        ),
      );
    } catch (err) {
      log.error('Mailman pipeline failed', { err });
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Pipeline failed', detail: (err as Error).message }));
    }
  });

  log.info('Mailman webhook registered at /webhook/mailman');
}
