#!/usr/bin/env node
/**
 * Offline before/after for brief-fit reranking.
 *
 * Uses the production weights and rubric math in
 * src/services/matching/rerankOrder.js. The Score answers are fixtures
 * (scripts/fixtures/typesafe-rerank-briefs.js), not a live TypeSafe call.
 * Does not read TYPESAFE_API_KEY.
 *
 *   node scripts/compare-typesafe-rerank.mjs
 */

import { fitFromRawScores, rerankTopN, RERANK_WEIGHTS } from '../src/services/matching/rerankOrder.js';
import { BRIEFS } from './fixtures/typesafe-rerank-briefs.js';

const weightLine = `style ${RERANK_WEIGHTS.style.toFixed(2)}, placement ${RERANK_WEIGHTS.placement.toFixed(2)}, subject ${RERANK_WEIGHTS.subject.toFixed(2)}`;

console.log('TypeSafe brief rerank — offline comparison');
console.log('No network. Mocked System One scores sit on the 0..3 rubric; composite = weighted score/3.');
console.log(`Weights: ${weightLine}`);
console.log('');

let failed = false;

for (const sample of BRIEFS) {
  const fits = sample.before.map((item) => fitFromRawScores(sample.mockedRaw[item.id]));
  const { items, applied } = rerankTopN(sample.before, fits, 20);
  const afterIds = items.map((item) => item.id);
  const expected = sample.afterIds.join(',');
  const actual = afterIds.join(',');
  const ok = applied && actual === expected;

  console.log(`Brief (${sample.kind}): ${sample.brief.text}`);
  console.log('  Before (candidate-search order):');
  sample.before.forEach((item, index) => {
    const raw = sample.mockedRaw[item.id];
    console.log(`    ${index + 1}. ${item.label}  [${item.id}]  style ${raw.style} / placement ${raw.placement} / subject ${raw.subject}`);
  });
  console.log('  After (brief fit):');
  items.forEach((item, index) => {
    const fit = item.briefFit;
    const score = fit ? `composite ${fit.composite.toFixed(3)}` : 'unscored';
    console.log(`    ${index + 1}. ${item.label}  [${item.id}]  ${score}`);
  });
  console.log(ok ? '  Matches the expected order.' : `  MISMATCH expected ${expected} got ${actual}`);
  console.log('');
  if (!ok) failed = true;
}

if (failed) process.exit(1);
