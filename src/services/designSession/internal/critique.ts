/**
 * The post-reveal critique lane (ADR-0039).
 *
 * Pure functions only — which cut a critique is about, whether it is a fix
 * request at all, and what the re-cut prompt becomes. Deterministic on
 * purpose, exactly like `./refinement.ts` and
 * `designConversation/internal/intent.ts`: a fixed vocabulary is cheap,
 * testable, and cannot hallucinate a fix in front of a paid render.
 *
 * The orchestrator owns everything stateful — the allowance ledger, the
 * pinned-model regen, persistence.
 */
import {
  ALL_CUT_NAMES,
  cutIdentity,
  messageNamesCut,
  sessionCutIdentities,
} from '../cutIdentity';
import type { DesignSession, Variation } from '../types';

/* ── Which cut ───────────────────────────────────────────────────────────── */

/** "the third one", "#2", "cut two", "number 4", "the 1st". */
const ORDINAL_WORDS: Record<string, number> = {
  first: 1,
  '1st': 1,
  one: 1,
  second: 2,
  '2nd': 2,
  two: 2,
  third: 3,
  '3rd': 3,
  three: 3,
  fourth: 4,
  '4th': 4,
  four: 4,
};

// The `#` alternative carries no leading \b — `#` is not a word character, so
// a shared \b would never match "#2".
const ORDINAL_PATTERN = new RegExp(
  `(?:\\bthe\\s+|\\bcut\\s+|\\bdesign\\s+|\\bnumber\\s+|\\bno\\.?\\s*|#\\s*)(${Object.keys(ORDINAL_WORDS).join('|')}|[1-4])\\b`,
  'i'
);

/** Pole words a user can name a cut by — "the blackwork one", "the bold one". */
const POLE_WORD: Record<string, RegExp> = {
  bold: /\bbold\b/i,
  fine: /\bfine([- ]?line)?\b|\bdelicate\b/i,
  color: /\bcolou?r(ful|ed)?\b/i,
  blackwork: /\bblack ?work\b|\bblack (and|&|n) gr[ae]y\b/i,
  literal: /\bliteral\b|\brealistic\b/i,
  abstract: /\babstract\b/i,
  minimal: /\bminimal(ist)?\b/i,
  ornate: /\bornate\b|\bintricate\b/i,
};

/**
 * Every cut the session can be talking about: every round's cuts in render
 * order, then any cuts critique already produced.
 */
export function allCuts(session: Pick<DesignSession, 'variations' | 'critiqueCuts'>): Variation[] {
  return [...session.variations, ...(session.critiqueCuts ?? [])];
}

/**
 * What a critique turn is about.
 *
 * `missed` exists because the old `Variation | undefined` could not tell two
 * very different situations apart, and that conflation is what cost a customer
 * a render in session 0f6234e9:
 *
 * - They typed "the totem" — a cut name this product genuinely uses, and one
 *   the grid had shown them. Nothing resolved it, so the resolver fell through
 *   to its "most recent cut" default, re-cut *the run*, and announced it by
 *   name. Confident, wrong, and paid for.
 * - They typed "make it bigger" — naming no cut at all. Falling through to the
 *   cut they are visibly working on is not a guess there; it is the context of
 *   the conversation, and taking it away would make the lane tedious.
 *
 * So: named a cut and it did not resolve to exactly one → `missed`, ask.
 * Named no cut → the context fallbacks still apply. Only `none` (no reference
 * and no context) reaches the original "which one am i fixing?" line.
 *
 * `via` records how a cut was reached: `reference` when the message named it,
 * `context` when it is simply the cut being worked on. The router above needs
 * that distinction — "more like an unreal engine 5 look" resolves to a cut by
 * context, but it is not a request about that cut.
 */
export type CritiqueTarget =
  | { kind: 'cut'; variation: Variation; via: 'reference' | 'context' }
  | { kind: 'missed' }
  | { kind: 'none' };

/**
 * Which cut this critique is about, in falling order of confidence:
 *   1. an ordinal naming one of the session's cuts ("the third one")
 *   2. the designed name the grid showed under the cut ("the totem")
 *   3. a pole word only one reveal cut carries ("the blackwork one")
 *   4. the most recent cut critique produced — the user is still fixing it
 *   5. the session's pick, once one exists
 *
 * 1–3 are the allowlist, and they are exact matches on normalized text: no
 * stemming, no edit distance, no semantics. A reference that misses is not
 * retried more loosely — it is handed back as a question, because the cheapest
 * possible outcome of an unresolved name is asking, and the most expensive is
 * rendering the wrong design.
 */
export function resolveCritiqueTarget(
  session: Pick<DesignSession, 'variations' | 'critiqueCuts' | 'pickId'>,
  message: string
): CritiqueTarget {
  const text = (message || '').trim();

  // An ordinal is an unambiguous reference. Out of range is still a reference —
  // "the fourth one" against a two-cut round is a miss to ask about, never a
  // reason to fall through to something they did not name.
  const ordinal = text.match(ORDINAL_PATTERN);
  if (ordinal) {
    const token = ordinal[1].toLowerCase();
    const index = (ORDINAL_WORDS[token] ?? Number(token)) - 1;
    if (index >= 0 && index < session.variations.length) {
      return { kind: 'cut', variation: session.variations[index], via: 'reference' };
    }
    return { kind: 'missed' };
  }

  // The names the customer was actually shown, matched against the same table
  // the grid rendered from. Two cuts sharing a name is a miss, not a coin flip.
  const named = sessionCutIdentities(session).filter(({ identity }) =>
    messageNamesCut(text, identity.name)
  );
  if (named.length === 1) {
    return { kind: 'cut', variation: named[0].variation, via: 'reference' };
  }
  if (named.length > 1) return { kind: 'missed' };

  // Pole words are a weaker signal than a name, and deliberately treated as
  // one.
  //
  // EVERY pole word in the message is taken together, not the first one found.
  // Checking them one at a time made specificity actively harmful: on a round
  // where three cuts share a locked "fine" pole, "the fine blackwork one" —
  // the most precise thing a customer can say — matched "fine" first, saw
  // three carriers, and gave up, while the vaguer "the blackwork one" resolved.
  // Intersecting instead means more words can only ever narrow. (Found by
  // review on #340; costs nothing today because the failure only asks, but the
  // rule was backwards.)
  const matchedPoles = Object.entries(POLE_WORD)
    .filter(([, pattern]) => pattern.test(text))
    .map(([pole]) => pole);

  if (matchedPoles.length > 0) {
    const carrying = session.variations.filter((variation) => {
      const poles = Object.values(variation.axisPosition);
      return matchedPoles.every((pole) => poles.includes(pole));
    });
    if (carrying.length === 1) {
      return { kind: 'cut', variation: carrying[0], via: 'reference' };
    }
    if (carrying.length > 1) return { kind: 'missed' };

    // Nothing carries the combination. If some of those words describe cuts
    // that exist, they described a pairing this round never drew — ask. If
    // none of them describe anything here, it is not a reference at all:
    // "too colorful" against a blackwork round is a complaint about the piece,
    // and interrogating it would be its own failure.
    const anyPoleExists = session.variations.some((variation) => {
      const poles = Object.values(variation.axisPosition);
      return matchedPoles.some((pole) => poles.includes(pole));
    });
    if (anyPoleExists) return { kind: 'missed' };
  }

  // A designed name from the wider vocabulary that this session never showed —
  // "the totem" on a round that has no stacked-tiers cut. The customer is
  // pointing at something; we just do not have it. Ask.
  if (ALL_CUT_NAMES.some((name) => messageNamesCut(text, name))) {
    return { kind: 'missed' };
  }

  // Named nothing. Context is legitimate from here down.
  const critiqueCuts = session.critiqueCuts ?? [];
  if (critiqueCuts.length > 0) {
    return { kind: 'cut', variation: critiqueCuts[critiqueCuts.length - 1], via: 'context' };
  }

  if (session.pickId) {
    const picked = allCuts(session).find((variation) => variation.id === session.pickId);
    if (picked) return { kind: 'cut', variation: picked, via: 'context' };
  }

  return { kind: 'none' };
}

/**
 * How a cut is named back to the user — the same designed string the grid put
 * under it, so "re-cut the totem" can only ever mean the cut the customer was
 * looking at when they typed "the totem".
 *
 * Speaking a different vocabulary than we resolve is what made the original
 * failure unreadable: the reply said a name the resolver had no concept of.
 */
export function cutLabel(
  session: Pick<DesignSession, 'variations'>,
  variation: Variation
): string {
  const index = session.variations.findIndex((candidate) => candidate.id === variation.id);
  if (index < 0) return 'that last one';
  return cutIdentity(variation, index).name;
}

/* ── What kind of turn is this? ──────────────────────────────────────────── */

/**
 * Explicit re-roll: the customer wants different pictures, not this one fixed.
 *
 * Kept narrow on purpose. This arm throws away the current set, so it should
 * fire on an unmistakable ask and nothing else — "redo", "start over", "new
 * ones", "new samples". Session 0f6234e9 died on exactly these words, having
 * asked "which one am i fixing?" three times at a customer who had said, in
 * plain English, that they were not fixing one.
 */
const REROLL_PATTERN =
  /\b(?:redo|start over|do ?over|try again)\b|\b(?:new|other|different|more|another|fresh)\s+(?:\w+\s+){0,2}(?:ones?|samples?|takes?|options?|versions?|designs?|cuts?|sets?|batch)\b/i;

/**
 * A direction for the whole piece rather than a change to one cut.
 *
 * "more like an unreal engine 5 look" is not a per-cut fix, and routing it to
 * "which cut?" is how the second failed session ended. The signal is a request
 * about the *look* — a named style, a reference to emulate, an overall feel —
 * with no cut named alongside it.
 */
const WHOLE_PIECE_PATTERN =
  /\b(?:look|style|vibe|feel|aesthetic|energy|mood)\b|\b(?:more|less)\s+like\b|\bin the style of\b|\bkind of\b.*\b(?:like|feel)\b/i;

/**
 * What this post-reveal turn is asking for, in ADR-0056's vocabulary.
 *
 * `reroll-set` carries `styleHint` — the customer's own words when they asked
 * for a direction as well as new pictures. Empty for a bare re-roll. Both are
 * the same outcome (a fresh round under the same Idea); the hint only rides
 * along additively into the round's prompt.
 */
export type CritiqueIntent =
  | { kind: 'commentary' }
  | { kind: 'reroll-set'; styleHint: string }
  | { kind: 'iterate-cut'; target: Variation }
  | { kind: 'ambiguous'; because: 'unplaceable-name' | 'no-cut-named' };

/**
 * The single front door for a post-reveal turn (ADR-0056).
 *
 * ## Why this is a rule table when ADR-0056 rejects rule tables
 *
 * 0056 decides the router is a classifier, not keywords, and it is right: a
 * rule table freezes today's guesses about what customers say, and
 * `CHATTER_PATTERN` already proves the point by failing on "not any particular
 * number". These branches are the sanctioned interim — the router's first
 * routes, hardcoded, so tonight's two dead sessions stop dying while there is
 * still no golden set large enough to grade a classifier against. The golden
 * file beside this code is what that grading will eventually run on. When it
 * is big enough, this function is what gets replaced, and its shape is the
 * point: one place decides, so promoting it is a swap rather than a hunt.
 *
 * ## Order, and why
 *
 * **A cut named by reference outranks everything.** "the third one, give me
 * another version" and "the third one, more like an unreal engine 5 look" are
 * both fixes to cut three. Naming a cut is the narrowest thing a customer can
 * do, and the two readings it outranks are the two that throw the round away.
 *
 * This guard applies to the re-roll branch and not only the whole-piece one,
 * which is the correction review made on this code: re-roll used to
 * short-circuit before any reference check ran, so "the third one, give me
 * another version" spent a credit discarding both cuts — including the one the
 * customer had just named to keep. The re-roll arm is the destructive one, so
 * its guard has to be the strictest in the function rather than the loosest.
 *
 * Only a cut reached by *context* can be re-read as being about the whole
 * piece, which is exactly what `CritiqueTarget.via` exists to tell us.
 *
 * Below that guard, re-roll is checked before whole-piece, and whole-piece
 * before per-cut-by-context. "new ones, more cinematic" is a re-roll carrying
 * a hint, not a whole-piece fix — so among messages that name no cut, the more
 * destructive reading still wins on explicit signal.
 *
 * ## What this changes about money
 *
 * A message like "more like an unreal engine 5 look" used to be heading for a
 * fix-allowance re-cut. Routed as `reroll-set` it becomes a fresh two-cut
 * round — **one generation credit** (ADR-0049), not a fix. That is coherent
 * (new pictures cost a round) but it is a customer-visible change to what this
 * class of message costs, and it is deliberate rather than incidental.
 *
 * ## What `styleHint` is NOT, yet
 *
 * It rides the round's prompt additively and nothing else. No
 * `idea.descriptor.add`, no durable record — there is no Idea object to write
 * one to until the ADR-0055 graph work starts. So a direction given this way
 * survives the round it was given in and no longer; a customer who says
 * "more cinematic" twice is telling us twice. The golden file already encodes
 * the descriptor writes this should eventually produce.
 */
export function classifyCritiqueTurn(
  session: Pick<DesignSession, 'variations' | 'critiqueCuts' | 'pickId'>,
  message: string
): CritiqueIntent {
  const text = (message || '').trim();

  if (!isFixRequest(text)) return { kind: 'commentary' };

  // Resolved FIRST, before either destructive reading gets a look. Both of
  // those throw the round away, so neither may fire on a message that named a
  // cut — and neither may fire on a name we could not place either.
  const target = resolveCritiqueTarget(session, text);

  // Named a cut we could not place. Ask before anything else reads the
  // message: a name we cannot resolve must never be re-read as "throw the set
  // away" just because it also mentioned a style word or a re-roll word.
  if (target.kind === 'missed') {
    return { kind: 'ambiguous', because: 'unplaceable-name' };
  }

  // They named a cut. That is the narrowest reading and it wins outright.
  if (target.kind === 'cut' && target.via === 'reference') {
    return { kind: 'iterate-cut', target: target.variation };
  }

  if (REROLL_PATTERN.test(text)) {
    // The whole message is the hint — the executor folds the customer's own
    // words in additively (ADR-0010), rather than us deciding what they meant.
    return { kind: 'reroll-set', styleHint: WHOLE_PIECE_PATTERN.test(text) ? text : '' };
  }

  if (WHOLE_PIECE_PATTERN.test(text)) return { kind: 'reroll-set', styleHint: text };

  if (target.kind === 'cut') return { kind: 'iterate-cut', target: target.variation };

  return { kind: 'ambiguous', because: 'no-cut-named' };
}

/* ── Is it a fix request? ────────────────────────────────────────────────── */

/**
 * The non-actionable set, deliberately tight. Everything else is a fix
 * request: someone who typed a sentence at a design they dislike meant it,
 * and an over-eager classifier that shrugs at "riku's missing" is exactly the
 * failure this lane exists to end (ADR-0039).
 */
const CHATTER_PATTERN =
  /^\s*(?:ok(?:ay)?|k|cool|nice|sick|sweet|great|love (?:it|these|them)|like (?:it|these|them)|(?:i )?love (?:it|these|them)|yes+|yeah+|yep|yup|sure|thanks?|thank you|ty|thx|hi|hey|hello|yo|lol|haha|wow|damn|perfect|amazing|beautiful|dope|fire)\b[\s!.,…]*$/i;

export function isFixRequest(message: string): boolean {
  const text = (message || '').trim();
  if (!text) return false;
  return !CHATTER_PATTERN.test(text);
}
