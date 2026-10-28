/**
 * Canonical body-part list for intake placement.
 *
 * Keyword normalization (below) and the TypeSafe placement Choice share
 * this list. Multi-word parts come first so "upper arm" wins over a
 * shorter part. Aliases in PLACEMENT_CANONICAL collapse to one option
 * ("ribs" and "rib cage" are both "ribcage") — the Choice must not offer
 * the alias and the canonical name as two answers.
 */

export const PLACEMENT_PARTS = [
  'behind the ear', 'shoulder blade', 'upper back', 'lower back',
  'upper arm', 'rib cage', 'collarbone', 'forearm', 'shoulder', 'sternum',
  'bicep', 'tricep', 'wrist', 'hand', 'finger', 'chest', 'spine', 'ribs',
  'ribcage', 'hip', 'thigh', 'knee', 'calf', 'shin', 'ankle', 'foot',
  'neck', 'back', 'ear', 'arm', 'leg',
] as const;

export const PLACEMENT_CANONICAL: Record<string, string> = {
  ribs: 'ribcage',
  'rib cage': 'ribcage',
};

/** Choice options: one entry per canonical part, alias duplicates removed. */
export function canonicalPlacementOptions(): string[] {
  const seen = new Set<string>();
  const options: string[] = [];
  for (const part of PLACEMENT_PARTS) {
    const canonical = PLACEMENT_CANONICAL[part] ?? part;
    if (seen.has(canonical)) continue;
    seen.add(canonical);
    options.push(canonical);
  }
  return options;
}

/** Left wins when both words appear — same rule as normalizePlacement. */
export function placementSide(text: string): 'left' | 'right' | null {
  if (/\bleft\b/.test(text)) return 'left';
  if (/\bright\b/.test(text)) return 'right';
  return null;
}

/**
 * Normalize a placement phrase to a canonical body part, preserving a
 * left/right qualifier when present. Placement is a hard generation
 * constraint (ADR-0009): unknown phrases pass through cleaned rather than
 * being guessed into a known part.
 */
export function normalizePlacement(raw: string): string {
  const text = (raw || '').toLowerCase().replace(/\s+/g, ' ').trim();
  const side = placementSide(text);

  for (const part of PLACEMENT_PARTS) {
    if (new RegExp(`\\b${part}\\b`).test(text)) {
      const canonical = PLACEMENT_CANONICAL[part] ?? part;
      return side ? `${side} ${canonical}` : canonical;
    }
  }

  const cleaned = text
    .replace(/[^a-z0-9\s'-]/g, ' ')
    .replace(/\b(?:on|my|the|probably|maybe|i|think|thinking|somewhere|around)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned || text;
}
