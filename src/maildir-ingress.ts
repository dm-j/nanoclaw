/**
 * Maildir ingress — writes RFC822 copies of inbound messages to the agent
 * group's mail/inbox/new/ directory. Fire-and-forget; failures are logged
 * but never propagate to the session DB path.
 */
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { GROUPS_DIR } from './config.js';
import { scaffoldOutboxMaildir } from './group-init.js';
import { log } from './log.js';
import { watchNewOutbox } from './maildir-egress.js';
import type { AgentGroup, MessagingGroup } from './types.js';
import type { InboundEvent } from './channels/adapter.js';

/**
 * Channel adaptors implement this to control per-message Maildir headers.
 * Registered via `registerMaildirAdaptor()`, keyed by channel type.
 */
export interface MaildirAdaptor {
  responseExpected(event: InboundEvent, mg: MessagingGroup): string;
  threadId(event: InboundEvent, mg: MessagingGroup): string;
}

const adaptors = new Map<string, MaildirAdaptor>();

export function registerMaildirAdaptor(channelType: string, adaptor: MaildirAdaptor): void {
  adaptors.set(channelType, adaptor);
}

function maildirFilename(): string {
  const ts = Math.floor(Date.now() / 1000);
  const usec = (Date.now() % 1000) * 1000;
  return `${ts}.M${usec}P${process.pid}.${os.hostname()}`;
}

function safeParseContent(raw: string): { text?: string; sender?: string; senderId?: string } {
  try {
    return JSON.parse(raw);
  } catch {
    return { text: raw };
  }
}

/**
 * Write an RFC822 message to the agent group's mail/inbox/new/.
 * Also ensures the response outbox exists so the agent can reply.
 */
export function writeMaildirIngress(
  agentGroup: AgentGroup,
  mg: MessagingGroup,
  event: InboundEvent,
  userId: string | null,
): void {
  try {
    const inboxNew = path.join(GROUPS_DIR, agentGroup.folder, 'mail', 'inbox', 'new');
    if (!fs.existsSync(inboxNew)) return;

    const parsed = safeParseContent(event.message.content);
    const sender = userId ?? parsed.sender ?? 'unknown';
    const body = parsed.text ?? '';
    const now = new Date();
    const messageId = `<${crypto.randomUUID()}@${os.hostname()}>`;
    const adaptor = adaptors.get(event.channelType);
    const threadId = adaptor ? adaptor.threadId(event, mg) : (event.threadId ?? mg.id);
    const responseExpected = adaptor ? adaptor.responseExpected(event, mg) : 'yes';

    // Ensure the response outbox exists. Convention: mail/out/<channel>/<chatId>/
    const chatId = event.platformId.includes(':')
      ? event.platformId.split(':').slice(1).join(':')
      : event.platformId;
    const addressPath = chatId;
    const outboxDir = path.join(GROUPS_DIR, agentGroup.folder, 'mail', 'out', event.channelType, addressPath);
    if (!fs.existsSync(path.join(outboxDir, 'new'))) {
      scaffoldOutboxMaildir(agentGroup.folder, event.channelType, addressPath);

      // Write .binding if it doesn't exist.
      const bindingFile = path.join(outboxDir, '.binding');
      if (!fs.existsSync(bindingFile)) {
        const bindingLines = [
          `Channel-Type: ${event.channelType}`,
          `Chat-ID: ${chatId}`,
          `Platform-ID: ${event.platformId}`,
        ];
        if (mg.name) bindingLines.push(`Display-Name: ${mg.name}`);
        if (mg.is_group) bindingLines.push(`Is-Group: true`);
        fs.writeFileSync(bindingFile, bindingLines.join('\n') + '\n');
      }

      watchNewOutbox(agentGroup.folder, event.channelType, addressPath);
    }

    const responseMaildir = `/workspace/mail/out/${event.channelType}/${addressPath}`;

    const headers = [
      `From: ${sender}`,
      `To: ${agentGroup.name ?? agentGroup.folder}`,
      `Date: ${now.toUTCString()}`,
      `Message-ID: ${messageId}`,
      `Thread-ID: ${threadId}`,
      `Response-Maildir: ${responseMaildir}`,
      `Response-Expected: ${responseExpected}`,
      `Channel-Type: ${event.channelType}`,
      `Platform-ID: ${event.platformId}`,
      `Content-Type: text/plain; charset=utf-8`,
    ];

    if (event.threadId) {
      headers.push(`X-Thread-ID: ${event.threadId}`);
    }

    const message = headers.join('\n') + '\n\n' + body + '\n';

    // Atomic write: tmp/ → rename to new/
    const filename = maildirFilename();
    const tmpPath = path.join(GROUPS_DIR, agentGroup.folder, 'mail', 'inbox', 'tmp', filename);
    const newPath = path.join(inboxNew, filename);
    fs.writeFileSync(tmpPath, message);
    fs.renameSync(tmpPath, newPath);

    log.debug('Maildir ingress written', {
      folder: agentGroup.folder,
      channelType: event.channelType,
      messageId,
    });
  } catch (err) {
    log.warn('Maildir ingress write failed', { folder: agentGroup.folder, err });
  }
}
