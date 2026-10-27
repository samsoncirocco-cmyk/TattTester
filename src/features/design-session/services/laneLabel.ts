// Friendly names for the lane that drew a cut (spec 12). Labels come from
// the model ids the code actually serves (`nano-banana-2` through
// Replicate, the Gemini image model behind the Vertex pin), never from raw
// ids on screen: an id with no label shows nothing at all.

const LANE_LABELS: Record<string, string> = {
  'flux-dev': 'Flux Dev',
  'flux-schnell': 'Flux Schnell',
  krea2: 'Krea 2',
  'nano-banana-2': 'Nano Banana 2',
  'gemini-3.1-flash-image': 'Gemini',
};

/** Lanes that take no seed, so their details say so instead of a number. */
const SEEDLESS_LANES = new Set(['nano-banana-2', 'gemini-3.1-flash-image']);

export function laneLabel(lane: string | undefined): string | null {
  return lane ? (LANE_LABELS[lane] ?? null) : null;
}

/** "drawn on Flux Dev", or null when the lane is unknown or absent. */
export function drawnOnLine(lane: string | undefined): string | null {
  const label = laneLabel(lane);
  return label ? `drawn on ${label}` : null;
}

/**
 * The details line: the seed when the lane used one, a plain "not used"
 * on a seedless lane, nothing otherwise (an old cut, an unknown lane).
 */
export function seedLine(lane: string | undefined, seed: number | undefined): string | null {
  if (!laneLabel(lane)) return null;
  if (typeof seed === 'number') return `seed ${seed}`;
  return lane && SEEDLESS_LANES.has(lane) ? 'seed: not used on this lane' : null;
}
