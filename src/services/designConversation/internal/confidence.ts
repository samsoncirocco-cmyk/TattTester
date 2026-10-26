/**
 * Readiness confidence for the proposal beat (ADR-0020, ADR-0021).
 *
 * This is a transparent 0–1 score computed in code from field presence and
 * strength — NEVER a raw model number. The formula (contributions sum to
 * exactly 1.0):
 *
 *   placement present                       +0.20
 *   placement specific (names a concrete
 *     body part, not just a bare limb)      +0.10
 *   meaning OR named subject present        +0.20
 *   meaning non-trivial (>= 4 words) OR
 *     named subject                         +0.10
 *   style tags present (>= 1)               +0.20
 *   variation axes resolved                 +0.05 per resolved axis (of 4),
 *                                            up to +0.20
 *
 * This is the ADR-0023 Part 3 formula ("style tags present +0.20") — an
 * earlier version demanded TWO style tags for full credit and gave a named
 * subject no scoring weight at all, which held a live session (arm sleeve +
 * five named characters) at 0.55 while the bot looped on the same style
 * question. The gate's bias is toward generating: the reveal is the
 * questionnaire in disguise (ADR-0012), so open axes are a reason to
 * generate a spread, not to keep interrogating.
 *
 * The judgment rule fires the proposal when confidence >=
 * CONFIDENCE_THRESHOLD AND the required fields are present: placement, plus
 * EITHER a meaning or a named subject. Requiring meaning outright stranded
 * complete briefs that simply had no emotional "why" — an observed session
 * gave placement, blackwork style and "goku charging a kamehameha", said
 * "thats everything", and still could not advance. A named character is a
 * concrete thing to draw, which is exactly what meaning was standing in for.
 * missingFields lists every field that earned less than full credit —
 * "missing or weak", per the TurnLog contract.
 */

import type { IntakeRecord } from '@/services/intake';
import { VARIATION_AXIS_POOL } from '@/services/intake';

export const CONFIDENCE_THRESHOLD = 0.7;

/**
 * Concrete body parts. A placement naming one of these counts as
 * "specific"; bare limbs/regions ("arm", "leg", "back") count as present
 * but not specific — the artist still has to pin them down.
 */
const SPECIFIC_PLACEMENT_PARTS = [
  'behind the ear', 'shoulder blade', 'upper arm', 'lower back', 'upper back',
  'forearm', 'shoulder', 'sternum', 'collarbone', 'bicep', 'tricep', 'wrist',
  'hand', 'finger', 'chest', 'spine', 'ribcage', 'rib cage', 'ribs', 'hip',
  'thigh', 'knee', 'calf', 'shin', 'ankle', 'foot', 'neck', 'ear',
  // A sleeve is a concrete, well-understood canvas — "arm sleeve" pins the
  // brief down as hard as "forearm" does.
  'sleeve',
] as const;

export interface RecordReadiness {
  /** 0–1 readiness score per the documented formula. */
  confidence: number;
  /** Fields that earned less than full credit — missing or weak. */
  missingFields: string[];
  /** Placement plus something to draw — a meaning or a named subject (ADR-0020). */
  hasRequiredFields: boolean;
}

export function isSpecificPlacement(placement: string): boolean {
  const text = placement.toLowerCase();
  return SPECIFIC_PLACEMENT_PARTS.some((part) =>
    new RegExp(`\\b${part}\\b`).test(text)
  );
}

export function scoreRecord(record: Partial<IntakeRecord>): RecordReadiness {
  const placement = (record.placement ?? '').trim();
  const meaning = (record.meaning ?? '').trim();
  const subject = (record.subject ?? '').trim();
  const styleTags = record.styleTags ?? [];
  const ambiguousAxes = record.ambiguousAxes ?? [...VARIATION_AXIS_POOL];

  const missingFields: string[] = [];
  let confidence = 0;

  if (placement) {
    confidence += 0.2;
    if (isSpecificPlacement(placement)) confidence += 0.1;
    else missingFields.push('placement');
  } else {
    missingFields.push('placement');
  }

  // A named subject is a concrete thing to draw — it earns the meaning
  // credit in full, exactly as it stands in for meaning in the gate below.
  const meaningWords = meaning ? meaning.split(/\s+/).filter(Boolean).length : 0;
  if (meaning || subject) {
    confidence += 0.2;
    if (meaningWords >= 4 || subject) confidence += 0.1;
    else missingFields.push('meaning');
  } else {
    missingFields.push('meaning');
  }

  // ADR-0023: "style tags present +0.20" — one committed style is a resolved
  // style. Demanding a second tag for full credit punished every session
  // with exactly one clear style choice.
  if (styleTags.length > 0) confidence += 0.2;
  else missingFields.push('styleTags');

  const resolvedAxes = Math.max(
    0,
    VARIATION_AXIS_POOL.length -
      Math.min(ambiguousAxes.length, VARIATION_AXIS_POOL.length)
  );
  confidence += resolvedAxes * 0.05;

  return {
    confidence: Math.min(1, Number(confidence.toFixed(2))),
    missingFields,
    hasRequiredFields: Boolean(placement && (meaning || (record.subject ?? '').trim())),
  };
}
