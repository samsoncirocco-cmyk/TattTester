// Shared contract for the design-session pipeline (ADR-0012, ADR-0013,
// ADR-0016). The session service, API routes, and reveal UI all build against
// these types — treat this file as frozen; changing it is a cross-module
// contract change, not a local edit.

import type { IntakeRecord, AxisSelection } from '../intake/types';
import type { DesignState } from './internal/designState';

/**
 * A session's lifecycle. Transitions are one-way (ADR-0013 hard stop):
 * intake → revealed → picked → complete. There is no path back from
 * 'complete' and exactly one refinement round between 'picked' and it.
 */
export type SessionPhase = 'intake' | 'revealed' | 'picked' | 'complete';

/** One of a round's two cuts (or the single refined regen). */
export interface Variation {
  id: string;
  /** Questionnaire mode: axis → pole (e.g. {"bold-fine":"bold"}). Compositional mode: {composition: "<treatment>"}. */
  axisPosition: Record<string, string>;
  prompt: string;
  negativePrompt?: string;
  imageUrl?: string;
}

/**
 * One two-cut round of the pick-to-refine loop (ADR-0049). Round 1 is the
 * reveal itself; every later round is charged one generation credit, holds
 * the poles picked so far, and seeds its renders with the previous round's
 * picked image as a reference.
 */
export interface RefineRound {
  /** 1-based round number. */
  round: number;
  /**
   * The axis this round spreads on: a ladder axis ('bold-fine', …),
   * 'composition' for compositional sessions, or 'reroll' past the ladder.
   */
  axis: string;
  /** The two cuts this round produced, in display order. */
  variationIds: string[];
  /** The cut the customer picked. Absent until they tap/reply. */
  pickedId?: string;
  /** When the pick landed (server clock, ISO). */
  pickedAt?: string;
  /**
   * Set the moment the NEXT round is charged — a frozen pick can never
   * change again, because a render already consumed it as a reference.
   */
  frozen?: boolean;
  /**
   * True when this round's renders fell back off the pinned model
   * (ADR-0048): delivered, said out loud, and the round's credit released.
   */
  downgraded?: boolean;
  /** Machine-readable cause from the failed primary (provider error code). */
  downgradeReason?: string;
}

/** One post-reveal critique turn and what it produced (ADR-0039). */
export interface CritiqueTurn {
  /** The user's own words, verbatim. */
  message: string;
  /** SketchBot's reply. */
  reply: string;
  /** Variation the critique was read as being about; absent when none resolved. */
  targetId?: string;
  /** The cut this turn produced; absent when the turn spent nothing. */
  cutId?: string;
  at: string;
}

export interface DesignSession {
  id: string;
  phase: SessionPhase;
  intake: IntakeRecord;
  /**
   * The design's state object (ADR-0060) — roster, composition, palette, the
   * look, the exclusions. Every re-cut renders from the whole of it, so a
   * critique updates a field instead of appending to the last prompt.
   *
   * Optional because sessions revealed before ADR-0060 do not have one; the
   * critique lane derives it from `intake` on first use, so an old session
   * gains a state the moment it needs one rather than being left behind.
   *
   * ADR-0060 calls this "the ADR-0055 Idea made concrete". It sits on the
   * session until the Idea graph exists and it moves up a level.
   */
  state?: DesignState;
  axisSelection: AxisSelection;
  /** Image provider locked for the whole session (ADR-0016). */
  provider: string;
  /**
   * True when the reveal's renders fell back off the model the routing
   * chose (ADR-0048): the cuts are real but came from a weaker lane, so the
   * reveal says so in copy and the round's credit is released. Never set on
   * a session that rendered on its routed model. Additive optional field —
   * existing stored sessions simply lack it.
   */
  downgraded?: boolean;
  /** Machine-readable cause from the failed primary (provider error code). */
  downgradeReason?: string;
  /**
   * Every round's cuts in render order — two per round (ADR-0049). Round 1
   * contributes v1/v2; each refine round appends two more.
   */
  variations: Variation[];
  /**
   * The pick-to-refine rounds, oldest first (ADR-0049). The last entry is
   * the live round; its pick stays changeable until the next round is
   * charged. Absent on sessions revealed before rounds existed.
   */
  rounds?: RefineRound[];
  /**
   * Extra cuts produced by post-reveal critique (ADR-0039). Kept out of
   * `variations` so the rounds stay the axis-divergent takes the pick
   * signal is read against — but pickable all the same, so a critique that
   * lands can be chosen.
   */
  critiqueCuts?: Variation[];
  /** Post-reveal critique turns, oldest first (ADR-0039). */
  critiqueTurns?: CritiqueTurn[];
  /** Fixes spent in the critique lane — the server-side allowance ledger. */
  fixesUsed?: number;
  /** Variation id the user chose. */
  pickId?: string;
  /** Variation id from the most-not-you tap — the one clean negative signal. */
  mostNotYouId?: string;
  /** The single refinement question derived from the pick's axis position. */
  refinementQuestion?: string;
  refinementAnswer?: string;
  /** The one regen (ADR-0013). Present only in phase 'complete'. */
  refinedVariation?: Variation;
  brief?: Brief;
  createdAt: string;
  updatedAt: string;
}

/**
 * The artist-facing deliverable (see CONTEXT.md "Brief"). Travels with the
 * booking; the artist creates the design — the brief informs it.
 */
export interface Brief {
  placement: string;
  styleTags: string[];
  /** Freeform emotional context, verbatim from intake (ADR-0010). */
  meaning: string;
  references: string[];
  finalImageUrl?: string;
  /**
   * Black line art derived from finalImageUrl — the artist's working file,
   * where finalImageUrl is the customer's approved intent. Product-owned
   * like every other session image, because this is the one asset opened at
   * a consult days later. Absent when stencil derivation is off or its
   * render failed; a session without one is diminished, not broken.
   */
  stencilUrl?: string;
  /**
   * Flattened placement-preview screenshot (design composited onto the
   * user's own photo on the /design canvas). Same durability class as
   * finalImageUrl — a signed/CDN URL, not a permanent asset reference.
   */
  placementPreviewUrl?: string;
  axisSelection: AxisSelection;
  /** Subtle placement concerns flagged for the consult (ADR-0014). */
  placementNotes: string[];
  /** The most-not-you variation's axis position — negative preference context. */
  rejectedAxisPosition?: Record<string, string>;
}

/** POST /api/v1/design-session — start: runs intake → council → generation. */
export interface StartSessionRequest {
  placementAnswer: string;
  meaningAnswer: string;
}

/** POST /api/v1/design-session/[id]/pick */
export interface PickRequest {
  pickId: string;
  mostNotYouId: string;
}

/** POST /api/v1/design-session/[id]/refine — allowed exactly once. */
export interface RefineRequest {
  answer: string;
}

/** POST /api/v1/design-session/[id]/round/pick — the round's pick (free). */
export interface RoundPickRequest {
  pickedId: string;
}

/**
 * What one charged refine round hands back (ADR-0049). `downgraded` is what
 * the route refunds on — the round rendered, but off the pinned lane.
 */
export interface RefineRoundResult {
  session: DesignSession;
  /** The round just produced — the session's last rounds entry. */
  round: RefineRound;
  /** True when the round's renders fell back off the pinned model (ADR-0048). */
  downgraded: boolean;
  downgradeReason?: string;
}

/** POST /api/v1/design-session/[id]/critique — one post-reveal turn (ADR-0039). */
export interface CritiqueRequest {
  message: string;
}

/**
 * What one critique turn hands back. `generated` is what the route meters on
 * — a chatter turn or a refused turn costs nothing and records no spend.
 */
export interface CritiqueResult {
  session: DesignSession;
  /** SketchBot's reply, always present. */
  reply: string;
  /** The cut this turn produced, when it produced one. */
  cut?: Variation;
  /**
   * The fresh cuts a reroll-set turn produced (ADR-0056 route → ADR-0049
   * round), in display order. Present only when the turn drew a new round;
   * per-cut fixes keep using `cut`.
   */
  cuts?: Variation[];
  /** The round a reroll-set turn appended — the session's new live round. */
  round?: RefineRound;
  /** Fixes left in this session's allowance. */
  fixesRemaining: number;
  /** True once the allowance is spent — the reply is the artist handoff. */
  exhausted: boolean;
  /** True when a paid render actually ran. */
  generated: boolean;
}
