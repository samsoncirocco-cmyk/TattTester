/**
 * SketchBot's lines in the critique lane (ADR-0039, ADR-0035 loud register).
 *
 * Same person as the intake bot in `src/services/designConversation` and the
 * Studio's `refineryVoice` — lowercase-comfortable, plain, never corporate.
 * The rules carried over verbatim from both: a refusal is a judgment call or
 * honest capacity, never "limit reached"; nothing happens to the design
 * silently; and the ceiling ends in an artist, never a purchase (ADR-0030).
 *
 * Kept in one place so this copy can be reviewed as copy (ADR-0036) instead of
 * being scattered through the orchestrator.
 */

// The invitation line under the reveal is client-only copy and lives with the
// component that renders it (CRITIQUE_INVITE in DesignSessionFlow) — importing
// this module into the browser bundle would drag the whole service graph in.

/** A critique landed and produced a cut. */
export function fixLandedLine(targetName: string): string {
  return `re-cut ${targetName} with that. have a look.`;
}

/**
 * Which cut the critique is about, when nothing in the message named one and
 * nothing has been picked yet. No render runs on this turn.
 */
export const WHICH_CUT_LINE =
  "which one am i fixing? tap it, or just say the number — 'the third one'.";

/**
 * They named a cut and it did not resolve to exactly one — a name from another
 * round, a number past the end, or a word both cuts answer to.
 *
 * Separate copy from WHICH_CUT_LINE on purpose. "which one am i fixing?" reads
 * as not-listening when the customer just told us, in the vocabulary we taught
 * them. This says we heard a name and could not place it, which is the true
 * thing, and it re-offers the two references that always work.
 */
export const NO_SUCH_CUT_LINE =
  "i'm not sure which one you mean — tap it, or say the number and i'll take it from there.";

/**
 * A fresh set is a charged round (ADR-0049: one credit, one round, two cuts)
 * and one is already rendering — the claim gate serialized this ask behind
 * it so nobody gets double-charged. Honest capacity, never "limit reached";
 * the credit reserved for this turn already went back when this is spoken.
 */
export const ROUND_IN_FLIGHT_LINE = "a round's already running — give it a moment.";

/**
 * The channel could not stand a generation meter behind this turn — an
 * unlinked texter, or a web caller whose bearer carried no uid. Channel-
 * neutral on purpose: both hear the same gate. Every FREE critique arm
 * still works without an account; only the charged fresh set needs one,
 * so the refusal names that and the way through, instead of pretending
 * the ask was unclear (the exact not-listening failure this arm ends).
 */
export const REROLL_NEEDS_ACCOUNT_LINE =
  'fresh cuts need an account so i can meter them — sign in and say the word.';

/**
 * They asked for a look we cannot translate into concrete controls (ADR-0060).
 *
 * A style word pasted verbatim onto the end of a prompt weighs almost nothing
 * — that is why "an unreal engine 5 look" never landed, asked three times.
 * Rather than sell a render of a guess, this says we did not get it and asks
 * for the thing we can actually act on. Free turn: nothing is charged.
 *
 * Register per ADR-0035: honest capacity, not "unsupported style". It names
 * what would help instead of putting the failure on the person paying for it.
 */
export const UNTRANSLATED_LOOK_LINE =
  "i don't want to fake that one — tell me what it should look like and i'll build it: " +
  'flat or 3d, soft or hard light, painted or photographic?';

/**
 * A re-roll landed: two fresh cuts re-asking the same axis the rejected set
 * spread (the axis label comes from the round machinery, never hardcoded).
 * `charged` folds the ADR-0049 price into the delivery — spoken only when a
 * credit was actually consumed, so demo mode and a refunded downgrade never
 * claim money that was not spent.
 */
export function rerollLandedLine(axisLabel: string, charged: boolean): string {
  return `fresh pair's up — same question, two new takes on ${axisLabel}.${
    charged ? ' that was one credit.' : ''
  } tell me which one's closer.`;
}

/**
 * ADR-0048's loud downgrade, spoken in the critique lane: delivered off the
 * pinned lane, said out loud, and the refund is only CLAIMED when the
 * release actually landed — same honesty split as the round route's copy.
 */
export const REROLL_DOWNGRADED_REFUNDED_NOTE =
  'heads up — the backup lane drew these, so that credit is back on your meter.';
export const REROLL_DOWNGRADED_NOTE = 'heads up — the backup lane drew these.';

/** A message that isn't a fix request. Warm, short, and hands the ball back. */
export const CHATTER_LINE = "still here — tell me what's wrong with it and i'll re-cut.";

/** A render came back empty or errored. Honest, not alarming. */
export const FIX_FAILED_LINE =
  "that one didn't come back. say it again and i'll take another run at it.";

/**
 * How many fixes are left, in voice rather than as a meter (ADR-0038's rule,
 * applied one room earlier). Spoken after each fix lands, so the ceiling is
 * never a surprise.
 */
export function fixesLeftLine(remaining: number): string {
  if (remaining <= 0) return ALLOWANCE_SPENT_LINE;
  if (remaining === 1) return "one more re-cut in this one and i'll hand you over.";
  return `${remaining} more re-cuts before i hand you over.`;
}

/**
 * The ceiling. Not a paywall, not silence — the true thing to say is that
 * this is what an artist is for (ADR-0038, ADR-0030).
 */
export const ALLOWANCE_SPENT_LINE =
  "you've been round this a few times now — that's your artist's job, honestly. pick the closest one and they'll close the rest on skin.";
