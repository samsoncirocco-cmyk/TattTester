// Shared contract for the SketchBot SMS channel (TAT-49). The webhook route
// and the channel adapter build against these types.

/** One media attachment on an inbound MMS (TAT-50). */
export interface InboundMediaItem {
  /** Twilio media URL (`MediaUrl{N}`) — fetched server-side, never echoed. */
  url: string;
  /** Declared MIME type (`MediaContentType{N}`), lowercase. */
  contentType: string;
}

/** One inbound SMS/MMS, already signature-verified by the webhook route. */
export interface InboundSms {
  /** Sender in E.164 (Twilio's `From`). */
  phone: string;
  /** Message text (Twilio's `Body`), may be empty on media-only MMS. */
  body: string;
  /** MMS attachments, in Twilio's order (TAT-50). */
  media?: InboundMediaItem[];
}

/**
 * What the adapter decided to do with an inbound message. The route renders
 * this as TwiML (and, for a reveal, schedules the async MMS delivery).
 *
 * 'silent'  — say nothing (opted-out sender, empty body). Silence is only
 *             ever used where a reply would itself be the harm; every
 *             guardrail refusal is an in-voice 'reply', never silence.
 * 'reply'   — one SMS-shaped bot turn.
 * 'reveal'  — the user said yes to the proposal and every spend guardrail
 *             passed: reply with `text` (the ack) now, then run
 *             executeReveal() after the response — generation takes minutes,
 *             far beyond Twilio's webhook timeout.
 */
export type InboundOutcome =
  | { kind: 'silent' }
  | { kind: 'reply'; text: string }
  | {
      kind: 'reveal';
      text: string;
      sessionId: string;
      phone: string;
      /** Matches profile.revealArmedAt — executeReveal aborts if superseded. */
      armedAt: string;
    }
  | {
      kind: 'critique';
      text: string;
      sessionId: string;
      phone: string;
      message: string;
      /** Matches profile.revealArmedAt — executeCritique aborts if superseded. */
      armedAt: string;
    }
  | {
      kind: 'refine';
      text: string;
      sessionId: string;
      phone: string;
      answer: string;
      /** Matches profile.revealArmedAt — executeRefine aborts if superseded. */
      armedAt: string;
    }
  | {
      kind: 'refine-round';
      text: string;
      sessionId: string;
      phone: string;
      /** The linked account charged for the round (ADR-0049 metering). */
      uid: string;
      /**
       * The generation credit reserved at arm time — executeRefineRound
       * releases it on failure or downgrade (ADR-0048). Absent in demo mode.
       */
      credit?: {
        id: string;
        source: 'free' | 'paid';
        freeRemaining: number;
        paidRemaining: number;
      };
      /** Matches profile.revealArmedAt — executeRefineRound aborts if superseded. */
      armedAt: string;
    }
  | {
      kind: 'placement';
      text: string;
      sessionId: string;
      phone: string;
      mediaUrl: string;
      contentType: string;
      message: string;
      /** Matches profile.placementArmedAt — executePlacement aborts if superseded. */
      armedAt: string;
    };

/** What executeReveal() hands back for MMS delivery. */
export interface RevealDelivery {
  /** One entry per cut, sent as sequential MMS (see route docs for why). */
  cuts: Array<{ caption: string; mediaUrl: string }>;
  /** Final text turn: the web link into the session (AR/booking). */
  closingText: string;
}

/**
 * Per-phone profile — the identity + taste anchor of the SMS channel
 * (ADR-0022 lane). Keyed by E.164 number; `uid` is set when the number
 * matches a verified-phone Firebase account (existing-user linking) and the
 * guest profile upgrades in place — sessions and reveal history carry over.
 */
export interface SmsProfile {
  phone: string;
  /** Linked Firebase account, when the phone matches a verified user. */
  uid?: string | null;
  /** Twilio STOP honored — never send this number anything. */
  optedOut: boolean;
  /** The design session the conversation is currently threaded onto. */
  activeSessionId?: string | null;
  /**
   * Conversation stage after the last turn. Engine stages ('chatting',
   * 'proposal', 'handoff') plus the channel-owned ones:
   *
   *   'reveal-pending'   — round one's renders in flight; a second yes must not re-fire
   *   'revealed'         — cuts delivered; critique, the A/B pick, and REFINE are live
   *   'round-running'    — a charged REFINE round's two renders in flight (ADR-0049)
   *   'critique-running' — one re-cut in flight
   *   'pick-pending'     — pick captured, awaiting the most-not-you tap
   *   'refine-pending'   — pick recorded, awaiting the refinement answer
   *   'refine-running'   — the final regen in flight
   *   'complete'         — Brief exists; the session is closed (ADR-0013)
   */
  lastStage?: string | null;
  /** When the in-flight render was armed — stale-recovery for the *-running stages. */
  revealArmedAt?: string | null;
  /**
   * When the in-flight placement composite was armed. Separate from
   * revealArmedAt because placement deliberately changes no stage — a
   * critique can render alongside it. Latest photo wins: a newer arm
   * supersedes an older composite still in flight.
   */
  placementArmedAt?: string | null;
  /**
   * The generation-credit reservation charged for the in-flight REFINE
   * round (ADR-0049). Persisted at reserve time — not only in the deferred
   * closure — so a reservation orphaned by a crash between arm and delivery
   * is reconcilable from the profile. Cleared when the round settles.
   */
  pendingCreditReservationId?: string | null;
  /**
   * Variation id chosen at 'revealed', held until the most-not-you tap
   * arrives — recordPick needs both ids at once and refuses a pair that
   * names the same cut twice.
   */
  pendingPickId?: string | null;
  /** Lifetime reveals — drives the account-link gate. */
  totalReveals: number;
  /** Rolling per-day reveal counter (UTC date), reset on date change. */
  dailyReveals: { date: string; count: number };
  /** Every design session this phone has driven — the taste-signal trail. */
  sessionIds: string[];
  createdAt: string;
  updatedAt: string;
}
