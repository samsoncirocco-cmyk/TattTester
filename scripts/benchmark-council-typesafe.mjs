#!/usr/bin/env node
/**
 * Before/after latency and cost for the design council.
 *
 * This does not call OpenRouter or TypeSafe. It sleeps for the planning
 * latencies in COUNCIL_COST_MODEL (src/services/council/internal/typesafeJudge.ts)
 * and prints call counts plus list-price estimates.
 *
 *   node scripts/benchmark-council-typesafe.mjs
 *   BENCHMARK_SCALE=0.05 node scripts/benchmark-council-typesafe.mjs
 *
 * BENCHMARK_SCALE multiplies the sleeps (default 1). Cost figures are not scaled.
 *
 * Prices, dated 2026-10-27:
 *   Legacy flat sum logged by the service: $0.08 (technical model counted once
 *   even though it is called twice).
 *   Legacy token estimate, four HTTP calls, public list prices:
 *     Claude 3.5 Sonnet $3/$15, GPT-4 Turbo $10/$30, Gemini 1.5 Pro $1.25/$5
 *     per million tokens. Rough sizes 900/400, 800/200, 900/250, 600/80.
 *     Total ≈ $0.0335.
 *   Generator: Gemini 2.5 Flash list price $0.30/$2.50 per million, ~700 in /
 *     450 out ≈ $0.00134 per draft.
 *   Judge: Jev $0.042 per million input tokens, output free
 *     (https://docs.typesafe.ai/models). ~1,600 input tokens ≈ $0.000067.
 *   Latencies are assumed p50s (1.8s per chat completion, 0.45s per Jev call
 *   on a short state). They are not a live trace.
 */

const SCALE = Number(process.env.BENCHMARK_SCALE || 1);

const LEGACY_CALLS = 4;
const LEGACY_CALL_MS = 1800;
const GENERATOR_MS = 1800;
const JUDGE_MS = 450;

const LEGACY_FLAT_USD = 0.08;
const LEGACY_TOKEN_USD = 0.0335;
const GENERATOR_USD = 0.00134;
const JUDGE_USD = 0.000067;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function timeSerial(calls, ms) {
  const started = Date.now();
  for (let i = 0; i < calls; i += 1) await sleep(ms * SCALE);
  return Date.now() - started;
}

async function timeTyped(generatorCalls) {
  const started = Date.now();
  for (let i = 0; i < generatorCalls; i += 1) {
    await sleep(GENERATOR_MS * SCALE);
    await sleep(JUDGE_MS * SCALE);
  }
  return Date.now() - started;
}

const legacyMs = await timeSerial(LEGACY_CALLS, LEGACY_CALL_MS);
const passMs = await timeTyped(1);
const regenerateMs = await timeTyped(2);

const passUsd = GENERATOR_USD + JUDGE_USD;
const regenerateUsd = (GENERATOR_USD + JUDGE_USD) * 2;

const report = {
  scale: SCALE,
  legacy: {
    llmCalls: LEGACY_CALLS,
    typesafeCalls: 0,
    measuredMs: legacyMs,
    unscaledEstimateMs: LEGACY_CALLS * LEGACY_CALL_MS,
    flatUsd: LEGACY_FLAT_USD,
    tokenEstimateUsd: LEGACY_TOKEN_USD,
  },
  typedPass: {
    llmCalls: 1,
    typesafeCalls: 1,
    measuredMs: passMs,
    unscaledEstimateMs: GENERATOR_MS + JUDGE_MS,
    estimateUsd: Number(passUsd.toFixed(6)),
  },
  typedRegenerate: {
    llmCalls: 2,
    typesafeCalls: 2,
    measuredMs: regenerateMs,
    unscaledEstimateMs: 2 * (GENERATOR_MS + JUDGE_MS),
    estimateUsd: Number(regenerateUsd.toFixed(6)),
  },
  ratios: {
    passVsLegacyCalls: `${LEGACY_CALLS} serial LLM calls → 1 generator + 1 judge`,
    passVsLegacyLatency: Number((legacyMs / passMs).toFixed(2)),
    passVsLegacyTokenCost: Number((LEGACY_TOKEN_USD / passUsd).toFixed(1)),
    passVsLegacyFlatCost: Number((LEGACY_FLAT_USD / passUsd).toFixed(1)),
  },
};

console.log(JSON.stringify(report, null, 2));
