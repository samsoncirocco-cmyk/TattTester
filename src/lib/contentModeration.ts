/**
 * Pure routing for the TypeSafe moderation guard.
 *
 * One System One call scores an item. This module turns that assessment into
 * pass, review, or block. It does not call the network, and it has no way to
 * delete data or resolve a takedown — those actions are not in the result.
 *
 * The bands follow TypeSafe's guardrail cookbook (strict policy): a Noul at
 * or above 0.70 is a confident yes, 0.35 is the review line, and a severity
 * score at or above 2 (the "Serious" level on a 0–3 scale) is high severity.
 * Score answers also carry a confidence from 0 to 1. A Noul has no separate
 * confidence; a value near 1 is the confident yes, so the hazard probability
 * is used on the same 0.70 / 0.35 lines.
 */

export type ModerationAction = 'pass' | 'review' | 'block';

export type ModerationSurface = 'design_prompt' | 'takedown' | 'appeal';

/** Named thresholds. Change them here; the call site does not invent its own. */
export const MODERATION_THRESHOLDS = {
  /** Score confidence, or a hazard Noul, at or above this is high confidence. */
  highConfidence: 0.7,
  /** At or above this, and below the high line, is the mid band. */
  reviewConfidence: 0.35,
  /** Severity score at or above this (level "Serious") is high severity. */
  highSeverity: 2,
  /** Severity score at or above this (level "Mild") is the mid band. */
  reviewSeverity: 1,
} as const;

export interface ModerationAssessment {
  /** Yes-probabilities for the hazard Nouls that were asked. */
  nouls: Record<string, number>;
  /** Severity score on the 0–3 level scale. May fall between levels. */
  severity: number;
  /** Confidence of the severity score, 0–1. */
  confidence: number;
}

/**
 * Combine severity and confidence.
 *
 * Block only when the read is high-severity and highly confident: the score
 * confidence is at or above 0.70, or a hazard Noul is at or above 0.70, and
 * the severity score is at or above 2. A confident hazard with only mild
 * severity does not block.
 *
 * Review is the middle: a hazard at or above 0.35, a mid severity the model
 * is at least somewhat confident in, or a high severity it is not confident
 * enough to block on. Low confidence on a severe score goes to a person
 * rather than blocking or passing.
 *
 * Pass is the low band: no hazard at the review line, and severity below mild
 * or a mild score the model is not confident in.
 */
export function routeModeration(input: ModerationAssessment): ModerationAction {
  const hazard = Object.values(input.nouls).reduce((max, value) => Math.max(max, value), 0);
  const { severity, confidence } = input;
  const highConfidence =
    confidence >= MODERATION_THRESHOLDS.highConfidence ||
    hazard >= MODERATION_THRESHOLDS.highConfidence;
  const highSeverity = severity >= MODERATION_THRESHOLDS.highSeverity;

  if (highConfidence && highSeverity) return 'block';

  const hazardNeedsReview = hazard >= MODERATION_THRESHOLDS.reviewConfidence;
  const mildAndConfident =
    confidence >= MODERATION_THRESHOLDS.reviewConfidence &&
    severity >= MODERATION_THRESHOLDS.reviewSeverity;

  if (highSeverity || hazardNeedsReview || mildAndConfident) return 'review';
  return 'pass';
}

/** Hazard ids whose Noul is at or above the review line, highest first. */
export function hazardsAtReview(nouls: Record<string, number>): string[] {
  return Object.entries(nouls)
    .filter(([, probability]) => probability >= MODERATION_THRESHOLDS.reviewConfidence)
    .sort((a, b) => b[1] - a[1])
    .map(([id]) => id);
}

/**
 * What the user is told. Design prompts stop before any image is made.
 * Takedown and appeal copy says a person will review and that nothing was
 * removed or restored — the request itself is still accepted.
 */
export function moderationUserMessage(
  surface: ModerationSurface,
  action: 'review' | 'block',
  receipt?: { correlationId: string; durable: boolean } | null,
): string {
  if (surface === 'design_prompt') {
    if (receipt?.durable && receipt.correlationId) {
      return `Saved for review. Reference ${receipt.correlationId}.`;
    }
    return 'This was not saved for review.';
  }

  if (surface === 'takedown') {
    if (action === 'block') {
      return (
        'We received your request. Nothing has been removed, and we will not resolve it ' +
        'automatically. A person will review it.'
      );
    }
    return (
      'We received your request. Nothing has been removed. A person will review it before anything changes.'
    );
  }

  if (action === 'block') {
    return (
      'We received your request. Nothing has been restored, and we will not resolve it ' +
      'automatically. A person will review it.'
    );
  }
  return (
    'We received your request. Nothing has been restored. A person will review it before anything changes.'
  );
}
