/**
 * Mailman webhook handler.
 *
 * Registers a raw webhook at /webhook/mailman that accepts email payloads
 * and spawns a triage subagent.
 */
import { registerWebhookHandler } from '../webhook-server.js';
import { log } from '../log.js';
import { spawnSubagent, type TriageInput } from './subagent.js';

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

    let input: TriageInput;
    try {
      const body = Buffer.concat(chunks).toString();
      input = JSON.parse(body) as TriageInput;
      if (!input.from || !input.subject || !input.body) {
        throw new Error('Missing required fields: from, subject, body');
      }
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: (err as Error).message }));
      return;
    }

    try {
      const result = await spawnSubagent(input);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result, null, 2));
    } catch (err) {
      log.error('Mailman triage failed', { err });
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Triage failed', detail: (err as Error).message }));
    }
  });

  log.info('Mailman webhook registered at /webhook/mailman');
}
