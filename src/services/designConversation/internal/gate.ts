/**
 * The proposal gate's user-facing state and the stall rule (#376).
 *
 * A production session sat in stage 'chatting' for four turns with
 * `missingFields: [placement]` on every one of them and `firedRule: none` —
 * the model kept chatting past the one field the proposal cannot fire
 * without, and the customer never saw a render or a reason. Two rules fix
 * that, both deterministic code (ADR-0021: cadence is never model
 * judgment):
 *
 *   1. When the SAME field blocks promotion for STALLED_FIELD_TURNS
 *      consecutive turns, the bot asks for it directly, in voice, and a
 *      short answer on the next turn settles it even if the model's
 *      extraction misses it.
 *   2. The gate state travels to the client as GateState so a stalled
 *      session is visibly stalled — the spoken `line`, never the score or
 *      the rationale (ADR-0012 log-not-speak; revealNarration precedent).
 */

import type { BlockingField, GateState, TurnLog } from '../types';
import type { RecordReadiness } from './confidence';
import {
  STALLED_PLACEMENT_ASK,
  STALLED_PLACEMENT_REASK,
  STALLED_MEANING_ASK,
  STALLED_STYLE_ASK,
  STALLED_PLACEMENT_DETAIL_ASK,
} from './persona';

/**
 * How many consecutive turns the same field may block the proposal before
 * the bot stops chatting past it and asks for it outright. Two: the first
 * blocked turn is ordinary conversation (the model may well be getting
 * there); the second in a row is a stall.
 */
export const STALLED_FIELD_TURNS = 2;

/**
 * Answers this short, given right after a direct ask, are taken as the
 * field — "forearm", "left shoulder blade", "my ribs". Longer replies are
 * conversation and go back through the model's extraction as usual.
 */
export const SHORT_ANSWER_MAX_WORDS = 8;

/** Opening words shared by every detail re-ask, whatever the limb. */
export const STALLED_PLACEMENT_DETAIL_PREFIX = 'where on your ';

/**
 * The placement the re-ask commits to when the customer hands the call
 * back ("you pick", "sure") — the most common first-tattoo canvas, and the
 * one the composite step renders most reliably.
 */
export const DEFAULT_PLACEMENT = 'inner forearm';

/**
 * "Not sure" / "sure, you pick" — a hand-back, never a field value. Matched
 * anywhere inside a SHORT message ("sure, you pick" leads with a yes), so
 * only replies that could have been an answer are read as declining to give
 * one.
 */
const HAND_BACK_PATTERN =
  /\b(not sure|no idea|idk|dunno|i don'?t know|dont know|you (pick|choose|decide|call it)|up to you|whatever( you think)?|surprise me|your call|anywhere)\b/i;

export function isHandBack(message: string): boolean {
  const words = (message || '').trim().split(/\s+/).filter(Boolean);
  return words.length > 0 && words.length <= SHORT_ANSWER_MAX_WORDS && HAND_BACK_PATTERN.test(message);
}

/** Consultant-voice status line per field — what the chat may show. */
const GATE_LINE: Record<BlockingField, string> = {
  placement: 'I still need a placement before I can draw.',
  meaning: 'I still need to know what it shows before I can draw.',
  styleTags: 'I still need a style call before I can draw.',
};

/**
 * The one field holding the proposal back, in the order the gate checks
 * them: placement (the hard downstream dependency), then something to draw,
 * then whichever weak field keeps confidence under the threshold.
 * `undefined` when nothing blocks — the judgment rule can fire.
 */
export function blockingFieldFor(
  readiness: RecordReadiness,
  threshold: number,
  record: { placement?: string; meaning?: string; subject?: string }
): BlockingField | undefined {
  const hasPlacement = Boolean((record.placement ?? '').trim());
  const hasSomethingToDraw = Boolean(
    (record.meaning ?? '').trim() || (record.subject ?? '').trim()
  );
  if (!hasPlacement) return 'placement';
  if (!hasSomethingToDraw) return 'meaning';
  if (readiness.confidence >= threshold) return undefined;
  const weak = readiness.missingFields.find(
    (field): field is BlockingField =>
      field === 'placement' || field === 'meaning' || field === 'styleTags'
  );
  return weak;
}

/**
 * How many turns in a row `field` has blocked, counting this one: 1 plus
 * the run of trailing previous TurnLogs with the same blockingField. A turn
 * that blocked on a different field (or didn't block) ends the run — the
 * count resets when the field changes.
 */
export function consecutiveBlockedTurns(
  field: BlockingField,
  previousTurnLogs: readonly TurnLog[]
): number {
  let count = 1;
  for (let i = previousTurnLogs.length - 1; i >= 0; i -= 1) {
    if (previousTurnLogs[i].blockingField !== field) break;
    count += 1;
  }
  return count;
}

/** The gate state for the client: field, stalled flag, spoken line. */
export function gateStateFor(field: BlockingField, blockedTurns: number): GateState {
  return {
    blocking: field,
    stalled: blockedTurns >= STALLED_FIELD_TURNS,
    line: GATE_LINE[field],
  };
}

/**
 * The direct ask for a stalled field. The first stalled turn asks plainly;
 * if the customer talks past that too, the placement re-ask commits to a
 * default and lets them steer (the Veri pattern from the REA competitor
 * study: state the assumption, keep the customer in control). Placement
 * that is present but vague ("arm") asks for the exact spot instead.
 */
export function stalledFieldAsk(
  field: BlockingField,
  blockedTurns: number,
  record: { placement?: string }
): string {
  const placement = (record.placement ?? '').trim();
  switch (field) {
    case 'placement':
      if (placement) return STALLED_PLACEMENT_DETAIL_ASK(placement);
      return blockedTurns > STALLED_FIELD_TURNS
        ? STALLED_PLACEMENT_REASK
        : STALLED_PLACEMENT_ASK;
    case 'meaning':
      return STALLED_MEANING_ASK;
    case 'styleTags':
      return STALLED_STYLE_ASK;
  }
}

/** Every direct-ask line the engine can have spoken, for answer matching. */
export function isStalledAskFor(field: BlockingField, botText: string): boolean {
  const text = botText.trim();
  if (!text) return false;
  switch (field) {
    case 'placement':
      return (
        text === STALLED_PLACEMENT_ASK ||
        text === STALLED_PLACEMENT_REASK ||
        text.startsWith(STALLED_PLACEMENT_DETAIL_PREFIX)
      );
    case 'meaning':
      return text === STALLED_MEANING_ASK;
    case 'styleTags':
      return text === STALLED_STYLE_ASK;
  }
}

/**
 * A short, declarative reply to a direct ask settles the field with the
 * customer's own words (ADR-0010: their words, verbatim). Questions and
 * long replies are conversation, not an answer.
 */
export function shortAnswerOf(message: string): string | undefined {
  const text = message.trim();
  if (!text || text.includes('?')) return undefined;
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length > SHORT_ANSWER_MAX_WORDS) return undefined;
  return text.replace(/[.!]+$/, '').trim();
}
