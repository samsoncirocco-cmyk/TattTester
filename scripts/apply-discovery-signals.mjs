#!/usr/bin/env node
/**
 * Stamp discovery-signal tiers from scripts/classify-discovery-signals.mjs
 * onto Artist nodes.
 *
 * DRY RUN BY DEFAULT — prints the plan and changes nothing until --apply.
 * Writes only three new additive properties (discoverySignal,
 * discoverySignalReason, discoverySignalAt); never identity, ownership,
 * visibility bits, or portfolio content. A handle matching zero or multiple
 * Artist nodes is skipped and reported, never guessed (same guard as
 * scripts/apply-artist-refresh-status.mjs). Every run writes a JSON receipt
 * next to the tiers file.
 *
 * The stamp itself hides nothing: the roster read excludes only unclaimed
 * artists with discoverySignal = 'junk' (src/lib/artist-visibility).
 *
 * Usage:
 *   node scripts/apply-discovery-signals.mjs --tiers /path/discovery-tiers.json
 *   node scripts/apply-discovery-signals.mjs --tiers /path/discovery-tiers.json --apply
 *   # --only junk    stamp a single tier (e.g. junk first, others later)
 *
 * Requires NEO4J_URI, NEO4J_USERNAME (or NEO4J_USER), NEO4J_PASSWORD.
 */

import { readFile, writeFile } from 'node:fs/promises';
import neo4j from 'neo4j-driver';
import { config } from 'dotenv';
import {
  DISCOVERY_TIERS,
  buildDiscoverySignalUpdate,
} from './lib/discovery-signal.mjs';

config();
config({ path: '.env.local', override: false });

function parseArgs(argv) {
  const opts = { tiers: null, apply: false, only: null, limit: Infinity };
  for (let index = 0; index < argv.length; index++) {
    const next = () => argv[++index];
    switch (argv[index]) {
      case '--tiers': opts.tiers = next(); break;
      case '--apply': opts.apply = true; break;
      case '--only': opts.only = next(); break;
      case '--limit': opts.limit = Math.max(0, Number.parseInt(next(), 10) || 0); break;
      default: break;
    }
  }
  if (opts.only && !DISCOVERY_TIERS.includes(opts.only)) {
    throw new Error(`--only must be one of: ${DISCOVERY_TIERS.join(', ')}`);
  }
  return opts;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!opts.tiers) {
    throw new Error('--tiers <discovery-tiers.json> is required');
  }
  const tiersFile = JSON.parse(await readFile(opts.tiers, 'utf8'));
  const entries = (tiersFile.entries ?? [])
    .filter((entry) => !opts.only || entry.tier === opts.only)
    .slice(0, opts.limit);

  const counts = { tattoo: 0, uncertain: 0, junk: 0 };
  for (const entry of entries) counts[entry.tier] += 1;
  console.log(`discovery signal ${opts.apply ? 'APPLY' : 'plan (dry run)'}`);
  console.log(`  selected:  ${entries.length}`);
  console.log(`  tattoo:    ${counts.tattoo}`);
  console.log(`  uncertain: ${counts.uncertain}`);
  console.log(`  junk:      ${counts.junk}`);

  const stampedAt = new Date().toISOString();
  const receipt = {
    stampedAt,
    tiersFile: opts.tiers,
    mode: opts.apply ? 'apply' : 'dry-run',
    only: opts.only,
    counts,
    applied: [],
    missing: [],
    ambiguous: [],
  };

  if (!opts.apply) {
    for (const entry of entries) {
      receipt.applied.push({ handle: entry.handle, tier: entry.tier, wouldSet: true });
    }
    console.log('\nDRY RUN — nothing changed. Re-run with --apply to stamp.');
  } else {
    const driver = neo4j.driver(
      process.env.NEO4J_URI,
      neo4j.auth.basic(
        process.env.NEO4J_USERNAME || process.env.NEO4J_USER,
        process.env.NEO4J_PASSWORD,
      ),
    );
    const session = driver.session(
      process.env.NEO4J_DATABASE ? { database: process.env.NEO4J_DATABASE } : undefined,
    );
    try {
      for (const entry of entries) {
        const { query, params } = buildDiscoverySignalUpdate(entry, stampedAt);
        const response = await session.executeWrite((transaction) =>
          transaction.run(query, params),
        );
        const record = response.records[0];
        const rawCount = record?.get('matchCount');
        const matchCount =
          typeof rawCount?.toNumber === 'function' ? rawCount.toNumber() : Number(rawCount ?? 0);
        if (matchCount === 1) {
          receipt.applied.push({
            handle: entry.handle,
            tier: entry.tier,
            artistId: record.get('matchedIds')[0],
          });
        } else if (matchCount === 0) {
          receipt.missing.push(entry.handle);
        } else {
          receipt.ambiguous.push({ handle: entry.handle, matchCount });
        }
      }
    } finally {
      await session.close();
      await driver.close();
    }
    console.log(`\nAPPLIED ${receipt.applied.length} stamp(s).`);
    if (receipt.missing.length) console.log(`  no artist matched: ${receipt.missing.length}`);
    if (receipt.ambiguous.length) console.log(`  ambiguous handles: ${receipt.ambiguous.length}`);
  }

  const receiptPath = `${opts.tiers.replace(/\.json$/, '')}.receipt-${stampedAt.replace(/[:.]/g, '-')}.json`;
  await writeFile(receiptPath, JSON.stringify(receipt, null, 2));
  console.log(`receipt: ${receiptPath}`);
}

main().catch((error) => {
  console.error(`[apply-discovery-signals] ${error.message}`);
  process.exit(1);
});
