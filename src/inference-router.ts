/**
 * Inference router — HTTP proxy on port 10261.
 *
 * Sits between agent containers and inference backends. Reads the `model`
 * field from each request body, strips a protocol prefix, rewrites the body,
 * and forwards to the right backend:
 *
 *   ollama://kimi-k2.6:cloud  → localhost:11434  (plain HTTP)
 *   anthropic://claude-sonnet → OneCLI :10255    (CONNECT tunnel)
 *   claude-sonnet             → OneCLI :10255    (default, no prefix)
 *
 * Streaming responses are piped directly after the body rewrite.
 */
import http from 'http';
import net from 'net';

import { log } from './log.js';

const ONECLI_PROXY_PORT = 10255;
const OLLAMA_PORT = 11434;

type Backend = { kind: 'ollama' } | { kind: 'anthropic' };

function parsePrefix(model: string): { backend: Backend; model: string } {
  if (model.startsWith('ollama://')) {
    return { backend: { kind: 'ollama' }, model: model.slice('ollama://'.length) };
  }
  if (model.startsWith('anthropic://')) {
    return { backend: { kind: 'anthropic' }, model: model.slice('anthropic://'.length) };
  }
  return { backend: { kind: 'anthropic' }, model };
}

function forwardToOllama(req: http.IncomingMessage, res: http.ServerResponse, body: Buffer): void {
  const options: http.RequestOptions = {
    hostname: '127.0.0.1',
    port: OLLAMA_PORT,
    path: req.url,
    method: req.method,
    headers: { ...req.headers, host: `127.0.0.1:${OLLAMA_PORT}` },
  };

  const upstream = http.request(options, (upRes) => {
    res.writeHead(upRes.statusCode ?? 200, upRes.headers);
    upRes.pipe(res);
  });

  upstream.on('error', (err) => {
    log.warn('Inference router: Ollama connection failed', { err: err.message });
    if (!res.headersSent) res.writeHead(502).end('Ollama unavailable');
  });

  upstream.write(body);
  upstream.end();
}

function forwardToAnthropic(req: http.IncomingMessage, res: http.ServerResponse, body: Buffer): void {
  // CONNECT tunnel through OneCLI so secrets are injected on the wire.
  const target = 'api.anthropic.com:443';
  const tunnel = net.connect(ONECLI_PROXY_PORT, '127.0.0.1', () => {
    tunnel.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`);
  });

  tunnel.once('data', (chunk) => {
    if (!chunk.toString().includes('200')) {
      log.warn('Inference router: OneCLI CONNECT failed', { response: chunk.toString().slice(0, 80) });
      res.writeHead(502).end('OneCLI tunnel failed');
      tunnel.destroy();
      return;
    }

    // TLS upgrade over the established tunnel
    import('tls').then(({ connect: tlsConnect }) => {
      const tls = tlsConnect({ socket: tunnel, servername: 'api.anthropic.com' }, () => {
        // Forward the original request over TLS
        let reqLine = `${req.method} ${req.url} HTTP/1.1\r\n`;
        for (const [k, v] of Object.entries(req.headers)) {
          if (k.toLowerCase() === 'host') continue; // use the upstream host
          if (Array.isArray(v)) {
            for (const val of v) reqLine += `${k}: ${val}\r\n`;
          } else if (v) {
            reqLine += `${k}: ${v}\r\n`;
          }
        }
        reqLine += `host: api.anthropic.com\r\n`;
        reqLine += `content-length: ${body.length}\r\n\r\n`;
        tls.write(reqLine);
        tls.write(body);

        // Pipe the TLS response back to the client
        // ponytail: raw pipe — HTTP/1.1 framing is preserved as-is (works for both
        // JSON and SSE streaming). A proper HTTP parser would be needed only if we
        // had to inspect the response body.
        tls.pipe(res.socket!);
        res.socket!.on('close', () => tls.destroy());
      });

      tls.on('error', (err) => {
        log.warn('Inference router: TLS error', { err: err.message });
        if (!res.headersSent) res.writeHead(502).end('TLS error');
      });
    });
  });

  tunnel.on('error', (err) => {
    log.warn('Inference router: tunnel error', { err: err.message });
    if (!res.headersSent) res.writeHead(502).end('Tunnel error');
  });
}

let server: http.Server | null = null;

export function startInferenceRouter(port: number): void {
  server = http.createServer(async (req, res) => {
    // Buffer body so we can read model and rewrite it
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const rawBody = Buffer.concat(chunks);

    let body = rawBody;
    let backend: Backend = { kind: 'anthropic' };

    try {
      const parsed = JSON.parse(rawBody.toString('utf-8'));
      if (typeof parsed.model === 'string' && parsed.model.includes('://')) {
        const resolved = parsePrefix(parsed.model);
        backend = resolved.backend;
        parsed.model = resolved.model;
        body = Buffer.from(JSON.stringify(parsed), 'utf-8');
        log.debug('Inference router: rewrote model', {
          original: (JSON.parse(rawBody.toString('utf-8')) as { model?: string }).model,
          rewritten: resolved.model,
          backend: resolved.backend.kind,
        });
      }
    } catch {
      // Non-JSON body (health checks, etc.) — forward as-is to Anthropic
    }

    if (backend.kind === 'ollama') {
      forwardToOllama(req, res, body);
    } else {
      forwardToAnthropic(req, res, body);
    }
  });

  server.listen(port, '127.0.0.1', () => {
    log.info('Inference router started', { port });
  });
}

export function stopInferenceRouter(): void {
  if (server) {
    server.close();
    server = null;
    log.info('Inference router stopped');
  }
}
