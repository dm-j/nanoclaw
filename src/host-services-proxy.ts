import crypto from 'crypto';
import http from 'http';
import net from 'net';
import { URL } from 'url';

import { getAgentGroupByFolder } from './db/agent-groups.js';
import { CONTAINER_INSTALL_LABEL } from './config.js';
import { log } from './log.js';

// ponytail: plain HTTP for .internal services, no TLS termination needed.
// The container stub uses http://memsearch.internal/... directly; we identify
// the caller by a per-container service token (macOS Docker Desktop NATs all
// container-to-host traffic to 127.0.0.1, making IP-based resolution impossible).
// External traffic still goes HTTPS through OneCLI via CONNECT tunnels.

const INTERNAL_TLD = '.internal';

interface ServiceHandler {
  access: 'all';
  handler: (req: http.IncomingMessage, res: http.ServerResponse, agentGroupId: string) => void | Promise<void>;
}

const services = new Map<string, ServiceHandler>();

export function registerHostService(hostname: string, service: ServiceHandler): void {
  services.set(hostname, service);
  log.info('Host service registered', { hostname });
}

// --- Agent identity from per-container service token ---

interface TokenRecord {
  agentGroupId: string;
  sessionId: string;
  createdAt: number;
}

const serviceTokens = new Map<string, TokenRecord>();

export function registerServiceToken(token: string, agentGroupId: string, sessionId: string): void {
  serviceTokens.set(token, { agentGroupId, sessionId, createdAt: Date.now() });
}

export function revokeServiceToken(token: string): void {
  serviceTokens.delete(token);
}

function resolveAgentByToken(req: http.IncomingMessage): string | null {
  const auth = req.headers.authorization ?? '';
  const match = /^Bearer\s+(\S+)$/i.exec(auth);
  if (!match) return null;
  const token = match[1];
  const record = serviceTokens.get(token);
  return record ? record.agentGroupId : null;
}

// --- Agent identity from container IP (fallback) ---

const ipToAgentGroup = new Map<string, string>();

function parseFolderFromContainerName(name: string): string | null {
  // Container names: nanoclaw-v2-<folder>-<timestamp>
  // Strip leading / from Docker API names
  const clean = name.startsWith('/') ? name.slice(1) : name;
  const match = clean.match(/^nanoclaw-v2-(.+)-\d+$/);
  return match ? match[1] : null;
}

async function refreshIpCache(): Promise<void> {
  // ponytail: shell out to docker CLI, not dockerode. One less dep.
  const { execSync } = await import('child_process');
  try {
    const out = execSync(`docker ps --filter "label=${CONTAINER_INSTALL_LABEL}" --format '{{.Names}} {{.ID}}'`, {
      encoding: 'utf-8',
      timeout: 5000,
    }).trim();
    if (!out) return;

    for (const line of out.split('\n')) {
      const [name, id] = line.split(' ');
      if (!name || !id) continue;

      const inspectOut = execSync(
        `docker inspect --format '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' ${id}`,
        { encoding: 'utf-8', timeout: 5000 },
      ).trim();
      if (!inspectOut) continue;

      const folder = parseFolderFromContainerName(name);
      if (!folder) continue;

      const group = getAgentGroupByFolder(folder);
      if (group) ipToAgentGroup.set(inspectOut, group.id);
    }
  } catch (err) {
    log.warn('Host services proxy: failed to refresh IP cache', { err });
  }
}

async function resolveAgent(remoteIp: string): Promise<string | null> {
  if (ipToAgentGroup.has(remoteIp)) return ipToAgentGroup.get(remoteIp)!;
  await refreshIpCache();
  return ipToAgentGroup.get(remoteIp) ?? null;
}

export function invalidateContainerIp(ip: string): void {
  ipToAgentGroup.delete(ip);
}

// --- Proxy server ---

// ponytail: hardcoded OneCLI proxy port. Change if OneCLI moves.
const ONECLI_PROXY_PORT = 10255;

function getRemoteIp(req: http.IncomingMessage | net.Socket): string {
  const socket = 'socket' in req ? req.socket : req;
  return socket.remoteAddress?.replace(/^::ffff:/, '') ?? '';
}

function isInternalHost(hostname: string): boolean {
  return hostname.endsWith(INTERNAL_TLD);
}

function getServiceName(hostname: string): string {
  // memsearch.internal → memsearch.internal (keep the full hostname as key)
  return hostname.toLowerCase();
}

let server: http.Server | null = null;

export function startHostServicesProxy(port: number): void {
  server = http.createServer(async (req, res) => {
    // Plain HTTP requests (not CONNECT) — handle .internal services
    const host = req.headers.host?.split(':')[0] ?? '';
    if (!isInternalHost(host)) {
      res.writeHead(400).end('Non-internal plain HTTP requests not supported');
      return;
    }

    const serviceName = getServiceName(host);
    const service = services.get(serviceName);
    if (!service) {
      res.writeHead(404).end(`Unknown service: ${serviceName}`);
      return;
    }

    // Prefer the per-container service token (required on macOS Docker Desktop
    // because NAT hides the real container IP). Fall back to IP resolution for
    // Linux and legacy/manual callers.
    let agentGroupId = resolveAgentByToken(req);
    let identitySource = 'token';
    if (!agentGroupId) {
      const remoteIp = getRemoteIp(req);
      agentGroupId = await resolveAgent(remoteIp);
      identitySource = 'ip';
    }
    if (!agentGroupId) {
      const remoteIp = getRemoteIp(req);
      log.warn('Host services proxy: unknown caller', { remoteIp, service: serviceName });
      res.writeHead(403).end('Unknown caller');
      return;
    }
    if (identitySource === 'token') {
      log.info('Host services proxy: caller identified by service token', { service: serviceName, agentGroupId });
    } else {
      log.debug('Host services proxy: resolved caller by IP', {
        service: serviceName,
        remoteIp: getRemoteIp(req),
        agentGroupId,
      });
    }

    try {
      await service.handler(req, res, agentGroupId);
    } catch (err) {
      log.error('Host service handler threw', { service: serviceName, err });
      if (!res.headersSent) res.writeHead(500).end('Internal error');
    }
  });

  // CONNECT tunnels — forward to OneCLI for external HTTPS
  server.on('connect', (req, clientSocket, head) => {
    const [hostname] = (req.url ?? '').split(':');

    if (isInternalHost(hostname)) {
      // .internal over CONNECT shouldn't happen if the stub uses http://
      // but handle it gracefully: reject with a hint
      clientSocket.write('HTTP/1.1 400 Use http:// for .internal services\r\n\r\n');
      clientSocket.end();
      return;
    }

    // Forward CONNECT to OneCLI proxy, passing through the container's auth header
    const upstream = net.connect(ONECLI_PROXY_PORT, '127.0.0.1', () => {
      let connectReq = `CONNECT ${req.url} HTTP/1.1\r\n`;
      for (const [key, value] of Object.entries(req.headers)) {
        if (value) connectReq += `${key}: ${Array.isArray(value) ? value[0] : value}\r\n`;
      }
      connectReq += '\r\n';
      upstream.write(connectReq);

      // Wait for OneCLI's 200 response, then pipe
      upstream.once('data', (chunk) => {
        const response = chunk.toString();
        if (response.includes('200')) {
          clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
          if (head.length) upstream.write(head);
          upstream.pipe(clientSocket);
          clientSocket.pipe(upstream);
        } else {
          clientSocket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n');
          clientSocket.end();
          upstream.end();
        }
      });
    });

    upstream.on('error', (err) => {
      log.warn('Host services proxy: upstream connection failed', { target: req.url, err: err.message });
      clientSocket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n');
      clientSocket.end();
    });

    clientSocket.on('error', () => upstream.destroy());
    upstream.on('error', () => clientSocket.destroy());
  });

  server.listen(port, '0.0.0.0', () => {
    log.info('Host services proxy started', { port, services: [...services.keys()] });
  });
}

export function stopHostServicesProxy(): void {
  if (server) {
    server.close();
    server = null;
    log.info('Host services proxy stopped');
  }
  serviceTokens.clear();
  ipToAgentGroup.clear();
}
