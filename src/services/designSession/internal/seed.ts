/**
 * The seed a design-session cut is drawn with (spec 12).
 *
 * Derived, not random: a stable hash of the session id and the cut id. A
 * retried render therefore asks for the same seed, so the staging
 * fingerprint (which keys on the slot) and the seed always agree without
 * the seed entering the fingerprint, and a stored seed can be recomputed to
 * check it. Two cuts of one round differ because their ids differ.
 *
 * Range 0 to 2^31−1: the conservative end of what the Replicate Flux and
 * Krea schemas take (their exact upper bound is unverified).
 */
export const MAX_SEED = 2 ** 31 - 1;

/** FNV-1a over UTF-16 code units, folded to 31 bits. Pure and synchronous. */
export function seedFor(sessionId: string, cutId: string): number {
  const text = `${sessionId}\u0000${cutId}`;
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash & MAX_SEED;
}
