/**
 * Post-hoc review of a finished (or stuck) design session.
 *
 * ## Why this file exists
 *
 * Every test session we run is evidence, and today almost none of it is
 * collected. Somebody drives a session, looks at the cuts, says "yeah that
 * felt off", and the observation dies in a Slack message. Meanwhile the two
 * failures we already know about are both *mechanically detectable* from the
 * document the session left behind:
 *
 *  1. The prompt contract (ADR-0060 / the astronaut-became-an-eagle defect).
 *     The rendered prompt is persisted verbatim on every cut, and the design
 *     state is persisted next to it, so "did the prompt still say what the
 *     state said" can be re-asked long after the render, for free.
 *  2. The zero-render stall (issue #376). A session that takes conversation
 *     turns and then never renders anything at all presents to the customer
 *     as an app that silently does nothing. No image review can catch it:
 *     there is no image. It is a query, not a judgment.
 *
 * This module is the query layer for both. It is pure — no I/O, no provider
 * call, no LLM, and the clock is a parameter rather than a global read —
 * because a review that costs money to run is a review nobody schedules, and
 * BUDGET_MAX_SPEND_CENTS is the live constraint. The judgment layer (does this
 * design look right?) is separate, later work.
 *
 * ## What is genuinely checkable post-hoc, and what is not
 *
 * Verified against the persisted document, not assumed:
 *
 *  - PERSISTED, so check 1 is real: `Variation.prompt` holds the exact string
 *    handed to the provider at every write site — the reveal, each refine
 *    round, the single regen, and the critique re-cut. `session.state` holds
 *    the DesignState the re-cut lane renders from.
 *  - NOT PERSISTED, so check 1 is narrower than a pre-flight check: only the
 *    prompt BODY survives. The request wrapper — model id and aspect ratio
 *    (they live on the session, not the cut), `allowProviderFallback`,
 *    `referenceImages`, and the `screenText` RENDER_TEXT_GUARD flag — is
 *    rebuilt per call by `pinnedRequest()` and is absent from the document.
 *    A cron therefore cannot tell whether a cut was rendered with the
 *    reference images it should have had. That gap is real and is not papered
 *    over here; closing it needs a field added at the write site, which lives
 *    in a file this workstream does not own.
 *  - NOT ALWAYS PRESENT: `session.state` is optional. Sessions revealed before
 *    ADR-0060 have none, and the contract cannot be checked on them at all.
 *    That case is reported as its own finding kind rather than counted as a
 *    clean pass — "we checked and found nothing" and "we could not check" are
 *    different claims, and conflating them is exactly how the roster-only
 *    guard shipped a green light over the eagle.
 *  - LANE-DEPENDENT, and narrower than it first looks. `renderStatePrompt`
 *    has exactly ONE non-test call site in the app: orchestrator.ts's critique
 *    lane. Reveal prompts come from the Council (`structuredMode`), round
 *    prompts from `enhanceRound`, and the refine prompt from
 *    `adjustPromptForAnswer` — all three are intake/Council-authored, so the
 *    state DESCRIBES those renders rather than producing them. Holding them to
 *    the contract is a signal, never a verdict.
 *  - STATE-DRIFT, the one that fabricates numbers if you ignore it.
 *    `session.state` is the LATEST state, not the state that produced any
 *    given cut: the orchestrator overwrites it on every critique turn. So a
 *    session whose critique turned the piece blackwork at 9:11 has four
 *    earlier, perfectly correct cuts that now "violate" a state written after
 *    they were rendered. Only the MOST RECENT critique cut is guaranteed to
 *    have been rendered from the state on the document.
 *
 *    Those two facts together decide the advisory rule, and it is stricter
 *    than "reveal is advisory": a finding is non-advisory ONLY on the last
 *    critique cut. Everything else is advisory. That leaves at most one hard
 *    finding per field per session, which is the honest ceiling on what a
 *    post-hoc sweep can actually prove — and a headline number that is real is
 *    worth more than a big one that buries the real ones in manufactured
 *    noise, which is the reassuring-noise failure this job exists to end.
 */

import type { SessionPhase, Variation } from '../types';
import type { StoredSession } from './store';
import { checkPromptContract, explainViolation } from './promptContract';
import type { PromptContractField } from './promptContract';

/**
 * Which renderer produced a cut. It decides how much a contract violation
 * means, so it travels with every finding rather than being inferred by
 * whoever reads the report.
 */
export type ReviewLane = 'reveal' | 'round' | 'critique' | 'refine';

/** Something the state asserted that the cut's persisted prompt never said. */
export interface PromptContractFinding {
  kind: 'prompt-contract';
  lane: ReviewLane;
  cutId: string;
  field: PromptContractField;
  /** The asserted value, verbatim from the state. */
  value: string;
  /** The exact terms of `value` absent from the prompt as whole words. */
  missing: string[];
  /** Terms the prompt says with the opposite polarity to the state. */
  contradicted: string[];
  /**
   * True unless this cut is the one the current state actually rendered.
   *
   * Only the most recent critique cut clears that bar — see the header's
   * LANE-DEPENDENT and STATE-DRIFT notes. Everything else is being held to a
   * state it either never derived from (reveal, round, refine) or that was
   * overwritten after it rendered (an earlier critique cut). Those findings
   * are worth reading and are not proof of anything.
   */
  advisory: boolean;
  explanation: string;
}

/**
 * The session talked and never drew (issue #376). Not a judgment about
 * quality: a count of conversation turns against a count of images.
 */
export interface ZeroRenderFinding {
  kind: 'zero-render-stall';
  phase: SessionPhase;
  /** User turns the conversation consumed before it went quiet. */
  turnCount: number;
  /** Where the intake conversation stood when it stopped, when recorded. */
  stage?: string;
  /** Cuts recorded on the document — distinct from cuts that produced an image. */
  cutsRecorded: number;
  /**
   * Hours since the session was last written, at review time. The reason this
   * is on the finding: a stall and an abandonment are the same document, and
   * this is the number that lets a reader tell "gave up after two turns" from
   * "kept trying for an hour and never got an image".
   */
  quietForHours: number;
  explanation: string;
}

/**
 * The contract could not be checked at all. Reported instead of silence,
 * because a sweep that quietly skips half the corpus reads as a clean sweep.
 */
export interface ContractNotCheckableFinding {
  kind: 'contract-not-checkable';
  reason: string;
  /** How many prompts went unchecked as a result. */
  cutsRecorded: number;
}

export type SessionReviewFinding =
  | PromptContractFinding
  | ZeroRenderFinding
  | ContractNotCheckableFinding;

export interface SessionReviewReport {
  sessionId: string;
  phase: SessionPhase;
  createdAt: string;
  updatedAt: string;
  /** Cuts on the document, every lane. */
  cutsRecorded: number;
  /** Cuts that actually carry an image URL — the real render count. */
  cutsRendered: number;
  /** User turns the intake conversation consumed, 0 on scripted sessions. */
  turnCount: number;
  findings: SessionReviewFinding[];
}

/** Every cut on a session, tagged with the lane that rendered it. */
function cutsWithLanes(session: StoredSession): { cut: Variation; lane: ReviewLane }[] {
  const rounds = session.rounds ?? [];
  const variations = session.variations ?? [];

  const laneOfVariation = (cut: Variation, index: number): ReviewLane => {
    for (const round of rounds) {
      if (round.variationIds?.includes(cut.id)) return round.round === 1 ? 'reveal' : 'round';
    }
    // Sessions that predate the rounds ledger (ADR-0049) have no round to ask.
    // Their first two cuts ARE the reveal; anything after came from a re-cut.
    return index < 2 ? 'reveal' : 'round';
  };

  return [
    ...variations.map((cut, index) => ({ cut, lane: laneOfVariation(cut, index) })),
    ...(session.critiqueCuts ?? []).map((cut) => ({ cut, lane: 'critique' as ReviewLane })),
    ...(session.refinedVariation ? [{ cut: session.refinedVariation, lane: 'refine' as ReviewLane }] : []),
  ];
}

/**
 * How many user turns this session consumed.
 *
 * `turnCount` is the counter the conversation engine maintains, so it is the
 * primary source; the transcript is the fallback for a session written before
 * the counter, or one whose counter never advanced. Post-reveal critique turns
 * count too — a session that only ever talked, in either lane, and never drew
 * is the shape #376 describes.
 */
function countTurns(session: StoredSession): number {
  const conversation = session.conversation;
  const fromCounter = conversation?.turnCount ?? 0;
  const fromTranscript = (conversation?.transcript ?? []).filter(
    (message) => message.role === 'user'
  ).length;
  return Math.max(fromCounter, fromTranscript) + (session.critiqueTurns ?? []).length;
}

/**
 * How long a session must sit untouched before "no image" is worth reporting.
 *
 * The sweep window is 25 hours wide and includes sessions written minutes ago,
 * so without this a customer who is mid-intake at 10:00 — still typing, the
 * render still ahead of them — is reported as a silent failure. Two hours is
 * well past any live conversation and well short of the sweep window.
 *
 * This does NOT separate a stall from an abandonment; nothing in the document
 * can. A tester who closed the tab during intake looks exactly like an app
 * that never rendered, and pre-launch that is probably the commonest session
 * shape we have. The finding carries `turnCount`, `stage` and `quietForHours`
 * so a reader can make that call; the check itself does not pretend to.
 */
export const STALL_QUIET_HOURS = 2;

export interface ReviewOptions {
  /** Review-time clock, in epoch ms. A parameter so the module stays pure. */
  now?: number;
}

/**
 * The id of the last critique cut, or undefined when the session has none.
 *
 * "Last" is document order, which is append order at the write site, so it is
 * the most recent re-cut — the only one rendered from the state the document
 * now carries.
 */
function lastCritiqueCutId(
  cuts: { cut: Variation; lane: ReviewLane }[]
): string | undefined {
  for (let i = cuts.length - 1; i >= 0; i--) {
    if (cuts[i].lane === 'critique') return cuts[i].cut.id;
  }
  return undefined;
}

/** Hours between an ISO timestamp and `now`, 0 when the stamp is unreadable. */
function hoursSince(iso: string | undefined, now: number): number {
  const at = Date.parse(iso ?? '');
  if (Number.isNaN(at)) return 0;
  return Math.max(0, (now - at) / (60 * 60 * 1000));
}

/**
 * Review one stored session. Pure, deterministic, and cheap enough to run over
 * every session in a sweep window.
 *
 * Returns a report even when there is nothing wrong — the caller decides what
 * to surface, and the zero-finding reports carry the counts that make a clean
 * result meaningful ("0 findings over 6 rendered cuts" says something; "0
 * findings" alone does not).
 */
export function reviewSession(
  session: StoredSession,
  options: ReviewOptions = {}
): SessionReviewReport {
  const cuts = cutsWithLanes(session);
  const cutsRendered = cuts.filter(({ cut }) => Boolean(cut.imageUrl)).length;
  const turnCount = countTurns(session);
  const findings: SessionReviewFinding[] = [];

  // ── Check 1: the prompt contract, re-asked against what was persisted ──
  const state = session.state;
  if (!state && cuts.length > 0) {
    findings.push({
      kind: 'contract-not-checkable',
      reason:
        'Session carries no DesignState (revealed before ADR-0060), so no assertion exists ' +
        'to hold its prompts to. Not a pass — an unchecked session.',
      cutsRecorded: cuts.length,
    });
  } else if (state) {
    // The one cut this state can be held to as evidence rather than as
    // commentary: the last critique re-cut, which is the only render in the
    // session that `renderStatePrompt` produced from the state as it now
    // stands. See the header's STATE-DRIFT note.
    const authoritativeCutId = lastCritiqueCutId(cuts);
    for (const { cut, lane } of cuts) {
      // The persisted prompt IS the string that was sent (verified at every
      // write site), so this is the same check a pre-flight guard would run —
      // minus the request wrapper, which the document does not keep.
      const report = checkPromptContract(state, cut.prompt ?? '');
      for (const violation of report.violations) {
        findings.push({
          kind: 'prompt-contract',
          lane,
          cutId: cut.id,
          field: violation.field,
          value: violation.value,
          missing: violation.missing,
          contradicted: violation.contradicted,
          advisory: cut.id !== authoritativeCutId,
          explanation: explainViolation(violation),
        });
      }
    }
  }

  // ── Check 2: the zero-render stall (#376) ──
  // Quiescence first. A session still being written to is a session in
  // progress, and reporting one as a silent failure is how a monitoring job
  // teaches its readers to ignore it.
  const now = options.now ?? Date.now();
  const quietForHours = hoursSince(session.updatedAt, now);
  if (turnCount > 0 && cutsRendered === 0 && quietForHours >= STALL_QUIET_HOURS) {
    findings.push({
      kind: 'zero-render-stall',
      phase: session.phase,
      turnCount,
      ...(session.conversation?.stage ? { stage: session.conversation.stage } : {}),
      cutsRecorded: cuts.length,
      quietForHours: Math.round(quietForHours * 10) / 10,
      explanation:
        `Session took ${turnCount} conversation turn${turnCount === 1 ? '' : 's'} and produced ` +
        `no rendered image (${cuts.length} cut${cuts.length === 1 ? '' : 's'} recorded, none with ` +
        `an image URL), then went quiet for ${Math.round(quietForHours)}h in phase ` +
        `"${session.phase}". Either the app silently never rendered — the #376 shape — or the ` +
        'customer left mid-conversation; the document cannot tell those apart.',
    });
  }

  return {
    sessionId: session.id,
    phase: session.phase,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    cutsRecorded: cuts.length,
    cutsRendered,
    turnCount,
    findings,
  };
}

/** Aggregate counts over a sweep — the headline a scheduled job reports. */
export interface SessionReviewSummary {
  /**
   * Contract violations on the one cut per session that really did render from
   * the state on the document — the most recent critique re-cut. This is the
   * number worth paging on, and it is deliberately small.
   */
  promptContract: number;
  /**
   * Contract findings on cuts whose prompt the state did NOT produce: the
   * Council-authored reveal, the intake-authored round and refine lanes, and
   * earlier critique cuts made against a state that has since been overwritten.
   * Signal, not defects. Expect a steady background level here — an aspect
   * ratio the reveal lane never writes into the prompt body lands in this
   * bucket on every session that sets one.
   */
  promptContractAdvisory: number;
  zeroRenderStall: number;
  contractNotCheckable: number;
}

export function summarizeReviews(reports: SessionReviewReport[]): SessionReviewSummary {
  const summary: SessionReviewSummary = {
    promptContract: 0,
    promptContractAdvisory: 0,
    zeroRenderStall: 0,
    contractNotCheckable: 0,
  };
  for (const report of reports) {
    for (const finding of report.findings) {
      if (finding.kind === 'prompt-contract') {
        if (finding.advisory) summary.promptContractAdvisory += 1;
        else summary.promptContract += 1;
      } else if (finding.kind === 'zero-render-stall') {
        summary.zeroRenderStall += 1;
      } else {
        summary.contractNotCheckable += 1;
      }
    }
  }
  return summary;
}
