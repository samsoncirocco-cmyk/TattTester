import { describe, expect, it } from 'vitest';
import {
  DEFAULT_DISCOVERY_CANDIDATES_INPUT,
  DEFAULT_DISCOVERY_OUTPUT,
  DEFAULT_MIN_FOLLOWERS,
  DISCOVERY_ARTIST_IMPORT_CYPHER,
  DISCOVERY_REFERENCE_ARTISTS_CYPHER,
  DISCOVERY_REFERENCE_SHOPS_CYPHER,
  buildImportPlanArtifact,
  buildReferenceIndex,
  buildSpotCheckSample,
  classifyDuplicate,
  detectNonUsLocation,
  discoveryArtistId,
  evaluateQualityGates,
  normalizeDomain,
  parseAliasLocation,
  parseBareCityLocation,
  parseDiscoveryImportArgs,
  parseExplicitLocation,
  planCandidate,
  planDiscoveryImport,
  resolveCandidateLocation,
  resolveSeedLocation,
  resolveShopLink,
  tombstoneKeysForCandidate,
} from './discovery-import.mjs';

// A miniature stand-in for the live graph. City prominence is measured in
// artists, so the fixture carries enough of them to make Chicago and Nashville
// resolvable, Portland genuinely ambiguous (OR barely outweighs ME, as in the
// real data before artist counts break the tie), and Wayne, NJ below the bar.
function shopsFor(city, state, count, extra = {}) {
  return Array.from({ length: count }, (_, i) => ({
    placeId: `place_${city}_${state}_${i}`,
    name: `${city} Shop ${i}`,
    city,
    state,
    website: null,
    ...(i === 0 ? extra : {}),
  }));
}

function artistsFor(city, state, count) {
  return Array.from({ length: count }, (_, i) => ({
    id: `artist_${city.toLowerCase()}_${state.toLowerCase()}_${i}`,
    name: `${city} Artist ${i}`,
    instagram: `@${city.toLowerCase()}_${state.toLowerCase()}_${i}`,
    city,
    state,
  }));
}

const REFERENCE = {
  artists: [
    { id: 'artist_artofmarcoantonio', name: 'Marco Antonio', instagram: '@artofmarcoantonio', city: 'Austin', state: 'TX' },
    { id: 'artist_alreadyhere', name: 'Already Here', instagram: '@alreadyhere', city: 'Chicago', state: 'IL' },
    { id: 'artist_someoneelse', name: 'Jane Doe', instagram: '@someoneelse', city: 'Austin', state: 'TX' },
    ...artistsFor('Austin', 'TX', 90),
    ...artistsFor('Chicago', 'IL', 110),
    ...artistsFor('Nashville', 'TN', 80),
    ...artistsFor('Portland', 'OR', 40),
    ...artistsFor('Portland', 'ME', 35),
    ...artistsFor('Los Angeles', 'CA', 60),
    ...artistsFor('Wayne', 'NJ', 10),
    // Thin on artists, thick on shops — the real Miami's shape in the graph.
    ...artistsFor('Miami', 'FL', 13),
  ],
  shops: [
    ...shopsFor('Austin', 'TX', 40, { website: 'https://www.prideandjoytattoo.com/?utm_source=g' }),
    ...shopsFor('Portland', 'OR', 40, { website: 'http://midnightportland.com/book' }),
    ...shopsFor('Portland', 'ME', 30),
    ...shopsFor('Nashville', 'TN', 25),
    ...shopsFor('Chicago', 'IL', 40),
    ...shopsFor('Miami', 'FL', 20),
    ...shopsFor('Miami', 'OK', 1),
    { placeId: 'place_aggregated_a', name: 'Aggregated A', city: 'Austin', state: 'TX', website: 'https://linktr.ee/one' },
    { placeId: 'place_aggregated_b', name: 'Aggregated B', city: 'Chicago', state: 'IL', website: 'https://linktr.ee/two' },
    { placeId: 'place_shared_a', name: 'Shared A', city: 'Austin', state: 'TX', website: 'https://book.example.com/a' },
    { placeId: 'place_shared_b', name: 'Shared B', city: 'Chicago', state: 'IL', website: 'https://book.example.com/b' },
  ],
};

const index = buildReferenceIndex(REFERENCE);

function candidate(overrides = {}) {
  return {
    handle: 'newartist',
    source: 'B:hashtag',
    seedFrom: '#austintattoo',
    bioSnippet: 'Tattoo artist',
    followers: 5000,
    looksBookable: true,
    filterReason: 'artist+booking',
    ...overrides,
  };
}

function profile(overrides = {}) {
  return {
    bio: 'Tattoo artist. Booking below.',
    followers: 5000,
    fullName: 'New Artist',
    url: '',
    category: 'Artist',
    private: false,
    verified: false,
    ...overrides,
  };
}

describe('discovery importer options', () => {
  it('is dry-run by default and derives the profiles path from the input', () => {
    expect(parseDiscoveryImportArgs([])).toEqual({
      apply: false,
      requirePhotos: false,
      input: DEFAULT_DISCOVERY_CANDIDATES_INPUT,
      profiles: 'data/discovery/profiles.json',
      out: DEFAULT_DISCOVERY_OUTPUT,
      reference: null,
      limit: Infinity,
      minFollowers: DEFAULT_MIN_FOLLOWERS,
      sample: 20,
    });
  });

  it('does not treat lookalike flags as permission to write', () => {
    expect(parseDiscoveryImportArgs(['--limit', '5']).apply).toBe(false);
    expect(() => parseDiscoveryImportArgs(['--apply=true'])).toThrow(/Unknown option/);
    expect(() => parseDiscoveryImportArgs(['--Apply'])).toThrow(/Unknown option/);
    expect(() => parseDiscoveryImportArgs(['--dry-run'])).toThrow(/Unknown option/);
  });

  it('accepts the full option set', () => {
    expect(
      parseDiscoveryImportArgs([
        '--apply',
        '--require-photos',
        '--input', 'a/candidates.json',
        '--profiles', 'b/profiles.json',
        '--out', 'c/plan.json',
        '--reference', 'snap.json',
        '--limit', '25',
        '--min-followers', '1000',
        '--sample', '5',
      ]),
    ).toEqual({
      apply: true,
      requirePhotos: true,
      input: 'a/candidates.json',
      profiles: 'b/profiles.json',
      out: 'c/plan.json',
      reference: 'snap.json',
      limit: 25,
      minFollowers: 1000,
      sample: 5,
    });
  });

  it('rejects destructive wipe and malformed numbers', () => {
    expect(() => parseDiscoveryImportArgs(['--apply', '--wipe'])).toThrow(/not supported/i);
    expect(() => parseDiscoveryImportArgs(['--limit', '0'])).toThrow(/positive integer/i);
    expect(() => parseDiscoveryImportArgs(['--min-followers', '-1'])).toThrow(/non-negative/i);
    expect(() => parseDiscoveryImportArgs(['--input'])).toThrow(/requires a value/i);
  });
});

describe('id assignment', () => {
  it('mints the deterministic id shape the graph already uses', () => {
    expect(discoveryArtistId('@Hori.Benny')).toBe('artist_hori.benny');
    expect(discoveryArtistId('https://instagram.com/Ink.By.Sam/reels')).toBe('artist_ink.by.sam');
    expect(discoveryArtistId('')).toBeNull();
  });

  it('builds handle-first tombstone keys', () => {
    expect(tombstoneKeysForCandidate('@Hori.Benny')).toEqual([
      'artist:artist_hori.benny',
      'instagram:hori.benny',
    ]);
  });
});

describe('quality gates', () => {
  it('admits a candidate that clears every automated gate', () => {
    const result = evaluateQualityGates(candidate(), profile());
    expect(result.admitted).toBe(true);
    expect(result.failures).toEqual([]);
  });

  it('rejects thin, private, bio-less and non-bookable records', () => {
    expect(evaluateQualityGates(candidate({ followers: 100 }), profile()).failures).toContain('followers');
    expect(evaluateQualityGates(candidate({ followers: null }), profile({ followers: null })).failures)
      .toContain('followers:unknown');
    expect(evaluateQualityGates(candidate(), profile({ private: true })).failures).toContain('notPrivate');
    expect(evaluateQualityGates(candidate({ bioSnippet: '' }), profile({ bio: '  ' })).failures).toContain('bio');
    expect(evaluateQualityGates(candidate({ looksBookable: false }), profile()).failures).toContain('looksBookable');
  });

  it('reports the photo gate as unknown rather than silently passing it', () => {
    const lenient = evaluateQualityGates(candidate(), profile());
    expect(lenient.photoEvidence).toBe('unknown');
    expect(lenient.warnings).toContain('photos:unknown');
    expect(lenient.admitted).toBe(true);

    const strict = evaluateQualityGates(candidate(), profile(), { requirePhotos: true });
    expect(strict.admitted).toBe(false);
    expect(strict.failures).toContain('photos:unknown');
  });

  it('enforces the photo gate when a run does carry a post count', () => {
    expect(evaluateQualityGates(candidate(), profile({ postCount: 0 })).failures).toContain('photos');
    expect(evaluateQualityGates(candidate(), profile({ postCount: 12 })).admitted).toBe(true);
    expect(evaluateQualityGates(candidate(), profile({ postCount: 12 })).photoEvidence).toBe('counted');
  });

  it('honours a custom follower floor', () => {
    expect(evaluateQualityGates(candidate({ followers: 300 }), profile(), { minFollowers: 100 }).admitted).toBe(true);
  });
});

describe('bio location parsing', () => {
  it('reads an explicit City, ST out of surrounding shop copy', () => {
    expect(parseExplicitLocation('Dead Ahead Tattoo - Nashville, TN.', index)).toMatchObject({
      city: 'Nashville',
      state: 'TN',
    });
    expect(parseExplicitLocation('Located in Portland, OR', index)).toMatchObject({
      city: 'Portland',
      state: 'OR',
    });
  });

  it('refuses a City, ST whose city the gazetteer cannot confirm in that state', () => {
    // "Tattooer in LA, SD" is a real pilot bio meaning Los Angeles and San
    // Diego, not South Dakota. Requiring the city to exist in the matched
    // state is what keeps it out.
    expect(parseExplicitLocation('Tattooer in LA, SD', index)).toBeNull();
    expect(parseExplicitLocation('Austin, ZZ', index)).toBeNull();
  });

  it('resolves unambiguous metro shorthands', () => {
    expect(parseAliasLocation('ATX | Co-Owner of Snake Eyes')).toMatchObject({ city: 'Austin', state: 'TX' });
    expect(parseAliasLocation('browatelier.pdx')).toBeNull();
    expect(parseAliasLocation('PDX based')).toMatchObject({ city: 'Portland', state: 'OR' });
  });

  it('matches a bare city name only when one metro dominates it', () => {
    expect(parseBareCityLocation('bright bold cute chicago artist', index)).toMatchObject({
      city: 'Chicago',
      state: 'IL',
    });
    // Portland OR and Portland ME are too close in this fixture to guess.
    expect(parseBareCityLocation('portland artist', index)).toBeNull();
    expect(parseBareCityLocation('no location here', index)).toBeNull();
  });

  it('resolves a metro that is thin on artists but thick on shops', () => {
    // Miami, FL holds only 13 artists in the live graph but 20 shops, and
    // Miami, OK holds one shop. Requiring artist coverage alone would strand
    // every Miami candidate the pilot found.
    expect(parseBareCityLocation('Local miami tattoo artist', index)).toMatchObject({
      city: 'Miami',
      state: 'FL',
    });
  });

  it('abandons the attempt rather than falling through to a lesser mention', () => {
    // Real pilot bio. "portland, oregon" is ambiguous in the gazetteer, and the
    // artist's surname is Austin — guessing Austin, TX here would be wrong.
    expect(
      parseBareCityLocation('tattoos, fabrication & animation in portland, oregon austin', index),
    ).toBeNull();
  });

  it('prefers the first city named over a later street address', () => {
    // Real pilot bio shape: home city first, a shop's street address second.
    expect(
      parseBareCityLocation('Tattooist based in Chicago. Walk-ins at 123 N Nashville Ave', index),
    ).toMatchObject({ city: 'Chicago', state: 'IL' });
  });

  it('ignores @mentions and links when reading a bare city name', () => {
    expect(parseBareCityLocation('CC President @legion_chicago_club', index)).toBeNull();
    expect(parseBareCityLocation('book at https://chicago-example.com', index)).toBeNull();
  });

  it('reads a lone non-US flag emoji as weaker, flag-grade evidence', () => {
    expect(detectNonUsLocation('37 yrs exp. Belle River ON \u{1F1E8}\u{1F1E6}')).toEqual({
      marker: 'flag:\u{1F1E8}\u{1F1E6}',
      kind: 'flag',
    });
    // A US flag beside it means the flags are heritage, not an address.
    expect(detectNonUsLocation('31 years \u{1F1E7}\u{1F1F7}\u{1F1FA}\u{1F1F8} Realism')).toBeNull();
    expect(detectNonUsLocation('Austin TX \u{1F1FA}\u{1F1F8} tattooer')).toBeNull();
  });

  it('lets a US city named in the bio outrank a bare flag emoji', () => {
    const result = resolveCandidateLocation({
      candidate: candidate({ seedFrom: 'nobodyknowsthisseed' }),
      profile: profile({ bio: 'artist run collective in chicago \u{1F1E7}\u{1F1EC}' }),
      index,
    });
    expect(result).toMatchObject({ city: 'Chicago', state: 'IL', source: 'bio-city' });
  });

  it('flags non-US bios so the seed fallback cannot teleport them', () => {
    expect(detectNonUsLocation('Otaku Tattoo Artist in Japan')).toEqual({
      marker: 'japan',
      kind: 'text',
    });
    expect(detectNonUsLocation('Tattoos: Versailles, 78 FRANCE')).toMatchObject({ kind: 'text' });
    expect(detectNonUsLocation('Austin, TX tattooer')).toBeNull();
  });

  it('sees through the styled Unicode artists write their bios in', () => {
    // "𝗥𝗼𝗻 𝗦𝗺𝗶𝘁𝗵 • 𝗧𝗮𝘁𝘁𝗼𝗼 𝗔𝗿𝘁𝗶𝘀𝘁 • 𝗩𝗮𝗻𝗰𝗼𝘂𝘃𝗲𝗿" is a real pilot display name.
    expect(detectNonUsLocation('\u{1D5E5}\u{1D5FC}\u{1D5FB} • \u{1D5E9}\u{1D5EE}\u{1D5FB}\u{1D5F0}\u{1D5FC}\u{1D602}\u{1D603}\u{1D5F2}\u{1D5FF}'))
      .toMatchObject({ marker: 'vancouver' });
    expect(parseBareCityLocation('\u{1D402}\u{1D421}\u{1D422}\u{1D41C}\u{1D41A}\u{1D420}\u{1D428} tattooer', index))
      .toMatchObject({ city: 'Chicago', state: 'IL' });
  });

  it('does not mistake a style for a country', () => {
    // "Japanese Tattoo, Drawing & Education" is a style list, not an address.
    expect(detectNonUsLocation('Japanese Tattoo, Drawing & Education')).toBeNull();
  });
});

describe('seed fallback', () => {
  it('infers the city from a seed artist already in the graph', () => {
    expect(resolveSeedLocation('artofmarcoantonio', index)).toMatchObject({
      city: 'Austin',
      state: 'TX',
      kind: 'artist',
    });
  });

  it('infers the city from a seed shop matched on its own domain', () => {
    expect(resolveSeedLocation('prideandjoytattoo', index)).toMatchObject({
      city: 'Austin',
      state: 'TX',
      kind: 'shop',
    });
  });

  it('infers the city from a city hashtag seed', () => {
    expect(resolveSeedLocation('#chicagotattoo', index)).toMatchObject({
      city: 'Chicago',
      state: 'IL',
      kind: 'hashtag',
    });
  });

  it('marks multi-seed candidates that disagree as ambiguous', () => {
    expect(resolveSeedLocation('#austintattoo,#chicagotattoo', index)).toMatchObject({ ambiguous: true });
    expect(resolveSeedLocation('#austintattoo,artofmarcoantonio', index)).toMatchObject({ ambiguous: false });
  });

  it('returns nothing for an unknown seed', () => {
    expect(resolveSeedLocation('someunknownseed', index)).toBeNull();
    expect(resolveSeedLocation('', index)).toBeNull();
  });
});

describe('location resolution order', () => {
  it('prefers the bio over the seed', () => {
    const result = resolveCandidateLocation({
      candidate: candidate({ seedFrom: '#austintattoo' }),
      profile: profile({ bio: 'Cathedral Tattoo Chicago, IL' }),
      index,
    });
    expect(result).toMatchObject({ city: 'Chicago', state: 'IL', source: 'bio-explicit' });
  });

  it('does not read a city out of the display name', () => {
    const result = resolveCandidateLocation({
      candidate: candidate({ seedFrom: 'nobodyknowsthisseed' }),
      profile: profile({ fullName: 'John Wayne Chicago', bio: 'Booking below' }),
      index,
    });
    expect(result.city).toBeNull();
  });

  it('falls back to the seed when the bio yields nothing', () => {
    const result = resolveCandidateLocation({
      candidate: candidate({ seedFrom: '#austintattoo' }),
      profile: profile({ bio: 'Booking link below' }),
      index,
    });
    expect(result).toMatchObject({ city: 'Austin', state: 'TX', source: 'seed', confidence: 'low' });
  });

  it('never applies the seed fallback to an artist working abroad', () => {
    const result = resolveCandidateLocation({
      candidate: candidate({ seedFrom: 'artofmarcoantonio' }),
      profile: profile({ bio: 'Otaku Tattoo Artist in Japan' }),
      index,
    });
    expect(result.city).toBeNull();
    expect(result.foreignMarker).toBe('japan');
  });
});

describe('shop linkage', () => {
  it('links a shop when exactly one owns the bio link domain', () => {
    expect(resolveShopLink('https://www.midnightportland.com/', index)).toMatchObject({
      city: 'Portland',
      state: 'OR',
    });
  });

  it('ignores aggregators, booking SaaS and domains several shops share', () => {
    expect(resolveShopLink('https://linktr.ee/someone', index)).toBeNull();
    expect(resolveShopLink('https://book.example.com/a', index)).toBeNull();
    expect(resolveShopLink('', index)).toBeNull();
  });

  it('normalizes domains before matching', () => {
    expect(normalizeDomain('HTTPS://WWW.Example.com/path?x=1')).toBe('example.com');
    expect(normalizeDomain(null)).toBeNull();
  });
});

describe('dedup', () => {
  it('treats an existing Instagram handle as a duplicate', () => {
    expect(classifyDuplicate({ handle: 'alreadyhere', name: 'Already Here' }, index)).toMatchObject({
      status: 'duplicate',
      reason: 'instagram-handle',
      existingId: 'artist_alreadyhere',
    });
  });

  it('flags an exact namesake in the same city instead of importing it', () => {
    expect(
      classifyDuplicate({ handle: 'brandnew', name: 'Jane Doe', city: 'Austin', state: 'TX' }, index),
    ).toMatchObject({ status: 'possible-duplicate', reason: 'name-in-city' });
  });

  it('does not flag the same name in a different city', () => {
    expect(
      classifyDuplicate({ handle: 'brandnew', name: 'Jane Doe', city: 'Chicago', state: 'IL' }, index),
    ).toMatchObject({ status: 'new' });
  });
});

describe('planning one candidate', () => {
  it('produces a row shaped like the Artist nodes already in the graph', () => {
    const decision = planCandidate({
      candidate: candidate({ handle: 'newartist', seedFrom: '#chicagotattoo' }),
      profile: profile({ bio: 'Fine line. Booking below.', url: 'https://www.midnightportland.com/' }),
      index,
      now: '2026-08-10T00:00:00.000Z',
    });

    expect(decision.status).toBe('import');
    expect(decision.row).toMatchObject({
      id: 'artist_newartist',
      instagram: '@newartist',
      instagramUrl: 'https://instagram.com/newartist',
      city: 'Portland',
      state: 'OR',
      shopName: 'Portland Shop 0',
      looksBookable: true,
      locationSource: 'shop',
      discoverySeedFrom: '#chicagotattoo',
      discoveredAt: '2026-08-10T00:00:00.000Z',
      tags: ['discovery-import'],
    });
  });

  it('holds a candidate that has no resolvable location', () => {
    const decision = planCandidate({
      candidate: candidate({ seedFrom: 'nobodyknowsthisseed' }),
      profile: profile({ bio: 'Booking below' }),
      index,
    });
    expect(decision.status).toBe('held');
    expect(decision.holds).toContain('no-location');
    expect(decision.row).toBeUndefined();
  });

  it('holds a non-US candidate separately from a plain missing location', () => {
    const decision = planCandidate({
      candidate: candidate({ seedFrom: 'artofmarcoantonio' }),
      profile: profile({ bio: 'Otaku Tattoo Artist in Japan' }),
      index,
    });
    expect(decision.holds).toContain('non-us-location');
    expect(decision.row).toBeUndefined();
  });

  it('never emits a row for a duplicate or a gate failure', () => {
    expect(
      planCandidate({ candidate: candidate({ handle: 'alreadyhere' }), profile: profile(), index }).row,
    ).toBeUndefined();
    expect(
      planCandidate({ candidate: candidate({ followers: 12 }), profile: profile({ followers: 12 }), index }).row,
    ).toBeUndefined();
  });
});

describe('planning a run', () => {
  const candidates = [
    candidate({ handle: 'keeper', seedFrom: '#austintattoo' }),
    candidate({ handle: 'alreadyhere', seedFrom: '#austintattoo' }),
    candidate({ handle: 'tiny', followers: 9, seedFrom: '#austintattoo' }),
    candidate({ handle: 'rejected', looksBookable: false }),
  ];
  const profiles = {
    keeper: profile({ fullName: 'Keeper' }),
    alreadyhere: profile({ fullName: 'Already Here' }),
    tiny: profile({ fullName: 'Tiny', followers: 9 }),
    rejected: profile({ fullName: 'Rejected' }),
  };

  it('only considers looksBookable candidates and reports the yield', () => {
    const plan = planDiscoveryImport({ candidates, profiles, index });
    expect(plan.stats.totalCandidates).toBe(4);
    expect(plan.stats.bookableCandidates).toBe(3);
    expect(plan.stats.importable).toBe(1);
    expect(plan.stats.duplicates).toBe(1);
    expect(plan.stats.heldQualityGate).toBe(1);
    expect(plan.rows.map((row) => row.id)).toEqual(['artist_keeper']);
    // The seed-vs-bio split the #66 spend decision needs, counted over the
    // rows that would actually be written rather than everything considered.
    expect(plan.stats.importableLocationSources).toMatchObject({ seed: 1, 'bio-explicit': 0 });
  });

  it('honours --limit', () => {
    expect(planDiscoveryImport({ candidates, profiles, index, options: { limit: 1 } }).stats.considered).toBe(1);
  });

  it('samples the weakest evidence first', () => {
    const plan = planDiscoveryImport({
      candidates: [
        candidate({ handle: 'fromseed', seedFrom: '#austintattoo' }),
        candidate({ handle: 'frombio', seedFrom: '#austintattoo' }),
      ],
      profiles: {
        fromseed: profile({ fullName: 'From Seed' }),
        frombio: profile({ fullName: 'From Bio', bio: 'Nashville, TN tattooer' }),
      },
      index,
    });
    const sample = buildSpotCheckSample(plan.decisions, 2);
    expect(sample[0].handle).toBe('fromseed');
    expect(sample[0].checkThis).toMatch(/seed account/);
    expect(buildSpotCheckSample(plan.decisions, 0)).toEqual([]);
  });

  it('builds an inert artifact carrying every decision and its evidence', () => {
    const options = parseDiscoveryImportArgs(['--sample', '1']);
    const plan = planDiscoveryImport({ candidates, profiles, index, options });
    const artifact = buildImportPlanArtifact({
      plan,
      options,
      generatedAt: '2026-08-10T00:00:00.000Z',
      referenceSummary: { origin: 'test', artists: 3, shops: 4 },
    });

    expect(artifact.issue).toBe(65);
    expect(artifact.generatedAt).toBe('2026-08-10T00:00:00.000Z');
    expect(artifact.decisions).toHaveLength(3);
    expect(artifact.spotCheckSample).toHaveLength(1);
    expect(artifact.decisions.find((d) => d.handle === 'alreadyhere')).toMatchObject({
      status: 'duplicate',
      duplicateOf: 'artist_alreadyhere',
    });
  });
});

describe('write Cypher', () => {
  it('keeps every protection the national importer applies', () => {
    expect(DISCOVERY_ARTIST_IMPORT_CYPHER).toContain('a.removedAt IS NULL');
    expect(DISCOVERY_ARTIST_IMPORT_CYPHER).toContain('a.claimedByUid IS NULL');
    expect(DISCOVERY_ARTIST_IMPORT_CYPHER).toContain("coalesce(a.selfRegistered, false) = false");
    expect(DISCOVERY_ARTIST_IMPORT_CYPHER).toContain('TakedownTombstone');
    expect(DISCOVERY_ARTIST_IMPORT_CYPHER).toContain("TakedownRequest {status: 'pending'");
    expect(DISCOVERY_ARTIST_IMPORT_CYPHER).toContain("'name' IN coalesce(a.artistManagedFields, [])");
    expect(DISCOVERY_ARTIST_IMPORT_CYPHER).toContain("coalesce(a.claimVerificationStatus, '') = 'verified'");
  });

  it('never deletes and never blind-creates', () => {
    expect(DISCOVERY_ARTIST_IMPORT_CYPHER).not.toContain('DETACH DELETE');
    expect(DISCOVERY_ARTIST_IMPORT_CYPHER).not.toContain('DELETE');
    expect(DISCOVERY_ARTIST_IMPORT_CYPHER).not.toMatch(/\bCREATE \(/);
    expect(DISCOVERY_ARTIST_IMPORT_CYPHER).toContain('MERGE (a:Artist {id: row.id})');
  });

  it('only links WORKS_AT when a shop was actually derived', () => {
    expect(DISCOVERY_ARTIST_IMPORT_CYPHER).toContain('row.shopName IS NOT NULL');
    expect(DISCOVERY_ARTIST_IMPORT_CYPHER).toContain('MERGE (a)-[:WORKS_AT]->(s)');
    expect(DISCOVERY_ARTIST_IMPORT_CYPHER).toContain('MERGE (a)-[:LOCATED_IN]->(c)');
  });

  it('reads the reference graph without writing to it', () => {
    for (const cypher of [DISCOVERY_REFERENCE_ARTISTS_CYPHER, DISCOVERY_REFERENCE_SHOPS_CYPHER]) {
      expect(cypher).toMatch(/^\s*MATCH/);
      expect(cypher).not.toMatch(/MERGE|CREATE|SET|DELETE/);
    }
  });
});
