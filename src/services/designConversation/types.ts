// Shared contract for the conversational intake (ADR-0019–0022). The
// conversation engine, designSession integration, API routes, and chat UI all
// build against these types — treat this file as frozen; changing it is a
// cross-module contract change, not a local edit.

import type { IntakeRecord } from '../intake/types';

/** One message in the intake conversation. */
export interface ConversationMessage {
  role: 'bot' | 'user';
  text: string;
}

/**
 * Where the conversation stands after a turn (ADR-0020, ADR-0021).
 * 'chatting'  — keep talking.
 * 'proposal'  — bot played back what it heard and asked to generate (turn ~6
 *               by judgment, forced by turn 12 once placement is known — the
 *               forced proposal never fires without a placement; the bot asks
 *               for it directly instead, ADR-0021 amendment).
 * 'handoff'   — turn-20 warm handoff to artists with free consultations;
 *               never framed as a limit.
 */
export type ConversationStage = 'chatting' | 'proposal' | 'handoff';

/**
 * Per-turn audit record — logged from day one so proposal timing can be
 * tuned against real transcripts. Confidence is the engine's readiness
 * score for firing the proposal, not a model logprob.
 */
export interface TurnLog {
  /** 1-based user-turn number. */
  turn: number;
  /** 0–1 readiness score for the intake record as of this turn. */
  confidence: number;
  /** IntakeRecord fields still considered missing/weak. */
  missingFields: string[];
  /** Which cadence rule decided this turn's stage. */
  firedRule:
    | 'judgment'
    | 'turn12-force-proposal'
    | 'turn12-ask-placement'
    | 'turn20-handoff'
    /** The user asked to SEE both poles of a variation axis — that request
     *  IS the proposal trigger (ADR-0012/0020); the reveal spreads the axis. */
    | 'axis-request-proposal'
    /** The user delegated an open style call ("which do you suggest") or
     *  dodged it twice — the bot made the call in-voice and advanced. */
    | 'style-recommendation'
    /** The user asked to skip the questions and just draw while the record
     *  was already generation-sufficient — the visible fast lane (TAT-48,
     *  ADR-0028 readiness); the announce beat still runs (ADR-0020). */
    | 'draw-request-proposal'
    /** The meaning pointed at a person/creator/franchise with nothing
     *  drawable on the record — the single evocation follow-up mined it
     *  for imagery (TAT-51). Asked at most once per session. */
    | 'evocation-question'
    /** The same field blocked the proposal for STALLED_FIELD_TURNS turns in
     *  a row — the bot asked for it directly instead of chatting past it
     *  (#376). */
    | 'stalled-field-ask'
    /** Guess-first intake (spec 17): the first message had something to
     *  draw but could not propose, so the bot stated its assumptions and
     *  proposed at once. The consent tap still gates the render. */
    | 'guess-first-proposal'
    | 'none';
  /**
   * The one field holding the proposal back this turn, if any (#376). The
   * engine reads it off the previous turns to count a stall; absent when
   * the stage is 'proposal'/'handoff' or nothing blocks.
   */
  blockingField?: BlockingField;
  /**
   * The placement the bot assumed and said out loud (spec 17). Carried
   * forward turn to turn until the customer names one, so every later
   * proposal still states it. Absent when the customer gave the placement.
   */
  assumedPlacement?: string;
  /** Model that served the turn (per-session pinned; fallback noted). */
  model: string;
}

/** POST /api/v1/design-session/converse */
export interface ConverseRequest {
  /** Omit to start a new conversation (bot sends the opener). */
  sessionId?: string;
  /** Omit on the opening call. */
  message?: string;
}

export interface ConverseResponse {
  sessionId: string;
  reply: string;
  stage: ConversationStage;
  /** Present when stage is 'proposal': the one-line playback. */
  playback?: string;
  /** Present when stage is 'handoff': URL for the warm handoff CTA. */
  handoffUrl?: string;
  turn: number;
  /** SketchBot's live notepad — the user-meaningful brief so far (TAT-48). */
  notes?: SessionNotes;
  /**
   * Why the proposal has not fired yet, in a form the chat may show (#376).
   * Present only while stage is 'chatting' and a field blocks promotion.
   */
  gate?: GateState;
  /**
   * Present only on the response that CREATED the session (spec 7): the
   * secret this browser sends back to resume an unowned session from
   * /design?ds=. The server keeps only its hash.
   */
  resumeKey?: string;
}

/**
 * The intake fields the proposal gate can hold on. Field names only — the
 * confidence score, the formula, and the cadence rule stay in the TurnLog.
 */
export type BlockingField = 'placement' | 'meaning' | 'styleTags';

/**
 * The gate's user-facing state (#376). HARD RULE, same as SessionNotes: the
 * `line` is consultant copy ("I still need a placement before I can draw"),
 * never the rationale, never a score — ADR-0012's log-not-speak rule, the
 * revealNarration precedent.
 */
export interface GateState {
  /** The field holding the proposal back. */
  blocking: BlockingField;
  /**
   * True once the same field has blocked for STALLED_FIELD_TURNS consecutive
   * turns — the chat shows `line` so a stalled session is visibly stalled.
   */
  stalled: boolean;
  /** The one spoken line for this field. */
  line: string;
}

/**
 * SketchBot's live notepad: the user-meaningful projection of the intake
 * record, rendered beside the chat so a silently-wrong brief is visible
 * immediately (TAT-48).
 *
 * HARD RULE (TAT-47 defect 8, revealNarration precedent): this carries ONLY
 * fields the user would recognize as their own brief. Internal rationale,
 * confidence scores, TurnLogs, and axis telemetry never cross this boundary
 * — they stay on the session record, whitelisted out at the service edge.
 */
export interface SessionNotes {
  /** Body placement as heard (lowercase phrase). Absent until known. */
  placement?: string;
  /**
   * Every named cast member, enumerated one entry each ("Gon (Hunter x
   * Hunter)") — never a truncated pair (TAT-47 defect 6). Falls back to the
   * brief's subject phrase when nothing matched the character database.
   */
  cast: string[];
  /** Human-formatted style read ("fine line + blackwork"). Absent until resolved. */
  style?: string;
  /** The scene/moment in the user's own action words. */
  scene?: string;
  /** What the piece is about, in the user's words. */
  vibe?: string;
  /** True once the IP rule fired — the inspired-by heads-up line renders. */
  ipHeadsUp: boolean;
  /**
   * One designed summary line per analyzed reference image (TAT-50) —
   * "five chibi anime characters, bold outlines, red smoke background".
   * Only ever the vision summary, never the raw analysis structure.
   */
  references?: string[];
  /**
   * The record could already generate (ADR-0028 readiness: placement plus
   * something to draw). Drives the visible fast-lane affordance.
   */
  sufficient: boolean;
}

/**
 * POST /api/v1/design-session/[id]/confirm — the user's yes to the proposal
 * (ADR-0020). Fires generation via the existing reveal pipeline; responds
 * with the revealed DesignSession. A 'no'/correction is just another
 * converse message, not this endpoint.
 */
export interface ConfirmRequest {
  /** Reserved; no fields today. */
  _?: never;
}

/** The engine's per-turn result, consumed by the designSession integration. */
export interface ConversationTurnResult {
  reply: string;
  stage: ConversationStage;
  playback?: string;
  /** Best-so-far structured record; complete enough to generate once stage is 'proposal'. */
  record: Partial<IntakeRecord>;
  turnLog: TurnLog;
  /** The notepad projection of `record` — the ONLY record view the UI gets. */
  notes: SessionNotes;
  /** The proposal gate's user-facing state, when something blocks (#376). */
  gate?: GateState;
}
