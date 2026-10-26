/**
 * Server-side entry point for what a pinned model can take as image input.
 *
 * A session pins one model at its reveal (ADR-0016), and later rounds build
 * on the reveal by feeding it the picked cut. Whether that cut can ride as a
 * reference image (nano-banana-2, ADR-0050), as an image-to-image source
 * (flux-dev), or not at all depends on the pinned model AND on the provider
 * that will actually serve it: `imagen3` is a Vertex pin and takes neither,
 * even though the Replicate table would map an unknown id to flux-dev.
 *
 * This is its own entry, like `routing.ts`, because callers ask the question
 * before they build a request, and because the many tests that mock the
 * server entry (`index.ts`) with only `generate`/`routeGeneration` should not
 * have to learn a new export. `internal/` stays private (ADR-0001).
 */
import { inferProvider } from './internal/routing';
import {
  modelSupportsReferenceImages,
  modelSupportsSourceImage,
} from './internal/replicate';

export interface PinnedImageInputs {
  /** The model accepts `referenceImages` (multi-image likeness input). */
  referenceImages: boolean;
  /** The model accepts `sourceImage` (image-to-image, one source). */
  sourceImage: boolean;
}

/** What image input the model `modelId` will honor on the provider that serves it. */
export function pinnedImageInputs(modelId: string): PinnedImageInputs {
  if (inferProvider(modelId) === 'vertex-ai') {
    return { referenceImages: false, sourceImage: false };
  }
  return {
    referenceImages: modelSupportsReferenceImages(modelId),
    sourceImage: modelSupportsSourceImage(modelId),
  };
}
