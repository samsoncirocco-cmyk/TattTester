// Public entry point of the design-session module (ADR-0012, ADR-0013,
// ADR-0016). Everything under internal/ is implementation detail — import
// only from here.
//
// The design session is the reveal + the pick-to-refine loop (ADR-0049):
// intake → two axis-divergent renders on one pinned provider → the pick →
// any number of charged two-cut refine rounds (each seeded by the previous
// pick) → pick + most-not-you tap → one refinement question → one regen →
// the artist Brief. The phase machine is one-way (intake → revealed →
// picked → complete) with a hard stop after the single refinement —
// persistence, provider pinning, question derivation, and placement
// cautions are all private.
import {
  startSession as runStart,
  recordPick as runPick,
  recordRoundPick as runRoundPick,
  refineRound as runRefineRound,
  rerollRound as runRerollRound,
  refine as runRefine,
  critique as runCritique,
  getSession as loadById,
  attachPlacementPreview as runAttachPreview,
} from './internal/orchestrator';
import type { RoundCreditPort } from './internal/orchestrator';
import {
  converse as runConverse,
  confirmProposal as runConfirm,
  attachReference as runAttachReference,
  type AttachReferenceResult,
} from './internal/conversation';
import type { ReferenceAnalysis } from '../vision';
// The public boundary strips internal session state (pinned generation
// route, conversation transcript/TurnLogs) — every function returning a
// session projects it through toDesignSession before it leaves the module,
// so API routes can serialize returns as-is without shipping internals to
// the browser. Internal callers keep the full StoredSession.
import { toDesignSession } from './internal/store';
import type {
  DesignSession,
  StartSessionRequest,
  PickRequest,
  RoundPickRequest,
  RefineRoundResult,
  RefineRequest,
  CritiqueRequest,
  CritiqueResult,
} from './types';
import type { ConverseRequest, ConverseResponse } from '../designConversation/types';

export { DesignSessionError } from './internal/orchestrator';
export type { DesignSessionErrorCode, RoundCreditPort } from './internal/orchestrator';
// The late-bind ownership gate (#338 item 1): stamp on charged actions,
// guard-only on uncharged mutations. Throws SESSION_NOT_FOUND on mismatch.
export { claimSessionOwnership } from './internal/orchestrator';
// Cut identity, for channels that must name cuts back to the user rather
// than render a clickable grid. `allCuts` is the canonical order — the
// rounds' takes followed by anything critique produced — so a number spoken
// over SMS means the same cut the web shows in that position.
export { allCuts, isFixRequest, cutLabel } from './internal/critique';
export type {
  DesignSession,
  SessionPhase,
  Variation,
  RefineRound,
  Brief,
  StartSessionRequest,
  PickRequest,
  RoundPickRequest,
  RefineRoundResult,
  RefineRequest,
  CritiqueRequest,
  CritiqueResult,
  CritiqueTurn,
} from './types';
// The round plan (ADR-0049) is pure and client-safe; re-exported here so
// server callers get it from the module entry like everything else.
export {
  ROUND_AXIS_LADDER,
  ROUND_POLE_LABEL,
  REROLL_AXIS,
  COMPOSITION_AXIS,
  nextRoundAxis,
  roundAxisLabel,
  refineInviteLine,
  currentRound,
  isLadderAxis,
} from './roundPlan';
export type {
  ConverseRequest,
  ConverseResponse,
  ConversationStage,
} from '../designConversation/types';

/**
 * Start a design session from the two intake answers: extraction →
 * Council structured enhancement → round one's two variation renders on
 * ONE image provider resolved once and pinned for the whole session
 * (ADR-0016). Returns the persisted session in phase 'revealed'.
 */
export async function startSession(request: StartSessionRequest): Promise<DesignSession> {
  return toDesignSession(await runStart(request));
}

/**
 * Record the user's pick and most-not-you tap (two distinct variation
 * ids), derive the single refinement question from the picked variation's
 * axis position, and advance to phase 'picked'. Throws DesignSessionError
 * on an unknown session, a wrong phase, or invalid variation ids.
 */
export async function recordPick(sessionId: string, request: PickRequest): Promise<DesignSession> {
  return toDesignSession(await runPick(sessionId, request));
}

/**
 * Record (or change) the live round's pick (ADR-0049). Free — the tap IS
 * the signal — and changeable until the next round is charged, at which
 * point refineRound freezes it. Throws DesignSessionError on an unknown
 * session, a wrong phase, a frozen round, or a cut outside the live round.
 */
export async function recordRoundPick(
  sessionId: string,
  request: RoundPickRequest
): Promise<DesignSession> {
  return toDesignSession(await runRoundPick(sessionId, request));
}

/**
 * One charged refine round (ADR-0049): two new cuts spread on the next
 * unasked ladder axis, holding every pole picked so far, seeded with the
 * picked cut's image plus the customer's own reference photos. The caller
 * (route) owns the credit: reserve before, release on failure or downgrade,
 * and pass the reservation id so it persists inside the round claim —
 * reconcilable if this process dies mid-render. One round at a time per
 * session: a concurrent call throws ROUND_IN_FLIGHT (409) with nothing
 * charged past its own reservation, which the caller then releases. Throws
 * with nothing persisted when the round cannot deliver both cuts.
 */
export async function refineRound(
  sessionId: string,
  opts?: { reservationId?: string }
): Promise<RefineRoundResult> {
  const { session, ...rest } = await runRefineRound(sessionId, opts);
  return { session: toDesignSession(session), ...rest };
}

/**
 * One charged RE-ROLL round: the customer rejected the whole live set
 * ("new ones", "new samples" — session 0f6234e9), so draw two fresh cuts
 * on the SAME axis as the rejected round. No pick is required or recorded
 * on the rejected round — the absence of a pick IS the signal (ADR-0049) —
 * and the new round seeds from the same references the rejected round used
 * (a prior round's frozen pick still leads; the customer's photos persist),
 * never from the rejected cuts. Costs ONE generation credit exactly like
 * refineRound and shares its credit split (route reserves before, releases
 * on failure or downgrade, reservation id rides the round claim), its
 * no-partial-charge rule, and its claim gate — a re-roll while a round is
 * in flight throws ROUND_IN_FLIGHT (409). `hint` is optional customer
 * freetext ("more cinematic") threaded additively into both prompts.
 * Callable from the web round route and the SMS adapter alike.
 */
export async function rerollRound(
  sessionId: string,
  opts?: { reservationId?: string; hint?: string }
): Promise<RefineRoundResult> {
  const { session, ...rest } = await runRerollRound(sessionId, opts);
  return { session: toDesignSession(session), ...rest };
}

/**
 * The one refinement round (ADR-0013 hard stop): adjust the picked
 * prompt from the answer, regenerate a single image on the session's
 * pinned provider, assemble the artist Brief, and close the session at
 * phase 'complete'. Exactly once — any later call throws a
 * DesignSessionError, never a second regen.
 */
export async function refine(sessionId: string, request: RefineRequest): Promise<DesignSession> {
  return toDesignSession(await runRefine(sessionId, request));
}

/**
 * One post-reveal critique turn (ADR-0039): the chat stays open after the
 * cuts land, so plain criticism — "riku's missing", "too busy", "the third one
 * but less color" — re-cuts the design instead of being discarded. Resolves
 * which cut the critique is about, regenerates ONE image on the session's
 * pinned model (ADR-0016), and returns the new cut alongside SketchBot's
 * reply. Bounded by the same env-tunable fix allowance as the Studio
 * (ADR-0038), counted server-side on the session.
 *
 * `generated` tells the route whether a paid render actually ran — a chatter
 * turn, an unresolvable target, and a spent allowance all cost nothing. Throws
 * DesignSessionError INVALID_PHASE outside phases 'revealed' and 'picked';
 * once the Brief exists the ADR-0013 hard stop owns the session.
 */
export async function critique(
  sessionId: string,
  request: CritiqueRequest,
  opts?: { roundCredit?: RoundCreditPort }
): Promise<CritiqueResult> {
  const { session, ...rest } = await runCritique(sessionId, request, opts);
  return { session: toDesignSession(session), ...rest };
}

/** Fetch a session by id. Throws DesignSessionError (SESSION_NOT_FOUND) when absent. */
export async function getSession(sessionId: string): Promise<DesignSession> {
  return toDesignSession(await loadById(sessionId));
}

/**
 * Attach the placement-preview screenshot URL to a completed session's
 * Brief (the /design canvas step). Requires phase 'complete'; re-placing
 * overwrites the previous preview. The Brief carries the URL into the
 * booking record via /api/v1/book.
 */
export async function attachPlacementPreview(
  sessionId: string,
  previewUrl: string
): Promise<DesignSession> {
  return toDesignSession(await runAttachPreview(sessionId, previewUrl));
}

/**
 * One turn of the conversational intake (ADR-0019–0022). Without a
 * sessionId, creates a session at phase 'intake' and returns the bot's
 * opener; with one, runs the user's message through the conversation
 * engine on the session's pinned conversation model. Transcript, partial
 * record, and per-turn TurnLogs are persisted on the session every turn.
 * Throws DesignSessionError CONVERSATION_UNAVAILABLE (503) when every
 * conversation provider is down — callers downgrade to the scripted
 * startSession flow (ADR-0019 degraded mode).
 */
export async function converse(request: ConverseRequest): Promise<ConverseResponse> {
  return runConverse(request);
}

/**
 * The user's yes to the proposal (ADR-0020): requires phase 'intake' with
 * the conversation at stage 'proposal', then fires the existing reveal
 * pipeline (council → pinned route → round one's two renders) over the record the
 * conversation extracted, moving the session to phase 'revealed'. Throws
 * DesignSessionError INVALID_PHASE before the proposal or after the reveal.
 */
export async function confirmProposal(sessionId: string): Promise<DesignSession> {
  return toDesignSession(await runConfirm(sessionId));
}

export type { AttachReferenceResult };

/**
 * Attach an analyzed reference image to a session in conversational intake
 * (TAT-50). Stores the analysis as a reference entry and merges its signals
 * into the working record — style tags toward Council enhancement, a
 * reference line toward the artist Brief, recognized characters through the
 * same inspired-by machinery as text mentions. Returns the notepad
 * projection including the new reference row. Throws DesignSessionError
 * INVALID_PHASE outside conversational intake.
 */
export async function attachReference(
  sessionId: string,
  analysis: ReferenceAnalysis,
  source: 'sms' | 'web',
  imagePath?: string
): Promise<AttachReferenceResult> {
  return runAttachReference(sessionId, analysis, source, imagePath);
}

export { storeReferencePhoto } from './internal/referencePhotos';
