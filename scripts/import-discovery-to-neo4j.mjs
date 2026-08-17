/**
 * Turn Instagram discovery candidates into :Artist nodes (issue #65).
 *
 * `execution/discover_ig.py` writes `data/discovery/candidates.json` +
 * `profiles.json` and stops. This script is the missing stage between that
 * artifact and the graph: it assigns ids, resolves city/state from the bio and
 * then from the seed account, links a shop when the bio URL proves one, runs
 * the automated quality gates, dedups against the artists already in the
 * graph, and writes an inert JSON plan the human can spot-check a sample from.
 *
 * SAFETY: dry run by default. Nothing is written without --apply, and the
 * reference read that powers dedup uses read-only sessions, so planning and
 * reviewing a plan cannot mutate the graph. There is deliberately no wipe
 * option — the graph holds claims, takedowns and payment state. Artists that
 * are removed, claimed, self-registered, tombstoned (docs/adr/0025) or have a
 * pending takedown request are excluded by the write query itself, not just by
 * the planner.
 *
 * Quality bar (locked on #65): automated gates admit; a human spot-checks a
 * sample. The gates are followers >= --min-followers, a non-empty bio, a
 * public profile, not a job board, and photos. A discovery run currently
 * records no post count, so the photo gate cannot be satisfied and every such
 * candidate is HELD — on the pilot artifact that holds all 137. Pass
 * --allow-unknown-photos to admit them anyway, which measures the ceiling the
 * pilot would reach once discovery captures media counts. Do not read a run
 * made with that flag as "the photo gate passed".
 *
 * Usage:
 *   node scripts/import-discovery-to-neo4j.mjs --input ../tatt-scraper/data/discovery/candidates.json
 *   node scripts/import-discovery-to-neo4j.mjs --limit 25            # dry run, small slice
 *   node scripts/import-discovery-to-neo4j.mjs --reference snap.json # fully offline plan
 *   node scripts/import-discovery-to-neo4j.mjs --allow-unknown-photos # ceiling, gate not enforced
 *   node scripts/import-discovery-to-neo4j.mjs --apply               # actually write
 *
 * Requires NEO4J_URI, NEO4J_USER, NEO4J_PASSWORD in .env unless --reference is
 * given and --apply is not.
 */

import neo4j from 'neo4j-driver';
import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, resolve } from 'path';
import dotenv from 'dotenv';
import {
  DISCOVERY_ARTIST_IMPORT_CYPHER,
  DISCOVERY_REFERENCE_ARTISTS_CYPHER,
  DISCOVERY_REFERENCE_SHOPS_CYPHER,
  buildImportPlanArtifact,
  buildReferenceIndex,
  parseDiscoveryImportArgs,
  planDiscoveryImport,
} from './lib/discovery-import.mjs';

dotenv.config();
dotenv.config({ path: '.env.local', override: true });

const options = parseDiscoveryImportArgs(process.argv.slice(2));
const BATCH = 500;

const {
  NEO4J_URI,
  NEO4J_USERNAME,
  NEO4J_USER = 'neo4j',
  NEO4J_PASSWORD,
  NEO4J_DATABASE,
} = process.env;

const needsGraph = options.apply || !options.reference;
if (needsGraph && (!NEO4J_URI || !NEO4J_PASSWORD)) {
  console.error(
    '❌ NEO4J_URI and NEO4J_PASSWORD must be set in .env ' +
      '(or pass --reference <snapshot.json> for an offline dry run)',
  );
  process.exit(1);
}

function readJson(path) {
  return JSON.parse(readFileSync(resolve(process.cwd(), path), 'utf8'));
}

const candidates = readJson(options.input);
if (!Array.isArray(candidates)) {
  throw new Error(`${options.input} must contain an array of discovery candidates`);
}
const profiles = readJson(options.profiles);

const driver = needsGraph
  ? neo4j.driver(NEO4J_URI, neo4j.auth.basic(NEO4J_USERNAME || NEO4J_USER, NEO4J_PASSWORD))
  : null;

function session(mode) {
  return driver.session({
    ...(NEO4J_DATABASE ? { database: NEO4J_DATABASE } : {}),
    defaultAccessMode: mode,
  });
}

async function readRows(cypher) {
  const s = session(neo4j.session.READ);
  try {
    const result = await s.executeRead((tx) => tx.run(cypher));
    return result.records.map((record) => record.toObject());
  } finally {
    await s.close();
  }
}

async function loadReference() {
  if (options.reference) {
    const snapshot = readJson(options.reference);
    // Accepts either this script's own reference dump or the scraper's
    // master.json, which names the shop field `shopName`.
    const artists = (snapshot.artists ?? []).map((a) => ({
      id: a.id,
      name: a.name,
      instagram: a.instagram,
      city: a.city,
      state: a.state,
    }));
    const shops = (snapshot.shops ?? []).map((s) => ({
      placeId: s.placeId ?? s.place_id,
      name: s.name ?? s.shopName,
      city: s.city,
      state: s.state,
      website: s.website,
    }));
    return { artists, shops, origin: `snapshot:${options.reference}` };
  }

  const [artists, shops] = await Promise.all([
    readRows(DISCOVERY_REFERENCE_ARTISTS_CYPHER),
    readRows(DISCOVERY_REFERENCE_SHOPS_CYPHER),
  ]);
  return { artists, shops, origin: `neo4j:${NEO4J_URI}` };
}

const t0 = Date.now();
console.log(`Input: ${options.input}`);
console.log(`Profiles: ${options.profiles}`);

const reference = await loadReference();
const index = buildReferenceIndex(reference);
const referenceSummary = {
  origin: reference.origin,
  artists: reference.artists.length,
  shops: reference.shops.length,
};
console.log(
  `Reference: ${referenceSummary.origin} — ${referenceSummary.artists} artists, ` +
    `${referenceSummary.shops} shops`,
);

const generatedAt = new Date().toISOString();
const plan = planDiscoveryImport({ candidates, profiles, index, options, now: generatedAt });
const { stats } = plan;

console.log('\n─── plan ───');
console.log(`  candidates in file:        ${stats.totalCandidates}`);
console.log(`  looksBookable=true:        ${stats.bookableCandidates}`);
console.log(`  considered:                ${stats.considered}`);
console.log(`  would import:              ${stats.importable}`);
console.log(`  already in graph (dupes):  ${stats.duplicates}`);
console.log(`  possible dupes (held):     ${stats.possibleDuplicates}`);
console.log(`  held — quality gate:       ${stats.heldQualityGate}`);
console.log(`  held — no location:        ${stats.heldNoLocation}`);
console.log(`  held — non-US location:    ${stats.heldNonUs}`);
console.log(`  job boards detected:       ${stats.heldJobBoard}`);
console.log(
  `  photo evidence unknown:    ${stats.photosUnknown}` +
    (options.allowUnknownPhotos ? ' (admitted — photo gate NOT enforced)' : ' (held)'),
);
console.log('\n  city from (all considered / of the importable)');
for (const [source, count] of Object.entries(stats.locationSources)) {
  const importable = stats.importableLocationSources[source] ?? 0;
  console.log(`    ${source.padEnd(14)} ${String(count).padStart(3)} / ${importable}`);
}
console.log(`\n  WORKS_AT links derivable:  ${stats.shopLinks}`);
console.log(`  ambiguous seeds:           ${stats.ambiguousSeeds}`);
if (Object.keys(stats.gateFailures).length) {
  console.log('\n  gate failures');
  for (const [gate, count] of Object.entries(stats.gateFailures)) {
    console.log(`    ${gate.padEnd(20)} ${count}`);
  }
}

const artifact = buildImportPlanArtifact({ plan, options, generatedAt, referenceSummary });
const outPath = resolve(process.cwd(), options.out);
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, `${JSON.stringify(artifact, null, 2)}\n`);
console.log(`\nSpot-check plan written to ${options.out} (${artifact.spotCheckSample.length} sampled)`);
for (const row of artifact.spotCheckSample.slice(0, 10)) {
  console.log(
    `  @${row.handle} → ${row.city ?? '—'}, ${row.state ?? '—'} ` +
      `[${row.locationSource}${row.locationEvidence ? `: ${row.locationEvidence}` : ''}]` +
      `${row.shopName ? ` @ ${row.shopName}` : ''}`,
  );
}

if (!options.apply) {
  console.log('\nDRY RUN — nothing was written. Pass --apply to write to Neo4j.');
  if (driver) await driver.close();
  process.exit(0);
}

for (const constraint of [
  'CREATE CONSTRAINT artist_id IF NOT EXISTS FOR (a:Artist) REQUIRE a.id IS UNIQUE',
  'CREATE CONSTRAINT city_key IF NOT EXISTS FOR (c:City) REQUIRE (c.name, c.state) IS UNIQUE',
  'CREATE CONSTRAINT tag_name IF NOT EXISTS FOR (t:Tag) REQUIRE t.name IS UNIQUE',
]) {
  const s = session(neo4j.session.WRITE);
  try {
    await s.executeWrite((tx) => tx.run(constraint));
  } finally {
    await s.close();
  }
}

let written = 0;
for (let i = 0; i < plan.rows.length; i += BATCH) {
  const s = session(neo4j.session.WRITE);
  try {
    const result = await s.executeWrite((tx) =>
      tx.run(DISCOVERY_ARTIST_IMPORT_CYPHER, { rows: plan.rows.slice(i, i + BATCH) }),
    );
    if (result.records[0]) written += result.records[0].get('written').toNumber();
  } finally {
    await s.close();
  }
  process.stdout.write(`\r  artists: ${Math.min(i + BATCH, plan.rows.length)}/${plan.rows.length}`);
}
console.log();

console.log(
  `Applied: ${written}/${plan.rows.length} artists. ` +
    `${plan.rows.length - written} candidates were protected at write time.`,
);
console.log(`\nDone in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

await driver.close();
