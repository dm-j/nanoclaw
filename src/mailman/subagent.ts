/**
 * Mailman subagent spawner.
 *
 * Spawns a containerised `claude -p` with OneCLI egress proxy.
 * The proxy intercepts HTTPS calls and applies credentials on egress —
 * no raw API keys ever enter the container.
 */
import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { CONTAINER_IMAGE, TIMEZONE } from '../config.js';
import { CONTAINER_RUNTIME_BIN, hostGatewayArgs } from '../container-runtime.js';
import { readEnvFile } from '../env.js';
import { log } from '../log.js';

const PROJECT_ROOT = path.resolve(import.meta.dirname, '../..');
const MAILMAN_DIR = path.join(PROJECT_ROOT, 'mailman');

const ONECLI_LOCAL_URL = 'http://127.0.0.1:10254';
const MAILMAN_AGENT_ID = 'mailman-triage';

const mailmanEnv = readEnvFile(['ANTHROPIC_BASE_URL', 'MAILMAN_MODEL']);
const ANTHROPIC_BASE_URL = process.env.ANTHROPIC_BASE_URL || mailmanEnv.ANTHROPIC_BASE_URL;
const MAILMAN_MODEL = process.env.MAILMAN_MODEL || mailmanEnv.MAILMAN_MODEL || 'claude-haiku-4-5';

export interface TriageInput {
  from: string;
  to?: string;
  subject: string;
  date?: string;
  body: string;
}

export interface TriageResult {
  action: 'notify_user' | 'defer';
  summary: string;
  reasoning: string;
  sender: string;
  subject: string;
}

interface OneCLIContainerConfig {
  env: Record<string, string>;
  caCertificate: string;
  caCertificateContainerPath: string;
  credentialStubs?: Array<{ containerPath: string; content: string }>;
}

async function getOneCLIContainerConfig(): Promise<OneCLIContainerConfig> {
  const url = `${ONECLI_LOCAL_URL}/api/container-config?agent=${encodeURIComponent(MAILMAN_AGENT_ID)}`;
  const res = await fetch(url);
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`OneCLI container-config failed (${res.status}): ${body}`);
  }
  return res.json() as Promise<OneCLIContainerConfig>;
}

function applyOneCLIConfig(args: string[], config: OneCLIContainerConfig): void {
  for (const [key, value] of Object.entries(config.env)) {
    args.push('-e', `${key}=${value}`);
  }

  // Write CA cert to host temp and mount into container
  const caPath = path.join(os.tmpdir(), 'onecli-mailman-ca.pem');
  fs.writeFileSync(caPath, config.caCertificate);
  args.push('-v', `${caPath}:${config.caCertificateContainerPath}:ro`);

  if (config.credentialStubs?.length) {
    for (const stub of config.credentialStubs) {
      const stubPath = path.join(os.tmpdir(), `onecli-stub-${path.basename(stub.containerPath)}`);
      fs.writeFileSync(stubPath, stub.content);
      args.push('-v', `${stubPath}:${stub.containerPath}:ro`);
    }
  }
}

export async function spawnSubagent(input: TriageInput): Promise<TriageResult> {
  const personaDir = path.join(MAILMAN_DIR, 'persona');
  const promptDir = path.join(MAILMAN_DIR, 'prompts');

  const kernelMd = fs.readFileSync(path.join(personaDir, 'kernel.md'), 'utf-8');
  const triagePrompt = fs.readFileSync(path.join(promptDir, 'email_triage.md'), 'utf-8');
  const systemPrompt = `${kernelMd}\n\n---\n\n${triagePrompt}`;
  const userMessage = `Triage this email:\n\n${JSON.stringify(input, null, 2)}`;

  const containerName = `mailman-triage-${Date.now()}`;

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

  // OneCLI egress proxy — credentials applied on egress, never in container
  const onecliConfig = await getOneCLIContainerConfig();
  applyOneCLIConfig(args, onecliConfig);

  // Anthropic base URL override (e.g. Ollama during development)
  // Applied after OneCLI so it wins over any proxy-injected default.
  if (ANTHROPIC_BASE_URL) {
    args.push('-e', `ANTHROPIC_BASE_URL=${ANTHROPIC_BASE_URL}`);
  }

  args.push('--entrypoint', 'claude');
  args.push(CONTAINER_IMAGE);
  args.push(
    '-p',
    '--system-prompt',
    systemPrompt,
    '--output-format',
    'json',
    '--model',
    MAILMAN_MODEL,
    '--allowedTools',
    '',
    '--',
    userMessage,
  );

  log.info('Spawning triage subagent', { sender: input.from, subject: input.subject, containerName });

  return new Promise<TriageResult>((resolve, reject) => {
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
      reject(new Error('Triage subagent timed out after 120s'));
    }, 120_000);

    proc.on('close', (code) => {
      clearTimeout(timeout);
      if (code !== 0) {
        const errMsg = stderr.slice(-5).join('\n');
        const stdoutStr = Buffer.concat(stdout).toString().trim();
        log.error('Triage subagent failed', { code, stderr: errMsg, stdout: stdoutStr.slice(0, 500) });
        reject(new Error(`Subagent exited with code ${code}: ${errMsg || stdoutStr.slice(0, 200)}`));
        return;
      }

      const raw = Buffer.concat(stdout).toString().trim();
      try {
        const parsed = parseTriageOutput(raw);
        log.info('Triage result', { action: parsed.action, summary: parsed.summary });
        resolve(parsed);
      } catch (err) {
        log.error('Failed to parse triage output', { raw: raw.slice(0, 500), err });
        reject(err);
      }
    });

    proc.on('error', (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}

function parseTriageOutput(raw: string): TriageResult {
  const parsed = JSON.parse(raw);
  const resultText = typeof parsed.result === 'string' ? parsed.result : JSON.stringify(parsed.result);

  const jsonMatch = resultText.match(/```(?:json)?\s*([\s\S]*?)```/) || resultText.match(/(\{[\s\S]*\})/);
  if (!jsonMatch) {
    throw new Error(`No JSON found in triage output: ${resultText.slice(0, 200)}`);
  }

  const result: TriageResult = JSON.parse(jsonMatch[1].trim());

  if (!result.action || !['notify_user', 'defer'].includes(result.action)) {
    throw new Error(`Invalid triage action: ${result.action}`);
  }
  return result;
}
