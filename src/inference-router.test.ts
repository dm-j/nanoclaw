import { describe, expect, it } from 'vitest';

import { parsePrefix } from './inference-router.js';

describe('parsePrefix', () => {
  it('strips ollama- prefix and routes to ollama backend', () => {
    const result = parsePrefix('ollama-kimi-k2.6:cloud');
    expect(result).toEqual({ backend: { kind: 'ollama' }, model: 'kimi-k2.6:cloud' });
  });

  it('strips anthropic- prefix and routes to anthropic backend', () => {
    const result = parsePrefix('anthropic-claude-sonnet-4-6');
    expect(result).toEqual({ backend: { kind: 'anthropic' }, model: 'claude-sonnet-4-6' });
  });

  it('no prefix defaults to anthropic backend, model unchanged', () => {
    const result = parsePrefix('claude-sonnet-4-6');
    expect(result).toEqual({ backend: { kind: 'anthropic' }, model: 'claude-sonnet-4-6' });
  });

  it('ollama- prefix with colon in model name (Ollama tag format)', () => {
    const result = parsePrefix('ollama-llama3:8b');
    expect(result).toEqual({ backend: { kind: 'ollama' }, model: 'llama3:8b' });
  });

  it('model name starting with "ollama" but without dash is not treated as prefix', () => {
    // e.g. a hypothetical Anthropic model named "ollamafied-something"
    const result = parsePrefix('ollamafied-model');
    expect(result).toEqual({ backend: { kind: 'anthropic' }, model: 'ollamafied-model' });
  });
});
