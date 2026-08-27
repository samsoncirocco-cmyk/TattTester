/**
 * The two production render lanes, callable from measurement scripts.
 *
 * Extracted from generate-backdrop-sample.mjs so every harness measures the
 * same thing the product does, and so a fix to one lane (throttle handling,
 * a changed input name) reaches every harness at once instead of being
 * patched into whichever script noticed first.
 *
 * Auth deliberately differs from the app: a gcloud ADC token for Vertex
 * rather than the service-account helper, because local runs have ADC and
 * not GOOGLE_APPLICATION_CREDENTIALS_JSON. Endpoints, models, and inputs are
 * otherwise identical to src/services/generation/internal/*.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';

export const PROJECT_ID = process.env.GCP_PROJECT_ID || 'tatt-pro';
export const REGION = process.env.GCP_REGION || 'us-central1';

const IMAGEN_MODEL = 'imagen-3.0-generate-001';
const FLUX_SLUG = 'black-forest-labs/flux-dev';
const IMAGEN_REPLICATE_SLUG = process.env.IMAGEN_REPLICATE_SLUG || 'google/imagen-4';
const GEMINI_IMAGE_MODEL = process.env.VERTEX_IMAGE_MODEL || 'gemini-3.1-flash-image';

/*
 * Per-image cost, used only for the harness's spend estimate. Replicate does
 * not expose per-run price through the models API, so the Imagen figure is an
 * estimate and overridable — treat the printed total as approximate.
 */
export const LANE_COST_USD = {
  imagen: 0.02,
  flux: 0.025,
  gemini: 0.039,
  'replicate-imagen': Number(process.env.IMAGEN_REPLICATE_COST_USD || 0.04),
};

export function adcToken() {
  return execFileSync('gcloud', ['auth', 'application-default', 'print-access-token'], {
    encoding: 'utf8',
  }).trim();
}

export function replicateToken() {
  const fromEnv = process.env.REPLICATE_API_TOKEN;
  if (fromEnv) return fromEnv;
  // Local runs read .env.local the same way `next dev` would.
  const envFile = readFileSync(path.join(process.cwd(), '.env.local'), 'utf8');
  const match = envFile.match(/^REPLICATE_API_TOKEN=(.*)$/m);
  if (!match) throw new Error('REPLICATE_API_TOKEN not found in env or .env.local');
  return match[1].trim().replace(/^["']|["']$/g, '');
}

export async function imagen(token, prompt, negativePrompt, aspectRatio) {
  const endpoint = `https://${REGION}-aiplatform.googleapis.com/v1/projects/${PROJECT_ID}/locations/${REGION}/publishers/google/models/${IMAGEN_MODEL}:predict`;
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      instances: [{ prompt }],
      parameters: {
        sampleCount: 1,
        aspectRatio,
        negativePrompt,
        safetySetting: 'block_only_high',
        personGeneration: 'allow_adult',
      },
    }),
  });
  if (!res.ok) throw new Error(`Imagen ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();
  return data.predictions?.map((p) => p.bytesBase64Encoded).filter(Boolean) ?? [];
}

/**
 * Fold negatives into the prompt as an "Avoid:" clause.
 *
 * Three of the four lanes need this and only Vertex Imagen did not: Flux,
 * the Gemini image models, and Google's Imagen models *as published on
 * Replicate* all expose no negative-prompt input. Verified against the live
 * Replicate schemas — google/imagen-4, imagen-4-fast, imagen-4-ultra and
 * imagen-3 accept only prompt, aspect_ratio, output_format,
 * safety_filter_level (+ image_size on some).
 *
 * That matters for reading the numbers: the 92% Imagen result in the
 * handoff was measured on Vertex with a real `negativePrompt` field. No
 * lane still reachable from the product can reproduce that exact input, so
 * every arm here carries the shield tokens as prose instead.
 */
function withAvoidClause(prompt, negativePrompt) {
  const avoid = (negativePrompt || '').trim();
  return avoid ? `${prompt.trim().replace(/\.$/, '')}. Avoid: ${avoid}.` : prompt;
}

/**
 * Create a Replicate prediction and wait it out, honouring throttles.
 *
 * Shared by every Replicate-hosted lane. Replicate throttles to 6/min with
 * a burst of 1 while account credit is under $5; a harness that ignores
 * retry_after measures a low-credit account as a broken lane rather than a
 * slow one.
 */
async function runReplicateModel(slug, apiToken, input, label) {
  let res;
  for (let attempt = 1; ; attempt++) {
    res = await fetch(`https://api.replicate.com/v1/models/${slug}/predictions`, {
      method: 'POST',
      headers: {
        Authorization: `Token ${apiToken}`,
        'Content-Type': 'application/json',
        Prefer: 'wait',
      },
      body: JSON.stringify({ input }),
    });
    if (res.status !== 429 || attempt >= 8) break;
    const body = await res.text();
    let waitMs = 10_000;
    try {
      const parsed = JSON.parse(body)?.retry_after;
      if (typeof parsed === 'number' && parsed > 0) waitMs = parsed * 1000;
    } catch {
      /* non-JSON throttle body — keep the default wait */
    }
    process.stdout.write(`    throttled, waiting ${Math.round(waitMs / 1000)}s\n`);
    await new Promise((r) => setTimeout(r, waitMs + 1500));
  }
  if (!res.ok) throw new Error(`${label} ${res.status}: ${(await res.text()).slice(0, 300)}`);

  let prediction = await res.json();
  for (let i = 0; prediction.status !== 'succeeded' && prediction.status !== 'failed' && i < 60; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    const poll = await fetch(`https://api.replicate.com/v1/predictions/${prediction.id}`, {
      headers: { Authorization: `Token ${apiToken}` },
    });
    prediction = await poll.json();
  }
  if (prediction.status !== 'succeeded') {
    throw new Error(`${label} prediction ${prediction.status}: ${prediction.error ?? 'unknown'}`);
  }
  const url = Array.isArray(prediction.output) ? prediction.output[0] : prediction.output;
  if (!url) return [];
  const image = await fetch(url);
  if (!image.ok) throw new Error(`${label} output fetch ${image.status}`);
  return [Buffer.from(await image.arrayBuffer()).toString('base64')];
}

/**
 * Google Imagen 4 as published on Replicate.
 *
 * The point of this lane: the handoff measured Vertex Imagen at 92% cast
 * completeness against Flux's 71%, but Vertex Imagen 3 retires 2026-08-17
 * and has been removed from the product. Replicate publishes the Imagen
 * family independently, so this asks whether that quality is reachable on a
 * provider we already use and already pay.
 */
export async function replicateImagen(apiToken, prompt, negativePrompt, aspectRatio) {
  return runReplicateModel(
    IMAGEN_REPLICATE_SLUG,
    apiToken,
    {
      prompt: withAvoidClause(prompt, negativePrompt),
      aspect_ratio: aspectRatio,
      output_format: 'png',
      safety_filter_level: 'block_only_high',
    },
    'ReplicateImagen'
  );
}

/**
 * Vertex Gemini image — what the product's `vertex-ai` provider now calls
 * after the Imagen migration (#277). Mirrors that provider exactly: global
 * publisher host, `:generateContent`, aspect ratio via `imageConfig`.
 *
 * Measured here for cast completeness AND for the text-intrusion problem
 * that took it off the routing table in the first place; the scorer reports
 * both so the tradeoff is one table rather than two arguments.
 */
export async function geminiImage(token, prompt, negativePrompt, aspectRatio) {
  const endpoint =
    `https://aiplatform.googleapis.com/v1/projects/${PROJECT_ID}` +
    `/locations/global/publishers/google/models/${GEMINI_IMAGE_MODEL}:generateContent`;
  const body = JSON.stringify({
    contents: [{ role: 'user', parts: [{ text: withAvoidClause(prompt, negativePrompt) }] }],
    generationConfig: {
      responseModalities: ['IMAGE'],
      imageConfig: { aspectRatio },
    },
    safetySettings: [
      'HARM_CATEGORY_HATE_SPEECH',
      'HARM_CATEGORY_DANGEROUS_CONTENT',
      'HARM_CATEGORY_HARASSMENT',
      'HARM_CATEGORY_SEXUALLY_EXPLICIT',
    ].map((category) => ({ category, threshold: 'BLOCK_ONLY_HIGH' })),
  });

  /*
   * Vertex per-project image quota is low and bursty, and a 429 here is a
   * capacity signal, not a verdict on the model. The first run of this lane
   * had no retry and lost 14 of 20 renders to 429 — which then scored as a
   * flawless 6/6 and would have been read as the best arm in the bake-off.
   * A lane that silently drops its hard cases is worse than a slow one.
   */
  let res;
  for (let attempt = 1; ; attempt++) {
    res = await fetch(endpoint, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body,
    });
    if (res.status !== 429 || attempt >= 8) break;
    const waitMs = Math.min(5000 * 2 ** (attempt - 1), 60_000);
    process.stdout.write(`    gemini throttled, waiting ${Math.round(waitMs / 1000)}s\n`);
    await new Promise((r) => setTimeout(r, waitMs));
  }
  if (!res.ok) throw new Error(`Gemini ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();
  // A safety refusal is a 200 with no image part, not an HTTP error.
  return (data.candidates ?? [])
    .flatMap((c) => c.content?.parts ?? [])
    .map((p) => p.inlineData?.data)
    .filter(Boolean);
}

/**
 * One flux-dev render, returned as base64 so every lane writes identically.
 * Mirrors the production provider: official-model slug endpoint, Prefer:
 * wait, and negatives folded into the prompt as an "Avoid:" clause because
 * the Flux family takes no negative_prompt input.
 */
export async function flux(apiToken, prompt, negativePrompt, aspectRatio) {
  const full = withAvoidClause(prompt, negativePrompt);

  return runReplicateModel(
    FLUX_SLUG,
    apiToken,
    {
      prompt: full,
      aspect_ratio: aspectRatio,
      guidance: 3,
      num_inference_steps: 28,
      output_format: 'png',
      num_outputs: 1,
    },
    'Flux'
  );
}

/** Pick a lane's renderer and token together, so they cannot be mismatched. */
export function resolveLane(lane) {
  if (lane === 'flux') return { render: flux, token: replicateToken(), costUsd: LANE_COST_USD.flux };
  if (lane === 'imagen') return { render: imagen, token: adcToken(), costUsd: LANE_COST_USD.imagen };
  if (lane === 'gemini') return { render: geminiImage, token: adcToken(), costUsd: LANE_COST_USD.gemini };
  if (lane === 'replicate-imagen') {
    return {
      render: replicateImagen,
      token: replicateToken(),
      costUsd: LANE_COST_USD['replicate-imagen'],
    };
  }
  throw new Error(`unknown lane '${lane}' (expected imagen|flux|gemini|replicate-imagen)`);
}
