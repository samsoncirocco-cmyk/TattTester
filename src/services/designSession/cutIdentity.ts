/**
 * The one table of human names for a round's cuts (ADR-0049: two cuts a round).
 *
 * ## Why this is not in `features/design-session` any more
 *
 * These strings used to live in `features/design-session/services/revealCutNames.ts`
 * — inside the browser feature that renders the grid. Two things went wrong with
 * that address.
 *
 * The visible one: the customer reads "the totem" under a cut, types "the
 * totem", and `resolveCritiqueTarget` — which had never heard of this table —
 * matched nothing, fell through to its default, and re-cut a different design
 * while announcing it by name. Wrong image, real money, spoken with confidence.
 * The names the customer is shown and the names the server can resolve have to
 * come from the same place, and that place cannot be the browser.
 *
 * The quiet one: `services/sketchbotSms/internal/adapter.ts` was already
 * importing the client module from the server to name cuts over SMS. The
 * dependency ran backwards; nobody noticed because the module happens to be
 * pure.
 *
 * So the table lives here, beside the session types it describes. It imports
 * nothing at runtime — only a `type` — so the reveal grid can still import it
 * into the browser bundle without dragging the service graph along.
 *
 * ## The law this module keeps (ADR-0012 / TAT-47 defect 8)
 *
 * The axis machinery is an audit artifact, not chat copy. A cut is never
 * labeled "bold-fine: bold" — it is "the bold one". Every string here is
 * designed, and anything unrecognized falls back to a plain cut number rather
 * than leaking a raw internal value.
 *
 * ## Takes (the astronaut session, 2026-08-26)
 *
 * A customer asked for an astronaut, picked the bold cut, and got two re-cuts
 * back — both labelled "the bold one", because a re-cut copied its target's
 * axis position and this table names a cut from that position alone. Three
 * cuts, two names, and the reply for the re-cuts had to say "that last one"
 * because nothing here could name them. That is the same failure the section
 * above says was fixed: the grid's vocabulary and the resolver's drifted apart
 * again, one level down.
 *
 * So a re-cut is a numbered TAKE of the cut it revises — "the bold one, take
 * 2" — carried on the variation (`revision`) rather than derived from the
 * session, because the reveal grid names cuts from a single variation and has
 * no session to count against. Distinct, stable once written, and still
 * designed copy: an unrecognized position falls back to a plain cut number
 * exactly as before, take or no take.
 */
import type { DesignSession, Variation } from './types';

export interface CutIdentity {
  /** The cut's human name — "the bold, full-color one". */
  name: string;
  /** One in-voice line under the name; empty on the generic fallback. */
  caption: string;
}

/** How each axis pole reads as part of a cut's name. */
const POLE_NAME: Record<string, string> = {
  bold: 'bold',
  fine: 'fine-line',
  color: 'full-color',
  blackwork: 'blackwork',
  literal: 'literal',
  abstract: 'abstract',
  minimal: 'minimal',
  ornate: 'ornate',
};

/** One caption fragment per pole; fragments join with an em dash. */
const POLE_CAPTION: Record<string, string> = {
  bold: 'heavy lines, built to last',
  fine: 'single-needle delicate',
  color: 'ink with a pulse',
  blackwork: 'black only, all contrast',
  literal: 'says it straight',
  abstract: 'the feeling, not the picture',
  minimal: 'one idea, room to breathe',
  ornate: 'detail stacked on detail',
};

/** Compositional mode: style is locked, so the cuts are personalities of framing. */
const COMPOSITION_IDENTITY: Record<string, CutIdentity> = {
  'centered emblem': { name: 'the emblem', caption: 'dead center, head-on' },
  'dynamic flow': { name: 'the mover', caption: 'built to sweep with the body' },
  'negative space': { name: 'the breather', caption: 'small mark, big air' },
  'close crop': { name: 'the close-up', caption: 'in tight, on purpose' },
  // Ensemble briefs get their own cuts (a close crop of four characters
  // is one cropped face), so each needs a designed name here too — otherwise
  // a whole cast reveal falls back to "cut one … cut four".
  'ensemble emblem': { name: 'the emblem', caption: 'the whole cast, dead center' },
  'battle scene': { name: 'the clash', caption: 'everyone in it, mid-fight' },
  'stacked tiers': { name: 'the totem', caption: 'stacked top to bottom' },
  'flowing procession': { name: 'the procession', caption: 'strung along the flow' },
  // A sleeve swaps out the cuts that argue with a limb-length run.
  'vertical story': { name: 'the story', caption: 'top to bottom, in order' },
  'connected transitions': { name: 'the run', caption: 'one piece, no seams' },
  'focal hierarchy': { name: 'the anchor', caption: 'one hero, the rest follow' },
};

const ORDINAL = ['one', 'two', 'three', 'four'];

/** Fallback when a position holds values we don't recognize — a plain number, never the raw value. */
function fallback(index: number): CutIdentity {
  return { name: `cut ${ORDINAL[index] ?? index + 1}`, caption: '' };
}

/**
 * The designed name for an axis position, or nothing when the position holds
 * values this table does not recognize. Index-free on purpose: the fallback
 * needs a grid slot, and a take name needs the base name, so the two callers
 * below decide what to do with "we cannot name this" rather than each
 * re-deriving it.
 */
function designedIdentity(variation: Variation): CutIdentity | undefined {
  const position = variation.axisPosition ?? {};

  // Compositional mode: axisPosition is {composition: "<treatment>"}.
  if (typeof position.composition === 'string') {
    return COMPOSITION_IDENTITY[position.composition];
  }

  const poles = Object.values(position);
  if (poles.length === 0) return undefined;

  const names: string[] = [];
  const captions: string[] = [];
  for (const pole of poles) {
    const name = POLE_NAME[pole];
    // One unknown pole poisons the whole name — a half-designed label that
    // splices in a raw value is exactly the leak this module exists to stop.
    if (!name) return undefined;
    names.push(name);
    captions.push(POLE_CAPTION[pole]);
  }

  return {
    name: `the ${names.join(', ')} one`,
    caption: captions.join(' — '),
  };
}

/**
 * Derive the human name + caption for one cut.
 *
 * A cut carrying `revision` is a TAKE of the cut it revises: same treatment,
 * so the same caption, and a name that says which take it is. The revision
 * number is stored rather than counted here because this runs in the browser
 * against one variation at a time — the grid has no session to count against,
 * and a name that shifted when a later cut landed would be worse than the
 * duplicate it replaced.
 *
 * @param index the cut's slot in the grid, used only for the fallback name.
 */
export function cutIdentity(variation: Variation, index: number): CutIdentity {
  const designed = designedIdentity(variation);
  // Unrecognized stays a plain cut number even for a take: "cut five, take 2"
  // would be a designed name wrapped around an undesigned one, and the grid
  // number is already unique. ADR-0012 / TAT-47 defect 8.
  if (!designed) return fallback(index);

  const take = variation.revision ?? 1;
  if (take < 2) return designed;
  return { name: `${designed.name}, take ${take}`, caption: designed.caption };
}

/**
 * Every cut the session can be talking about, in ONE canonical order: every
 * round's cuts in render order, then the cuts critique produced.
 *
 * This order is a contract, not a convenience. The SMS channel captions each
 * MMS "Cut N of M" from it (`sketchbotSms/internal/render.ts`), the web grid
 * numbers its second grid from `variations.length`, and the critique
 * resolver reads an ordinal against it. All three have to count the same way
 * or a customer is told a number the product then denies knowing — the exact
 * shape of the "the totem" failure above.
 */
export function allCuts(
  session: Pick<DesignSession, 'variations' | 'critiqueCuts'>
): Variation[] {
  return [...session.variations, ...(session.critiqueCuts ?? [])];
}

/**
 * Which take number a new re-cut of `target` should carry.
 *
 * Counts from the target's own take, so a re-cut of "take 2" is "take 3"
 * rather than a second "take 2", and then steps past any name already in play
 * — two rounds can spread the same axis, so two cuts CAN share a base name,
 * and a take that collided would put us straight back into the two-cuts-one-
 * name miss this fixes.
 */
export function nextTake(
  session: Pick<DesignSession, 'variations' | 'critiqueCuts'>,
  target: Variation
): number {
  let take = (target.revision ?? 1) + 1;
  const designed = designedIdentity(target);
  // No designed base name: the take rides along for lineage, but the cut is
  // named by its grid number, which is unique already.
  if (!designed) return take;

  const taken = new Set(
    allCuts(session).map((variation, index) => cutIdentity(variation, index).name)
  );
  while (taken.has(`${designed.name}, take ${take}`)) take += 1;
  return take;
}

/* ── Resolving a name the customer typed ─────────────────────────────────── */

/**
 * Every designed name this product can ever put under a cut.
 *
 * Used to tell "named a cut we don't have" from "named no cut at all" — the
 * distinction the critique lane has to make before it spends a render. A name
 * that exists in the vocabulary but not in *this* session is a miss worth
 * asking about; a message with no cut reference in it at all is not.
 */
export const ALL_CUT_NAMES: readonly string[] = Object.freeze(
  Array.from(
    new Set([
      ...Object.values(COMPOSITION_IDENTITY).map((identity) => identity.name),
      ...ORDINAL.map((word) => `cut ${word}`),
    ])
  )
);

/**
 * Lowercase, strip punctuation, collapse whitespace.
 *
 * Normalization is the *only* liberty taken with the customer's text. Matching
 * stays exact on the normalized form — no stemming, no edit distance, no
 * synonyms. Fuzzy-matching display names is how "the totem" became a re-cut of
 * "the run"; widening the net would narrow that failure, not close it.
 */
export function normalizeCutName(text: string): string {
  return (text || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Does `message` contain `name` as a whole phrase?
 *
 * Whole-phrase, so "the run" does not match inside "the running man", and the
 * leading article is optional because people drop it ("totem, but bigger").
 */
export function messageNamesCut(message: string, name: string): boolean {
  const haystack = normalizeCutName(message);
  const needle = normalizeCutName(name);
  if (!haystack || !needle) return false;

  const bare = needle.replace(/^the\s+/, '');
  return [needle, bare].some((phrase) => {
    const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(?:^|\\s)${escaped}(?:$|\\s)`).test(haystack);
  });
}

/**
 * The named cuts of a session, in the canonical `allCuts` order, paired with
 * their variation.
 *
 * Built from the same `cutIdentity` the grid renders with, so the allowlist a
 * critique is matched against is by construction the set of names the customer
 * was actually shown — INCLUDING the critique re-cuts, which the web renders
 * in a second grid and SMS sends as the next numbers up. Leaving them out is
 * why "the bold one, take 2" was unreachable by name and the reply had to fall
 * back to "that last one" (the astronaut session).
 */
export function sessionCutIdentities(
  session: Pick<DesignSession, 'variations' | 'critiqueCuts'>
): { variation: Variation; identity: CutIdentity }[] {
  return allCuts(session).map((variation, index) => ({
    variation,
    identity: cutIdentity(variation, index),
  }));
}
