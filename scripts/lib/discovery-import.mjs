/**
 * Pure planning logic for the discovery → graph importer (issue #65).
 *
 * The discovery crawler (`execution/discover_ig.py`) writes
 * `data/discovery/candidates.json` + `profiles.json` and stops there. Those
 * records carry a handle, a bio, a follower count and the seed that surfaced
 * them — no id, no city, no shop. This module turns one of those records into
 * an `:Artist` row shaped exactly like the national importer's, and decides,
 * per record, whether it is allowed in at all.
 *
 * Everything here is pure: no fs, no driver, no clock. The driver script
 * (`scripts/import-discovery-to-neo4j.mjs`) supplies the candidate rows, the
 * profile map and a reference index read out of Neo4j, and owns every write.
 *
 * Design decisions locked with the owner on issue #65 (2026-08-11):
 *   - Automated gates admit a candidate; a human spot-checks a *sample*.
 *   - City comes from the bio first, and falls back to the seed account that
 *     surfaced the candidate. Never silently blank without trying both.
 *   - Zero new discovery spend: no lookups, no network, no paid enrichment.
 */

import { normalizeInstagramHandle } from './takedown-tombstone.mjs';
import {
  preserveArtistManagedField,
  preserveVerifiedIdentityField,
} from './artist-managed-import.mjs';

export const DEFAULT_DISCOVERY_CANDIDATES_INPUT =
  'data/discovery/candidates.json';
export const DEFAULT_DISCOVERY_OUTPUT = 'data/discovery/import-plan.json';

/**
 * Follower floor for admission. The pilot's bookable candidates run from 28 to
 * 165,749 followers (median ~5k); 500 drops the accounts too small to have a
 * portfolio worth showing without cutting into the working artists. Tunable
 * with --min-followers precisely because it is a judgement call.
 */
export const DEFAULT_MIN_FOLLOWERS = 500;

/**
 * Minimum artists already in a metro before a bare city name in a bio counts
 * as a hit. Artist counts lead because the shop dataset is capped at ~20 rows
 * per city by the place search that produced it, which flattens Portland OR
 * and Portland ME into a tie; artist counts keep the real distribution
 * (154 vs 34) and can break it.
 */
export const DEFAULT_CITY_PROMINENCE = 25;

/**
 * ...but artist coverage is uneven — the graph holds 154 Portland artists and
 * only 13 in Miami — so a metro also qualifies on shop count alone. Both
 * signals are then consulted before calling a city name ambiguous.
 */
export const DEFAULT_SHOP_PROMINENCE = 15;

export const US_STATE_CODES = Object.freeze([
  'AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'DC', 'FL', 'GA', 'HI', 'ID',
  'IL', 'IN', 'IA', 'KS', 'KY', 'LA', 'ME', 'MD', 'MA', 'MI', 'MN', 'MS', 'MO',
  'MT', 'NE', 'NV', 'NH', 'NJ', 'NM', 'NY', 'NC', 'ND', 'OH', 'OK', 'OR', 'PA',
  'RI', 'SC', 'SD', 'TN', 'TX', 'UT', 'VT', 'VA', 'WA', 'WV', 'WI', 'WY',
]);
const US_STATE_SET = new Set(US_STATE_CODES);

/**
 * Unambiguous metro shorthands artists actually write in bios. Deliberately
 * short: two-letter forms like "LA"/"SD" collide with state codes and with
 * ordinary words, and a wrong city is worse than no city.
 */
export const CITY_ALIASES = Object.freeze({
  ATX: { city: 'Austin', state: 'TX' },
  PDX: { city: 'Portland', state: 'OR' },
  NYC: { city: 'New York', state: 'NY' },
  NOLA: { city: 'New Orleans', state: 'LA' },
  SATX: { city: 'San Antonio', state: 'TX' },
  DTLA: { city: 'Los Angeles', state: 'CA' },
  PHX: { city: 'Phoenix', state: 'AZ' },
  SEA: { city: 'Seattle', state: 'WA' },
});

/**
 * Signals that a candidate works outside the US. The graph is a US directory
 * (every one of its cities carries a two-letter state) and, more importantly,
 * the seed fallback would otherwise hand a Tokyo artist "Austin, TX" purely
 * because an Austin shop follows them. Detected foreign artists are held for
 * review, never located from a seed.
 */
export const NON_US_LOCATION_MARKERS = Object.freeze([
  'japan', 'tokyo', 'osaka', 'kyoto', 'korea', 'seoul', 'china', 'shanghai',
  'taiwan', 'thailand', 'bangkok', 'singapore', 'philippines', 'indonesia',
  'bali', 'vietnam', 'india', 'dubai', 'uae', 'israel', 'turkey', 'istanbul',
  'united kingdom', 'uk', 'england', 'london', 'liverpool',
  'bristol', 'leeds', 'glasgow', 'edinburgh', 'scotland', 'wales', 'ireland',
  'dublin', 'france', 'paris', 'versailles', 'lyon', 'marseille', 'germany',
  'berlin', 'munich', 'hamburg', 'cologne', 'köln', 'austria',
  'switzerland', 'zurich', 'geneva', 'netherlands', 'amsterdam',
  'rotterdam', 'belgium', 'brussels', 'spain', 'madrid', 'barcelona',
  'portugal', 'lisbon', 'italy', 'rome', 'milan', 'poland', 'warsaw',
  'krakow', 'czech', 'prague', 'hungary', 'budapest', 'romania', 'bucharest',
  'ukraine', 'kyiv', 'kiev', 'russia', 'moscow', 'sweden', 'stockholm',
  'norway', 'oslo', 'denmark', 'copenhagen', 'finland', 'helsinki', 'greece',
  'athens', 'canada', 'toronto', 'vancouver', 'montreal', 'calgary', 'ottawa',
  'quebec', 'australia', 'sydney', 'melbourne', 'brisbane', 'perth',
  'new zealand', 'auckland', 'mexico city', 'cdmx', 'guadalajara', 'brazil',
  'sao paulo', 'são paulo', 'rio de janeiro', 'argentina', 'buenos aires',
  'chile', 'santiago', 'colombia', 'bogota', 'bogotá', 'medellin',
  'osnabruck', 'osnabrück', 'nantes', 'milano', 'praha',
]);
// Deliberately absent: Peru, Lima, Vienna, Manchester and other names the US
// also uses for towns (and, in "Bobbi Peru", for people).

/**
 * Link aggregators, booking SaaS and marketplaces. A shop row in the graph can
 * legitimately carry one of these as its "website", so a bio URL landing on
 * one proves nothing about where the artist works.
 */
export const NON_SHOP_DOMAINS = Object.freeze([
  'linktr.ee', 'beacons.ai', 'msha.ke', 'carrd.co', 'dot.cards', 'link.me',
  'withkoji.com', 'tally.so', 'forms.gle', 'form.jotform.com', 'jotform.com',
  'docs.google.com', 'sites.google.com', 'instagram.com', 'facebook.com',
  'tiktok.com', 'youtube.com', 'twitter.com', 'x.com', 't.me', 'wa.me',
  'wa.link', 'whatsapp.com', 'etsy.com', 'bigcartel.com', 'gumroad.com',
  'shopify.com', 'squareup.com', 'square.site', 'venue.ink', 'heygoldie.com',
  'book.heygoldie.com', 'calendly.com', 'vagaro.com', 'booksy.com',
  'web.getporter.io', 'eventbrite.com', 'patreon.com', 'cash.app', 'venmo.com',
  'paypal.me', 'wixsite.com', 'mailchi.mp', 'bit.ly',
]);
const NON_SHOP_DOMAIN_SET = new Set(NON_SHOP_DOMAINS);

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

function optionValue(args, name) {
  const index = args.indexOf(name);
  if (index < 0) return null;
  const value = args[index + 1];
  if (!value || value.startsWith('--')) {
    throw new Error(`${name} requires a value`);
  }
  return value;
}

function positiveInteger(raw, name, { allowZero = false } = {}) {
  const value = Number(raw);
  const floor = allowZero ? 0 : 1;
  if (!Number.isInteger(value) || value < floor) {
    throw new Error(
      `${name} must be a${allowZero ? ' non-negative' : ' positive'} integer`,
    );
  }
  return value;
}

/**
 * Dry run is the default and there is no way to write without --apply. The
 * graph holds real scraped artists plus claims, takedowns and payment state,
 * so --wipe is rejected outright the way the national importer rejects it.
 */
export function parseDiscoveryImportArgs(args) {
  if (args.includes('--wipe')) {
    throw new Error(
      '--wipe is not supported by the discovery importer because the live ' +
        'graph contains claimed profiles, takedown records, and payment state.',
    );
  }

  const valued = new Set([
    '--input',
    '--profiles',
    '--out',
    '--limit',
    '--min-followers',
    '--sample',
    '--reference',
  ]);
  const supported = new Set([...valued, '--apply', '--allow-unknown-photos']);
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!supported.has(arg)) throw new Error(`Unknown option: ${arg}`);
    if (valued.has(arg)) index += 1;
  }

  const rawLimit = optionValue(args, '--limit');
  const rawMinFollowers = optionValue(args, '--min-followers');
  const rawSample = optionValue(args, '--sample');
  const input = optionValue(args, '--input') ?? DEFAULT_DISCOVERY_CANDIDATES_INPUT;

  return {
    apply: args.includes('--apply'),
    allowUnknownPhotos: args.includes('--allow-unknown-photos'),
    input,
    profiles: optionValue(args, '--profiles') ?? defaultProfilesPathFor(input),
    out: optionValue(args, '--out') ?? DEFAULT_DISCOVERY_OUTPUT,
    reference: optionValue(args, '--reference'),
    limit: rawLimit === null ? Infinity : positiveInteger(rawLimit, '--limit'),
    minFollowers:
      rawMinFollowers === null
        ? DEFAULT_MIN_FOLLOWERS
        : positiveInteger(rawMinFollowers, '--min-followers', { allowZero: true }),
    sample: rawSample === null ? 20 : positiveInteger(rawSample, '--sample', { allowZero: true }),
  };
}

/** profiles.json always sits beside candidates.json in a discovery run. */
export function defaultProfilesPathFor(candidatesPath) {
  const separator = candidatesPath.includes('/') ? '/' : null;
  if (!separator) return 'profiles.json';
  return `${candidatesPath.slice(0, candidatesPath.lastIndexOf('/'))}/profiles.json`;
}

// ---------------------------------------------------------------------------
// Reference index (existing graph state)
// ---------------------------------------------------------------------------

export function normalizeDomain(rawUrl) {
  if (!rawUrl) return null;
  const trimmed = String(rawUrl).trim().toLowerCase();
  if (!trimmed) return null;
  const withoutScheme = trimmed.replace(/^[a-z][a-z0-9+.-]*:\/\//, '');
  const host = withoutScheme.split(/[/?#]/)[0].replace(/^www\./, '');
  return host || null;
}

/**
 * Fold the styled Unicode artists write their bios in — "𝗩𝗮𝗻𝗰𝗼𝘂𝘃𝗲𝗿" and
 * "𝕺𝖜𝖓𝖊𝖗" are Vancouver and Owner, and no amount of city matching finds them
 * otherwise.
 */
export function foldText(raw) {
  return String(raw ?? '').normalize('NFKD');
}

function normalizeName(raw) {
  return String(raw ?? '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * Fold the graph's existing artists and shops into the lookups the planner
 * needs: dedup by handle and by (name, city), seed → location, bio URL → shop,
 * and a city gazetteer weighted by how many shops sit in each metro.
 */
export function buildReferenceIndex({ artists = [], shops = [] } = {}) {
  const artistsByHandle = new Map();
  const artistsByName = new Map();
  const artistIds = new Set();
  const cityCounts = new Map();

  const cityEntry = (rawCity, rawState) => {
    const city = String(rawCity ?? '').trim();
    const state = String(rawState ?? '').trim().toUpperCase();
    if (!city || !US_STATE_SET.has(state)) return null;
    const key = `${city.toLowerCase()}|${state}`;
    const entry = cityCounts.get(key) ?? { city, state, artistCount: 0, shopCount: 0 };
    cityCounts.set(key, entry);
    return entry;
  };

  for (const artist of artists) {
    if (artist?.id) artistIds.add(artist.id);
    const home = cityEntry(artist?.city, artist?.state);
    if (home) home.artistCount += 1;
    const handle = normalizeInstagramHandle(artist?.instagram);
    if (handle && !artistsByHandle.has(handle)) artistsByHandle.set(handle, artist);
    const name = normalizeName(artist?.name);
    if (!name) continue;
    if (!artistsByName.has(name)) artistsByName.set(name, []);
    artistsByName.get(name).push(artist);
  }

  const shopsByDomain = new Map();
  for (const shop of shops) {
    const domain = normalizeDomain(shop?.website);
    if (domain && !NON_SHOP_DOMAIN_SET.has(domain)) {
      if (!shopsByDomain.has(domain)) shopsByDomain.set(domain, []);
      shopsByDomain.get(domain).push(shop);
    }
    const home = cityEntry(shop?.city, shop?.state);
    if (home) home.shopCount += 1;
  }

  const citiesByName = new Map();
  for (const entry of cityCounts.values()) {
    const key = entry.city.toLowerCase();
    if (!citiesByName.has(key)) citiesByName.set(key, []);
    citiesByName.get(key).push(entry);
  }
  for (const entries of citiesByName.values()) {
    entries.sort(
      (a, b) =>
        b.artistCount - a.artistCount ||
        b.shopCount - a.shopCount ||
        a.state.localeCompare(b.state),
    );
  }

  return { artistsByHandle, artistsByName, artistIds, shopsByDomain, citiesByName };
}

/**
 * Pick the metro a bare city name refers to. "Portland" means Oregon in this
 * dataset and Maine in about a twentieth of it, so a name only resolves when
 * one metro clearly dominates; otherwise it stays unresolved.
 */
export function resolveCityName(
  name,
  index,
  { prominence = DEFAULT_CITY_PROMINENCE, shopProminence = DEFAULT_SHOP_PROMINENCE } = {},
) {
  const entries = index?.citiesByName?.get(String(name ?? '').trim().toLowerCase());
  if (!entries?.length) return null;
  const [best, runnerUp] = entries;
  if (best.artistCount < prominence && best.shopCount < shopProminence) return null;
  // Ambiguous only when the runner-up is close on *both* signals. Portland OR
  // outweighs Portland ME on artists; Miami FL outweighs Miami OK on shops.
  if (
    runnerUp &&
    runnerUp.artistCount * 3 > best.artistCount &&
    runnerUp.shopCount * 3 > best.shopCount
  ) {
    return null;
  }
  return { city: best.city, state: best.state };
}

// ---------------------------------------------------------------------------
// Location
// ---------------------------------------------------------------------------

/** Regional-indicator pairs — the flag emoji artists put in their bios. */
const FLAG_EMOJI_PATTERN = /[\u{1F1E6}-\u{1F1FF}]{2}/gu;
const US_FLAG = '\u{1F1FA}\u{1F1F8}';

/**
 * Two grades of evidence, because they are not equally trustworthy:
 *   - `text` — a country or foreign city written out. That is a location
 *     claim, and it wins outright.
 *   - `flag`  — a flag emoji with no US flag beside it. Often a location, but
 *     just as often heritage ("🇨🇺🇹🇹🇦🇪 Various styles"), so the caller gives a
 *     US city named in the bio a chance to win first.
 * Whole words only: "Japanese Tattoo" is a style, not an address.
 */
export function detectNonUsLocation(text) {
  const raw = foldText(text);
  const haystack = raw.toLowerCase().replace(/\s+/g, ' ');
  for (const marker of NON_US_LOCATION_MARKERS) {
    const pattern = new RegExp(`(^|[^\\p{L}])${marker}([^\\p{L}]|$)`, 'u');
    if (pattern.test(haystack)) return { marker, kind: 'text' };
  }

  const flags = raw.match(FLAG_EMOJI_PATTERN) ?? [];
  if (flags.length && !flags.includes(US_FLAG)) {
    return { marker: `flag:${flags[0]}`, kind: 'flag' };
  }
  return null;
}

const EXPLICIT_LOCATION_PATTERN =
  /([A-Za-z][A-Za-z.'’-]*(?:[ ][A-Za-z][A-Za-z.'’-]*){0,3})\s*,\s*([A-Za-z]{2})(?![A-Za-z])/g;

/**
 * "Dead Ahead Tattoo - Nashville, TN." → Nashville, TN.
 *
 * The city half of a bio's "City, ST" is nearly always glued to shop names and
 * emoji, so the longest trailing word-run that the gazetteer recognises *in
 * that state* wins. Requiring the gazetteer to agree is what stops
 * "Tattooer in LA, SD" from importing an artist to South Dakota.
 */
export function parseExplicitLocation(text, index) {
  const haystack = foldText(text);
  for (const match of haystack.matchAll(EXPLICIT_LOCATION_PATTERN)) {
    const state = match[2].toUpperCase();
    if (!US_STATE_SET.has(state)) continue;
    const words = match[1].split(/\s+/).filter(Boolean);
    for (let start = Math.max(0, words.length - 3); start < words.length; start += 1) {
      const candidate = words.slice(start).join(' ');
      const entries = index?.citiesByName?.get(candidate.toLowerCase());
      const hit = entries?.find((entry) => entry.state === state);
      if (hit) {
        return { city: hit.city, state: hit.state, evidence: `${candidate}, ${state}` };
      }
    }
  }
  return null;
}

export function parseAliasLocation(text) {
  const haystack = foldText(text);
  for (const [alias, location] of Object.entries(CITY_ALIASES)) {
    if (new RegExp(`(^|[^A-Za-z])${alias}([^A-Za-z]|$)`).test(haystack)) {
      return { ...location, evidence: alias };
    }
  }
  return null;
}

/**
 * Last resort before the seed: a bare city name written in the bio.
 *
 * Three rules keep this honest, each of them earned from a wrong answer on the
 * pilot data:
 *   - Bio text only, never the display name. "John Wayne Beesting" is not
 *     Wayne, NJ and "Abby Austin" is not Austin, TX.
 *   - @mentions and links are stripped first. "@legion_los_angeles" is a club,
 *     not an address.
 *   - The *first* city named wins, not the longest: "Tattooist based in
 *     Chicago ... 123 N Milwaukee Ave" is a Chicago artist with a street
 *     address, not a Milwaukee one. If that first name is ambiguous the whole
 *     attempt is abandoned rather than falling through to a later mention — a
 *     bio that says "portland, oregon" must not end up in Austin.
 */
export function parseBareCityLocation(text, index, options) {
  const cleaned = foldText(text)
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/\S+\.(com|net|org|co|ink|art|studio|tattoo)\b\S*/g, ' ')
    .replace(/@[a-z0-9._]+/g, ' ');
  const haystack = ` ${cleaned.replace(/[^a-z0-9]+/g, ' ')} `;

  let first = null;
  for (const name of index?.citiesByName?.keys() ?? []) {
    if (name.length < 4) continue;
    const at = haystack.indexOf(` ${name} `);
    if (at < 0) continue;
    // Earliest mention wins; on a tie the longer name does ("las vegas" beats
    // "vegas" when both start at the same offset).
    if (!first || at < first.at || (at === first.at && name.length > first.name.length)) {
      first = { name, at };
    }
  }
  if (!first) return null;

  const resolved = resolveCityName(first.name, index, options);
  if (!resolved) return null;
  return { city: resolved.city, state: resolved.state, evidence: first.name };
}

/**
 * Resolve the seed that surfaced this candidate. Seeds are either an artist
 * handle (already in the graph), a shop handle (matched via its own domain —
 * shops are keyed by placeId and carry no Instagram), or a city hashtag such
 * as `#portlandtattoo`.
 */
export function resolveSeedLocation(seedFrom, index, options) {
  const tokens = String(seedFrom ?? '')
    .split(',')
    .map((token) => token.trim())
    .filter(Boolean);

  const hits = [];
  for (const token of tokens) {
    if (token.startsWith('#')) {
      const bare = token.slice(1).toLowerCase().replace(/^tattoos?/, '').replace(/tattoos?$/, '');
      const resolved = resolveCityName(bare, index, options);
      if (resolved) hits.push({ ...resolved, evidence: token, kind: 'hashtag' });
      continue;
    }
    const handle = normalizeInstagramHandle(token);
    if (!handle) continue;
    const artist = index?.artistsByHandle?.get(handle);
    if (artist?.city && artist?.state) {
      hits.push({ city: artist.city, state: artist.state, evidence: `@${handle}`, kind: 'artist' });
      continue;
    }
    const shops = index?.shopsByDomain?.get(`${handle}.com`);
    if (shops?.length === 1 && shops[0].city && shops[0].state) {
      hits.push({
        city: shops[0].city,
        state: shops[0].state,
        evidence: `@${handle}`,
        kind: 'shop',
      });
    }
  }

  if (!hits.length) return null;
  const distinct = new Set(hits.map((hit) => `${hit.city}|${hit.state}`));
  return { ...hits[0], ambiguous: distinct.size > 1 };
}

/**
 * Bio first, seed second — the order the owner locked. A candidate that reads
 * as working outside the US never reaches the seed fallback; it is held for
 * review instead of being teleported to the seed's metro.
 */
export function resolveCandidateLocation({ candidate, profile, index, options } = {}) {
  const bio = String(profile?.bio ?? candidate?.bioSnippet ?? '');
  const text = `${profile?.fullName ?? ''}\n${bio}`;

  const explicit = parseExplicitLocation(text, index);
  if (explicit) return { ...explicit, source: 'bio-explicit', confidence: 'high' };

  const alias = parseAliasLocation(text);
  if (alias) return { ...alias, source: 'bio-alias', confidence: 'medium' };

  const foreign = detectNonUsLocation(text);
  const held = {
    city: null,
    state: null,
    source: 'none',
    confidence: 'none',
    foreignMarker: foreign?.marker,
    evidence: foreign?.marker,
  };
  if (foreign?.kind === 'text') return held;

  // Bare city names are read out of the bio only — a display name is a name.
  const bare = parseBareCityLocation(bio, index, options);
  if (bare) return { ...bare, source: 'bio-city', confidence: 'medium' };
  if (foreign) return held;

  const seed = resolveSeedLocation(candidate?.seedFrom, index, options);
  if (seed) {
    return {
      city: seed.city,
      state: seed.state,
      evidence: seed.evidence,
      seedKind: seed.kind,
      ambiguousSeed: Boolean(seed.ambiguous),
      source: 'seed',
      confidence: 'low',
    };
  }

  return { city: null, state: null, source: 'none', confidence: 'none' };
}

// ---------------------------------------------------------------------------
// Shop linkage
// ---------------------------------------------------------------------------

/**
 * Link a candidate to a shop only when its bio URL is a domain that exactly
 * one shop in the graph claims. Aggregator domains are excluded up front, and
 * a domain shared by several shops proves nothing, so it is dropped. This is
 * deliberately low-recall: a wrong WORKS_AT edge shows a client the wrong
 * address.
 */
export function resolveShopLink(profileUrl, index) {
  const domain = normalizeDomain(profileUrl);
  if (!domain || NON_SHOP_DOMAIN_SET.has(domain)) return null;
  const shops = index?.shopsByDomain?.get(domain);
  if (!shops || shops.length !== 1) return null;
  const shop = shops[0];
  if (!shop.name || !shop.city || !shop.state) return null;
  return { name: shop.name, city: shop.city, state: shop.state, placeId: shop.placeId, domain };
}

// ---------------------------------------------------------------------------
// Quality gates
// ---------------------------------------------------------------------------

export const QUALITY_GATES = Object.freeze([
  'looksBookable',
  'notPrivate',
  'notJobBoard',
  'followers',
  'bio',
  'photos',
]);

/**
 * Instagram categories that say outright the account is not a person who
 * tattoos. Kept narrow on purpose — the pilot's bookable set also contains an
 * `Artist` who runs a shop and a working artist filed under `Hot Dog Joint`,
 * so only categories that *are* the disqualification belong here.
 */
export const NON_ARTIST_CATEGORIES = Object.freeze([
  'employment agency',
  'recruiter',
  'staffing agency',
  'staffing service',
  'job board',
]);
const NON_ARTIST_CATEGORY_SET = new Set(NON_ARTIST_CATEGORIES);

/**
 * Job boards and gig marketplaces clear the upstream `looks_bookable`
 * classifier because their bios are wall-to-wall tattoo-and-booking language
 * (#62 is the upstream fix). These are phrases, never the bare word "job" —
 * a working artist writes "I have a full time job, but I also make ceramics"
 * and must not be held for it.
 */
export const JOB_BOARD_BIO_PATTERNS = Object.freeze([
  /\bjob board\b/i,
  /\btattoo (?:jobs|gigs)\b/i,
  /\bjobs? (?:worldwide|available|posted|board)\b/i,
  /\bartists? wanted\b/i,
  /\bnow hiring\b/i,
  /\bhiring\b[^.\n]{0,30}\bartists?\b/i,
  /\bpost (?:&|and) search jobs\b/i,
  /\brecruit(?:ing|ment|er)\b/i,
  /\b\d[\d,]*\+?\s*jobs\b/i,
]);

/** Handles minted like a domain — `tattoo.jobs`, `tattoo.gigs`. */
const JOB_BOARD_HANDLE_SUFFIXES = Object.freeze(['.jobs', '.gigs']);

/**
 * True when the account is a job board / gig marketplace rather than an
 * artist. Returns the evidence so the hold is auditable in the plan artifact
 * instead of being an unexplained rejection.
 */
export function classifyJobBoard(candidate, profile) {
  const category = String(profile?.category ?? '').trim().toLowerCase();
  if (NON_ARTIST_CATEGORY_SET.has(category)) {
    return { isJobBoard: true, evidence: `category: ${profile.category}` };
  }

  const handle = normalizeInstagramHandle(candidate?.handle ?? profile?.handle) ?? '';
  const suffix = JOB_BOARD_HANDLE_SUFFIXES.find((end) => handle.endsWith(end));
  if (suffix) return { isJobBoard: true, evidence: `handle ends in ${suffix}` };

  const bio = String(profile?.bio ?? candidate?.bioSnippet ?? '');
  const pattern = JOB_BOARD_BIO_PATTERNS.find((regex) => regex.test(bio));
  if (pattern) {
    return { isJobBoard: true, evidence: `bio matches ${pattern.source}` };
  }

  return { isJobBoard: false, evidence: null };
}

/**
 * The automated bar. `photos` is the honest problem: a discovery run records
 * no post or media count, so "has photos" cannot be evaluated from the pilot
 * artifact. It is a **hold** — an account we cannot show a portfolio for is
 * not import-ready, and admitting it while calling the gate enforced was the
 * defect Samson caught in review. `--allow-unknown-photos` opts back into
 * admitting them, which is how you measure the ceiling the pilot *would* have
 * if discovery captured media counts; every unknown is force-included in the
 * human spot-check sample either way.
 */
export function evaluateQualityGates(candidate, profile, options = {}) {
  const minFollowers = options.minFollowers ?? DEFAULT_MIN_FOLLOWERS;
  const allowUnknownPhotos = options.allowUnknownPhotos ?? false;

  const followers = candidate?.followers ?? profile?.followers ?? null;
  const bio = String(profile?.bio ?? candidate?.bioSnippet ?? '').trim();
  const photoCount = profile?.postCount ?? profile?.mediaCount ?? null;
  const photosKnown = Number.isFinite(photoCount);
  const jobBoard = classifyJobBoard(candidate, profile);

  const failures = [];
  const warnings = [];

  if (candidate?.looksBookable !== true) failures.push('looksBookable');
  if (profile?.private === true) failures.push('notPrivate');
  if (jobBoard.isJobBoard) failures.push('notJobBoard');
  if (!Number.isFinite(followers)) failures.push('followers:unknown');
  else if (followers < minFollowers) failures.push('followers');
  if (!bio) failures.push('bio');

  if (photosKnown) {
    if (photoCount <= 0) failures.push('photos');
  } else if (allowUnknownPhotos) {
    warnings.push('photos:unknown');
  } else {
    failures.push('photos:unknown');
  }

  return {
    admitted: failures.length === 0,
    failures,
    warnings,
    followers,
    photoEvidence: photosKnown ? 'counted' : 'unknown',
    jobBoardEvidence: jobBoard.evidence,
  };
}

// ---------------------------------------------------------------------------
// Dedup
// ---------------------------------------------------------------------------

export function discoveryArtistId(handle) {
  const normalized = normalizeInstagramHandle(handle);
  return normalized ? `artist_${normalized}` : null;
}

/**
 * Handle first, id second, then an exact name match inside the same city.
 * Handle and id are the same key in practice (ids are minted from handles),
 * but they are checked separately because the graph also holds artists whose
 * ids were minted elsewhere. The name check is exact-match-in-city only: the
 * repo deliberately avoids fuzzy name matching, and a same-city namesake is
 * flagged for a human rather than merged or imported.
 */
export function classifyDuplicate({ handle, name, city, state }, index) {
  const normalized = normalizeInstagramHandle(handle);
  const id = discoveryArtistId(handle);

  const byHandle = normalized ? index?.artistsByHandle?.get(normalized) : null;
  if (byHandle) {
    return { status: 'duplicate', reason: 'instagram-handle', existingId: byHandle.id };
  }
  if (id && index?.artistIds?.has(id)) {
    return { status: 'duplicate', reason: 'artist-id', existingId: id };
  }

  const nameKey = normalizeName(name);
  if (nameKey && city && state) {
    const namesakes = index?.artistsByName?.get(nameKey) ?? [];
    const sameCity = namesakes.find(
      (artist) =>
        String(artist.city ?? '').toLowerCase() === String(city).toLowerCase() &&
        String(artist.state ?? '').toUpperCase() === String(state).toUpperCase(),
    );
    if (sameCity) {
      return { status: 'possible-duplicate', reason: 'name-in-city', existingId: sameCity.id };
    }
  }

  return { status: 'new', reason: null, existingId: null };
}

// ---------------------------------------------------------------------------
// Planning
// ---------------------------------------------------------------------------

export function instagramProfileUrl(raw) {
  const handle = normalizeInstagramHandle(raw);
  return handle ? `https://instagram.com/${handle}` : null;
}

export function tombstoneKeysForCandidate(handle) {
  const keys = [];
  const id = discoveryArtistId(handle);
  if (id) keys.push(`artist:${id}`);
  const normalized = normalizeInstagramHandle(handle);
  if (normalized) keys.push(`instagram:${normalized}`);
  return keys;
}

/**
 * Decide one candidate's fate. Returns the decision plus, when the candidate
 * is importable, the exact row the write Cypher will consume.
 */
export function planCandidate({ candidate, profile, index, options = {}, now } = {}) {
  const handle = normalizeInstagramHandle(candidate?.handle);
  const gates = evaluateQualityGates(candidate, profile, options);
  const location = resolveCandidateLocation({ candidate, profile, index, options });
  const shop = resolveShopLink(profile?.url, index);

  // A shop link is a stronger location signal than the seed fallback: it is a
  // street address, not an inference. It never overrides the bio.
  const resolved =
    shop && (location.source === 'seed' || location.source === 'none')
      ? { city: shop.city, state: shop.state, source: 'shop', confidence: 'high', evidence: shop.domain }
      : location;

  const name = String(profile?.fullName ?? '').trim() || handle;
  const duplicate = classifyDuplicate(
    { handle, name, city: resolved.city, state: resolved.state },
    index,
  );

  const decision = {
    handle,
    id: discoveryArtistId(handle),
    name,
    followers: gates.followers,
    seedFrom: candidate?.seedFrom ?? null,
    source: candidate?.source ?? null,
    filterReason: candidate?.filterReason ?? null,
    gates,
    location: resolved,
    shop,
    duplicate,
    holds: [],
    status: 'import',
  };

  if (!handle) decision.holds.push('unusable-handle');
  if (!gates.admitted) decision.holds.push('quality-gate');
  if (duplicate.status === 'duplicate') decision.holds.push('duplicate');
  if (duplicate.status === 'possible-duplicate') decision.holds.push('possible-duplicate');
  if (!resolved.city || !resolved.state) {
    decision.holds.push(resolved.foreignMarker ? 'non-us-location' : 'no-location');
  }

  if (decision.holds.length) {
    decision.status = decision.holds.includes('duplicate') ? 'duplicate' : 'held';
    return decision;
  }

  decision.row = buildArtistRow({ candidate, profile, decision, now });
  return decision;
}

/**
 * Shaped to match `NATIONAL_ARTIST_IMPORT_CYPHER`'s row contract, plus the
 * discovery provenance the human needs to audit an import after the fact.
 */
export function buildArtistRow({ candidate, profile, decision, now }) {
  return {
    id: decision.id,
    name: decision.name,
    instagram: `@${decision.handle}`,
    instagramUrl: instagramProfileUrl(decision.handle),
    bio: String(profile?.bio ?? candidate?.bioSnippet ?? '').trim(),
    city: decision.location.city,
    state: decision.location.state,
    shopName: decision.shop?.name ?? null,
    followers: decision.followers,
    looksBookable: true,
    bookabilityReason: candidate?.filterReason ?? null,
    discoverySource: candidate?.source ?? null,
    discoverySeedFrom: candidate?.seedFrom ?? null,
    discoveredAt: now ?? null,
    locationSource: decision.location.source,
    locationEvidence: decision.location.evidence ?? null,
    tombstoneKeys: tombstoneKeysForCandidate(decision.handle),
    tags: ['discovery-import'],
  };
}

/**
 * Plan the whole run. Nothing here touches the network; the caller has already
 * read the artifacts and the reference index.
 */
export function planDiscoveryImport({
  candidates = [],
  profiles = {},
  index,
  options = {},
  now = null,
} = {}) {
  const bookable = candidates.filter((candidate) => candidate?.looksBookable === true);
  const considered = Number.isFinite(options.limit) ? bookable.slice(0, options.limit) : bookable;

  const decisions = considered.map((candidate) =>
    planCandidate({
      candidate,
      profile: profiles[candidate?.handle] ?? profiles[normalizeInstagramHandle(candidate?.handle)],
      index,
      options,
      now,
    }),
  );

  return {
    decisions,
    rows: decisions.filter((decision) => decision.status === 'import').map((d) => d.row),
    stats: summarizeDecisions(decisions, { totalCandidates: candidates.length, bookable: bookable.length }),
  };
}

export function summarizeDecisions(decisions, { totalCandidates = 0, bookable = 0 } = {}) {
  const stats = {
    totalCandidates,
    bookableCandidates: bookable,
    considered: decisions.length,
    importable: 0,
    duplicates: 0,
    possibleDuplicates: 0,
    heldQualityGate: 0,
    heldNoLocation: 0,
    heldNonUs: 0,
    heldJobBoard: 0,
    photosUnknown: 0,
    gateFailures: {},
    locationSources: { 'bio-explicit': 0, 'bio-alias': 0, 'bio-city': 0, shop: 0, seed: 0, none: 0 },
    // Same breakdown restricted to the rows that would actually be written —
    // this is the number the #66 spend decision hangs on.
    importableLocationSources: { 'bio-explicit': 0, 'bio-alias': 0, 'bio-city': 0, shop: 0, seed: 0 },
    shopLinks: 0,
    ambiguousSeeds: 0,
  };

  for (const decision of decisions) {
    if (decision.gates.photoEvidence === 'unknown') stats.photosUnknown += 1;
    if (decision.gates.jobBoardEvidence) stats.heldJobBoard += 1;
    if (decision.shop) stats.shopLinks += 1;
    if (decision.location.ambiguousSeed) stats.ambiguousSeeds += 1;
    stats.locationSources[decision.location.source] =
      (stats.locationSources[decision.location.source] ?? 0) + 1;
    for (const failure of decision.gates.failures) {
      stats.gateFailures[failure] = (stats.gateFailures[failure] ?? 0) + 1;
    }
    if (decision.status === 'import') {
      stats.importable += 1;
      stats.importableLocationSources[decision.location.source] =
        (stats.importableLocationSources[decision.location.source] ?? 0) + 1;
    }
    if (decision.duplicate.status === 'duplicate') stats.duplicates += 1;
    if (decision.duplicate.status === 'possible-duplicate') stats.possibleDuplicates += 1;
    if (decision.holds.includes('quality-gate')) stats.heldQualityGate += 1;
    if (decision.holds.includes('no-location')) stats.heldNoLocation += 1;
    if (decision.holds.includes('non-us-location')) stats.heldNonUs += 1;
  }

  return stats;
}

/**
 * The human reviews a sample, not the whole set. Weakest evidence first, so
 * the sample is the part of the run most likely to be wrong: seed-inferred
 * cities, then bare-city guesses, then shop links, then the rest — spread
 * across seeds so one seed cannot fill the whole sample.
 */
export function buildSpotCheckSample(decisions, size = 20) {
  const importable = decisions.filter((decision) => decision.status === 'import');
  if (size <= 0 || !importable.length) return [];

  const rank = (decision) => {
    if (decision.location.ambiguousSeed) return 0;
    if (decision.location.source === 'seed') return 1;
    if (decision.location.source === 'bio-city') return 2;
    if (decision.shop) return 3;
    if (decision.location.source === 'bio-alias') return 4;
    return 5;
  };

  const ordered = [...importable].sort(
    (a, b) => rank(a) - rank(b) || String(a.handle).localeCompare(String(b.handle)),
  );

  const seen = new Map();
  const picked = [];
  const overflow = [];
  for (const decision of ordered) {
    const seed = decision.seedFrom ?? 'unknown';
    const used = seen.get(seed) ?? 0;
    if (used < Math.max(1, Math.ceil(size / 4))) {
      seen.set(seed, used + 1);
      picked.push(decision);
    } else {
      overflow.push(decision);
    }
    if (picked.length >= size) break;
  }
  return [...picked, ...overflow].slice(0, size).map(toSpotCheckRow);
}

function toSpotCheckRow(decision) {
  return {
    handle: decision.handle,
    id: decision.id,
    name: decision.name,
    followers: decision.followers,
    city: decision.location.city,
    state: decision.location.state,
    locationSource: decision.location.source,
    locationEvidence: decision.location.evidence ?? null,
    seedFrom: decision.seedFrom,
    shopName: decision.shop?.name ?? null,
    instagramUrl: instagramProfileUrl(decision.handle),
    checkThis:
      decision.location.source === 'seed'
        ? 'City inferred from the seed account, not the bio — verify the artist really works there.'
        : decision.location.source === 'bio-city'
          ? 'City matched a bare city name in the bio — verify it is where they tattoo.'
          : decision.shop
            ? 'Shop matched on the bio link domain — verify the artist works at that shop.'
            : 'Verify this is a real, currently-working tattoo artist.',
  };
}

/**
 * The artifact a human reviews. Inert JSON: reading it changes nothing, and
 * the importer needs a separate --apply run to act on it.
 */
export function buildImportPlanArtifact({ plan, options, generatedAt, referenceSummary }) {
  return {
    generatedAt,
    source: 'scripts/import-discovery-to-neo4j.mjs',
    issue: 65,
    input: { candidates: options.input, profiles: options.profiles },
    reference: referenceSummary,
    settings: {
      minFollowers: options.minFollowers,
      allowUnknownPhotos: options.allowUnknownPhotos,
      cityProminence: DEFAULT_CITY_PROMINENCE,
      limit: Number.isFinite(options.limit) ? options.limit : null,
    },
    stats: plan.stats,
    spotCheckSample: buildSpotCheckSample(plan.decisions, options.sample),
    decisions: plan.decisions.map((decision) => ({
      handle: decision.handle,
      id: decision.id,
      name: decision.name,
      status: decision.status,
      holds: decision.holds,
      followers: decision.followers,
      seedFrom: decision.seedFrom,
      filterReason: decision.filterReason,
      gateFailures: decision.gates.failures,
      gateWarnings: decision.gates.warnings,
      jobBoardEvidence: decision.gates.jobBoardEvidence ?? null,
      city: decision.location.city,
      state: decision.location.state,
      locationSource: decision.location.source,
      locationEvidence: decision.location.evidence ?? null,
      shopName: decision.shop?.name ?? null,
      duplicateOf: decision.duplicate.existingId,
      duplicateReason: decision.duplicate.reason,
    })),
  };
}

// ---------------------------------------------------------------------------
// Cypher
// ---------------------------------------------------------------------------

/**
 * MERGE-only, and every protection the national importer applies is repeated
 * here: tombstones, pending takedown requests, removed/claimed/self-registered
 * profiles, artist-managed fields and verified identity fields. An artist who
 * became protected between planning and writing is still not overwritten.
 */
export const DISCOVERY_ARTIST_IMPORT_CYPHER = `
  UNWIND $rows AS row
  CALL (row) {
    WITH row
    OPTIONAL MATCH (t:TakedownTombstone)
    WHERE t.key IN row.tombstoneKeys
    WITH row, count(t) AS tombstoneCount
    OPTIONAL MATCH (r:TakedownRequest {status: 'pending', artistId: row.id})
    RETURN tombstoneCount, count(r) AS pendingRequestCount
  }
  WITH row, tombstoneCount, pendingRequestCount
  WHERE tombstoneCount = 0 AND pendingRequestCount = 0
  MERGE (a:Artist {id: row.id})
  WITH a, row
  WHERE a.removedAt IS NULL
    AND a.claimedByUid IS NULL
    AND coalesce(a.selfRegistered, false) = false
  SET a.name = ${preserveArtistManagedField('name', 'row.name')},
      a.city = ${preserveArtistManagedField('city', 'row.city')},
      a.state = ${preserveArtistManagedField('state', 'row.state')},
      a.bio = ${preserveArtistManagedField('bio', 'row.bio')},
      a.shopName = ${preserveArtistManagedField('shopName', 'row.shopName')},
      a.instagram = ${preserveVerifiedIdentityField('instagram', 'row.instagram')},
      a.instagramUrl = ${preserveVerifiedIdentityField('instagramUrl', 'row.instagramUrl')},
      a.looksBookable = row.looksBookable,
      a.bookabilityReason = row.bookabilityReason,
      a.discoverySource = row.discoverySource,
      a.discoverySeedFrom = row.discoverySeedFrom,
      a.discoveredAt = row.discoveredAt,
      a.locationSource = row.locationSource,
      a.locationEvidence = row.locationEvidence,
      a.portfolioImages = coalesce(a.portfolioImages, []),
      a.portfolioImageCount = size(coalesce(a.portfolioImages, []))
  MERGE (c:City {name: row.city, state: row.state})
  MERGE (a)-[:LOCATED_IN]->(c)
  WITH a, row
  CALL (a, row) {
    WITH a, row
    UNWIND row.tags AS tagName
    MERGE (t:Tag {name: tagName})
    MERGE (a)-[:TAGGED_WITH]->(t)
  }
  CALL (a, row) {
    WITH a, row
    WITH a, row WHERE row.shopName IS NOT NULL
    MATCH (s:Shop {name: row.shopName, city: row.city, state: row.state})
    MERGE (a)-[:WORKS_AT]->(s)
  }
  RETURN count(a) AS written
`;

/** Read-only. Everything the planner needs to know about the existing graph. */
export const DISCOVERY_REFERENCE_ARTISTS_CYPHER = `
  MATCH (a:Artist)
  RETURN a.id AS id, a.name AS name, a.instagram AS instagram,
         a.city AS city, a.state AS state
`;

export const DISCOVERY_REFERENCE_SHOPS_CYPHER = `
  MATCH (s:Shop)
  RETURN s.placeId AS placeId, s.name AS name, s.city AS city,
         s.state AS state, s.website AS website
`;
