import { describe, expect, it } from 'vitest';
import {
  APPLY_DISCOVERY_SIGNAL_CYPHER,
  buildDiscoverySignalUpdate,
  classifySignal,
  classifySignals,
} from './discovery-signal.mjs';

const signal = (overrides = {}) => ({
  handle: 'someartist',
  biography: '',
  businessCategory: '',
  isBusinessAccount: false,
  verified: false,
  followers: 300,
  postsCount: 50,
  externalUrls: [],
  externalUrlTitles: [],
  hashtags: [],
  captions: [],
  ...overrides,
});

describe('classifySignal', () => {
  it('finds tattoo evidence on any scraped surface, including the handle', () => {
    expect(classifySignal(signal({ biography: 'Tattoo artist in Austin' })).tier).toBe('tattoo');
    expect(classifySignal(signal({ businessCategory: 'Tattoo & Piercing Shop' })).tier).toBe('tattoo');
    expect(classifySignal(signal({ hashtags: ['blackwork'] })).tier).toBe('tattoo');
    expect(classifySignal(signal({ captions: ['fresh tatuaje for maria'] })).tier).toBe('tattoo');
    expect(classifySignal(signal({ handle: 'smithtatts' })).tier).toBe('tattoo');
    expect(
      classifySignal(signal({ externalUrlTitles: ['Book your tattoo'] })).tier,
    ).toBe('tattoo');
  });

  it('junks only affirmative non-artist evidence: category or verified brand', () => {
    expect(classifySignal(signal({ businessCategory: 'Movie Theater' }))).toEqual({
      tier: 'junk',
      reason: 'non-tattoo businessCategory: movie theater',
    });
    expect(classifySignal(signal({ businessCategory: 'Restaurant' })).tier).toBe('junk');
    // AMC-shaped: verified mega-follower brand with zero tattoo evidence.
    expect(
      classifySignal(signal({ verified: true, followers: 2_000_000 })).tier,
    ).toBe('junk');
    // Verified but human-scale is not brand evidence.
    expect(
      classifySignal(signal({ verified: true, followers: 40_000 })).tier,
    ).toBe('uncertain');
  });

  it('never junks a sparse profile — absence of evidence is uncertain', () => {
    expect(classifySignal(signal()).tier).toBe('uncertain');
    // Adjacent/ambiguous categories stay uncertain: PMU and miscategorized
    // real artists use them, and hiding a real artist is the worse failure.
    for (const businessCategory of ['Artist', 'Hair Stylist', 'Beauty, cosmetic & personal care', 'Health/beauty']) {
      expect(classifySignal(signal({ businessCategory })).tier).toBe('uncertain');
    }
  });

  it('tattoo evidence always outranks a junk category (removal clinics, mislabels)', () => {
    expect(
      classifySignal(
        signal({ businessCategory: 'Restaurant', captions: ['our staff tattoo party'] }),
      ).tier,
    ).toBe('tattoo');
  });
});

describe('classifySignals', () => {
  it('tiers a whole file, dedupes handles case-insensitively, counts skips', () => {
    const { entries, counts, skipped } = classifySignals([
      signal({ handle: 'Inked_Joe', biography: 'tattoos by joe' }),
      signal({ handle: 'inked_joe', biography: 'tattoos by joe' }),
      signal({ handle: 'amctheatres', businessCategory: 'Movie Theater' }),
      signal({ handle: 'quietartist' }),
      signal({ handle: '' }),
    ]);
    expect(entries).toHaveLength(3);
    expect(counts).toEqual({ tattoo: 1, junk: 1, uncertain: 1 });
    expect(skipped).toBe(1);
    expect(entries.map((e) => e.handle)).toEqual(['inked_joe', 'amctheatres', 'quietartist']);
  });
});

describe('buildDiscoverySignalUpdate', () => {
  it('stamps only the three additive discoverySignal properties, single-match guarded', () => {
    const { query, params } = buildDiscoverySignalUpdate(
      { handle: 'amctheatres', tier: 'junk', reason: 'non-tattoo businessCategory: movie theater' },
      '2026-08-17T00:00:00.000Z',
    );
    expect(query).toBe(APPLY_DISCOVERY_SIGNAL_CYPHER);
    expect(query).toContain('CASE WHEN size(matches) = 1 THEN matches ELSE [] END');
    // Additive properties only — never visibility bits, identity, or ownership.
    expect(query.match(/SET a\.(\w+)/g)).toEqual(['SET a.discoverySignal']);
    expect(query).not.toMatch(/a\.(stale|looksBookable|removedAt|claimedByUid|name|instagram)\s*=/);
    expect(params.handleVariants).toContain('@amctheatres');
    expect(params.tier).toBe('junk');
    expect(params.stampedAt).toBe('2026-08-17T00:00:00.000Z');
  });

  it('rejects unknown tiers instead of writing them', () => {
    expect(() =>
      buildDiscoverySignalUpdate({ handle: 'x', tier: 'spam' }, 'now'),
    ).toThrow(/unknown tier/);
  });
});
