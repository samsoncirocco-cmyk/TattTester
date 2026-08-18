#!/usr/bin/env node
/**
 * Tier scraped Instagram discovery signals into tattoo / uncertain / junk.
 *
 * Reads the Apify-recovered signals JSON (array of per-handle scrape rows)
 * and writes a tiered list for scripts/apply-discovery-signals.mjs. Pure and
 * re-runnable: the signals file grows as the sweep completes — just run this
 * again over the updated file. Touches no database.
 *
 * Usage:
 *   node scripts/classify-discovery-signals.mjs --signals /path/signals.json \
 *     --out /path/discovery-tiers.json
 */

import { readFile, writeFile } from 'node:fs/promises';
import { classifySignals } from './lib/discovery-signal.mjs';

function parseArgs(argv) {
  const opts = { signals: null, out: null };
  for (let index = 0; index < argv.length; index++) {
    const next = () => argv[++index];
    switch (argv[index]) {
      case '--signals': opts.signals = next(); break;
      case '--out': opts.out = next(); break;
      default: break;
    }
  }
  return opts;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!opts.signals || !opts.out) {
    throw new Error('--signals <signals.json> and --out <tiers.json> are required');
  }
  const signals = JSON.parse(await readFile(opts.signals, 'utf8'));
  const { entries, counts, skipped } = classifySignals(signals);

  console.log('discovery signal tiers');
  console.log(`  handles:   ${entries.length}`);
  console.log(`  tattoo:    ${counts.tattoo}`);
  console.log(`  uncertain: ${counts.uncertain}`);
  console.log(`  junk:      ${counts.junk}`);
  if (skipped) console.log(`  skipped (no handle): ${skipped}`);

  await writeFile(
    opts.out,
    JSON.stringify(
      {
        classifiedAt: new Date().toISOString(),
        source: opts.signals,
        counts,
        entries,
      },
      null,
      2,
    ),
  );
  console.log(`\nwrote ${entries.length} tiered handle(s) to ${opts.out}`);
}

main().catch((error) => {
  console.error(`[classify-discovery-signals] ${error.message}`);
  process.exit(1);
});
