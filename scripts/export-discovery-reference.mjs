#!/usr/bin/env node
/**
 * READ-ONLY export of the graph facts discovery needs for dedupe/protection.
 *
 * Writes a reference snapshot in the shape `import-discovery-to-neo4j.mjs --reference`
 * and `execution/discover_inhouse.py --reference` read:
 *   { generatedAt, artists: [{id,name,instagram,city,state,claimed,selfRegistered,
 *     removed,verified,takedownPending}], shops: [...], tombstoneKeys: [...] }
 *
 * Every query runs in a READ session via executeRead and is checked for write
 * clauses before it is sent. Credentials come from .env/.env.local and are never printed.
 *
 *   node scripts/export-discovery-reference.mjs [--out data/discovery-inhouse/reference-snapshot.json]
 */
import { mkdirSync, writeFileSync, chmodSync } from 'fs';
import { dirname, resolve } from 'path';
import dotenv from 'dotenv';
import neo4j from 'neo4j-driver';
import { DISCOVERY_REFERENCE_SHOPS_CYPHER } from './lib/discovery-import.mjs';
import { TOMBSTONE_KEYS_CYPHER } from './lib/takedown-tombstone.mjs';

dotenv.config({ quiet: true });
dotenv.config({ path: '.env.local', override: true, quiet: true });

export const REFERENCE_EXPORT_ARTISTS_CYPHER = `
  MATCH (a:Artist)
  OPTIONAL MATCH (r:TakedownRequest {status: 'pending', artistId: a.id})
  WITH a, count(r) AS pending
  RETURN a.id AS id, a.name AS name, a.instagram AS instagram,
         a.city AS city, a.state AS state,
         a.claimedByUid IS NOT NULL AS claimed,
         coalesce(a.selfRegistered, false) AS selfRegistered,
         a.removedAt IS NOT NULL AS removed,
         coalesce(a.claimVerificationStatus, '') = 'verified' AS verified,
         pending > 0 AS takedownPending
`;

const WRITE_CLAUSE = /\b(CREATE|MERGE|SET|DELETE|DETACH|REMOVE|DROP|LOAD\s+CSV|FOREACH)\b|CALL\s*\{|apoc\./i;
export function assertReadOnly(cypher) {
  if (WRITE_CLAUSE.test(cypher)) throw new Error('refusing to run a non-read query');
  return cypher;
}

const args = process.argv.slice(2);
const outIdx = args.indexOf('--out');
const out = resolve(outIdx >= 0 ? args[outIdx + 1] : 'data/discovery-inhouse/reference-snapshot.json');

const { NEO4J_URI, NEO4J_USERNAME, NEO4J_USER = 'neo4j', NEO4J_PASSWORD, NEO4J_DATABASE } = process.env;
if (!NEO4J_URI || !NEO4J_PASSWORD) {
  console.error('NEO4J_URI and NEO4J_PASSWORD must be set in .env/.env.local');
  process.exit(1);
}

const driver = neo4j.driver(NEO4J_URI, neo4j.auth.basic(NEO4J_USERNAME || NEO4J_USER, NEO4J_PASSWORD));
async function readRows(cypher) {
  const session = driver.session({
    ...(NEO4J_DATABASE ? { database: NEO4J_DATABASE } : {}),
    defaultAccessMode: neo4j.session.READ,
  });
  try {
    const result = await session.executeRead((tx) => tx.run(assertReadOnly(cypher)));
    return result.records.map((record) => record.toObject());
  } finally {
    await session.close();
  }
}

try {
  const [artists, shops, tombstones] = await Promise.all([
    readRows(REFERENCE_EXPORT_ARTISTS_CYPHER),
    readRows(DISCOVERY_REFERENCE_SHOPS_CYPHER),
    readRows(TOMBSTONE_KEYS_CYPHER),
  ]);
  const snapshot = {
    generatedAt: new Date().toISOString(),
    readOnly: true,
    artists,
    shops,
    tombstoneKeys: tombstones.map((row) => row.key).filter(Boolean),
  };
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(snapshot, null, 2));
  chmodSync(out, 0o600);
  const flag = (k) => artists.filter((a) => a[k]).length;
  console.log(JSON.stringify({
    out,
    artists: artists.length,
    withInstagram: artists.filter((a) => a.instagram).length,
    shops: shops.length,
    tombstoneKeys: snapshot.tombstoneKeys.length,
    claimed: flag('claimed'), selfRegistered: flag('selfRegistered'), removed: flag('removed'),
    verified: flag('verified'), takedownPending: flag('takedownPending'),
  }, null, 2));
} finally {
  await driver.close();
}
