/**
 * The pick-to-refine round plan (ADR-0049).
 *
 * A round is two cuts spread on ONE axis; the pick chooses a pole, and the
 * next round holds every pole picked so far while spreading on the next
 * axis in the ladder. Beyond the ladder a round re-rolls on the locked
 * poles — the credit meter, not a round cap, is what ends the loop.
 *
 * Pure and dependency-free on purpose: the orchestrator (server) computes
 * the next round from it, and the reveal UI (client) computes the same
 * next-axis copy from it — one ladder, never two.
 */
import type { VariationAxis } from '../intake/types';
import { ROUND_AXIS_LADDER } from '../intake/types';
import type { RefineRound } from './types';

export { ROUND_AXIS_LADDER };

/** Rounds past the ladder: two fresh draws on everything already locked. */
export const REROLL_AXIS = 'reroll';

/** Compositional sessions spread on framing, not a style axis. */
export const COMPOSITION_AXIS = 'composition';

/** The two poles of each ladder axis, in the order the cuts are shown. */
export const ROUND_AXIS_POLES: Record<VariationAxis, [string, string]> = {
  'bold-fine': ['bold', 'fine'],
  'color-blackwork': ['color', 'blackwork'],
  'literal-abstract': ['literal', 'abstract'],
  'minimal-ornate': ['minimal', 'ornate'],
};

/**
 * How each pole reads in round copy — same designed vocabulary as
 * `./cutIdentity`'s POLE_NAME (never the raw internal value).
 */
export const ROUND_POLE_LABEL: Record<string, string> = {
  bold: 'bold',
  fine: 'fine-line',
  color: 'full-color',
  blackwork: 'blackwork',
  literal: 'literal',
  abstract: 'abstract',
  minimal: 'minimal',
  ornate: 'ornate',
};

/**
 * The axis the NEXT round spreads on, given the axes already spread and the
 * axes the brief itself already settled. Compositional sessions stay
 * compositional; questionnaire sessions walk the ladder — skipping any rung
 * an earlier round already asked (round one may lead with an axis the
 * customer explicitly requested) AND any rung the intake resolved
 * (ADR-0049: a blackwork-committed brief must never be charged a credit for
 * a color-blackwork round whose color cut contradicts its own palette
 * clause) — and then re-roll on locked poles. There is no hard cap.
 *
 * `settledAxes` arrives as plain data (compute it with the intake module's
 * settledAxes(record)) so this module stays pure and dependency-free —
 * server and reveal UI keep computing the identical next axis.
 */
export function nextRoundAxis(
  mode: 'questionnaire' | 'compositional',
  priorAxes: readonly string[],
  settledAxes: readonly string[] = []
): string {
  if (mode === 'compositional') return COMPOSITION_AXIS;
  return (
    ROUND_AXIS_LADDER.find(
      axis => !priorAxes.includes(axis) && !settledAxes.includes(axis)
    ) ?? REROLL_AXIS
  );
}

/**
 * How a round's axis is spoken about — "bold vs fine-line", computed from
 * the pole labels, never hardcoded per axis.
 */
export function roundAxisLabel(axis: string): string {
  const poles = ROUND_AXIS_POLES[axis as VariationAxis];
  if (poles) {
    return `${ROUND_POLE_LABEL[poles[0]]} vs ${ROUND_POLE_LABEL[poles[1]]}`;
  }
  if (axis === COMPOSITION_AXIS) return 'two new framings of the locked style';
  return 'a fresh re-roll on everything you locked';
}

/**
 * The post-pick invitation (ADR-0049 acceptance copy). The next-axis name
 * is computed from the ladder; only the sentence frame is fixed.
 */
export function refineInviteLine(
  mode: 'questionnaire' | 'compositional',
  priorAxes: readonly string[],
  settledAxes: readonly string[] = []
): string {
  return `Good eye. Refine it? Next round is ${roundAxisLabel(
    nextRoundAxis(mode, priorAxes, settledAxes)
  )} — 1 credit.`;
}

/** The latest round — the only one whose pick can still change. */
export function currentRound(rounds: RefineRound[] | undefined): RefineRound | undefined {
  return rounds?.[rounds.length - 1];
}

/**
 * The poles locked by every frozen-or-picked round so far, keyed by axis.
 * Read off the picked variation's own axisPosition by the caller — this
 * helper only walks the ladder axes a round can lock.
 */
export function isLadderAxis(axis: string): axis is VariationAxis {
  return (ROUND_AXIS_LADDER as readonly string[]).includes(axis);
}

/**
 * What moved between rounds (spec 10), said before the new pair:
 * "kept: fine-line. now splitting: full-color vs blackwork." The kept part
 * is the pole picked on the previous round's axis; with no pick there (the
 * set was rejected and re-rolled) the line says it is a new set instead.
 * Pure, so the web flow and any later channel speak the same sentence.
 */
export function roundChangeLine(opts: {
  /** Whether the previous round had a pick this round builds on. */
  picked: boolean;
  /** That pick's pole on the previous round's axis, when it was a ladder axis. */
  keptPole?: string;
  /** The axis the new round spreads on. */
  axis: string;
}): string {
  const now =
    isLadderAxis(opts.axis)
      ? `now splitting: ${roundAxisLabel(opts.axis)}.`
      : `now: ${roundAxisLabel(opts.axis)}.`;
  if (!opts.picked) return `changed: new set on the same direction. ${now}`;
  if (!opts.keptPole) return `kept: your pick. ${now}`;
  return `kept: ${ROUND_POLE_LABEL[opts.keptPole] ?? opts.keptPole}. ${now}`;
}
