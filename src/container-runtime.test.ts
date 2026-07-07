import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock log
vi.mock('./log.js', () => ({
  log: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
  },
}));

// Mock child_process — store the mock fn so tests can configure it
const mockExecSync = vi.fn();
vi.mock('child_process', () => ({
  execSync: (...args: unknown[]) => mockExecSync(...args),
}));

import {
  CONTAINER_RUNTIME_BIN,
  readonlyMountArgs,
  stopContainer,
  ensureContainerRuntimeRunning,
  cleanupOrphans,
} from './container-runtime.js';
import { CONTAINER_INSTALL_LABEL } from './config.js';
import { log } from './log.js';

beforeEach(() => {
  vi.clearAllMocks();
});

// --- Pure functions ---

describe('readonlyMountArgs', () => {
  it('returns --mount flag with Apple Container bind syntax', () => {
    const args = readonlyMountArgs('/host/path', '/container/path');
    expect(args).toEqual(['--mount', 'type=bind,source=/host/path,target=/container/path,readonly']);
  });
});

describe('stopContainer', () => {
  it('calls container stop for valid container names', () => {
    stopContainer('nanoclaw-test-123');
    expect(mockExecSync).toHaveBeenCalledWith(`${CONTAINER_RUNTIME_BIN} stop nanoclaw-test-123`, {
      stdio: 'pipe',
    });
  });

  it('rejects names with shell metacharacters', () => {
    expect(() => stopContainer('foo; rm -rf /')).toThrow('Invalid container name');
    expect(() => stopContainer('foo$(whoami)')).toThrow('Invalid container name');
    expect(() => stopContainer('foo`id`')).toThrow('Invalid container name');
    expect(mockExecSync).not.toHaveBeenCalled();
  });
});

// --- ensureContainerRuntimeRunning ---

describe('ensureContainerRuntimeRunning', () => {
  it('does nothing when runtime is already running', () => {
    mockExecSync.mockReturnValueOnce('');

    ensureContainerRuntimeRunning();

    expect(mockExecSync).toHaveBeenCalledTimes(1);
    expect(mockExecSync).toHaveBeenCalledWith(`${CONTAINER_RUNTIME_BIN} system status`, {
      stdio: 'pipe',
      timeout: 10000,
    });
    expect(log.debug).toHaveBeenCalledWith('Container runtime already running');
  });

  it('attempts to start runtime when status check fails, throws if start fails too', () => {
    mockExecSync.mockImplementationOnce(() => {
      throw new Error('runtime not running');
    });
    mockExecSync.mockImplementationOnce(() => {
      throw new Error('cannot start');
    });

    expect(() => ensureContainerRuntimeRunning()).toThrow('Container runtime is required but failed to start');
    expect(log.error).toHaveBeenCalled();
  });

  it('succeeds if status fails but start succeeds', () => {
    mockExecSync.mockImplementationOnce(() => {
      throw new Error('not running');
    });
    mockExecSync.mockReturnValueOnce('');

    ensureContainerRuntimeRunning();

    expect(mockExecSync).toHaveBeenCalledTimes(2);
    expect(log.debug).toHaveBeenCalledWith('Container runtime started');
  });
});

// --- cleanupOrphans ---

const [labelKey, labelVal] = CONTAINER_INSTALL_LABEL.split('=');

describe('cleanupOrphans', () => {
  it('filters by the install label so peers are not reaped', () => {
    mockExecSync.mockReturnValueOnce('[]');

    cleanupOrphans();

    expect(mockExecSync).toHaveBeenCalledWith(`${CONTAINER_RUNTIME_BIN} ls --format json`, expect.any(Object));
  });

  it('stops orphaned nanoclaw containers', () => {
    const containers = [
      { id: 'nanoclaw-group1-111', configuration: { labels: { [labelKey]: labelVal } } },
      { id: 'nanoclaw-group2-222', configuration: { labels: { [labelKey]: labelVal } } },
    ];
    mockExecSync.mockReturnValueOnce(JSON.stringify(containers));
    mockExecSync.mockReturnValue('');

    cleanupOrphans();

    expect(mockExecSync).toHaveBeenCalledTimes(3);
    expect(log.info).toHaveBeenCalledWith('Stopped orphaned containers', {
      count: 2,
      names: ['nanoclaw-group1-111', 'nanoclaw-group2-222'],
    });
  });

  it('does not stop containers from a different install', () => {
    const containers = [{ id: 'nanoclaw-other-999', configuration: { labels: { [labelKey]: 'different-slug' } } }];
    mockExecSync.mockReturnValueOnce(JSON.stringify(containers));

    cleanupOrphans();

    expect(mockExecSync).toHaveBeenCalledTimes(1);
    expect(log.info).not.toHaveBeenCalled();
  });

  it('does nothing when no containers exist', () => {
    mockExecSync.mockReturnValueOnce('[]');

    cleanupOrphans();

    expect(mockExecSync).toHaveBeenCalledTimes(1);
    expect(log.info).not.toHaveBeenCalled();
  });

  it('warns and continues when ls fails', () => {
    mockExecSync.mockImplementationOnce(() => {
      throw new Error('container not available');
    });

    cleanupOrphans(); // should not throw

    expect(log.warn).toHaveBeenCalledWith(
      'Failed to clean up orphaned containers',
      expect.objectContaining({ err: expect.any(Error) }),
    );
  });

  it('continues stopping remaining containers when one stop fails', () => {
    const containers = [
      { id: 'nanoclaw-a-1', configuration: { labels: { [labelKey]: labelVal } } },
      { id: 'nanoclaw-b-2', configuration: { labels: { [labelKey]: labelVal } } },
    ];
    mockExecSync.mockReturnValueOnce(JSON.stringify(containers));
    mockExecSync.mockImplementationOnce(() => {
      throw new Error('already stopped');
    });
    mockExecSync.mockReturnValueOnce('');

    cleanupOrphans(); // should not throw

    expect(mockExecSync).toHaveBeenCalledTimes(3);
    expect(log.info).toHaveBeenCalledWith('Stopped orphaned containers', {
      count: 2,
      names: ['nanoclaw-a-1', 'nanoclaw-b-2'],
    });
  });

  // Regression fixture — a trimmed but *real* sample of `container ls --format
  // json` output (captured 2026-07-07). The bug this guards against: an
  // earlier version of cleanupOrphans read top-level `name`/`labels` fields
  // that don't exist in Apple Container's actual output (name is `id`, labels
  // live under `configuration.labels`), so the orphan filter silently matched
  // nothing on every run — containers accumulated across every host restart
  // for weeks before it was caught. A hand-rolled mock shape can drift from
  // reality the same way the buggy code did; this fixture can't.
  it('matches real container ls --format json output shape', () => {
    const realSample = JSON.stringify([
      {
        configuration: {
          id: 'buildkit',
          labels: {
            'com.apple.container.plugin': 'builder',
            'com.apple.container.resource.role': 'builder',
          },
        },
        id: 'buildkit',
        status: { state: 'running' },
      },
      {
        configuration: {
          id: `nanoclaw-v2-dm-with-dmj-1783339327910`,
          labels: { [labelKey]: labelVal },
        },
        id: 'nanoclaw-v2-dm-with-dmj-1783339327910',
        status: { state: 'running' },
      },
    ]);
    mockExecSync.mockReturnValueOnce(realSample);
    mockExecSync.mockReturnValueOnce('');

    cleanupOrphans();

    expect(log.info).toHaveBeenCalledWith('Stopped orphaned containers', {
      count: 1,
      names: ['nanoclaw-v2-dm-with-dmj-1783339327910'],
    });
  });
});
