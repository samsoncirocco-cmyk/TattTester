// Public entry point of the intake extraction module (ADR-0009, ADR-0010).
// Everything under internal/ is implementation detail — import only from here.
//
// Intake is the fixed two-question conversational opening of a design
// session. The only operation callers need is "extract a structured record
// from the two answers" — provider selection (Vertex Gemini → OpenRouter →
// deterministic heuristic), ontology loading, alias resolution, and
// ambiguity detection are all private. Style tags in the result are
// guaranteed to be canonical ids from the closed style ontology; meaning is
// the user's answer kept verbatim as prose for the artist brief.
import { extractIntakeRecord } from './internal/extractionService';
export {
  charactersIn,
  characterLabelFor,
  subjectPhraseFor,
  characterIdentitiesFor,
  momentFrom,
} from './internal/characterSubject';
export {
  groundedCharacterIdentities,
  mergeCharacterIdentities,
} from './internal/characterIdentity';
import type { IntakeRecord } from './types';

export type {
  IntakeRecord,
  CharacterIdentity,
  VariationAxis,
  AxisSelection,
} from './types';
export { VARIATION_AXIS_POOL } from './types';
// Pure and client-safe, like the types themselves: the council, the round
// orchestrator, and the reveal UI all skip the same settled rungs (ADR-0049).
export { resolvePalette, sessionPalette, settledAxes } from './settledAxes';
export type { Palette } from './settledAxes';

export interface IntakeAnswers {
  /** The user's answer to the placement question, in their own words. */
  placementAnswer: string;
  /** The user's answer to the meaning question, in their own words. */
  meaningAnswer: string;
}

/**
 * Extract a structured IntakeRecord from the two fixed intake answers.
 *
 * Never throws on provider trouble: when no LLM provider is configured (or
 * every configured one fails) it degrades to a deterministic keyword
 * extractor, so dev mode works offline. Throws only on infrastructure
 * problems that make the result untrustworthy (missing/invalid style
 * ontology file).
 */
export async function extractIntake(answers: IntakeAnswers): Promise<IntakeRecord> {
  return extractIntakeRecord(answers);
}
