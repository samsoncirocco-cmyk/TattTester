import { describe, it, expect } from 'vitest';
import { MAX_SEED, seedFor } from '../internal/seed';

describe('seedFor', () => {
  it('is stable for the same session and cut', () => {
    expect(seedFor('sess-1', 'v1')).toBe(seedFor('sess-1', 'v1'));
  });

  it('stays an integer inside 0..2^31-1', () => {
    for (const id of ['v1', 'v2', 'v3-fix1', 'v2-refined', '']) {
      const seed = seedFor('9f1c2b7e-0000-4000-8000-000000000000', id);
      expect(Number.isInteger(seed)).toBe(true);
      expect(seed).toBeGreaterThanOrEqual(0);
      expect(seed).toBeLessThanOrEqual(MAX_SEED);
    }
  });

  it('differs per cut and per session', () => {
    expect(seedFor('sess-1', 'v1')).not.toBe(seedFor('sess-1', 'v2'));
    expect(seedFor('sess-1', 'v1')).not.toBe(seedFor('sess-2', 'v1'));
    // The separator keeps ("ab","c") and ("a","bc") apart.
    expect(seedFor('ab', 'c')).not.toBe(seedFor('a', 'bc'));
  });
});
