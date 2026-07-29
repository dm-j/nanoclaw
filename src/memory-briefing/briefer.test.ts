import { describe, expect, it } from 'vitest';

import { buildBrieferPrompt } from './briefer.js';

describe('buildBrieferPrompt', () => {
  it('puts the new message last and labels it clearly', () => {
    const prompt = buildBrieferPrompt([{ role: 'user', text: 'earlier turn' }], 'what should I know before replying?');

    const historyIdx = prompt.indexOf('earlier turn');
    const newMsgIdx = prompt.indexOf('what should I know before replying?');
    expect(historyIdx).toBeGreaterThan(-1);
    expect(newMsgIdx).toBeGreaterThan(historyIdx);
    expect(prompt).toContain('## Inciting message — what you are preparing a briefing to answer');
  });

  it('handles no recent turns', () => {
    const prompt = buildBrieferPrompt([], 'hello');
    expect(prompt).toContain('(no recent turns)');
    expect(prompt).toContain('hello');
  });
});
