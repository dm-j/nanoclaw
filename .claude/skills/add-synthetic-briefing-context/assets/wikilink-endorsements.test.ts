import { describe, expect, it } from 'vitest';

import { decayedCount } from './wikilink-endorsements.js';

describe('decayedCount', () => {
  it('never zeroes purely from wall-clock time (proportional decay only)', () => {
    const entry = { count: 10, lastUpdatedAt: new Date(0).toISOString(), lastUpdatedStep: 5 };
    const eightHoursLater = 8 * 60 * 60 * 1000;
    // same step, so only the proportional time term applies
    const result = decayedCount(entry, eightHoursLater, 5);
    expect(result).toBeGreaterThan(0);
    expect(result).toBeLessThan(10);
  });

  it('zeroes out once enough steps have elapsed (linear step term)', () => {
    const entry = { count: 10, lastUpdatedAt: new Date(0).toISOString(), lastUpdatedStep: 0 };
    const result = decayedCount(entry, 0, 100);
    expect(result).toBe(0);
  });

  it('is monotonically non-increasing in both elapsed time and elapsed steps', () => {
    const entry = { count: 10, lastUpdatedAt: new Date(0).toISOString(), lastUpdatedStep: 0 };
    const t1 = decayedCount(entry, 60 * 60 * 1000, 1);
    const t2 = decayedCount(entry, 2 * 60 * 60 * 1000, 2);
    expect(t2).toBeLessThanOrEqual(t1);
  });
});
