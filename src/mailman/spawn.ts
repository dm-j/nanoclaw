import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { CONTAINER_IMAGE, TIMEZONE } from '../config.js';
import { CONTAINER_RUNTIME_BIN, hostGatewayArgs } from '../container-runtime.js';
import { log } from '../log.js';

const ONECLI_LOCAL_URL = 'http://127.0.0.1:10254';

interface OneCLIContainerConfig {
  env: Record<string, string>;
  caCertificate: string;
  caCertificateContainerPath: string;
  credentialStubs?: Array<{ containerPath: string; content: string }>;
}

async function getOneCLIContainerConfig(agentId: string): Promise<OneCLIContainerConfig> {
  const url = `${ONECLI_LOCAL_URL}/api/container-config?agent=${encodeURIComponent(agentId)}`;
  const res = await fetch(url);
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`OneCLI container-config failed (${res.status}): ${body}`);
  }
  return res.json() as Promise<OneCLIContainerConfig>;
}

function applyOneCLIConfig(args: string[], config: OneCLIContainerConfig, label: string): void {
  for (const [key, value] of Object.entries(config.env)) {
    args.push('-e', `${key}=${value}`);
  }

  const caPath = path.join(os.tmpdir(), `onecli-${label}-ca.pem`);
  fs.writeFileSync(caPath, config.caCertificate);
  args.push('-v', `${caPath}:${config.caCertificateContainerPath}:ro`);

  if (config.credentialStubs?.length) {
    for (const stub of config.credentialStubs) {
      const stubPath = path.join(os.tmpdir(), `onecli-${label}-stub-${path.basename(stub.containerPath)}`);
      fs.writeFileSync(stubPath, stub.content);
      args.push('-v', `${stubPath}:${stub.containerPath}:ro`);
    }
  }
}

export interface SpawnOptions {
  systemPrompt: string;
  userMessage: string;
  model: string;
  agentId: string;
  containerLabel: string;
  anthropicBaseUrl?: string;
  timeoutMs?: number;
}

export async function spawnMailmanContainer(opts: SpawnOptions): Promise<string> {
  const containerName = `mailman-${opts.containerLabel}-${Date.now()}`;

  const args: string[] = [
    'run',
    '--rm',
    '--name',
    containerName,
    '-e',
    `TZ=${TIMEZONE}`,
    '--memory',
    '512m',
    '--cpus',
    '1',
  ];

  args.push(...hostGatewayArgs());

  const hostUid = process.getuid?.();
  const hostGid = process.getgid?.();
  if (hostUid != null && hostUid !== 0 && hostUid !== 1000) {
    args.push('--user', `${hostUid}:${hostGid}`);
    args.push('-e', 'HOME=/home/node');
  }

  const onecliConfig = await getOneCLIContainerConfig(opts.agentId);
  applyOneCLIConfig(args, onecliConfig, opts.containerLabel);

  if (opts.anthropicBaseUrl) {
    args.push('-e', `ANTHROPIC_BASE_URL=${opts.anthropicBaseUrl}`);
  }

  args.push('--entrypoint', 'claude');
  args.push(CONTAINER_IMAGE);
  args.push(
    '-p',
    '--system-prompt',
    opts.systemPrompt,
    '--output-format',
    'json',
    '--model',
    opts.model,
    '--allowedTools',
    '',
    '--',
    opts.userMessage,
  );

  log.info('Spawning mailman container', { containerName, model: opts.model });

  const timeoutMs = opts.timeoutMs ?? 120_000;

  return new Promise<string>((resolve, reject) => {
    const proc = spawn(CONTAINER_RUNTIME_BIN, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    proc.stdin.end();

    const stdout: Buffer[] = [];
    const stderr: string[] = [];

    proc.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    proc.stderr.on('data', (chunk: Buffer) => {
      for (const line of chunk.toString().trim().split('\n')) {
        if (line) stderr.push(line);
      }
    });

    const timeout = setTimeout(() => {
      proc.kill('SIGKILL');
      reject(new Error(`Mailman container timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    proc.on('close', (code) => {
      clearTimeout(timeout);
      if (code !== 0) {
        const errMsg = stderr.slice(-5).join('\n');
        const stdoutStr = Buffer.concat(stdout).toString().trim();
        log.error('Mailman container failed', { containerName, code, stderr: errMsg, stdout: stdoutStr.slice(0, 500) });
        reject(new Error(`Container exited with code ${code}: ${errMsg || stdoutStr.slice(0, 200)}`));
        return;
      }
      resolve(Buffer.concat(stdout).toString().trim());
    });

    proc.on('error', (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}

export function parseJsonResult<T>(raw: string): T {
  const parsed = JSON.parse(raw);
  const resultText = typeof parsed.result === 'string' ? parsed.result : JSON.stringify(parsed.result);

  const jsonMatch = resultText.match(/```(?:json)?\s*([\s\S]*?)```/) || resultText.match(/(\{[\s\S]*\})/);
  if (!jsonMatch) {
    throw new Error(`No JSON found in output: ${resultText.slice(0, 200)}`);
  }

  return JSON.parse(jsonMatch[1].trim()) as T;
}
