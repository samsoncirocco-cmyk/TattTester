/**
 * Import the national artist dataset (data/national-artists-*.json) into Neo4j.
 *
 * Schema:
 *   (Artist {id, name, city, state, instagram, instagramUrl, rating, reviewCount,
 *            bio, lat, lng, portfolioImages, portfolioImageCount, portfolioSource})
 *   (Shop   {placeId, name, address, city, state, lat, lng, rating, reviewCount, website})
 *   (City   {name, state})
 *   (Style  {name})
 *   (Tag    {name})
 *   (Artist)-[:WORKS_AT]->(Shop)         matched on shopName + city + state
 *   (Artist)-[:LOCATED_IN]->(City)
 *   (Shop)-[:LOCATED_IN]->(City)
 *   (Artist)-[:SPECIALIZES_IN]->(Style)
 *   (Artist)-[:TAGGED_WITH]->(Tag)
 *
 * portfolioImages currently come from the artist's or shop's own website (the
 * scraper's HTML crawl), NOT from Instagram posts — portfolioSource records
 * that provenance explicitly so it's never confused with a future Instagram
 * post-scraping step (that's separate, unbuilt work; see TAT-41). instagramUrl
 * is the artist's real Instagram profile permalink, derived from the existing
 * `instagram` handle.
 *
 * SAFETY: dry run by default — always prints what it *would* do and changes
 * nothing until you pass --apply. Artists that have been claimed
 * (claimedByUid), taken down (removedAt), tombstoned (:TakedownTombstone —
 * see docs/adr/0025), or have a pending takedown request
 * (:TakedownRequest {status:'pending'}) are always excluded from the write,
 * regardless of --apply. A re-import must never resurrect or overwrite a
 * profile someone has claimed, asked to have removed, or is already removed —
 * see src/lib/takedown.ts, which is the source of truth this mirrors.
 *
 * Usage:
 *   node scripts/import-national-to-neo4j.js --limit 50        # dry run, small slice
 *   node scripts/import-national-to-neo4j.js                   # dry run, full dataset
 *   node scripts/import-national-to-neo4j.js --apply            # actually write
 *   node scripts/import-national-to-neo4j.js --apply --wipe     # wipe then write (careful)
 *
 * Requires NEO4J_URI, NEO4J_USER, NEO4J_PASSWORD in .env (Aura: neo4j+s://...).
 */

import neo4j from 'neo4j-driver';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import dotenv from 'dotenv';

dotenv.config();

const { NEO4J_URI, NEO4J_USER = 'neo4j', NEO4J_PASSWORD } = process.env;
if (!NEO4J_URI || !NEO4J_PASSWORD) {
  console.error('❌ NEO4J_URI and NEO4J_PASSWORD must be set in .env');
  process.exit(1);
}

const args = process.argv.slice(2);
const limitIdx = args.indexOf('--limit');
const LIMIT = limitIdx >= 0 ? parseInt(args[limitIdx + 1], 10) : Infinity;
const WIPE = args.includes('--wipe');
const APPLY = args.includes('--apply');
const BATCH = 500;

// Mirrors src/lib/takedown.ts normalizeInstagramHandle — must stay in sync so
// tombstone keys computed here match the ones the app writes.
function normalizeInstagramHandle(raw) {
  if (!raw) return null;
  const clean = raw
    .trim()
    .replace(/^https?:\/\/(www\.)?instagram\.com\//i, '')
    .replace(/^@/, '')
    .replace(/\/.*$/, '')
    .trim()
    .toLowerCase();
  return clean || null;
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const data = JSON.parse(
  readFileSync(join(__dirname, '../data/national-artists-2026-07-15.json'), 'utf8')
);

const rawArtists = data.artists.slice(0, LIMIT).map((a) => ({
  ...a,
  instagramUrl: a.instagram ? `https://instagram.com/${a.instagram.replace(/^@/, '')}` : null,
}));

const driver = neo4j.driver(NEO4J_URI, neo4j.auth.basic(NEO4J_USER, NEO4J_PASSWORD));

async function run(cypher, params) {
  const session = driver.session();
  try {
    return await session.run(cypher, params);
  } finally {
    await session.close();
  }
}

async function inBatches(items, label, cypher) {
  for (let i = 0; i < items.length; i += BATCH) {
    await run(cypher, { rows: items.slice(i, i + BATCH) });
    process.stdout.write(`\r  ${label}: ${Math.min(i + BATCH, items.length)}/${items.length}`);
  }
  console.log();
}

/**
 * Everything a re-import must never touch. Four independent checks, one per
 * way an artist can have left "plain scraped data" behind them.
 */
async function findProtectedArtists() {
  const [flags, pendingRequest, tombstones] = await Promise.all([
    run(
      `MATCH (a:Artist) WHERE a.removedAt IS NOT NULL OR a.claimedByUid IS NOT NULL
       RETURN a.id AS id, a.removedAt IS NOT NULL AS removed, a.claimedByUid IS NOT NULL AS claimed`,
      {}
    ),
    run(
      `MATCH (:TakedownRequest {status: 'pending'})-[:REQUESTS_REMOVAL_OF]->(a:Artist)
       RETURN collect(DISTINCT a.id) AS ids`,
      {}
    ),
    run(`MATCH (t:TakedownTombstone) RETURN collect(DISTINCT t.key) AS keys`, {}),
  ]);

  const removedIds = new Set();
  const claimedIds = new Set();
  for (const rec of flags.records) {
    if (rec.get('removed')) removedIds.add(rec.get('id'));
    if (rec.get('claimed')) claimedIds.add(rec.get('id'));
  }
  const pendingRequestIds = new Set(pendingRequest.records[0].get('ids'));
  const tombstoneKeys = new Set(tombstones.records[0].get('keys'));
  return { removedIds, claimedIds, pendingRequestIds, tombstoneKeys };
}

function isTombstoned(artist, tombstoneKeys) {
  if (tombstoneKeys.has(`artist:${artist.id}`)) return true;
  const handle = normalizeInstagramHandle(artist.instagram);
  return Boolean(handle && tombstoneKeys.has(`instagram:${handle}`));
}

const t0 = Date.now();
console.log(`Checking Neo4j for protected artists → ${NEO4J_URI}`);
const protectedArtists = await findProtectedArtists();

const skipCounts = { removed: 0, claimed: 0, pendingRequest: 0, tombstoned: 0 };
const artists = rawArtists.filter((a) => {
  if (protectedArtists.removedIds.has(a.id)) {
    skipCounts.removed++;
    return false;
  }
  if (protectedArtists.claimedIds.has(a.id)) {
    skipCounts.claimed++;
    return false;
  }
  if (protectedArtists.pendingRequestIds.has(a.id)) {
    skipCounts.pendingRequest++;
    return false;
  }
  if (isTombstoned(a, protectedArtists.tombstoneKeys)) {
    skipCounts.tombstoned++;
    return false;
  }
  return true;
});

const shopKeys = new Set(artists.map((a) => `${a.shopName}|${a.city}|${a.state}`));
// Import shops referenced by the artist slice, plus (on full runs) the rest.
const shops = Number.isFinite(LIMIT)
  ? data.shops.filter((s) => shopKeys.has(`${s.shopName}|${s.city}|${s.state}`))
  : data.shops;

console.log(`\nImport candidates: ${artists.length} artists, ${shops.length} shops`);
console.log(
  `Protected — never written: ${skipCounts.removed} removed, ${skipCounts.claimed} claimed, ` +
    `${skipCounts.pendingRequest} pending takedown request, ${skipCounts.tombstoned} tombstoned`
);

if (!APPLY) {
  console.log('\nDRY RUN — nothing was written. Pass --apply to write to Neo4j.');
  await driver.close();
  process.exit(0);
}

if (WIPE) {
  console.log('  wiping existing graph…');
  // Batched delete so large graphs don't blow the transaction memory limit
  let deleted;
  do {
    const res = await run('MATCH (n) WITH n LIMIT 10000 DETACH DELETE n RETURN count(n) AS c');
    deleted = res.records[0].get('c').toNumber();
  } while (deleted > 0);
}

// Constraints (idempotent) — also give us index-backed MERGEs
for (const c of [
  'CREATE CONSTRAINT artist_id IF NOT EXISTS FOR (a:Artist) REQUIRE a.id IS UNIQUE',
  'CREATE CONSTRAINT shop_place_id IF NOT EXISTS FOR (s:Shop) REQUIRE s.placeId IS UNIQUE',
  'CREATE CONSTRAINT city_key IF NOT EXISTS FOR (c:City) REQUIRE (c.name, c.state) IS UNIQUE',
  'CREATE CONSTRAINT style_name IF NOT EXISTS FOR (s:Style) REQUIRE s.name IS UNIQUE',
  'CREATE CONSTRAINT tag_name IF NOT EXISTS FOR (t:Tag) REQUIRE t.name IS UNIQUE',
])
  await run(c);

await inBatches(
  shops,
  'shops',
  `
  UNWIND $rows AS row
  MERGE (s:Shop {placeId: row.place_id})
  SET s.name = row.shopName, s.address = row.address, s.city = row.city,
      s.state = row.state, s.lat = row.lat, s.lng = row.lng,
      s.rating = row.rating, s.reviewCount = row.reviewCount, s.website = row.website
  MERGE (c:City {name: row.city, state: row.state})
  MERGE (s)-[:LOCATED_IN]->(c)
`
);

await inBatches(
  artists,
  'artists',
  `
  UNWIND $rows AS row
  MERGE (a:Artist {id: row.id})
  SET a.name = row.name, a.shopName = row.shopName, a.city = row.city,
      a.state = row.state, a.instagram = row.instagram, a.instagramUrl = row.instagramUrl,
      a.rating = row.rating, a.reviewCount = row.reviewCount, a.bio = row.bio,
      a.lat = row.coordinates.lat, a.lng = row.coordinates.lng,
      a.portfolioImages = coalesce(row.portfolioImages, []),
      a.portfolioImageCount = size(coalesce(row.portfolioImages, [])),
      a.portfolioSource = 'website'
  MERGE (c:City {name: row.city, state: row.state})
  MERGE (a)-[:LOCATED_IN]->(c)
  WITH a, row
  CALL (a, row) {
    WITH a, row
    UNWIND row.styles AS styleName
    MERGE (st:Style {name: styleName})
    MERGE (a)-[:SPECIALIZES_IN]->(st)
  }
  CALL (a, row) {
    WITH a, row
    UNWIND row.tags AS tagName
    MERGE (t:Tag {name: tagName})
    MERGE (a)-[:TAGGED_WITH]->(t)
  }
  CALL (a, row) {
    WITH a, row
    MATCH (s:Shop {name: row.shopName, city: row.city, state: row.state})
    MERGE (a)-[:WORKS_AT]->(s)
  }
`
);

// Verify: report what actually landed
const counts = await run(`
  CALL () { MATCH (a:Artist) RETURN count(a) AS artists }
  CALL () { MATCH (s:Shop) RETURN count(s) AS shops }
  CALL () { MATCH (c:City) RETURN count(c) AS cities }
  CALL () { MATCH (st:Style) RETURN count(st) AS styles }
  CALL () { MATCH ()-[r:WORKS_AT]->() RETURN count(r) AS worksAt }
  CALL () { MATCH ()-[r:SPECIALIZES_IN]->() RETURN count(r) AS specializes }
  RETURN artists, shops, cities, styles, worksAt, specializes
`);
const rec = counts.records[0];
console.log('\nGraph now contains:');
for (const k of rec.keys) console.log(`  ${k}: ${rec.get(k).toNumber()}`);
console.log(`\nDone in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

await driver.close();
