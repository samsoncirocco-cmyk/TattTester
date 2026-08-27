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
  allCuts,
  cutIdentity,
  messageNamesCut,
  normalizeCutName,
  sessionCutIdentities,
} from '../cutIdentity';
import { currentRound } from '../roundPlan';
import type { DesignSession, PendingCritique, Variation } from '../types';

// The canonical cut order lives beside the names it numbers (see
// `allCuts` in ../cutIdentity) — both channels count from it, and the
// resolver's ordinals have to agree with what they printed.
export { allCuts } from '../cutIdentity';

/* ── Which cut ───────────────────────────────────────────────────────────── */

/**
 * "the third one", "#2", "cut two", "number 4", "the 1st".
 *
 * Runs past four because the numbers a customer is given run past four: SMS
 * captions every image "Cut N of M" over the whole session (`cutCaption` in
 * sketchbotSms/internal/render.ts), and the web numbers its critique grid from
 * `variations.length` up. A texter told "Cut 3 of 3" and then answered "cut 3"
 * used to be told that cut did not exist.
 */
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
  fifth: 5,
  '5th': 5,
  five: 5,
  sixth: 6,
  '6th': 6,
  six: 6,
  seventh: 7,
  '7th': 7,
  seven: 7,
  eighth: 8,
  '8th': 8,
  eight: 8,
};

// The `#` alternative carries no leading \b — `#` is not a word character, so
// a shared \b would never match "#2".
const ORDINAL_PATTERN = new RegExp(
  `(?:\\bthe\\s+|\\bcut\\s+|\\bdesign\\s+|\\bnumber\\s+|\\bno\\.?\\s*|#\\s*)(${Object.keys(ORDINAL_WORDS).join('|')}|\\d{1,2})\\b`,
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
 *   5. the cut tapped in the LIVE round — the one wearing YOUR PICK
 *   6. the session's pick, once LOCK IT IN has been pressed
 *
 * 1–3 are the allowlist, and they are exact matches on normalized text: no
 * stemming, no edit distance, no semantics. A reference that misses is not
 * retried more loosely — it is handed back as a question, because the cheapest
 * possible outcome of an unresolved name is asking, and the most expensive is
 * rendering the wrong design.
 */
export function resolveCritiqueTarget(
  session: Pick<DesignSession, 'variations' | 'critiqueCuts' | 'pickId' | 'rounds'>,
  message: string
): CritiqueTarget {
  const text = (message || '').trim();

  // An ordinal is an unambiguous reference. Out of range is still a reference —
  // "the fourth one" against a two-cut round is a miss to ask about, never a
  // reason to fall through to something they did not name.
  //
  // Counted over `allCuts`, which is the ONE order both channels number from:
  // SMS captions each image "Cut N of M" across the whole session and the web
  // grid numbers its re-cuts from `variations.length` up. Counting the reveal
  // cuts only meant a texter who was told "Cut 3 of 3" and answered "cut 3"
  // was told that cut did not exist — the product denying a number it had just
  // printed, which is the "the totem" failure wearing different clothes.
  const ordinal = text.match(ORDINAL_PATTERN);
  if (ordinal) {
    const token = ordinal[1].toLowerCase();
    const index = (ORDINAL_WORDS[token] ?? Number(token)) - 1;
    const cuts = allCuts(session);
    if (index >= 0 && index < cuts.length) {
      return { kind: 'cut', variation: cuts[index], via: 'reference' };
    }
    return { kind: 'missed' };
  }

  // The names the customer was actually shown, matched against the same table
  // the grid rendered from. Two cuts sharing a name is a miss, not a coin flip.
  const named = sessionCutIdentities(session).filter(({ identity }) =>
    messageNamesCut(text, identity.name)
  );
  // …except when one of those names CONTAINS another. "the bold one, take 2"
  // carries "the bold one" inside it, so a take always matches its own base as
  // well, and treating that as a tie would make every take name a miss — the
  // take names would be unusable the day they shipped. The longest match is
  // the most specific one the customer could have typed, which is the same
  // rule the pole-word block below already keeps: more words can only narrow.
  // A genuine tie (two different names, same length, both matched) still asks.
  const longest = Math.max(0, ...named.map(({ identity }) => identity.name.length));
  const mostSpecific = named.filter(({ identity }) => identity.name.length === longest);
  if (mostSpecific.length === 1) {
    return { kind: 'cut', variation: mostSpecific[0].variation, via: 'reference' };
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
    // Reveal cuts only, deliberately. A re-cut copies its target's poles — it
    // is the same treatment, one take later — so widening this to `allCuts`
    // would make "the bold one" ambiguous the moment a bold cut was re-cut,
    // and turn a working reference into a question. Takes are separated by
    // NAME ("the bold one, take 2"), which is checked above and is exact.
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

  // The cut wearing YOUR PICK right now (ADR-0049). `session.pickId` is only
  // written by LOCK IT IN; a tap on a cut records the LIVE ROUND's pick, and
  // that is the badge the customer can see on their screen. Reading only the
  // locked-in pick is why the astronaut session asked "which one am i fixing?"
  // at a customer who had visibly just answered that question with their
  // thumb — the badge and the resolver disagreed about what a pick was.
  //
  // Ranked below the newest re-cut (a fix in progress is the closer context)
  // and above the locked-in pick (a later tap is a fresher signal than an
  // older lock).
  const roundPickId = currentRound(session.rounds)?.pickedId;
  if (roundPickId) {
    const tapped = allCuts(session).find((variation) => variation.id === roundPickId);
    if (tapped) return { kind: 'cut', variation: tapped, via: 'context' };
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
  session: Pick<DesignSession, 'variations' | 'critiqueCuts'>,
  variation: Variation
): string {
  // Over `allCuts`, so a re-cut has a name here too. It used to search the
  // reveal cuts alone, so every critique cut fell through to "that last one" —
  // the reply speaking a vocabulary the grid did not have and the resolver
  // could not accept, which is exactly what this module's header says was
  // fixed. "that last one" survives only for a cut that is genuinely not in
  // the session (a refined regen), where there is no name to speak.
  const cuts = allCuts(session);
  const index = cuts.findIndex((candidate) => candidate.id === variation.id);
  if (index < 0) return 'that last one';
  return cutIdentity(variation, index).name;
}

/* ── A critique waiting on "which one?" ──────────────────────────────────── */

/**
 * How long an unanswered "which one am i fixing?" keeps the sentence that
 * caused it.
 *
 * A session sits open for days; a critique lane turn is a conversation. Thirty
 * minutes is the outer edge of "they went to find a photo and came back" and
 * well inside "they opened this again tomorrow with something else in mind".
 * The turn-index bound below is the real fence — this one exists so a stashed
 * sentence cannot sit on a session indefinitely waiting for an unrelated turn
 * that happens to land in the right slot (an SMS turn superseded mid-flight
 * never records a turn at all, so the index alone would hold it forever).
 */
export const PENDING_CRITIQUE_TTL_MS = 30 * 60 * 1000;

/**
 * How many unanswered sentences a session holds. Matches designState's
 * `MAX_DIRECTIVES` in spirit: past three, the oldest is not what this re-cut
 * is about any more.
 */
export const MAX_PENDING_CRITIQUES = 3;

/**
 * Stash the critique we could not place, bound to the turn that must answer it.
 *
 * `turnIndex` is the position the ANSWERING turn will occupy — i.e. the number
 * of turns recorded once the asking turn has settled. Only a turn landing at
 * exactly that index may inherit these words.
 */
export function stashPendingCritique(
  messages: readonly string[],
  turnsAfterAsking: number,
  askedAt: string
): PendingCritique {
  const kept = messages
    .map((entry) => entry.trim())
    .filter((entry, index, all) => entry && all.indexOf(entry) === index)
    .slice(-MAX_PENDING_CRITIQUES);
  return { messages: kept, turnIndex: turnsAfterAsking, askedAt };
}

/**
 * The pending critique this turn is allowed to apply, if any.
 *
 * Two fences, both explicit: the turn now being recorded must be the one the
 * ask was waiting for, and the ask must not have gone cold. Everything else —
 * a re-roll in between, a superseded SMS turn, a session picked up tomorrow —
 * fails one of them and the words are dropped rather than pasted into a render
 * the customer was not talking about.
 */
export function readPendingCritique(
  session: Pick<DesignSession, 'critiqueTurns' | 'pendingCritique'>,
  now: number = Date.now()
): string[] {
  const pending = session.pendingCritique;
  if (!pending?.messages?.length) return [];
  if ((session.critiqueTurns?.length ?? 0) !== pending.turnIndex) return [];
  const askedAt = Date.parse(pending.askedAt);
  if (!Number.isFinite(askedAt) || now - askedAt > PENDING_CRITIQUE_TTL_MS) return [];
  return [...pending.messages];
}

/** Words that carry no request of their own once the cut reference is gone. */
const FILLER_WORDS = new Set([
  'a', 'an', 'and', 'the', 'that', 'this', 'those', 'these', 'it', 'its',
  'one', 'ones', 'cut', 'design', 'number', 'no', 'take', 'is', 'was', 'be',
  'please', 'pls', 'ok', 'okay', 'yeah', 'yes', 'yep', 'yup', 'sure', 'thanks',
  'thanks!', 'thx', 'i', 'im', 'mean', 'meant', 'want', 'wanted', 'lets', 'let',
  'go', 'with', 'do', 'my', 'me', 'you',
]);

/** "the bold one", "the fine-line, full-color one", "that one". */
const CUT_REFERENCE_PHRASE = /\b(?:the|that|this)\s+(?:[a-z-]+\s+){0,4}ones?\b/gi;

/**
 * Does this answer to "which one am i fixing?" ask for anything, once the cut
 * reference is taken out of it?
 *
 * "The bold one" does not: it is an address. Rendering an address is the
 * astronaut session's defect in one line — a customer paid for a picture of
 * the words "The bold one" while the sentence they had written went nowhere.
 * So a bare address contributes nothing to the design, and the held sentence
 * is the whole critique.
 *
 * "the bold one, and lose the background" does: that customer said two things
 * and both are theirs, so both are applied — separately and whole (ADR-0010),
 * never glued into one sentence, because the state object reads each message
 * as a description of the design and one message that says two things resolves
 * to one field.
 *
 * `referenceLabel` is the designed name the answer resolved to, stripped
 * before the check so a customer who TYPES the label gets the same result as
 * one who taps it.
 */
export function answerAddsRequest(answer: string, referenceLabel?: string): boolean {
  let residue = normalizeCutName(answer);
  if (!residue) return false;
  if (referenceLabel) {
    const label = normalizeCutName(referenceLabel);
    if (label) residue = residue.split(label).join(' ');
  }
  return residue
    .replace(CUT_REFERENCE_PHRASE, ' ')
    .replace(ORDINAL_PATTERN, ' ')
    .split(/\s+/)
    .some((word) => word && !FILLER_WORDS.has(word) && !/^\d+$/.test(word));
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
 * The render came back as something else entirely, and the customer is saying
 * so (astronaut session, 2026-08-26).
 *
 * "what happened to my astonaught this is a laadys back and an eagle" was read
 * as a brief and rendered: `Customer direction: "what happened to my
 * astonaught this is a laadys back and an eagle"` — the customer's DESCRIPTION
 * OF THE WRONG OUTPUT became the desired output, and the second render was a
 * second lady's back with an eagle. They paid for both.
 *
 * The signal is a report about the picture rather than a request for one: a
 * missing subject ("what happened to my X", "where'd my X go") or a naming of
 * what arrived instead ("this is a X", "that's not what i asked for").
 *
 * Deliberately narrow. "this is too busy" carries no article and does not
 * match; neither does "this is better". A false positive here costs a re-cut
 * that ignores one sentence, which is the same cost the old behavior paid on
 * EVERY sentence of this shape — but it is still a cost, so the pattern asks
 * for the two shapes we have actually seen and no more.
 */
const WRONG_RENDER_PATTERN =
  /\bwhat happened to (?:my|the|our)\b|\bwhere(?:'?s| is| did| have)\b[^.?!]{0,40}\b(?:go|gone|went)\b|\bthis (?:is|looks like)\s+(?:a|an|some)\b|\bthat(?:'?s| is)\s+(?:a|an|some)\b|\bthis (?:is ?n'?t|isn'?t|ain'?t)\b|\bnot what i (?:asked|wanted|said|meant)\b|\bthat(?:'?s| is) not (?:my|the|what)\b|\bwrong (?:subject|design|image|picture|person)\b/i;

/**
 * What this post-reveal turn is asking for, in ADR-0056's vocabulary.
 *
 * `reroll-set` carries `styleHint` — the customer's own words when they asked
 * for a direction as well as new pictures. Empty for a bare re-roll. Both are
 * the same outcome (a fresh round under the same Idea); the hint only rides
 * along additively into the round's prompt.
 *
 * `iterate-cut` carries a `reading`, because two very different turns land on
 * the same cut: `apply` folds the customer's words into the design, and
 * `regenerate` renders the state again WITHOUT them (ADR-0060 — "regenerate
 * from state, the state is already right").
 */
export type CritiqueIntent =
  | { kind: 'commentary' }
  | { kind: 'reroll-set'; styleHint: string }
  | { kind: 'iterate-cut'; target: Variation; reading: 'apply' | 'regenerate' }
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
 * Between that guard and the destructive readings sits the wrong-render arm:
 * a customer saying the picture came back as something else has told us about
 * THIS cut, not asked for a different one, so it must be read before "throw
 * the set away" gets a look at the same sentence.
 *
 * Below that, re-roll is checked before whole-piece, and whole-piece
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
  session: Pick<DesignSession, 'variations' | 'critiqueCuts' | 'pickId' | 'rounds'>,
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
    return { kind: 'iterate-cut', target: target.variation, reading: readingFor(text) };
  }

  // "what happened to my astronaut, this is a lady's back and an eagle" is a
  // report about the cut on screen, so it is a fix to THAT cut — checked here,
  // ahead of the two readings that throw the round away, because a customer
  // telling us the render is wrong has not asked for a different design. It is
  // the same design, again, from the state that still describes it.
  if (target.kind === 'cut' && WRONG_RENDER_PATTERN.test(text)) {
    return { kind: 'iterate-cut', target: target.variation, reading: 'regenerate' };
  }

  if (REROLL_PATTERN.test(text)) {
    // The whole message is the hint — the executor folds the customer's own
    // words in additively (ADR-0010), rather than us deciding what they meant.
    return { kind: 'reroll-set', styleHint: WHOLE_PIECE_PATTERN.test(text) ? text : '' };
  }

  if (WHOLE_PIECE_PATTERN.test(text)) return { kind: 'reroll-set', styleHint: text };

  if (target.kind === 'cut') {
    return { kind: 'iterate-cut', target: target.variation, reading: readingFor(text) };
  }

  return { kind: 'ambiguous', because: 'no-cut-named' };
}

/**
 * Is this turn a direction to apply, or a report that the render came back
 * wrong?
 *
 * ## Why this decision lives here and not in the cue table
 *
 * `DIRECTIVE_CUES` in ./designState.ts has a "missing / left out / forgot" cue
 * that produces exactly the right directive for this complaint, and it would
 * be one regex to teach it "what happened to my X". That would not fix this.
 * `asDirective` returns `${their words} — apply this as: ${directive}`, so the
 * customer's description of the WRONG image still lands in the prompt as
 * Customer direction, still at the front where the lane weights it hardest.
 * The cue table decides what a direction MEANS; it cannot decide that a
 * sentence is not a direction at all. That is a routing question, so it is
 * answered at the routing layer — here, once, before the state is touched.
 */
function readingFor(text: string): 'apply' | 'regenerate' {
  return WRONG_RENDER_PATTERN.test(text) ? 'regenerate' : 'apply';
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
