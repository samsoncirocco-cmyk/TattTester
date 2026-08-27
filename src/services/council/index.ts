// Public entry point of the council module (ADR-0002).
// Everything under internal/ is implementation detail — import only from here.
//
// Council (prompt enhancement) has consumers beyond the generation pipeline
// (its own API route, health probe, UI), so it lives as its own module rather
// than as a generation internal. The only operation callers need is
// "enhance this prompt" — everything else (provider selection, caching,
// character detection, stencil-mode detection) is private.
import { enhancePrompt, CouncilProviderError } from './internal/councilService';
import {
  enhanceStructured as runStructured,
  enhanceRoundStructured as runRoundStructured,
} from './internal/structuredMode';
import type { StructuredEnhanceResult, RoundSpread } from './internal/structuredMode';
import type { IntakeRecord } from '../intake/types';

export { CouncilProviderError };
export type {
  StructuredEnhanceResult,
  StructuredVariation,
  RoundSpread,
} from './internal/structuredMode';

// Two pieces of the prompt contract the re-cut path needs by value rather than
// by call (`designSession/internal/designState.ts`): the flash-art presentation
// clause the AR preview depends on, and the chromatic-word strip a monochrome
// design needs applied to its subject prose. Both are measured behaviors with a
// comment at their definition, and a re-cut that keeps its own copy of either
// is a second answer waiting to drift from this one. Re-exported so the
// boundary in ADR-0002 stays the only door in.
export { PRESENTATION_LEAD, stripChromaticWords } from './internal/structuredMode';

export interface CouncilEnhanceRequest {
  /** The user's rough tattoo idea, in their own words. */
  userIdea: string;
  /** Tattoo style (e.g. 'traditional', 'japanese'). Defaults to 'traditional'. */
  style?: string;
  /** Body placement (e.g. 'forearm'). Defaults to 'forearm'. */
  bodyPart?: string;
  /** Optional callback receiving simulated council discussion updates. */
  onDiscussionUpdate?: ((update: unknown) => void) | null;
  /** Force stencil mode on/off; null lets the module auto-detect from the idea. */
  isStencilMode?: boolean | null;
}

export interface CouncilEnhanceResult {
  prompts: { simple?: string; detailed?: string; ultra?: string };
  negativePrompt?: string;
  metadata?: Record<string, unknown>;
  [key: string]: unknown;
}

/**
 * Enhance a rough tattoo idea into generation-ready prompts via the AI
 * Council (Vertex AI Gemini, with OpenRouter and external-API fallbacks).
 * Throws CouncilProviderError when every provider is exhausted.
 */
export async function enhance(request: CouncilEnhanceRequest): Promise<CouncilEnhanceResult> {
  return enhancePrompt(request) as Promise<CouncilEnhanceResult>;
}

/**
 * Structured-input mode (ADR-0015): enhance an intake record into the first
 * round's two axis-divergent prompt variations (ADR-0012, ADR-0049).
 * Questionnaire mode spreads the ADR-0049 ladder's first axis; when intake
 * resolved every axis, style locks and the two slots vary composition
 * instead. Axis selection is always narrated through `onDiscussionUpdate` —
 * never silent. Template-based: works offline without any provider call.
 */
export async function enhanceStructured(
  record: IntakeRecord,
  opts?: { onDiscussionUpdate?: (update: unknown) => void }
): Promise<StructuredEnhanceResult> {
  return runStructured(record, opts);
}

/**
 * One REFINE round's two variations (ADR-0049): spread on the round's axis
 * while holding every previously picked pole. Template-based like
 * enhanceStructured — never calls a provider.
 */
export async function enhanceRound(
  record: IntakeRecord,
  spread: RoundSpread
): Promise<StructuredEnhanceResult> {
  return runRoundStructured(record, spread);
}
