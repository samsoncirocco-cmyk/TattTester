// Takedown domain rules. See docs/adr/0025.
//
// The load-bearing bit is tombstone key derivation: national-dataset artist ids
// are derived from the instagram handle, but the crawler mints RANDOM ids
// (artist_validator.js uses Math.random()). An id-keyed tombstone therefore does
// not survive a re-crawl — the handle is the only identifier stable across runs.
import { describe, expect, it } from 'vitest';
import {
  NOT_REMOVED_CLAUSE,
  isSafeArtistId,
  normalizeInstagramHandle,
  takedownModerationText,
  tombstoneKeysFor,
  validateTakedownRequest,
} from './takedown';

describe('normalizeInstagramHandle', () => {
  it('strips @, urls, trailing paths and lowercases', () => {
    expect(normalizeInstagramHandle('@TattoosByGing')).toBe('tattoosbyging');
    expect(normalizeInstagramHandle('https://www.instagram.com/TattoosByGing/')).toBe('tattoosbyging');
    expect(normalizeInstagramHandle('  tattoosbyging  ')).toBe('tattoosbyging');
  });

  it('returns null for absent or junk handles', () => {
    expect(normalizeInstagramHandle(null)).toBeNull();
    expect(normalizeInstagramHandle(undefined)).toBeNull();
    expect(normalizeInstagramHandle('')).toBeNull();
    expect(normalizeInstagramHandle('@')).toBeNull();
    expect(normalizeInstagramHandle('https://instagram.com/')).toBeNull();
  });
});

describe('tombstoneKeysFor', () => {
  it('keys on the instagram handle, the artist id, and every source page', () => {
    const keys = tombstoneKeysFor({
      artistId: 'artist_tattoosbyging',
      instagram: '@TattoosByGing',
      sourcePages: ['http://timelesstattoo.co/artists'],
    });

    expect(keys).toEqual([
      { key: 'instagram:tattoosbyging', keyType: 'instagram' },
      { key: 'artist:artist_tattoosbyging', keyType: 'artist' },
      { key: 'source:http://timelesstattoo.co/artists', keyType: 'source' },
    ]);
  });

  it('always emits an artist-id key even when nothing else is known', () => {
    expect(tombstoneKeysFor({ artistId: 'artist_dvpyb68gp' })).toEqual([
      { key: 'artist:artist_dvpyb68gp', keyType: 'artist' },
    ]);
  });

  it('de-duplicates repeated source pages', () => {
    const keys = tombstoneKeysFor({
      artistId: 'a1',
      sourcePages: ['http://x.co/a', 'http://x.co/a'],
    });
    expect(keys.filter((k) => k.keyType === 'source')).toHaveLength(1);
  });

  it('rejects an artistId that could smuggle a path segment', () => {
    expect(() => tombstoneKeysFor({ artistId: '../../etc' })).toThrow(/artistId/i);
  });

  // Instagram handles allow dots, and national-dataset ids are derived from the
  // handle. A validator that rejects dots refuses 1,621 of the 10,427 artists in
  // data/national-artists-2026-07-15.json — 15.5% of the people this mechanism
  // exists to serve could not file a takedown request at all.
  describe('dotted ids (Instagram handles contain dots)', () => {
    it.each([
      'artist_pham.minh.phuc',
      'artist_joshbrown.615',
      'artist_ink.by.aliza',
      'artist_ak.tattooing',
    ])('accepts %s', (artistId) => {
      expect(tombstoneKeysFor({ artistId })).toEqual([{ key: `artist:${artistId}`, keyType: 'artist' }]);
    });

    it('still rejects traversal built from dots', () => {
      for (const bad of ['..', 'a..b', 'artist_..', '../x', '.hidden', 'a/../b', 'a\\b']) {
        expect(() => tombstoneKeysFor({ artistId: bad })).toThrow(/artistId/i);
      }
    });
  });
});

describe('isSafeArtistId', () => {
  it('accepts the two real id shapes in the dataset', () => {
    // National dataset (derived from the handle) and crawler-minted random ids.
    expect(isSafeArtistId('artist_pham.minh.phuc')).toBe(true);
    expect(isSafeArtistId('artist_dvpyb68gp')).toBe(true);
  });

  it('blocks anything that could escape its GCS prefix', () => {
    // The property that actually matters for `artists/<id>/…`.
    for (const bad of ['..', 'a..b', '../etc', '.hidden', 'a/b', 'a\\b', '', ' ']) {
      expect(isSafeArtistId(bad)).toBe(false);
    }
  });
});

describe('validateTakedownRequest', () => {
  const good = {
    artistId: 'artist_tattoosbyging',
    contactEmail: 'ging@example.com',
    relationship: 'artist',
    scope: 'all',
    message: 'These are my photos, please remove them.',
  };

  it('accepts a well-formed request', () => {
    const r = validateTakedownRequest(good);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.artistId).toBe('artist_tattoosbyging');
      expect(r.value.scope).toBe('all');
      expect(r.value.relationship).toBe('artist');
    }
  });

  it('defaults scope to "all" — the safer reading of an ambiguous request', () => {
    const { scope: _drop, ...noScope } = good;
    const r = validateTakedownRequest(noScope);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.scope).toBe('all');
  });

  it('accepts an images-only scope', () => {
    const r = validateTakedownRequest({ ...good, scope: 'images' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.scope).toBe('images');
  });

  it.each([
    ['missing artistId', { ...good, artistId: undefined }, /artistId/i],
    ['unsafe artistId', { ...good, artistId: 'a/../b' }, /artistId/i],
    ['missing contactEmail', { ...good, contactEmail: undefined }, /email/i],
    ['malformed contactEmail', { ...good, contactEmail: 'nope' }, /email/i],
    ['unknown relationship', { ...good, relationship: 'wizard' }, /relationship/i],
    ['unknown scope', { ...good, scope: 'everything' }, /scope/i],
    ['non-object body', 'nope', /body/i],
  ])('rejects %s', (_label, body, pattern) => {
    const r = validateTakedownRequest(body);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(pattern);
  });

  it('rejects an over-long message rather than truncating it silently', () => {
    const r = validateTakedownRequest({ ...good, message: 'x'.repeat(5001) });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/message/i);
  });

  it('trims whitespace and lowercases the contact email', () => {
    const r = validateTakedownRequest({ ...good, contactEmail: '  Ging@Example.COM ' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.contactEmail).toBe('ging@example.com');
  });
});

describe('takedownModerationText', () => {
  const request = {
    artistId: 'artist_tattoosbyging',
    contactEmail: 'ging@example.com',
    relationship: 'artist' as const,
    scope: 'all' as const,
    message: 'These photos are my copyright. Please remove them.',
  };

  it('sends the message and not the contact email', () => {
    const text = takedownModerationText(request);
    expect(text).toContain('These photos are my copyright');
    expect(text).not.toContain('ging@example.com');
  });

  it('is empty when there is no message, so the call is skipped', () => {
    expect(takedownModerationText({ ...request, message: null })).toBe('');
  });
});

describe('NOT_REMOVED_CLAUSE', () => {
  // Every artist read path interpolates this. If it ever matched removed
  // artists, a takedown would be cosmetic.
  it('gates on removedAt being null', () => {
    expect(NOT_REMOVED_CLAUSE).toBe('a.removedAt IS NULL');
  });
});
