/**
 * Tier scraped Instagram discovery signals into tattoo / uncertain / junk,
 * and build the additive Neo4j stamp for the apply script.
 *
 * The tiers exist so the public roster can stop showing movie theaters and
 * sandwich chains as "real tattoo artists" (RESEARCH/TATT_LIVE_SITE_VALUE_BETS.md
 * bet 2) without ever hiding a real artist with a sparse profile:
 *
 *   tattoo    — tattoo evidence anywhere in the scrape (handle, bio,
 *               businessCategory, hashtags, captions, link titles/urls).
 *   junk      — ZERO tattoo evidence AND an affirmative non-artist signal:
 *               a clearly non-tattoo businessCategory (Movie Theater,
 *               Restaurant, Hotel, retail, ...) or a verified mega-follower
 *               brand account. Only this tier is ever hidden.
 *   uncertain — no tattoo evidence but nothing affirmatively non-tattoo.
 *               Sparse-bio real artists live here; they stay visible.
 *
 * The bias is deliberate: hiding a real artist is worse than temporarily
 * showing junk, so junk requires positive non-artist evidence, never mere
 * absence of tattoo terms.
 */

export const DISCOVERY_TIERS = ['tattoo', 'uncertain', 'junk'];

/**
 * Tattoo evidence, multilingual. Broad on purpose — any hit rescues the
 * account from junk. `tatt` alone (no trailing "oo") is common in handles
 * ("smithtatts"); `tatu…` stems cover Spanish/Portuguese/Italian; the rest
 * are unambiguous craft terms.
 */
const TATTOO_EVIDENCE =
  /tat(?:t+|too|2)|tatoo|tatu(?:aje|agem|ador|adora|atore|aggi|s\b)|t[aä]towier|irezumi|tebori|handpoke|stick\s*(?:and|n|&)\s*poke|blackwork|microrealism|piercing/i;

/**
 * businessCategory values that are affirmatively not a tattoo artist.
 * Exact lowercase matches only — ambiguous or adjacent categories
 * (Artist, Beauty..., Hair Stylist, Health/beauty) are NOT here, because
 * PMU/cosmetic-tattoo artists and miscategorized real artists use them.
 */
export const NON_TATTOO_CATEGORIES = new Set([
  'movie theater',
  'movies',
  'restaurant',
  'fast food restaurant',
  'sandwich shop',
  'cafe',
  'coffee shop',
  'bakery',
  'bar',
  'brewery',
  'food & beverage',
  'hotel',
  'hotel & lodging',
  'resort',
  'cemetery',
  'bookstore',
  'grocery store',
  'shopping & retail',
  'shopping mall',
  'clothing (brand)',
  'clothing store',
  'jewelry/watches',
  'jewelry store',
  'stores',
  'department store',
  'personal goods & general merchandise stores',
  'gym/physical fitness center',
  'fitness studio',
  'sports & fitness instruction',
  'real estate',
  'real estate agent',
  'insurance company',
  'bank',
  'car dealership',
  'automotive repair shop',
  'airline',
  'church',
  'religious organization',
  'school',
  'university',
  'pharmacy / drugstore',
  'optometrist',
  'eyewear store',
  'pet store',
  'veterinarian',
]);

/**
 * A verified account this large with zero tattoo evidence across its whole
 * scrape is a brand/media page swept up by discovery, not an unclaimed
 * artist. Threshold is deliberately huge; real artists never trip it.
 */
export const VERIFIED_BRAND_FOLLOWER_FLOOR = 500_000;

const asStrings = (value) =>
  Array.isArray(value) ? value.filter((v) => typeof v === 'string') : [];

/** Every scraped text surface, joined for one evidence sweep. */
export function evidenceText(signal) {
  return [
    signal.handle,
    signal.biography,
    signal.businessCategory,
    ...asStrings(signal.hashtags),
    ...asStrings(signal.captions),
    ...asStrings(signal.externalUrls),
    ...asStrings(signal.externalUrlTitles),
  ]
    .filter((v) => typeof v === 'string')
    .join('\n');
}

export function hasTattooEvidence(signal) {
  return TATTOO_EVIDENCE.test(evidenceText(signal));
}

/** Classify one scraped account into { tier, reason }. */
export function classifySignal(signal) {
  if (hasTattooEvidence(signal)) {
    return { tier: 'tattoo', reason: 'tattoo evidence in scrape' };
  }
  const category = String(signal.businessCategory ?? '').trim().toLowerCase();
  if (NON_TATTOO_CATEGORIES.has(category)) {
    return { tier: 'junk', reason: `non-tattoo businessCategory: ${category}` };
  }
  if (
    signal.verified === true &&
    Number(signal.followers) >= VERIFIED_BRAND_FOLLOWER_FLOOR
  ) {
    return {
      tier: 'junk',
      reason: `verified brand account, ${signal.followers} followers, no tattoo evidence`,
    };
  }
  return { tier: 'uncertain', reason: 'no tattoo evidence, no non-artist signal' };
}

/**
 * Classify a whole signals.json array. Re-runnable over a growing file: pure
 * function of its input, dedupes on lowercased handle (last scrape wins).
 */
export function classifySignals(signals) {
  const byHandle = new Map();
  let skipped = 0;
  for (const signal of Array.isArray(signals) ? signals : []) {
    const handle = String(signal?.handle ?? '').trim().toLowerCase();
    if (!handle) {
      skipped += 1;
      continue;
    }
    const { tier, reason } = classifySignal(signal);
    byHandle.set(handle, {
      handle,
      tier,
      reason,
      businessCategory: signal.businessCategory ?? null,
      followers: typeof signal.followers === 'number' ? signal.followers : null,
    });
  }
  const entries = [...byHandle.values()];
  const counts = { tattoo: 0, uncertain: 0, junk: 0 };
  for (const entry of entries) counts[entry.tier] += 1;
  return { entries, counts, skipped };
}

/**
 * Stamp one handle's tier onto its Artist node — additive properties only,
 * and only when exactly one node matches (same guard as
 * scripts/lib/artist-refresh-status.mjs). Never touches identity, ownership,
 * visibility bits, or portfolio content; the read side decides what a tier
 * means (src/lib/artist-visibility NOT_DISCOVERY_JUNK_CLAUSE).
 */
export const APPLY_DISCOVERY_SIGNAL_CYPHER = `
  MATCH (a:Artist)
  WHERE toLower(trim(coalesce(a.instagram, ''))) IN $handleVariants
    OR EXISTS {
      MATCH (a)-[:HAS_INSTAGRAM]->(ig:Instagram)
      WHERE toLower(trim(coalesce(ig.handle, ''))) IN $handleVariants
    }
  WITH collect(a) AS matches
  FOREACH (a IN CASE WHEN size(matches) = 1 THEN matches ELSE [] END |
    SET a.discoverySignal = $tier,
        a.discoverySignalReason = $reason,
        a.discoverySignalAt = $stampedAt
  )
  RETURN size(matches) AS matchCount,
         [a IN matches | a.id] AS matchedIds
`;

export function handleVariants(handle) {
  return [
    handle,
    `@${handle}`,
    `https://instagram.com/${handle}`,
    `https://instagram.com/${handle}/`,
    `https://www.instagram.com/${handle}`,
    `https://www.instagram.com/${handle}/`,
  ];
}

export function buildDiscoverySignalUpdate(entry, stampedAt) {
  if (!DISCOVERY_TIERS.includes(entry.tier)) {
    throw new Error(`unknown tier for @${entry.handle}: ${entry.tier}`);
  }
  return {
    query: APPLY_DISCOVERY_SIGNAL_CYPHER,
    params: {
      handleVariants: handleVariants(entry.handle),
      tier: entry.tier,
      reason: entry.reason ?? null,
      stampedAt,
    },
  };
}
