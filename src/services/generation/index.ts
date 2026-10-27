// Public entry point of the generation module (ADR-0001).
// Everything under internal/ is implementation detail — import only from here.
import { vertexImagenProvider } from './internal/vertexImagen';
import {
  replicateProvider,
  modelSupportsSourceImage,
  modelSupportsReferenceImages,
} from './internal/replicate';
import { routeGeneration, inferProvider, fallbackChainForModelId } from './internal/routing';
import type { GenerationRequest, GenerationResult, ProviderName } from './internal/provider';
import { asGenerationError } from './internal/provider';
import { screenForText } from './internal/textGuard';

export type {
  GenerationRequest,
  GenerationResult,
  GenerationMode,
  ProviderName,
  AspectRatio,
  SafetyFilterLevel
} from './internal/provider';

// Deliberate second public export (contract step, ticket 05): routeGeneration
// is a pure routing helper (no I/O, imports only the model-routing config) and
// is safe on the client. Feature code that previews model/aspect/negative-prompt
// choices without generating imports it from here instead of the deleted
// src/services/generationRouter.ts.
export { routeGeneration } from './internal/routing';
export type { GenerationRoute } from './internal/routing';
// The exclusion vocabulary that keeps a render readable as linework. Shared
// so a caller building its own stencil prompt uses the same words the
// stencil route already folds in, instead of a drifting second list.
export { STENCIL_SHIELD_TOKENS } from './internal/routing';

interface ResolvedRoute {
  modelId: string;
  provider: ProviderName;
  fallbackChain: string[];
}

function resolveRoute(request: GenerationRequest): { route: ResolvedRoute; request: GenerationRequest } {
  if (request.modelId) {
    // Explicit model choice skips routing; the caller owns aspect/negative
    // prompt. The fallback chain is resolved ONLY on explicit opt-in
    // (allowProviderFallback === true): a pinned model that quietly fell
    // back was the silent downgrade ADR-0048 forbids, so a pinned caller
    // that wants the downgrade must ask for it — and gets it flagged in the
    // result's fallbackUsed/fallbackReason metadata. Callers passing
    // undefined keep the historical no-fallback behavior.
    return {
      route: {
        modelId: request.modelId,
        provider: inferProvider(request.modelId),
        fallbackChain:
          request.allowProviderFallback === true ? fallbackChainForModelId(request.modelId) : []
      },
      request
    };
  }

  const routed = routeGeneration(request);
  return {
    route: {
      modelId: routed.modelId,
      provider: routed.provider,
      fallbackChain: routed.fallbackChain
    },
    request: {
      ...request,
      modelId: routed.modelId,
      aspectRatio: request.aspectRatio ?? routed.aspectRatio,
      negativePrompt: routed.negativePrompt || request.negativePrompt
    }
  };
}

function dispatch(provider: ProviderName, request: GenerationRequest): Promise<GenerationResult> {
  return provider === 'vertex-ai'
    ? vertexImagenProvider.generate(request)
    : replicateProvider.generate(request);
}

/**
 * Re-rolls AFTER the first render. Default 1. Non-finite / negative values
 * from bad JSON coercion must not reach `rerolls >= maxRerolls` — NaN and
 * Infinity never compare true, which would unbounded-loop the paid render.
 */
function resolveMaxRerolls(maxRerolls?: number): number {
  if (typeof maxRerolls !== 'number' || !Number.isFinite(maxRerolls)) return 1;
  return Math.max(0, Math.floor(maxRerolls));
}

/**
 * Screen a result and re-roll while it carries unrequested lettering (#297).
 *
 * The re-roll lives here rather than in a caller for the same reason the
 * retry and the provider fallback do (ADR-0001): this module owns "try again"
 * policy, and a second copy in the design-session orchestrator would drift
 * from this one.
 *
 * Bounded by construction. Each re-roll is a real paid render, so the default
 * is one — two renders at most — and a result that is still lettered after the
 * budget is spent is RETURNED, flagged, not thrown. The customer seeing a
 * design with a word in it is the defect; the customer seeing nothing is worse.
 */
async function screenAndReroll(
  first: GenerationResult,
  // `attempt` counts re-rolls from 1, so a seeded request can vary its seed.
  render: (attempt: number) => Promise<GenerationResult>,
  prompt: string,
  maxRerolls: number
): Promise<GenerationResult> {
  let result = first;
  let rerolls = 0;
  // Prior lettered batch kept so an empty re-roll can fall back to a flagged
  // design instead of dropping the only images the customer paid for.
  let lastFlagged: GenerationResult | null = null;
  let lastFlaggedWords: string[] = [];

  for (;;) {
    // Nothing to screen: do not claim a clean pass. Absent textIntrusion means
    // the guard did not run; false would mean screened and clean.
    if (result.images.length === 0) {
      if (lastFlagged) {
        lastFlagged.metadata.textIntrusion = true;
        lastFlagged.metadata.textIntrusionWords = lastFlaggedWords;
        lastFlagged.metadata.textGuardRerolls = rerolls;
        return lastFlagged;
      }
      if (rerolls) result.metadata.textGuardRerolls = rerolls;
      return result;
    }

    // Screen sequentially so each checkBudget sees prior recordSpend from
    // siblings in this batch. Promise.all raced N near-limit checks to
    // allowed:true before any spend landed, exceeding the global cap.
    const verdicts = [];
    for (const image of result.images) {
      verdicts.push(await screenForText(image, prompt));
    }

    // Known intrusion wins over a sibling skip. A mixed batch (one OCR hit,
    // one budget/provider failure) still has enough signal to re-roll or flag;
    // treating the whole result as "could not check" would deliver lettering.
    const offending = verdicts.filter((v) => v.intruded);
    if (offending.length === 0) {
      const unscreened = verdicts.find((v) => !v.screened);
      if (unscreened) {
        // Could not check. Say so rather than let "no intrusion found" stand in
        // for "did not look" — those are different facts to debug.
        result.metadata.textGuardSkipped = unscreened.skipReason;
        if (rerolls) result.metadata.textGuardRerolls = rerolls;
        return result;
      }

      result.metadata.textIntrusion = false;
      if (rerolls) result.metadata.textGuardRerolls = rerolls;
      return result;
    }

    const words = [...new Set(offending.flatMap((v) => v.words))];

    if (rerolls >= maxRerolls) {
      result.metadata.textIntrusion = true;
      result.metadata.textIntrusionWords = words;
      result.metadata.textGuardRerolls = rerolls;
      return result;
    }

    lastFlagged = result;
    lastFlaggedWords = words;

    /*
     * A re-roll that throws must not escape. `generate()` calls this inside
     * the try that guards the PRIMARY dispatch, so an error here would be
     * read as "the first render failed" — triggering provider fallback, or
     * throwing — and the batch the customer already paid for would be
     * discarded because the free second opinion on it failed.
     *
     * The first batch is lettered, not lost. Returning it flagged is the same
     * answer as exhausting the re-roll budget, which is the contract: showing
     * a flagged design beats showing nothing.
     *
     * Count only completed re-rolls. Billing reads textGuardRerolls as paid
     * extras (1 + N); incrementing before render() would overbill when the
     * provider call throws and we hand back the first batch.
     */
    try {
      result = await render(rerolls + 1);
      rerolls += 1;
    } catch {
      lastFlagged.metadata.textIntrusion = true;
      lastFlagged.metadata.textIntrusionWords = lastFlaggedWords;
      if (rerolls) lastFlagged.metadata.textGuardRerolls = rerolls;
      return lastFlagged;
    }
  }
}

/**
 * The request for text-guard re-roll `attempt` (spec 12). Without a seed the
 * provider's own randomness makes the re-roll differ; WITH one, re-sending
 * the same seed would redraw the same lettered picture and the re-roll would
 * be paid for nothing. So a seeded re-roll moves to the next seed, and the
 * provider reports back the seed of the attempt that was kept.
 */
export function rerollRequest(request: GenerationRequest, attempt: number): GenerationRequest {
  if (request.seed === undefined || request.seed === '') return request;
  const seed = Number(request.seed);
  if (!Number.isFinite(seed)) return request;
  return { ...request, seed: (Math.trunc(seed) + attempt) % 2 ** 31 };
}

export async function generate(request: GenerationRequest): Promise<GenerationResult> {
  const { route, request: resolved } = resolveRoute(request);

  const withScreening = async (result: GenerationResult): Promise<GenerationResult> => {
    if (!request.screenText) return result;
    return screenAndReroll(
      result,
      (attempt) => dispatch(route.provider, rerollRequest(resolved, attempt)),
      resolved.prompt,
      resolveMaxRerolls(request.screenText.maxRerolls)
    );
  };

  try {
    return await withScreening(await dispatch(route.provider, resolved));
  } catch (thrown) {
    const error = asGenerationError(thrown);
    if (resolved.allowProviderFallback === false) throw error;

    // Vertex → Replicate SDXL (when a token exists); Replicate → its routed
    // fallback chain. Vertex never appears as a fallback target.
    const routedFallbacks =
      route.provider === 'vertex-ai'
        ? process.env.REPLICATE_API_TOKEN
          ? ['sdxl']
          : []
        : route.fallbackChain.filter((id) => id !== 'imagen3');

    // An image-to-image request can only fall back to a model that also
    // takes a source image. Letting the others through would replace the
    // primary model's real failure with a uniform SOURCE_IMAGE_UNSUPPORTED.
    // Same rule for reference photos (ADR-0050): no current fallback model
    // takes them, so a photo-carrying request gets an empty chain and fails
    // visibly — a render without the customer's photo is not a downgrade,
    // it is a different product than the one they asked for.
    let fallbackModels = resolved.sourceImage
      ? routedFallbacks.filter(modelSupportsSourceImage)
      : routedFallbacks;
    if (resolved.referenceImages?.length) {
      fallbackModels = fallbackModels.filter(modelSupportsReferenceImages);
    }

    let lastError: Error = error;
    for (const modelId of fallbackModels) {
      try {
        const result = await replicateProvider.generate({ ...resolved, modelId });
        result.metadata.fallbackUsed = true;
        result.metadata.fallbackReason = error.code || error.message || 'PRIMARY_FAILED';
        // A fallback render reaches the customer exactly like a primary one,
        // so it gets the same gate — re-rolling on the fallback model.
        return request.screenText
          ? await screenAndReroll(
              result,
              async (attempt) => {
                const retry = await replicateProvider.generate({
                  ...rerollRequest(resolved, attempt),
                  modelId,
                });
                retry.metadata.fallbackUsed = true;
                retry.metadata.fallbackReason = result.metadata.fallbackReason;
                return retry;
              },
              resolved.prompt,
              resolveMaxRerolls(request.screenText.maxRerolls)
            )
          : result;
      } catch (fallbackError) {
        lastError = asGenerationError(fallbackError);
      }
    }
    throw lastError;
  }
}
