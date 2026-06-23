import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { ProxyAgent, fetch as undiciFetch } from 'undici';

import { log } from '../log.js';

const PROJECT_ROOT = path.resolve(import.meta.dirname, '../..');
const INBOX_TMP = path.join(PROJECT_ROOT, 'mailman/inbox/tmp');
const INBOX_NEW = path.join(PROJECT_ROOT, 'mailman/inbox/new');

const ONECLI_LOCAL_URL = 'http://127.0.0.1:10254';
const GMAIL_API = 'https://gmail.googleapis.com/gmail/v1/users/me';

export interface GmailFeedConfig {
  feedName: string;
  agentId: string;
  pollIntervalS: number;
  maxAgeDays: number;
  query: string;
}

interface ProxyContext {
  dispatcher: ProxyAgent;
}

async function getProxyContext(agentId: string): Promise<ProxyContext | null> {
  const url = `${ONECLI_LOCAL_URL}/api/container-config?agent=${encodeURIComponent(agentId)}`;
  let res: Response;
  try {
    res = await fetch(url);
  } catch {
    log.warn('OneCLI not reachable — Gmail ingress skipping this cycle', { agentId });
    return null;
  }

  if (!res.ok) {
    const body = await res.text();
    log.error('OneCLI container-config failed', { agentId, status: res.status, body });
    return null;
  }

  const config = (await res.json()) as {
    env: Record<string, string>;
    caCertificate: string;
    caCertificateContainerPath: string;
  };
  const proxyUrl = config.env.HTTPS_PROXY || config.env.https_proxy;
  if (!proxyUrl) {
    log.error('OneCLI config has no HTTPS_PROXY', { agentId });
    return null;
  }

  const caPath = path.join(os.tmpdir(), `onecli-gmail-${agentId}-ca.pem`);
  fs.writeFileSync(caPath, config.caCertificate);
  const ca = fs.readFileSync(caPath);

  return { dispatcher: new ProxyAgent({ uri: proxyUrl, connect: { ca } }) };
}

function maildirFilename(): string {
  const ts = Math.floor(Date.now() / 1000);
  const usec = (Date.now() % 1000) * 1000;
  const pid = process.pid;
  const host = os.hostname();
  const uniq = crypto.randomBytes(4).toString('hex');
  return `${ts}.M${usec}P${pid}Q${uniq}.${host}`;
}

function writeToMaildir(rfc822: Buffer, feedName: string): string {
  fs.mkdirSync(INBOX_TMP, { recursive: true });
  fs.mkdirSync(INBOX_NEW, { recursive: true });

  // Stamp trusted headers — Gmail API authenticates via OAuth, Google verifies DKIM/SPF
  const fromMatch = rfc822.toString().match(/^From:\s*(.+)$/m);
  const verifiedFrom = fromMatch ? `X-Verified-From: ${fromMatch[1].trim()}\n` : '';
  const stamped = Buffer.concat([
    Buffer.from(`X-Mailman-Source: ${feedName}\nX-Mailman-Trust: gmail-api\n${verifiedFrom}`),
    rfc822,
  ]);

  const filename = maildirFilename();
  const tmpPath = path.join(INBOX_TMP, filename);
  const newPath = path.join(INBOX_NEW, filename);

  fs.writeFileSync(tmpPath, stamped);
  fs.renameSync(tmpPath, newPath);

  return filename;
}

async function gmailFetch(
  urlPath: string,
  ctx: ProxyContext,
  options?: { method?: string; body?: string },
): Promise<Response> {
  return undiciFetch(`${GMAIL_API}${urlPath}`, {
    method: options?.method || 'GET',
    body: options?.body,
    headers: options?.body ? { 'Content-Type': 'application/json' } : undefined,
    dispatcher: ctx.dispatcher,
  }) as unknown as Response;
}

async function pollOnce(config: GmailFeedConfig): Promise<void> {
  const ctx = await getProxyContext(config.agentId);
  if (!ctx) return;

  try {
    const query = `${config.query} newer_than:${config.maxAgeDays}d`;
    const listRes = await gmailFetch(`/messages?q=${encodeURIComponent(query)}&maxResults=10`, ctx);
    if (!listRes.ok) {
      const body = await listRes.text();
      log.error('Gmail list failed', { feed: config.feedName, status: listRes.status, body: body.slice(0, 300) });
      return;
    }

    const listData = (await listRes.json()) as { messages?: Array<{ id: string }> };
    if (!listData.messages?.length) return;

    log.info('Gmail poll found messages', { feed: config.feedName, count: listData.messages.length });

    for (const msg of listData.messages) {
      const rawRes = await gmailFetch(`/messages/${msg.id}?format=raw`, ctx);
      if (!rawRes.ok) {
        log.warn('Gmail fetch raw failed', { feed: config.feedName, msgId: msg.id, status: rawRes.status });
        continue;
      }

      const rawData = (await rawRes.json()) as { raw?: string };
      if (!rawData.raw) continue;

      const rfc822 = Buffer.from(rawData.raw, 'base64url');
      const filename = writeToMaildir(rfc822, config.feedName);
      log.info('Gmail message delivered', { feed: config.feedName, msgId: msg.id, filename });

      await gmailFetch(`/messages/${msg.id}/modify`, ctx, {
        method: 'POST',
        body: JSON.stringify({ removeLabelIds: ['UNREAD'] }),
      });
    }
  } catch (err) {
    log.error('Gmail poll failed', { feed: config.feedName, err });
  } finally {
    ctx.dispatcher.close();
  }
}

export function startGmailFeed(config: GmailFeedConfig): { stop: () => void } {
  let running = true;

  // Verify OneCLI is reachable before starting the poll loop
  getProxyContext(config.agentId).then((ctx) => {
    if (!ctx) {
      log.info('Gmail feed not starting — OneCLI not configured', { feed: config.feedName, agentId: config.agentId });
      return;
    }
    ctx.dispatcher.close();

    log.info('Gmail feed started', { feed: config.feedName, pollIntervalS: config.pollIntervalS });

    pollOnce(config).catch((err) => log.error('Initial Gmail poll failed', { feed: config.feedName, err }));

    const timer = setInterval(() => {
      if (running) pollOnce(config).catch((err) => log.error('Gmail poll failed', { feed: config.feedName, err }));
    }, config.pollIntervalS * 1000);

    // Replace stop fn to clear the interval
    handle.stop = () => {
      running = false;
      clearInterval(timer);
      log.info('Gmail feed stopped', { feed: config.feedName });
    };
  });

  const handle = {
    stop: () => {
      running = false;
    },
  };
  return handle;
}
