import type { AspectRatio, GenerationRequest, GenerationResult, Provider } from './provider';
import { makeGenerationError } from './provider';

const REPLICATE_API_URL = 'https://api.replicate.com/v1';
const POLL_INTERVAL_MS = 2000;
// Poll window after create — must fit inside the render routes' maxDuration
// (300s, Fluid) together with the create retries, or the function dies after
// the renders were already paid for. Throttled/cold predictions can sit
// queued well past the Prefer: wait hold, so give polling real room.
const MAX_POLLS = 60;
// Replicate throttles hard when account credit is low (burst of 1 per ~10s
// window), so a reveal's four concurrent predictions need four windows: the
// last one to land needs attempt #4 or #5, not #3. Jitter spreads the herd —
// without it all four retry on the same tick and only one wins per window.
const MAX_CREATE_ATTEMPTS = 5;
const MAX_RETRY_AFTER_MS = 15_000;
const RETRY_JITTER_MS = 4_000;

interface ReplicateModel {
  id: string;
  name: string;
  /** Official Replicate model — invoked by slug via /models/{slug}/predictions, no version hash. */
  slug: string;
  cost: number;
  /** Krea accepts one output per prediction; the Flux family takes num_outputs. */
  supportsNumOutputs: boolean;
  /**
   * Accepts an `image` input for image-to-image (verified against each
   * model's published schema, 2026-08-01). Only flux-dev does: schnell has
   * no image input at all, and krea2's style_reference_images transfers
   * style rather than preserving composition, which is the opposite of what
   * an image-to-image caller is asking for.
   */
  supportsSourceImage: boolean;
  /**
   * Accepts an `image_input` ARRAY of reference images (ADR-0050 likeness).
   * Only nano-banana-2 has it. Distinct from supportsSourceImage — that is
   * composition-preserving image-to-image; this is subject/likeness
   * reference for a fresh composition.
   */
  supportsReferenceImages: boolean;
  /**
   * Accepts a `seed` input (spec 12). The Flux family and Krea do;
   * nano-banana-2 (Gemini) has no seed, so it is never sent one and never
   * reports one — a seed it ignored would be a false reproducibility claim.
   */
  supportsSeed: boolean;
  /** Ratios this model's input schema actually accepts (verified against its OpenAPI schema). */
  aspectRatios: ReadonlySet<string>;
  /** Requested ratio → nearest schema-legal ratio, for the gaps in aspectRatios. */
  aspectRemap: Readonly<Record<string, string>>;
  params: Record<string, unknown>;
}

// Verified from the models' published OpenAPI schemas (replicate.com/<slug>).
const FLUX_ASPECT_RATIOS = new Set(['1:1', '16:9', '21:9', '3:2', '2:3', '4:5', '5:4', '3:4', '4:3', '9:16', '9:21']);
const KREA_ASPECT_RATIOS = new Set(['1:1', '4:3', '3:2', '16:9', '2.35:1', '4:5', '2:3', '9:16']);
// Fetched from the live model API 2026-08-05 (also carries
// 'match_input_image' and banner ratios 1:4/4:1/1:8/8:1, deliberately
// excluded: the first needs an input image and the rest are not tattoo
// shapes).
const NANO_BANANA_ASPECT_RATIOS = new Set(['1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9']);

// The Flux/Krea catalog (replaced the SDXL-era models — two generations
// behind on linework and prompt adherence). None of these accept a
// negative_prompt input: negatives are folded into the prompt as an
// "Avoid:" clause below.
export const REPLICATE_MODELS: Record<string, ReplicateModel> = {
  'flux-dev': {
    id: 'flux-dev',
    name: 'FLUX.1 Dev',
    slug: 'black-forest-labs/flux-dev',
    cost: 0.025,
    supportsNumOutputs: true,
    supportsSourceImage: true,
    supportsReferenceImages: false,
    supportsSeed: true,
    aspectRatios: FLUX_ASPECT_RATIOS,
    aspectRemap: {},
    params: {
      guidance: 3,
      num_inference_steps: 28,
      output_format: 'png'
    }
  },
  'flux-schnell': {
    id: 'flux-schnell',
    name: 'FLUX.1 Schnell',
    slug: 'black-forest-labs/flux-schnell',
    cost: 0.003,
    supportsNumOutputs: true,
    supportsSourceImage: false,
    supportsReferenceImages: false,
    supportsSeed: true,
    aspectRatios: FLUX_ASPECT_RATIOS,
    aspectRemap: {},
    params: {
      output_format: 'png'
    }
  },
  // The cast lane (ADR-0048): Gemini-family image model, replacing the
  // Vertex imagen3 route for 3+ character requests. Contract verified live
  // in the #318 measurement run: exactly one output per prediction (a
  // string URI, no num_outputs input), $0.067/output at the default 1K
  // resolution.
  'nano-banana-2': {
    id: 'nano-banana-2',
    name: 'Nano Banana 2 (Gemini)',
    slug: 'google/nano-banana-2',
    cost: 0.067,
    supportsNumOutputs: false,
    // sourceImage stays false: the schema's image input is `image_input`,
    // an ARRAY carrying likeness/subject reference — not the single `image`
    // field composition-preserving image-to-image sends. Conflating them
    // would silently repurpose a stencil derivation into a reference remix.
    supportsSourceImage: false,
    supportsReferenceImages: true,
    supportsSeed: false,
    aspectRatios: NANO_BANANA_ASPECT_RATIOS,
    aspectRemap: {},
    // output_format defaults to jpg on this model — pin png to match the
    // rest of the catalog and the durable-image pipeline's expectations.
    params: { output_format: 'png' }
  },
  krea2: {
    id: 'krea2',
    name: 'Krea 2 Medium',
    slug: 'krea/krea-2-medium',
    cost: 0.035,
    supportsNumOutputs: false,
    supportsSourceImage: false,
    supportsReferenceImages: false,
    supportsSeed: true,
    aspectRatios: KREA_ASPECT_RATIOS,
    // Krea's schema has no 3:4 — 4:5 is the nearest portrait ratio it takes.
    aspectRemap: { '3:4': '4:5' },
    params: {}
  }
};

// Sessions persist their pinned modelId (ADR-0016), so ids from the retired
// SDXL catalog must keep resolving — a stored pick or refinement regen from
// before the switch lands on the closest current model.
const LEGACY_MODEL_ALIASES: Record<string, string> = {
  sdxl: 'flux-dev',
  tattoo: 'flux-dev',
  dreamshaper: 'flux-schnell',
  animeXL: 'krea2'
};

function resolveModel(modelId?: string): ReplicateModel {
  if (modelId && REPLICATE_MODELS[modelId]) return REPLICATE_MODELS[modelId];
  const alias = modelId ? LEGACY_MODEL_ALIASES[modelId] : undefined;
  if (alias) return REPLICATE_MODELS[alias];
  return REPLICATE_MODELS['flux-dev'];
}

/**
 * Whether a model id can honor `sourceImage`. Exported so the fallback
 * chain can skip models that would refuse, instead of letting their
 * refusal mask the primary model's real failure.
 */
export function modelSupportsSourceImage(modelId?: string): boolean {
  return resolveModel(modelId).supportsSourceImage;
}

/**
 * Whether a model id can honor `referenceImages` (ADR-0050 likeness).
 * Exported for the same reason as modelSupportsSourceImage: a fallback to a
 * model that would drop the customer's photo must be skipped, because a
 * likeness silently dropped is a stranger's face in a memorial tattoo.
 */
export function modelSupportsReferenceImages(modelId?: string): boolean {
  return resolveModel(modelId).supportsReferenceImages;
}

/** Whether a model id takes a `seed` input (spec 12). */
export function modelSupportsSeed(modelId?: string): boolean {
  return resolveModel(modelId).supportsSeed;
}

/** Schema cap on nano-banana-2's image_input; also our session cap is 6. */
const MAX_REFERENCE_IMAGES = 6;

function resolveAspectRatio(model: ReplicateModel, aspectRatio?: AspectRatio): string {
  if (!aspectRatio) return '1:1';
  if (model.aspectRatios.has(aspectRatio)) return aspectRatio;
  return model.aspectRemap[aspectRatio] || '1:1';
}

/**
 * Flux/Krea have no negative_prompt input — fold the negatives into the
 * prompt itself, which these prompt-adherent models handle well.
 */
function withAvoidClause(prompt: string, negativePrompt?: string): string {
  const negatives = (negativePrompt || '').trim();
  if (!negatives) return prompt;
  const base = prompt.trim().replace(/\.$/, '');
  return `${base}. Avoid: ${negatives}.`;
}

async function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** One prediction: create (with 429 retry_after handling), then poll to settled. */
async function runPrediction(
  model: ReplicateModel,
  input: Record<string, unknown>,
  token: string
): Promise<{ images: string[]; createAttempts: number }> {
  const endpoint = `${REPLICATE_API_URL}/models/${model.slug}/predictions`;

  let createRes: Response;
  let attempt = 1;
  for (;;) {
    createRes = await fetch(endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Token ${token}`,
        'Content-Type': 'application/json',
        Prefer: 'wait'
      },
      body: JSON.stringify({ input })
    });

    if (createRes.status === 429 && attempt < MAX_CREATE_ATTEMPTS) {
      const errText = await createRes.text();
      let retryAfterMs = 10_000;
      try {
        const retryAfter = JSON.parse(errText)?.retry_after;
        if (typeof retryAfter === 'number' && retryAfter > 0) {
          retryAfterMs = retryAfter * 1000;
        }
      } catch {
        // Non-JSON throttle body — keep the default wait.
      }
      // Jitter proportional to the wait (never longer than it) so short
      // test/throttle windows stay short while real 10s windows spread out.
      const jitterMs = Math.random() * Math.min(retryAfterMs, RETRY_JITTER_MS);
      await sleep(Math.min(retryAfterMs, MAX_RETRY_AFTER_MS) + jitterMs);
      attempt += 1;
      continue;
    }
    break;
  }

  if (!createRes.ok) {
    const errText = await createRes.text();
    throw makeGenerationError(`Replicate API Error: ${createRes.status} - ${errText}`, {
      status: createRes.status,
      code: 'REPLICATE_ERROR'
    });
  }

  let prediction = await createRes.json();
  let polls = 1;

  // Prefer: wait usually returns a settled prediction; poll if it didn't.
  while (prediction.status !== 'succeeded' && prediction.status !== 'failed' && polls <= MAX_POLLS) {
    await sleep(POLL_INTERVAL_MS);
    const pollRes = await fetch(`${REPLICATE_API_URL}/predictions/${prediction.id}`, {
      headers: { Authorization: `Token ${token}` }
    });
    prediction = await pollRes.json();
    polls += 1;
  }

  if (prediction.status === 'failed') {
    throw new Error(`Replicate prediction failed: ${prediction.error || 'unknown error'}`);
  }
  if (prediction.status !== 'succeeded') {
    throw new Error('Replicate prediction timed out');
  }

  const images: string[] = Array.isArray(prediction.output)
    ? prediction.output
    : [prediction.output].filter(Boolean);

  return { images, createAttempts: attempt };
}

async function generateWithReplicate(request: GenerationRequest): Promise<GenerationResult> {
  const startedAt = Date.now();
  const token = process.env.REPLICATE_API_TOKEN;
  if (!token) {
    throw makeGenerationError('REPLICATE_API_TOKEN not configured', {
      code: 'REPLICATE_NOT_CONFIGURED'
    });
  }

  const model = resolveModel(request.modelId);
  const numImages = Math.min(Math.max(request.numImages ?? 1, 1), 4);

  const input: Record<string, unknown> = {
    ...model.params,
    prompt: withAvoidClause(request.prompt, request.negativePrompt),
    aspect_ratio: resolveAspectRatio(model, request.aspectRatio)
  };
  if (model.supportsNumOutputs) {
    input.num_outputs = numImages;
  }

  // Image-to-image. Refused loudly rather than dropped: a caller asking to
  // keep a source's composition and silently getting a fresh text render
  // back has no way to tell — they just receive a different design.
  if (request.sourceImage) {
    if (!model.supportsSourceImage) {
      throw makeGenerationError(
        `Model '${model.id}' has no image-to-image input; sourceImage cannot be honored.`,
        { status: 400, code: 'SOURCE_IMAGE_UNSUPPORTED' }
      );
    }
    input.image = request.sourceImage;
    // flux-dev derives the output ratio from the source, so the requested
    // aspect_ratio would silently disagree with what comes back.
    delete input.aspect_ratio;
    if (typeof request.sourceStrength === 'number' && Number.isFinite(request.sourceStrength)) {
      input.prompt_strength = Math.min(Math.max(request.sourceStrength, 0), 1);
    }
  }
  // Reference photos as pixels (ADR-0050, #296 17a). Refused loudly on a
  // model without the input, for the same reason sourceImage is: a caller
  // promising a customer their photo informs the render must not silently
  // get a photo-less render back.
  const referenceImages = (request.referenceImages ?? []).filter(Boolean);
  if (referenceImages.length > 0) {
    if (!model.supportsReferenceImages) {
      throw makeGenerationError(
        `Model '${model.id}' has no reference-image input; referenceImages cannot be honored.`,
        { status: 400, code: 'REFERENCE_IMAGES_UNSUPPORTED' }
      );
    }
    input.image_input = referenceImages.slice(0, MAX_REFERENCE_IMAGES);
  }

  let sentSeed: number | undefined;
  if (model.supportsSeed && request.seed !== undefined && request.seed !== '') {
    const seed = Number(request.seed);
    if (Number.isFinite(seed)) {
      input.seed = seed;
      sentSeed = seed;
    }
  }

  // Single-output models (Krea) fan out: N parallel predictions merged in
  // order, so callers asking for 4 images get 4 regardless of model.
  const fanOut = model.supportsNumOutputs ? 1 : numImages;
  const runs = await Promise.all(
    // A seeded fan-out steps the seed per prediction: N copies of one seed
    // would be N copies of one picture.
    Array.from({ length: fanOut }, (_, i) =>
      runPrediction(
        model,
        sentSeed !== undefined && i > 0 ? { ...input, seed: (sentSeed + i) % 2 ** 31 } : input,
        token
      )
    )
  );

  return {
    images: runs.flatMap((run) => run.images),
    metadata: {
      model: model.id,
      provider: 'replicate',
      generatedAt: new Date().toISOString(),
      durationMs: Date.now() - startedAt,
      // Total create calls (throttle retries + fan-out included) — the
      // telemetry to watch when reading 429 frequency.
      attempts: runs.reduce((sum, run) => sum + run.createAttempts, 0),
      // Only the seed actually sent: a lane without one reports none.
      ...(sentSeed !== undefined ? { seed: sentSeed } : {}),
      fallbackUsed: false
    }
  };
}

export const replicateProvider: Provider = {
  name: 'replicate',
  generate: generateWithReplicate
};
