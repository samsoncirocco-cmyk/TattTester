#!/usr/bin/env node
/**
 * Generate the multi-character corpus through the REAL prompt builder and
 * score how much of each requested cast actually survived into the render.
 *
 * This is the measurement `measure-backdrop` cannot make. Backdrop scores
 * presentation and is blind to correctness; this scores whether the people
 * the customer named are in the picture.
 *
 * Usage (needs a TS-aware runner for the .ts imports):
 *   vite-node -c vitest.config.js scripts/measure-cast.mjs -- <outDir> [imagen|flux] [jsonOut]
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { enhanceStructured } from '../src/services/council/index.ts';
import { resolveLane, adcToken } from './renderLanes.mjs';
import { CAST_RECORDS, scoreCastDir, summarizeCast } from './castCorpus.mjs';

const [outDir, lane = 'flux', jsonOut] = process.argv.slice(2).filter((a) => a !== '--');
if (!outDir) {
  console.error('usage: measure-cast.mjs <outDir> [imagen|flux|gemini|replicate-imagen] [jsonOut]');
  process.exit(1);
}

await mkdir(outDir, { recursive: true });
const { render, token, costUsd } = resolveLane(lane);
console.log(`lane: ${lane}  records: ${CAST_RECORDS.length}`);

const manifest = [];
let billable = 0;

/*
 * CAST_CLAUSE=off drops ONLY the per-character identity clause
 * ("Character identities: Sora — Kingdom Hearts; …") by emptying
 * characterIdentities, and keeps requestedCharacters intact.
 *
 * That distinction is the whole point: emptying requestedCharacters too would
 * also switch selectAxes out of compositional mode and swap the ensemble
 * treatments, so it would measure a different prompt path rather than the
 * proposed one-line production fix.
 */
const dropClause = (process.env.CAST_CLAUSE || 'on').toLowerCase() === 'off';
if (dropClause) console.log('identity clause: OFF (characterIdentities emptied)');

for (const { id, cast, record: baseRecord } of CAST_RECORDS) {
  const record = dropClause ? { ...baseRecord, characterIdentities: [] } : baseRecord;
  const { variations } = await enhanceStructured(record);
  for (const [vi, v] of variations.entries()) {
    const prompt = v.prompts.detailed ?? v.prompts.simple ?? '';
    if (!prompt) continue;
    const name = `${id}_v${vi}.png`;
    try {
      const [b64] = await render(token, prompt, v.negativePrompt, '9:16');
      billable++;
      if (!b64) {
        console.log(`  ${name}  NO IMAGE (safety filter?)`);
        manifest.push({ name, recordId: id, cast, blocked: true });
        continue;
      }
      await writeFile(path.join(outDir, name), Buffer.from(b64, 'base64'));
      manifest.push({ name, recordId: id, cast, prompt });
      console.log(`  ${name}  ok`);
    } catch (err) {
      console.log(`  ${name}  FAILED ${err.message}`);
      manifest.push({ name, recordId: id, cast, error: err.message });
    }
  }
}

await writeFile(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
console.log(`\nrendered ${billable}  approx $${(billable * costUsd).toFixed(2)}`);

console.log('\nscoring with the production vision prompt…');
const results = await scoreCastDir(outDir, adcToken());
const summary = summarizeCast(results);

console.log(`\n${outDir}  (lane: ${lane})`);
console.log(`  renders scored        ${summary.total}`);
console.log(`  full cast present     ${summary.complete}`);
console.log(`  no cast recognized    ${summary.none}`);
console.log(`  mean completeness     ${(summary.meanCompleteness * 100).toFixed(1)}%`);
console.log(`  renders with text     ${summary.textIntrusions}/${summary.total}`);
if (summary.intrudedWords.length) {
  console.log(`  words drawn in        ${summary.intrudedWords.slice(0, 12).join(', ')}`);
}
console.log('\n  by request:');
for (const [id, s] of Object.entries(summary.byRecord)) {
  const pct = ((s.sum / s.total) * 100).toFixed(0);
  console.log(`    ${id.padEnd(20)} ${pct.padStart(4)}%   full ${s.complete}/${s.total}`);
}

console.log('\n  per render:');
for (const r of results) {
  if (r.error) {
    console.log(`    ${r.file.padEnd(22)} ERROR ${r.error}`);
    continue;
  }
  const got = r.found.length ? r.found.join(', ') : '—';
  console.log(
    `    ${r.file.padEnd(22)} ${r.found.length}/${r.cast.length}  got: ${got}` +
      (r.extra.length ? `  | unexpected: ${r.extra.join(', ')}` : '')
  );
}

if (jsonOut) {
  await writeFile(jsonOut, JSON.stringify({ dir: outDir, lane, summary, results }, null, 2));
  console.log(`\n  wrote ${jsonOut}`);
}
