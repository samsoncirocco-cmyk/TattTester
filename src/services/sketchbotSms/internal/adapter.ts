/**
 * SMS ↔ conversation-engine channel adapter (TAT-49).
 *
 * Maps inbound texts onto the EXISTING design-session machinery — the same
 * brain as the web chat, consumed only via '@/services/designSession''s
 * public entry — with the SMS channel's own identity (phone → profile),
 * rendering (render.ts), and the REQUIRED spend guardrails:
 *
 *   1. per-phone daily reveal cap   SKETCHBOT_SMS_REVEALS_PER_DAY (2/day)
 *      — consumed ATOMICALLY before generation (profileStore.tryConsumeReveal)
 *   2. account-link gate            SKETCHBOT_SMS_FREE_REVEALS (2 lifetime)
 *      — an unlinked number can never pass this many reveals, ever
 *   3. global budget                checkBudget/recordSpend, the exact same
 *      BUDGET_MAX_SPEND_CENTS pool and cost constants as /api/v1/generate
 *   4. per-phone message rate limit — enforced by the webhook route
 *      ('sms-inbound' in src/lib/rate-limit.ts)
 *
 * Every refusal is an in-voice SMS reply (honest capacity, a judgment call,
 * an invitation) — never an HTTP status nobody reads and never silence.
 *
 * Worst case for an unknown number per UTC day:
 *   min(SKETCHBOT_SMS_REVEALS_PER_DAY, remaining free reveals) × 2 images
 *   × per-image cost — with the defaults, 2 × 2 × VERTEX_IMAGEN_COST_CENTS
 *   = 16¢, and never more than 2 reveals lifetime without an account.
 *   Charged REFINE rounds (ADR-0049) require a LINKED account: they meter
 *   generation credits, and a number with no account has none to spend.
 */
import { randomUUID } from 'crypto';
import { logger } from '@/lib/logger';
import {
  checkBudget,
  recordConversationTurnSpend,
} from '@/lib/budget-tracker';
// Image spend for the SMS reveal is recorded by the designSession service
// itself (confirmProposal), from the same pool and the same per-provider
// constants as the web reveal — this channel must not add a second charge.
import { resolveSharedDesignStore, type SharedDesign } from '@/lib/shared-design-store';
import {
  converse,
  confirmProposal,
  attachReference,
  storeReferencePhoto,
  getSession,
  recordPick,
  recordRoundPick,
  refineRound,
  refine,
  critique,
  allCuts,
  isFixRequest,
  attachPlacementPreview,
  isLadderAxis,
  ROUND_POLE_LABEL,
  DesignSessionError,
} from '@/services/designSession';
import type { DesignSession, RefineRound } from '@/services/designSession';
// The charged round's credit primitive (ADR-0041 / ADR-0049): reserved at
// arm time so exhaustion is told immediately, released by the deferred
// execute on failure or downgrade.
import {
  GenerationCreditsExhaustedError,
  releaseGenerationCredit,
  reserveGenerationCredit,
  type GenerationCreditReservation,
} from '@/lib/generation-credits';
// The cut-naming vocabulary — the SMS round text names poles exactly the
// way the web reveal does ("A is bold, B is fine-line").
import { cutIdentity } from '@/services/designSession/cutIdentity';
import {
  referenceFollowUpText,
  REFERENCE_UNREADABLE_TEXT,
  REFERENCE_BUDGET_TEXT,
  type ReferenceAnalysis,
} from '@/services/vision';
// One yes-vocabulary for every channel: the same deterministic gate the web
// chat uses to decide "advance to confirm vs. keep talking". A drifted SMS
// copy of this list is a real bug class — a phrase that reveals on the web
// but argues over SMS.
import { isConfirmationIntent } from '@/features/design-session/services/confirmationIntent';
// The pick vocabulary. `isBarePickReference` is the SMS-only half: the web
// never needs it because there a pick is a click, not a sentence.
import {
  parsePickIntent,
  isBarePickReference,
} from '@/features/design-session/services/pickIntent';
import type {
  InboundSms,
  InboundOutcome,
  InboundMediaItem,
  RevealDelivery,
  SmsProfile,
} from '../types';
import { resolveProfileStore, newProfile } from './profileStore';
import { analyzeInboundMedia, fetchTwilioMedia, type MediaIngest } from './media';
import { compositeOnBody, widthFractionFor } from './placement';
import {
  renderSmsReply,
  REVEAL_ACK,
  BUDGET_EXHAUSTED_TEXT,
  REVEAL_FAILED_TEXT,
  capReachedText,
  linkGateText,
  unavailableText,
  roundRevealText,
  roundCutCaption,
  roundUnpickedText,
  bookText,
  ROUND_ACK,
  ROUND_LOCKED_TEXT,
  ROUND_FAILED_TEXT,
  ROUND_FAILED_NO_REFUND_TEXT,
  cutCaption,
  referenceAckText,
  pickRetryText,
  mostNotYouQuestion,
  pickCollisionText,
  chatterAckText,
  CRITIQUE_ACK,
  CRITIQUE_FAILED_TEXT,
  REFINE_ACK,
  REFINE_FAILED_TEXT,
  REFINED_CAPTION,
  STENCIL_CAPTION,
  refinedClosingText,
  PLACEMENT_ACK,
  PLACEMENT_CAPTION,
  PLACEMENT_DONE_TEXT,
  PLACEMENT_FAILED_TEXT,
  PLACEMENT_UNREADABLE_TEXT,
  PLACEMENT_UNUSABLE_DESIGN_TEXT,
  PLACEMENT_NO_DESIGN_TEXT,
} from './render';

/** After this long, an unreported in-flight render is presumed dead. */
const REVEAL_PENDING_STALE_MS = 10 * 60 * 1000;

/**
 * Stages where a paid render is already running. A second text must never
 * re-fire one; it waits, or — past the stale window — falls back to the
 * stage that armed it so the texter can try again.
 */
const IN_FLIGHT_STAGES: Record<string, { waiting: string; recoverTo: string }> = {
  'reveal-pending': {
    waiting: 'Still sketching — your two cuts land here in a minute or two.',
    recoverTo: 'proposal',
  },
  'round-running': {
    waiting: 'Still cutting the next round — two new cuts land here shortly.',
    recoverTo: 'revealed',
  },
  'critique-running': {
    waiting: "On it — the new cut lands here shortly.",
    recoverTo: 'revealed',
  },
  'refine-running': {
    waiting: 'Still reworking it — the new one lands here shortly.',
    recoverTo: 'refine-pending',
  },
};

/** Per-phone reveal cap per UTC day. REQUIRED guardrail, env-tunable. */
export function revealsPerDay(): number {
  return Number(process.env.SKETCHBOT_SMS_REVEALS_PER_DAY) || 2;
}

/** Lifetime reveals before an unlinked number hits the account-link gate. */
export function freeReveals(): number {
  return Number(process.env.SKETCHBOT_SMS_FREE_REVEALS) || 2;
}

/**
 * Public base for links texted to users. tatttester.com is the brand domain
 * (ADR-0004) — a localhost fallback in an SMS would be a dead link, so the
 * fallback is the public site, and NEXT_PUBLIC_APP_URL overrides per env.
 */
function appBaseUrl(): string {
  return (
    process.env.NEXT_PUBLIC_APP_URL ||
    process.env.NEXT_PUBLIC_BASE_URL ||
    'https://tatttester.com'
  ).replace(/\/$/, '');
}

function isDemoMode(): boolean {
  return process.env.NEXT_PUBLIC_DEMO_MODE === 'true';
}

/** Last 4 digits — enough to correlate log lines, never a full number. */
function phoneLast4(phone: string): string {
  return phone.slice(-4);
}

/**
 * Existing-user linking: a Firebase account whose VERIFIED phone matches
 * the texter upgrades the guest profile in place. Best-effort — no account
 * (or no Admin creds) just means the profile stays phone-first guest.
 */
async function lookupUidByPhone(phone: string): Promise<string | null> {
  try {
    // getAuth() throws on an uninitialized app (creds-less dev) — that and
    // "no user with this phone" both land in the catch: guest profile.
    const { getAuth } = await import('firebase-admin/auth');
    const user = await getAuth().getUserByPhoneNumber(phone);
    return user.uid;
  } catch {
    return null;
  }
}

async function loadOrCreateProfile(phone: string): Promise<SmsProfile> {
  const store = resolveProfileStore();
  const existing = await store.get(phone);
  if (existing) return existing;
  const profile = newProfile(phone);
  // First contact: check for an existing account with this verified phone.
  profile.uid = await lookupUidByPhone(phone);
  await store.save(profile);
  logger.info({
    event_type: 'sketchbot_sms.profile_created',
    phone_last4: phoneLast4(phone),
    linked: !!profile.uid,
  });
  return profile;
}

/**
 * Twilio opt-out bookkeeping. Twilio's advanced opt-out already sent the
 * compliance auto-reply before we see the message — this only records the
 * state so no code path (especially the async reveal MMS) ever messages an
 * opted-out number again. START re-opens; HELP changes nothing.
 */
export async function recordOptOut(phone: string, optOutType: string): Promise<void> {
  const type = optOutType.toUpperCase();
  if (type !== 'STOP' && type !== 'START') return;
  const store = resolveProfileStore();
  const profile = (await store.get(phone)) ?? newProfile(phone);
  profile.optedOut = type === 'STOP';
  profile.updatedAt = new Date().toISOString();
  await store.save(profile);
  logger.info({
    event_type: 'sketchbot_sms.opt_out_recorded',
    phone_last4: phoneLast4(phone),
    opt_out_type: type,
  });
}

/** True when this number must never be messaged (STOP on record). */
export async function isOptedOut(phone: string): Promise<boolean> {
  const profile = await resolveProfileStore().get(phone);
  return profile?.optedOut === true;
}

/**
 * One inbound message → one outcome. Everything synchronous happens here
 * (conversation turn, guardrail checks); only image generation is deferred
 * to executeReveal because it outlives Twilio's webhook timeout.
 */
export async function handleInbound(inbound: InboundSms): Promise<InboundOutcome> {
  const phone = inbound.phone.trim();
  const body = inbound.body.trim();
  const media = inbound.media ?? [];
  const store = resolveProfileStore();
  const profile = await loadOrCreateProfile(phone);

  // Belt and braces with the route's OptOutType screen: an opted-out number
  // gets nothing, ever. Twilio suppresses our sends too (error 21610).
  if (profile.optedOut) return { kind: 'silent' };

  if (!body && media.length === 0) {
    // An empty ping with nothing attached — the engine needs words.
    return {
      kind: 'reply',
      text: 'Tell me in words first — what are you thinking, and where on your body would it go?',
    };
  }

  // ── Renders in flight: never double-fire on an impatient second yes ──
  // Media sent mid-render is deliberately NOT analyzed: no vision spend on
  // a message that cannot attach to anything yet.
  const inFlight = IN_FLIGHT_STAGES[profile.lastStage ?? ''];
  if (inFlight) {
    const armedAtMs = Date.parse(profile.revealArmedAt ?? '') || 0;
    if (Date.now() - armedAtMs < REVEAL_PENDING_STALE_MS) {
      return { kind: 'reply', text: inFlight.waiting };
    }
    // The in-flight render died without reporting (crashed instance). Any
    // reserved slot was refunded only if the failure path ran, so recover to
    // the stage that armed it: a fresh answer re-runs every guardrail.
    profile.lastStage = inFlight.recoverTo;
    profile.revealArmedAt = null;
    await store.save(profile);
  }

  // ── A photo AFTER the reveal is the texter's own body ────────────────
  // Before the reveal a picture is inspiration; after it, the only picture
  // worth sending is where the tattoo would go. Checked before the vision
  // analyzer so a body photo never spends analysis budget being read as a
  // reference — and never lands in the Brief as one.
  if (
    media.length > 0 &&
    profile.activeSessionId &&
    PLACEMENT_STAGES.has(profile.lastStage ?? '')
  ) {
    return armPlacement(profile, store, media[0], body);
  }

  // ── Reference photos (TAT-50): fetch → vision → attach, before routing ──
  // Vision spends from the global budget inside the analyzer; nothing here
  // touches the reveal caps. The ack names what was seen — SketchBot never
  // silently ingests an image.
  let ingest: MediaIngest | null = null;
  let ackText = '';
  if (media.length > 0) {
    ingest = await analyzeInboundMedia(media);
    ackText = await attachAnalyses(profile, store, ingest);
  }

  if (!body) {
    // Media-only MMS: the ack (or the honest failure line) IS the turn,
    // plus the one most useful follow-up when something was read.
    const followUp =
      ingest && ingest.analyses.length > 0
        ? referenceFollowUpText(ingest.analyses[0].analysis)
        : '';
    return {
      kind: 'reply',
      text: renderSmsReply([ackText, followUp].filter(Boolean).join(' ')),
    };
  }

  // ── The yes to a proposal: arm the reveal, guardrails first ──────────
  // Any references were attached above, so the confirm-time merge already
  // carries them into Council enhancement and the Brief.
  if (
    profile.activeSessionId &&
    profile.lastStage === 'proposal' &&
    isConfirmationIntent(body)
  ) {
    return withReferenceAck(await armReveal(profile, store), ackText);
  }

  // ── The refinement answer: the last paid step, and the only one that
  // reaches phase 'complete' — where the Brief an artist reads is built.
  // Free text, not an ordinal: whatever they'd change IS the answer.
  // Restart still wins first — the closing reveal copy invites "start over",
  // and charging a refine on an abandoned design is real spend.
  if (profile.activeSessionId && profile.lastStage === 'refine-pending') {
    if (RESTART_INTENT.test(body)) {
      return withReferenceAck(await restartDesign(profile, store, body), ackText);
    }
    return withReferenceAck(await armRefine(profile, store, body), ackText);
  }

  // ── Life after the reveal: critique, then the pick ───────────────────
  if (profile.activeSessionId && POST_REVEAL_STAGES.has(profile.lastStage ?? '')) {
    return withReferenceAck(await postRevealTurn(profile, store, body), ackText);
  }

  // ── A regular conversation turn on the shared engine ─────────────────
  return withReferenceAck(
    await conversationTurn(profile, store, withMediaAnnotation(body, ingest)),
    ackText
  );
}

/**
 * Attach a message's analyzed references to a session (creating one via
 * the free deterministic opener when the phone has no continuable
 * conversation) and return the in-voice acknowledgment. Attachment is
 * best-effort — a stale session must never eat the user's message.
 */
async function attachAnalyses(
  profile: SmsProfile,
  store: ProfileStoreT,
  ingest: MediaIngest
): Promise<string> {
  if (ingest.analyses.length === 0) {
    // Nothing readable: honest capacity when the budget gate refused,
    // honest failure otherwise — never silence, never a fake reading.
    return ingest.budgetExhausted ? REFERENCE_BUDGET_TEXT : REFERENCE_UNREADABLE_TEXT;
  }

  const sessionId = await ensureAttachableSession(profile, store);
  if (sessionId) {
    for (const { analysis, image } of ingest.analyses) {
      try {
        // Keep the pixels too (ADR-0050): stored privately, fail-soft — a
        // reference whose photo upload failed still attaches its analysis.
        const imagePath = await storeReferencePhoto(sessionId, image);
        await attachReference(sessionId, analysis, 'sms', imagePath);
      } catch (error) {
        logger.warn({
          event_type: 'sketchbot_sms.reference_attach_failed',
          phone_last4: phoneLast4(profile.phone),
          session_id: sessionId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  return referenceAckText(
    ingest.analyses.map(({ analysis }) => analysis),
    ingest.ignored,
    ingest.unreadable
  );
}

/**
 * The session a reference can attach to: the active intake or post-reveal
 * session, or a fresh one opened via the deterministic (free) opener call.
 * Post-reveal stages must keep the delivered session — opening a new one
 * would retarget critique/pick/refine away from the cuts the texter sees.
 */
async function ensureAttachableSession(
  profile: SmsProfile,
  store: ProfileStoreT
): Promise<string | null> {
  const continuable =
    profile.activeSessionId &&
    (profile.lastStage === 'chatting' ||
      profile.lastStage === 'proposal' ||
      profile.lastStage === 'revealed' ||
      profile.lastStage === 'pick-pending' ||
      profile.lastStage === 'refine-pending');
  if (continuable) return profile.activeSessionId!;

  try {
    const opened = await converse({});
    profile.activeSessionId = opened.sessionId;
    profile.lastStage = opened.stage;
    if (!profile.sessionIds.includes(opened.sessionId)) {
      profile.sessionIds = [...profile.sessionIds, opened.sessionId];
    }
    profile.updatedAt = new Date().toISOString();
    await store.save(profile);
    return opened.sessionId;
  } catch (error) {
    logger.warn({
      event_type: 'sketchbot_sms.reference_session_failed',
      phone_last4: phoneLast4(profile.phone),
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/**
 * Represent analyzed photos inside the engine turn as a bracketed textual
 * annotation on the user's message. Deliberate double coverage with the
 * structured merge: the annotation gives the MODEL the context (so its
 * reply and extraction can react to the photo), and naming the recognized
 * characters in text runs them through the exact TAT-47 subject-scan
 * machinery a typed mention would hit — while the stored reference entry
 * guarantees the signals deterministically either way.
 */
function withMediaAnnotation(body: string, ingest: MediaIngest | null): string {
  if (!ingest || ingest.analyses.length === 0) return body;
  const annotations = ingest.analyses
    .map(({ analysis }: { analysis: ReferenceAnalysis }) => {
      const characters = analysis.characters
        .map((c) => (c.series ? `${c.name} (${c.series})` : c.name))
        .join(', ');
      return characters
        ? `[photo attached — ${analysis.summary}; recognizable characters: ${characters}]`
        : `[photo attached — ${analysis.summary}]`;
    })
    .join(' ');
  return `${body} ${annotations}`;
}

/** Prepend the reference ack to whatever the routed outcome replied. */
function withReferenceAck(outcome: InboundOutcome, ackText: string): InboundOutcome {
  if (!ackText || outcome.kind === 'silent') return outcome;
  return { ...outcome, text: renderSmsReply(`${ackText} ${outcome.text}`) };
}

type ProfileStoreT = ReturnType<typeof resolveProfileStore>;

/**
 * Stages where the texter is talking ABOUT a delivered reveal rather than
 * describing a new tattoo.
 */
const POST_REVEAL_STAGES = new Set(['revealed', 'pick-pending']);

/**
 * Stages where an inbound photo means "here is where it would go" rather
 * than "here is what I like". Once cuts exist, a reference image has nowhere
 * useful to attach — intake is over — and the placement read is both the
 * more likely intent and the cheaper one.
 */
const PLACEMENT_STAGES = new Set([
  'revealed',
  'pick-pending',
  'refine-pending',
  'complete',
]);

/**
 * The way out of a delivered reveal into a brand-new design.
 *
 * The web does not need one: a user who wants to start again navigates back
 * to /design. SMS has no navigation — every message lands in the same
 * thread — so without an explicit escape a texter would be stuck critiquing
 * the same cuts forever, because `isFixRequest` reads any sentence as
 * a fix. Deterministic rather than model-judged: mistaking "start over" for
 * a critique spends a render on a design they have already abandoned.
 */
// Whole-message only: refinement is free text ("add something else around
// the dagger", "don't forget it needs contrast") and must not match as a
// substring. The reveal closing copy invites the bare phrase "start over".
const RESTART_INTENT =
  /^\s*(?:start (?:over|again|fresh)|from scratch|new (?:design|tattoo|idea|one)|different (?:design|tattoo|idea)|something else|scrap (?:it|that|this)|forget (?:it|that|this))\s*[.!]?\s*$/i;

/** Drop the active design and open a fresh intake with the same message. */
async function restartDesign(
  profile: SmsProfile,
  store: ProfileStoreT,
  body: string
): Promise<InboundOutcome> {
  profile.pendingPickId = null;
  profile.activeSessionId = null;
  profile.lastStage = null;
  profile.updatedAt = new Date().toISOString();
  await store.save(profile);
  return conversationTurn(profile, store, body);
}

/**
 * Everything the web offers after a round's cuts land, over SMS.
 *
 * The web can tell a critique from a pick by which affordance was used —
 * typing versus clicking. SMS has only text, so the split is explicit:
 *
 *   a choice and nothing else ("3", "I'll take cut 2")  → the pick
 *   an instruction ("make 2 bolder", "riku's missing")  → a critique re-cut
 *   pure chatter ("these are sick")                     → acknowledged, free
 *
 * Order matters. `isFixRequest` deliberately treats almost everything as a
 * fix, so the bare-choice test has to run first — otherwise a texter who
 * answers "2" spends a render re-cutting cut 2 against the instruction "2".
 */
async function postRevealTurn(
  profile: SmsProfile,
  store: ProfileStoreT,
  body: string
): Promise<InboundOutcome> {
  const sessionId = profile.activeSessionId!;

  let session;
  try {
    session = await getSession(sessionId);
  } catch {
    // The session expired out from under the profile. Drop the post-reveal
    // state and let the message open a fresh design rather than dead-end.
    profile.activeSessionId = null;
    profile.lastStage = null;
    profile.pendingPickId = null;
    profile.updatedAt = new Date().toISOString();
    await store.save(profile);
    return conversationTurn(profile, store, body);
  }

  // The escape hatch, checked before anything that could spend: a texter
  // asking for a fresh design must not be charged for a re-cut of the old one.
  if (RESTART_INTENT.test(body)) {
    return restartDesign(profile, store, body);
  }

  // Critique cuts are pickable too (ADR-0039), and SMS numbers the whole
  // list so a number means the same cut the web shows in that position.
  const cuts = allCuts(session);
  const stage = profile.lastStage;

  // ── The most-not-you tap: an ordinal answer to a direct question ─────
  if (stage === 'pick-pending') {
    return mostNotYouTurn(profile, store, session, cuts, body);
  }

  // ── The round vocabulary (ADR-0049): A/B picks, REFINE charges, BOOK exits ──
  const letter = parseRoundLetter(body);
  if (letter) {
    return roundPickTurn(profile, store, session, letter);
  }
  if (REFINE_INTENT.test(body)) {
    return armRefineRound(profile, store, session);
  }
  if (BOOK_INTENT.test(body)) {
    return { kind: 'reply', text: bookText(handoffUrl(appBaseUrl(), session.id)) };
  }

  if (isBarePickReference(body, cuts.length)) {
    return firstPickTurn(profile, store, cuts, body);
  }

  if (!isFixRequest(body)) {
    // Chatter costs nothing and gets a real answer, not silence.
    return { kind: 'reply', text: chatterAckText() };
  }

  return armCritique(profile, store, body);
}

/* ── The two-cut round replies (ADR-0049) ──────────────────────────────── */

/** A bare A or B — the round pick. Anything more is an instruction. */
const ROUND_LETTER = /^\s*(?:cut\s+)?([ab])\s*[.!?]?\s*$/i;

function parseRoundLetter(body: string): 'A' | 'B' | null {
  const match = body.match(ROUND_LETTER);
  return match ? (match[1].toUpperCase() as 'A' | 'B') : null;
}

/**
 * Whole-message keywords, same discipline as RESTART_INTENT. A contentless
 * lead ("yes", "let's") or tail ("it", "this one", "please") still counts:
 * those words carry no instruction, and letting "book it" fall through
 * spends a fix allowance on a critique the texter never asked for (#338).
 * Anything with real content ("refine the lines on A") still reads as an
 * instruction and takes the critique lane.
 */
const KEYWORD_LEAD = /(?:(?:ok(?:ay)?|yes|yeah|please|let'?s|lets)[\s,]+)*/
  .source;
const KEYWORD_TAIL = /(?:\s+(?:it|this|that|one|them|please|now))*/.source;
const REFINE_INTENT = new RegExp(
  `^\\s*${KEYWORD_LEAD}refine${KEYWORD_TAIL}\\s*[.!?]*\\s*$`,
  'i'
);
const BOOK_INTENT = new RegExp(
  `^\\s*${KEYWORD_LEAD}book${KEYWORD_TAIL}\\s*[.!?]*\\s*$`,
  'i'
);

/** The live round — the only one whose pick can still change. */
function liveRound(session: DesignSession): RefineRound | undefined {
  return session.rounds?.[session.rounds.length - 1];
}

/**
 * How a round's two cuts are named in SMS copy: the pole label on a ladder
 * axis ("bold", "fine-line" — same vocabulary the web reveal uses), the
 * designed cut name otherwise (compositional/re-roll rounds).
 */
function roundPoleLabels(
  round: RefineRound | undefined,
  cuts: { axisPosition: Record<string, string> }[]
): [string, string] {
  const label = (index: number): string => {
    const cut = cuts[index];
    if (!cut) return index === 0 ? 'the first take' : 'the second take';
    if (round && isLadderAxis(round.axis)) {
      const pole = cut.axisPosition?.[round.axis];
      const poleLabel = pole ? ROUND_POLE_LABEL[pole] : undefined;
      if (poleLabel) return poleLabel;
    }
    return cutIdentity(cut as Parameters<typeof cutIdentity>[0], index).name;
  };
  return [label(0), label(1)];
}

/**
 * The A/B reply: record (or change) the round pick (ADR-0049). Free, and
 * changeable until REFINE charges the next round — the stage deliberately
 * stays 'revealed' so a second letter re-picks.
 */
async function roundPickTurn(
  profile: SmsProfile,
  store: ProfileStoreT,
  session: Awaited<ReturnType<typeof getSession>>,
  letter: 'A' | 'B'
): Promise<InboundOutcome> {
  const round = liveRound(session);
  const pickedId = round?.variationIds[letter === 'A' ? 0 : 1];
  if (!round || !pickedId) {
    // A pre-rounds session (or a malformed round): the old ordinal pick
    // vocabulary still works, say so instead of guessing.
    return { kind: 'reply', text: chatterAckText() };
  }

  try {
    await recordRoundPick(session.id, { pickedId });
  } catch (error) {
    if (error instanceof DesignSessionError && error.code === 'ROUND_PICK_FROZEN') {
      return {
        kind: 'reply',
        text: "That round's already locked into the next one — reply REFINE to keep going, or BOOK when you're ready.",
      };
    }
    // Transient, not a broken session: a round is rendering right now, so
    // the pick reopens when its cuts land. Dropping the profile here would
    // strand the texter mid-flow over a timing collision.
    if (error instanceof DesignSessionError && error.code === 'ROUND_IN_FLIGHT') {
      return {
        kind: 'reply',
        text: 'Hold that thought — your next cuts are rendering right now. Pick again as soon as they land.',
      };
    }
    if (error instanceof DesignSessionError) {
      // The session moved on without this channel (web pick, completed
      // session) — same recovery as the ordinal pick path.
      profile.pendingPickId = null;
      profile.lastStage = null;
      profile.activeSessionId = null;
      profile.updatedAt = new Date().toISOString();
      await store.save(profile);
      logger.warn({
        event_type: 'sketchbot_sms.round_pick_rejected',
        phone_last4: phoneLast4(profile.phone),
        session_id: session.id,
        code: error.code,
      });
      return {
        kind: 'reply',
        text: "Looks like that set already moved on without me. Tell me what you're after and I'll start a fresh one.",
      };
    }
    throw error;
  }

  logger.info({
    event_type: 'sketchbot_sms.round_pick_recorded',
    phone_last4: phoneLast4(profile.phone),
    session_id: session.id,
    round: round.round,
    picked_id: pickedId,
  });

  return { kind: 'reply', text: ROUND_LOCKED_TEXT };
}

/**
 * Arm one charged REFINE round (ADR-0049): link gate first (a credit needs
 * an account to belong to), then the global budget, then ONE generation
 * credit reserved before anything renders. The deferred executeRefineRound
 * releases it on failure or downgrade — no partial-charge path.
 */
async function armRefineRound(
  profile: SmsProfile,
  store: ProfileStoreT,
  session: Awaited<ReturnType<typeof getSession>>
): Promise<InboundOutcome> {
  const base = appBaseUrl();
  const round = liveRound(session);
  if (!round?.pickedId) {
    return { kind: 'reply', text: roundUnpickedText() };
  }

  // Late upgrade, same as armReveal: the texter may have linked an account
  // since the conversation started.
  if (!profile.uid) {
    profile.uid = await lookupUidByPhone(profile.phone);
    if (profile.uid) await store.save(profile);
  }
  if (!profile.uid) {
    logger.info({
      event_type: 'sketchbot_sms.round_link_gate',
      phone_last4: phoneLast4(profile.phone),
    });
    return { kind: 'reply', text: linkGateText(`${base}/signup`) };
  }

  if (!isDemoMode()) {
    const budget = await checkBudget();
    if (!budget.allowed) {
      logger.warn({
        event_type: 'sketchbot_sms.round_budget_exhausted',
        phone_last4: phoneLast4(profile.phone),
        spent_cents: budget.spentCents,
      });
      return { kind: 'reply', text: BUDGET_EXHAUSTED_TEXT };
    }
  }

  // One credit per round (ADR-0049). Reserved NOW so an exhausted meter is
  // told immediately instead of after an ack that promised cuts.
  let credit: GenerationCreditReservation | undefined;
  if (!isDemoMode()) {
    try {
      credit = await reserveGenerationCredit(profile.uid);
    } catch (error) {
      if (error instanceof GenerationCreditsExhaustedError) {
        return { kind: 'reply', text: error.message };
      }
      throw error;
    }
  }

  profile.lastStage = 'round-running';
  profile.revealArmedAt = new Date().toISOString();
  // Persisted at reserve time, not only in the deferred closure: a crash
  // between here and delivery leaves a reconcilable reservation id instead
  // of an unaccountable missing credit.
  profile.pendingCreditReservationId = credit?.id ?? null;
  profile.updatedAt = profile.revealArmedAt;
  try {
    await store.save(profile);
  } catch (saveError) {
    // The arm never happened: hand the credit straight back rather than
    // leaking it into a state nothing will ever deliver or release.
    if (credit) {
      await releaseGenerationCredit(profile.uid, credit).catch((releaseError) => {
        logger.error({
          event_type: 'sketchbot_sms.round_credit_release_failed',
          phone_last4: phoneLast4(profile.phone),
          session_id: session.id,
          error: releaseError instanceof Error ? releaseError.message : String(releaseError),
        });
      });
    }
    throw saveError;
  }

  logger.info({
    event_type: 'sketchbot_sms.round_armed',
    phone_last4: phoneLast4(profile.phone),
    session_id: session.id,
    credit_source: credit?.source,
  });

  return {
    kind: 'refine-round',
    text: ROUND_ACK,
    sessionId: session.id,
    phone: profile.phone,
    uid: profile.uid,
    ...(credit ? { credit } : {}),
    armedAt: profile.revealArmedAt!,
  };
}

/**
 * The deferred half of a charged round (ADR-0049): two renders outlive
 * Twilio's webhook window, so the ack already went out and the new pair
 * arrives by MMS with the same A/B ask as the reveal.
 *
 * The credit reserved at arm time is released on ANY path that did not
 * deliver a clean round — supersession, failure, and the ADR-0048 loud
 * downgrade — and the failure text promises exactly that.
 */
export async function executeRefineRound(
  sessionId: string,
  phone: string,
  uid: string,
  credit: GenerationCreditReservation | undefined,
  armedAt: string
): Promise<RevealDelivery> {
  const store = resolveProfileStore();

  /**
   * Release the reserved credit, reporting whether it actually landed —
   * the copy only claims "your credit is back" when this returns true.
   */
  const release = async (): Promise<boolean> => {
    if (!credit) return false;
    return releaseGenerationCredit(uid, credit)
      .then(() => true)
      .catch((releaseError) => {
        logger.error({
          event_type: 'sketchbot_sms.round_credit_release_failed',
          phone_last4: phoneLast4(phone),
          session_id: sessionId,
          reservation_id: credit.id,
          error: releaseError instanceof Error ? releaseError.message : String(releaseError),
        });
        return false;
      });
  };

  if (!(await stillArmed(store, phone, 'round-running', armedAt))) {
    // Superseded before generation — nothing was bought, hand it back.
    await release();
    logger.info({
      event_type: 'sketchbot_sms.round_superseded',
      phone_last4: phoneLast4(phone),
      session_id: sessionId,
    });
    return { cuts: [], closingText: '' };
  }

  let result;
  try {
    // The reservation id rides inside the service's round claim (and the
    // claim race serializes concurrent web + SMS rounds server-side).
    result = await refineRound(
      sessionId,
      credit ? { reservationId: credit.id } : undefined
    );
  } catch (error) {
    // No partial-charge path (ADR-0049): the round persisted nothing and
    // the pick stays changeable. The refund is only CLAIMED in copy when
    // the release actually succeeded.
    const released = await release();
    const profile = await store.get(phone);
    if (profile && profile.revealArmedAt === armedAt) {
      profile.lastStage = 'revealed';
      profile.revealArmedAt = null;
      profile.pendingCreditReservationId = released ? null : profile.pendingCreditReservationId;
      profile.updatedAt = new Date().toISOString();
      await store.save(profile);
    }
    logger.error({
      event_type: 'sketchbot_sms.round_failed',
      phone_last4: phoneLast4(phone),
      session_id: sessionId,
      credit_released: released,
      error: error instanceof Error ? error.message : String(error),
    });
    return { cuts: [], closingText: released || !credit ? ROUND_FAILED_TEXT : ROUND_FAILED_NO_REFUND_TEXT };
  }

  // Loud downgrade (ADR-0048): the cuts are delivered, but off the pinned
  // lane — the credit goes back, and the note below only says so when the
  // release actually landed.
  const downgradeRefunded = result.downgraded ? await release() : false;

  const profile = (await store.get(phone)) ?? newProfile(phone);
  // Paid renders already ran — always deliver. Only claim profile state
  // when this job is still the armed one; do not clobber a newer arm.
  if (profile.revealArmedAt === armedAt) {
    profile.lastStage = 'revealed';
    profile.revealArmedAt = null;
    // The round settled: charged (kept) or refunded — either way the
    // reservation is no longer pending reconciliation.
    profile.pendingCreditReservationId = null;
    profile.updatedAt = new Date().toISOString();
    await store.save(profile);
  } else if (profile.revealArmedAt != null) {
    logger.info({
      event_type: 'sketchbot_sms.round_superseded',
      phone_last4: phoneLast4(phone),
      session_id: sessionId,
    });
  }

  const session = result.session;
  const roundCuts = session.variations.filter((variation) =>
    result.round.variationIds.includes(variation.id)
  );
  const labels = roundPoleLabels(result.round, roundCuts);
  const cutUrls = roundCuts
    .map((variation) => variation.imageUrl)
    .filter((url): url is string => typeof url === 'string' && url.length > 0);
  const link = await mintShareLink(session, profile, cutUrls);

  logger.info({
    event_type: 'sketchbot_sms.round_delivered',
    phone_last4: phoneLast4(phone),
    session_id: session.id,
    round: result.round.round,
    axis: result.round.axis,
    downgraded: result.downgraded,
    cuts: cutUrls.length,
  });

  // The refund is only claimed when it landed; a downgraded round whose
  // release failed is still announced, just without the ledger promise.
  const downgradeNote = result.downgraded
    ? downgradeRefunded
      ? 'Heads up — these came off my backup lane, so that credit is back. '
      : 'Heads up — these came off my backup lane. '
    : '';
  return {
    cuts: cutUrls.map((mediaUrl, index) => ({
      caption: roundCutCaption(index === 0 ? 'A' : 'B', labels[index]),
      mediaUrl,
    })),
    closingText: `${downgradeNote}${roundRevealText(labels[0], labels[1], link)}`,
  };
}

async function armReveal(
  profile: SmsProfile,
  store: ProfileStoreT
): Promise<InboundOutcome> {
  const phone = profile.phone;
  const base = appBaseUrl();

  // Late upgrade: the texter may have created/linked an account since the
  // conversation started — re-check before the gate refuses them.
  if (!profile.uid) {
    profile.uid = await lookupUidByPhone(phone);
    if (profile.uid) await store.save(profile);
  }

  // Guardrail 2 — account-link gate: free reveals are lifetime, not daily.
  if (!profile.uid && profile.totalReveals >= freeReveals()) {
    logger.info({
      event_type: 'sketchbot_sms.link_gate',
      phone_last4: phoneLast4(phone),
      total_reveals: profile.totalReveals,
    });
    return { kind: 'reply', text: linkGateText(`${base}/signup`) };
  }

  // Guardrail 1 — atomic daily-cap reserve. Consumed BEFORE generation;
  // refunded only if generation later fails.
  const reserved = await store.tryConsumeReveal(phone, revealsPerDay());
  if (!reserved) {
    logger.info({
      event_type: 'sketchbot_sms.reveal_cap_hit',
      phone_last4: phoneLast4(phone),
    });
    return { kind: 'reply', text: capReachedText(`${base}/design`) };
  }

  // Guardrail 3 — the global pool. Demo mode renders free stock images, so
  // budget policy is skipped there, matching the web confirm route.
  if (!isDemoMode()) {
    const budget = await checkBudget();
    if (!budget.allowed) {
      await store.releaseReveal(phone);
      logger.warn({
        event_type: 'sketchbot_sms.budget_exhausted',
        phone_last4: phoneLast4(phone),
        spent_cents: budget.spentCents,
      });
      return { kind: 'reply', text: BUDGET_EXHAUSTED_TEXT };
    }
  }

  // Re-read before mutating: tryConsumeReveal just advanced the counters in
  // the store, and saving the pre-consume object here would silently roll
  // them back — the exact clobber the atomic reserve exists to prevent.
  const fresh = (await store.get(phone)) ?? profile;
  fresh.lastStage = 'reveal-pending';
  fresh.revealArmedAt = new Date().toISOString();
  fresh.updatedAt = fresh.revealArmedAt;
  await store.save(fresh);

  logger.info({
    event_type: 'sketchbot_sms.reveal_armed',
    phone_last4: phoneLast4(phone),
    session_id: profile.activeSessionId,
  });
  return {
    kind: 'reveal',
    text: REVEAL_ACK,
    sessionId: profile.activeSessionId!,
    phone,
    armedAt: fresh.revealArmedAt!,
  };
}

/**
 * Arm the one refinement round (ADR-0013 hard stop). The global budget gate
 * applies, but NOT the daily reveal cap — that counts reveals, this session
 * already spent its slot, and charging it twice would strand a texter
 * mid-flow with a design they cannot finish.
 */
async function armRefine(
  profile: SmsProfile,
  store: ProfileStoreT,
  answer: string
): Promise<InboundOutcome> {
  if (!isDemoMode()) {
    const budget = await checkBudget();
    if (!budget.allowed) {
      logger.warn({
        event_type: 'sketchbot_sms.refine_budget_exhausted',
        phone_last4: phoneLast4(profile.phone),
        spent_cents: budget.spentCents,
      });
      return { kind: 'reply', text: BUDGET_EXHAUSTED_TEXT };
    }
  }

  profile.lastStage = 'refine-running';
  profile.revealArmedAt = new Date().toISOString();
  profile.updatedAt = profile.revealArmedAt;
  await store.save(profile);

  logger.info({
    event_type: 'sketchbot_sms.refine_armed',
    phone_last4: phoneLast4(profile.phone),
    session_id: profile.activeSessionId,
  });

  return {
    kind: 'refine',
    text: REFINE_ACK,
    sessionId: profile.activeSessionId!,
    phone: profile.phone,
    answer,
    armedAt: profile.revealArmedAt!,
  };
}

/**
 * The deferred half of a refinement. Reaching phase 'complete' is what
 * assembles the Brief — until this runs, an SMS session has nothing an
 * artist can be handed.
 *
 * Spend is NOT recorded here: the designSession service records it, exactly
 * as it does for the reveal. A second charge in this channel would bill the
 * same render twice against the shared cap.
 *
 * `armedAt` is the token from armRefine. Stale recovery clears it (and a
 * newer arm replaces it), so a deferred job that outlived the wait window
 * must not call refine() after the channel already invited a retry.
 */
export async function executeRefine(
  sessionId: string,
  phone: string,
  answer: string,
  armedAt: string
): Promise<RevealDelivery> {
  const store = resolveProfileStore();
  const base = appBaseUrl();

  if (!(await stillArmed(store, phone, 'refine-running', armedAt))) {
    logger.info({
      event_type: 'sketchbot_sms.refine_superseded',
      phone_last4: phoneLast4(phone),
      session_id: sessionId,
    });
    return { cuts: [], closingText: '' };
  }

  let session;
  try {
    session = await refine(sessionId, { answer });
  } catch (error) {
    // Re-arm so a fresh answer can retry — the failure text promises it.
    // No cap slot to refund: refinement never consumed one.
    const profile = await store.get(phone);
    if (profile && profile.revealArmedAt === armedAt) {
      profile.lastStage = 'refine-pending';
      profile.revealArmedAt = null;
      profile.updatedAt = new Date().toISOString();
      await store.save(profile);
    }
    logger.error({
      event_type: 'sketchbot_sms.refine_failed',
      phone_last4: phoneLast4(phone),
      session_id: sessionId,
      error: error instanceof Error ? error.message : String(error),
    });
    return { cuts: [], closingText: REFINE_FAILED_TEXT };
  }

  const profile = (await store.get(phone)) ?? newProfile(phone);
  // Paid refine already ran — always deliver. Only claim profile state when
  // this job is still the armed one (or stale recovery left refine-pending).
  if (profile.revealArmedAt === armedAt) {
    profile.lastStage = 'complete';
    profile.revealArmedAt = null;
    profile.updatedAt = new Date().toISOString();
    await store.save(profile);
  } else if (profile.revealArmedAt == null && profile.lastStage === 'refine-pending') {
    profile.lastStage = 'complete';
    profile.updatedAt = new Date().toISOString();
    await store.save(profile);
  } else if (profile.revealArmedAt != null) {
    logger.info({
      event_type: 'sketchbot_sms.refine_superseded',
      phone_last4: phoneLast4(phone),
      session_id: sessionId,
    });
  }

  const refinedUrl = session.refinedVariation?.imageUrl;
  // Two artifacts for two readers: the render the texter approved, and the
  // black line art their artist actually works from. Only present when
  // stencil derivation is on and its render landed.
  const stencilUrl = session.brief?.stencilUrl;

  logger.info({
    event_type: 'sketchbot_sms.refine_delivered',
    phone_last4: phoneLast4(phone),
    session_id: session.id,
    provider: session.provider,
    has_image: !!refinedUrl,
    has_stencil: !!stencilUrl,
  });

  const cuts: RevealDelivery['cuts'] = [];
  if (refinedUrl) cuts.push({ caption: REFINED_CAPTION, mediaUrl: refinedUrl });
  if (stencilUrl) cuts.push({ caption: STENCIL_CAPTION, mediaUrl: stencilUrl });

  return {
    cuts,
    closingText: refinedClosingText(handoffUrl(base, session.id), !!stencilUrl),
  };
}

/**
 * The artist handoff link. `ds` is what /smart-match reads to load the
 * brief, pre-select the style pills, and enrich the semantic query — and it
 * threads onward to /swipe so the eventual booking records which design
 * session it came from. Without it the texter restarts artist discovery
 * from a blank form.
 */
function handoffUrl(base: string, sessionId: string, path = '/smart-match'): string {
  return `${base}${path}?ds=${encodeURIComponent(sessionId)}`;
}

/**
 * Arm the placement composite. No paid render and no vision call — this is
 * local pixel work — so there is no budget gate. It still defers, because
 * fetching two images and compositing them can outlast Twilio's window.
 */
async function armPlacement(
  profile: SmsProfile,
  store: ProfileStoreT,
  photo: InboundMediaItem,
  message: string
): Promise<InboundOutcome> {
  logger.info({
    event_type: 'sketchbot_sms.placement_armed',
    phone_last4: phoneLast4(profile.phone),
    session_id: profile.activeSessionId,
  });
  // Deliberately no stage change: compositing spends nothing, so there is
  // nothing to double-fire, and leaving the stage alone means the texter can
  // keep critiquing or pick while the preview is on its way. The armed token
  // still persists (#304): executePlacement aborts if a newer photo or a
  // restart superseded this composite before it delivered.
  const armedAt = new Date().toISOString();
  await store.save({ ...profile, placementArmedAt: armedAt, updatedAt: armedAt });

  return {
    kind: 'placement',
    text: PLACEMENT_ACK,
    sessionId: profile.activeSessionId!,
    phone: profile.phone,
    mediaUrl: photo.url,
    contentType: photo.contentType,
    message,
    armedAt,
  };
}

/**
 * The deferred half of a placement preview: fetch the design and the photo,
 * composite, and hand back one MMS.
 *
 * The body photo is never persisted — see internal/placement.ts. Only the
 * flattened composite is stored, and only because the Brief carries it to
 * the artist, exactly as the web preview does.
 */
export async function executePlacement(
  sessionId: string,
  phone: string,
  photo: InboundMediaItem,
  message: string,
  armedAt: string
): Promise<RevealDelivery> {
  // The superseded guard its deferred siblings already have (#304): a
  // composite must not deliver after the texter restarted, moved to a
  // different design, or sent a newer photo. lastStage is deliberately not
  // checked — placement never set one.
  const profile = await resolveProfileStore().get(phone);
  if (
    !profile ||
    profile.activeSessionId !== sessionId ||
    profile.placementArmedAt !== armedAt
  ) {
    logger.info({
      event_type: 'sketchbot_sms.placement_superseded',
      phone_last4: phoneLast4(phone),
      session_id: sessionId,
    });
    return { cuts: [], closingText: '' };
  }

  try {
    const session = await getSession(sessionId);
    const designUrl = placementSourceUrl(session);
    if (!designUrl) {
      return { cuts: [], closingText: PLACEMENT_NO_DESIGN_TEXT };
    }

    const [photoImage, designResponse] = await Promise.all([
      fetchTwilioMedia(photo),
      fetch(designUrl),
    ]);
    if (!photoImage) return { cuts: [], closingText: PLACEMENT_UNREADABLE_TEXT };
    if (!designResponse.ok) throw new Error(`design fetch ${designResponse.status}`);

    const composite = await compositeOnBody(
      Buffer.from(await designResponse.arrayBuffer()),
      // fetchTwilioMedia hands back base64 (it exists to feed the vision
      // model); sharp wants bytes.
      Buffer.from(photoImage.data, 'base64'),
      widthFractionFor(message)
    );
    if (composite === 'unusable-design') {
      return { cuts: [], closingText: PLACEMENT_UNUSABLE_DESIGN_TEXT };
    }

    // The composite has to be reachable by Twilio and by the artist, so it
    // goes to the same product-owned bucket as every other session image.
    const { uploadToGCS } = await import('@/services/gcs-service');
    const upload = await uploadToGCS(
      composite.buffer,
      `design-sessions/${sessionId}/placement-${Date.now()}.png`
    );

    // Same Brief field the web preview writes, so a booking made from an
    // SMS session carries the placement exactly as a web one does.
    await attachPlacementPreview(sessionId, upload.url).catch((error) => {
      // Persisting is a bonus; the texter still gets to see it.
      logger.warn({
        event_type: 'sketchbot_sms.placement_attach_failed',
        session_id: sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
    });

    logger.info({
      event_type: 'sketchbot_sms.placement_delivered',
      phone_last4: phoneLast4(phone),
      session_id: sessionId,
    });

    return {
      cuts: [{ caption: PLACEMENT_CAPTION, mediaUrl: upload.url }],
      closingText: PLACEMENT_DONE_TEXT,
    };
  } catch (error) {
    logger.error({
      event_type: 'sketchbot_sms.placement_failed',
      phone_last4: phoneLast4(phone),
      session_id: sessionId,
      error: error instanceof Error ? error.message : String(error),
    });
    return { cuts: [], closingText: PLACEMENT_FAILED_TEXT };
  }
}

/**
 * Which design to lay on the body: the finished one when the session has a
 * Brief, otherwise whatever they last committed to. Deliberately falls back
 * to the newest cut so a texter can try a placement before picking — that is
 * how people actually decide which one they want.
 */
function placementSourceUrl(
  session: Awaited<ReturnType<typeof getSession>>
): string | undefined {
  if (session.brief?.finalImageUrl) return session.brief.finalImageUrl;
  const cuts = allCuts(session);
  const picked = cuts.find((cut) => cut.id === session.pickId);
  return picked?.imageUrl ?? cuts[cuts.length - 1]?.imageUrl;
}

/** First tap: hold the choice, ask for its opposite (ADR-0012). */
async function firstPickTurn(
  profile: SmsProfile,
  store: ProfileStoreT,
  cuts: Awaited<ReturnType<typeof allCuts>>,
  body: string
): Promise<InboundOutcome> {
  const ordinal = parsePickIntent(body, cuts.length)!;
  profile.pendingPickId = cuts[ordinal - 1].id;
  profile.lastStage = 'pick-pending';
  profile.updatedAt = new Date().toISOString();
  await store.save(profile);
  return { kind: 'reply', text: mostNotYouQuestion(ordinal) };
}

/**
 * Second tap: both ids in hand. recordPick needs them together and refuses a
 * pair naming the same cut, which is why this is a second turn rather than a
 * fabricated default — inventing a most-not-you writes a dislike the texter
 * never expressed into the artist's Brief.
 *
 * Same bare-choice gate as the first tap: "make 2 bolder" names an ordinal
 * but is an instruction, not a most-not-you. parsePickOrdinals alone would
 * record it as a dislike and pollute the Brief.
 */
async function mostNotYouTurn(
  profile: SmsProfile,
  store: ProfileStoreT,
  session: Awaited<ReturnType<typeof getSession>>,
  cuts: Awaited<ReturnType<typeof allCuts>>,
  body: string
): Promise<InboundOutcome> {
  if (!isBarePickReference(body, cuts.length)) {
    return { kind: 'reply', text: pickRetryText(cuts.length) };
  }

  const ordinal = parsePickIntent(body, cuts.length)!;
  const namedId = cuts[ordinal - 1].id;
  if (namedId === profile.pendingPickId) {
    return { kind: 'reply', text: pickCollisionText(cuts.length) };
  }

  let picked;
  try {
    picked = await recordPick(session.id, {
      pickId: profile.pendingPickId!,
      mostNotYouId: namedId,
    });
  } catch (error) {
    // The session moved on without this channel — most likely the same
    // person picked on the web. Clear the state so the next text opens a
    // new design instead of re-asking a dead question.
    if (error instanceof DesignSessionError) {
      profile.pendingPickId = null;
      profile.lastStage = null;
      profile.activeSessionId = null;
      profile.updatedAt = new Date().toISOString();
      await store.save(profile);
      logger.warn({
        event_type: 'sketchbot_sms.pick_rejected',
        phone_last4: phoneLast4(profile.phone),
        session_id: session.id,
        code: error.code,
      });
      return {
        kind: 'reply',
        text: "Looks like that set already moved on without me. Tell me what you're after and I'll start a fresh one.",
      };
    }
    throw error;
  }

  profile.pendingPickId = null;
  profile.lastStage = 'refine-pending';
  profile.updatedAt = new Date().toISOString();
  await store.save(profile);

  logger.info({
    event_type: 'sketchbot_sms.pick_recorded',
    phone_last4: phoneLast4(profile.phone),
    session_id: session.id,
  });

  return {
    kind: 'reply',
    text: renderSmsReply(
      picked.refinementQuestion ??
        "Locked in. One last thing — what would you change about it?"
    ),
  };
}

/**
 * Arm one critique re-cut (ADR-0039). The allowance ledger and the spend
 * both live inside the designSession service, so this channel only checks
 * the global pool before committing to the wait — charging here as well
 * would bill the same render twice.
 */
async function armCritique(
  profile: SmsProfile,
  store: ProfileStoreT,
  message: string
): Promise<InboundOutcome> {
  if (!isDemoMode()) {
    const budget = await checkBudget();
    if (!budget.allowed) {
      logger.warn({
        event_type: 'sketchbot_sms.critique_budget_exhausted',
        phone_last4: phoneLast4(profile.phone),
        spent_cents: budget.spentCents,
      });
      return { kind: 'reply', text: BUDGET_EXHAUSTED_TEXT };
    }
  }

  profile.lastStage = 'critique-running';
  profile.revealArmedAt = new Date().toISOString();
  profile.updatedAt = profile.revealArmedAt;
  await store.save(profile);

  logger.info({
    event_type: 'sketchbot_sms.critique_armed',
    phone_last4: phoneLast4(profile.phone),
    session_id: profile.activeSessionId,
  });

  return {
    kind: 'critique',
    text: CRITIQUE_ACK,
    sessionId: profile.activeSessionId!,
    phone: profile.phone,
    message,
    armedAt: profile.revealArmedAt!,
  };
}

/**
 * True when this deferred job is still the one the profile is waiting on.
 * Stale recovery clears revealArmedAt; a newer arm replaces it — either way
 * the after() callback must not spend.
 */
async function stillArmed(
  store: ProfileStoreT,
  phone: string,
  stage: string,
  armedAt: string
): Promise<boolean> {
  const profile = await store.get(phone);
  return (
    !!profile &&
    profile.lastStage === stage &&
    profile.revealArmedAt === armedAt
  );
}

/**
 * The deferred half of a critique. Mirrors executeReveal: the render
 * outlives Twilio's webhook window, so the ack already went out and the new
 * cut arrives by MMS.
 *
 * A turn that spends nothing — chatter the service filtered, an unresolvable
 * target, a spent allowance — still returns its reply. The service decides;
 * this channel only delivers.
 *
 * `armedAt` dedupes against stale recovery: if the wait window expired and
 * the texter armed again, this callback must not call critique() a second time.
 */
export async function executeCritique(
  sessionId: string,
  phone: string,
  message: string,
  armedAt: string
): Promise<RevealDelivery> {
  const store = resolveProfileStore();

  if (!(await stillArmed(store, phone, 'critique-running', armedAt))) {
    logger.info({
      event_type: 'sketchbot_sms.critique_superseded',
      phone_last4: phoneLast4(phone),
      session_id: sessionId,
    });
    return { cuts: [], closingText: '' };
  }

  // A reroll-set turn ("new ones") is a charged round, not a fix — the
  // service calls this port's reserve() only when the classifier says so,
  // and settles an exhausted meter as spoken copy. Only a linked texter has
  // a meter to stand behind it; unlinked, the service refuses in voice
  // toward the web link, mirroring the round lane's link gate.
  const armed = await store.get(phone);
  const uid = armed?.uid;
  const roundCredit = uid
    ? {
        reserve: () => reserveGenerationCredit(uid),
        release: (reservation: { id: string }) =>
          releaseGenerationCredit(uid, reservation as GenerationCreditReservation)
            .then(() => true)
            .catch((releaseError) => {
              logger.error({
                event_type: 'sketchbot_sms.reroll_credit_release_failed',
                phone_last4: phoneLast4(phone),
                session_id: sessionId,
                reservation_id: reservation.id,
                error:
                  releaseError instanceof Error ? releaseError.message : String(releaseError),
              });
              return false;
            }),
      }
    : undefined;

  let result;
  try {
    result = await critique(sessionId, { message }, roundCredit ? { roundCredit } : undefined);
  } catch (error) {
    const profile = await store.get(phone);
    if (profile && profile.revealArmedAt === armedAt) {
      profile.lastStage = 'revealed';
      profile.revealArmedAt = null;
      profile.updatedAt = new Date().toISOString();
      await store.save(profile);
    }
    logger.error({
      event_type: 'sketchbot_sms.critique_failed',
      phone_last4: phoneLast4(phone),
      session_id: sessionId,
      error: error instanceof Error ? error.message : String(error),
    });
    return { cuts: [], closingText: CRITIQUE_FAILED_TEXT };
  }

  const profile = (await store.get(phone)) ?? newProfile(phone);
  // Paid critique already ran — always deliver. Only claim profile state when
  // this job is still the armed one; do not clobber a newer arm.
  if (profile.revealArmedAt === armedAt) {
    profile.lastStage = 'revealed';
    profile.revealArmedAt = null;
    profile.updatedAt = new Date().toISOString();
    await store.save(profile);
  } else if (profile.revealArmedAt != null) {
    logger.info({
      event_type: 'sketchbot_sms.critique_superseded',
      phone_last4: phoneLast4(phone),
      session_id: sessionId,
    });
  }

  logger.info({
    event_type: 'sketchbot_sms.critique_delivered',
    phone_last4: phoneLast4(phone),
    session_id: sessionId,
    generated: result.generated,
    fixes_remaining: result.fixesRemaining,
  });

  // New cuts take the next numbers in the session's running order, so "5"
  // means to the texter exactly what the fifth tile means on the web. A
  // per-cut fix delivers one image; a reroll-set turn delivers the fresh
  // round's pair.
  const all = allCuts(result.session);
  const delivered = (result.cuts?.length ? result.cuts : result.cut ? [result.cut] : []).filter(
    (cut) => Boolean(cut.imageUrl)
  );
  return {
    // Positions come from allCuts — the canonical order both channels share
    // — not from "last N": a reroll's pair sits before any critique cuts.
    cuts: delivered.map((cut) => ({
      caption: cutCaption(
        all.findIndex((candidate) => candidate.id === cut.id),
        all.length
      ),
      mediaUrl: cut.imageUrl!,
    })),
    closingText: renderSmsReply(result.reply),
  };
}

async function conversationTurn(
  profile: SmsProfile,
  store: ProfileStoreT,
  body: string
): Promise<InboundOutcome> {
  const base = appBaseUrl();
  // Thread onto the active session only while it is still in conversational
  // intake; after a reveal (or handoff) a new text starts a new design.
  const continuable =
    profile.activeSessionId &&
    (profile.lastStage === 'chatting' || profile.lastStage === 'proposal');

  let response;
  try {
    response = await converse({
      ...(continuable ? { sessionId: profile.activeSessionId! } : {}),
      message: body,
    });
  } catch (error) {
    if (error instanceof DesignSessionError) {
      if (error.code === 'CONVERSATION_UNAVAILABLE') {
        return { kind: 'reply', text: unavailableText(`${base}/design`) };
      }
      // Stale thread (session advanced past intake, closed at handoff, or
      // expired from the store) — start fresh with the same message.
      try {
        response = await converse({ message: body });
      } catch (retryError) {
        if (
          retryError instanceof DesignSessionError &&
          retryError.code === 'CONVERSATION_UNAVAILABLE'
        ) {
          return { kind: 'reply', text: unavailableText(`${base}/design`) };
        }
        throw retryError;
      }
    } else {
      throw error;
    }
  }

  // Same per-turn budget line item as the web converse route; demo turns
  // run the engine's free script — nothing to record.
  if (!isDemoMode()) await recordConversationTurnSpend();

  const isNewSession = response.sessionId !== profile.activeSessionId;
  profile.activeSessionId = response.sessionId;
  profile.lastStage = response.stage;
  if (isNewSession && !profile.sessionIds.includes(response.sessionId)) {
    // The taste trail (ADR-0022): every session this phone drives is
    // reachable from the profile, so signals accrue across conversations.
    profile.sessionIds = [...profile.sessionIds, response.sessionId];
  }

  let text = renderSmsReply(response.reply);
  if (response.stage === 'handoff') {
    // The warm handoff closes the conversation (ADR-0021) — the CTA link
    // rides after the reply so tightening can never drop it.
    text = `${text} ${base}${response.handoffUrl ?? '/smart-match'}`;
    profile.activeSessionId = null;
    profile.lastStage = null;
  }

  profile.updatedAt = new Date().toISOString();
  await store.save(profile);

  logger.info({
    event_type: 'sketchbot_sms.turn',
    phone_last4: phoneLast4(profile.phone),
    session_id: response.sessionId,
    stage: response.stage,
    turn: response.turn,
  });

  return { kind: 'reply', text };
}

/**
 * The deferred half of a reveal: runs AFTER the webhook already answered
 * (a round's renders take minutes; Twilio gives webhooks seconds). The daily-cap
 * slot was reserved in armReveal — a failure here refunds it, tells the
 * user honestly, and never leaves them waiting on nothing.
 *
 * `armedAt` is the same token pattern as critique/refine: after stale
 * recovery a second yes may arm again, and this callback must not also run.
 */
export async function executeReveal(
  sessionId: string,
  phone: string,
  armedAt: string
): Promise<RevealDelivery> {
  const store = resolveProfileStore();

  if (!(await stillArmed(store, phone, 'reveal-pending', armedAt))) {
    // Refund only when this arm never delivered: stale recovery left
    // proposal, or a newer reveal arm replaced the token. A completed
    // reveal (revealed / pick / restart / …) already used the slot —
    // releasing here would hand back a free daily reveal.
    const profile = await store.get(phone);
    const abandonedBeforeGenerate =
      !!profile &&
      (profile.lastStage === 'proposal' ||
        (profile.lastStage === 'reveal-pending' &&
          profile.revealArmedAt != null &&
          profile.revealArmedAt !== armedAt));
    if (abandonedBeforeGenerate) {
      await store.releaseReveal(phone);
    }
    logger.info({
      event_type: 'sketchbot_sms.reveal_superseded',
      phone_last4: phoneLast4(phone),
      session_id: sessionId,
    });
    return { cuts: [], closingText: '' };
  }

  let session;
  try {
    session = await confirmProposal(sessionId);
  } catch (error) {
    // Refund the reserved cap slot. Always — this attempt failed. A newer
    // arm consumed a separate increment; one release leaves that intact.
    // Re-arm the proposal only when this job is still the armed one.
    // releaseReveal first, then re-read — saving a pre-release clone would
    // clobber the refunded counters.
    await store.releaseReveal(phone);
    const armed = await store.get(phone);
    if (armed && armed.revealArmedAt === armedAt) {
      const profile = (await store.get(phone)) ?? armed;
      profile.lastStage = 'proposal';
      profile.revealArmedAt = null;
      profile.updatedAt = new Date().toISOString();
      await store.save(profile);
    }
    logger.error({
      event_type: 'sketchbot_sms.reveal_failed',
      phone_last4: phoneLast4(phone),
      session_id: sessionId,
      error: error instanceof Error ? error.message : String(error),
    });
    return { cuts: [], closingText: REVEAL_FAILED_TEXT };
  }

  const profile = (await store.get(phone)) ?? newProfile(phone);
  // Paid render already ran — always deliver. Only claim profile state when
  // this job is still the armed one (or stale recovery left proposal).
  if (profile.revealArmedAt === armedAt) {
    profile.lastStage = 'revealed';
    profile.revealArmedAt = null;
    profile.updatedAt = new Date().toISOString();
    await store.save(profile);
  } else if (profile.revealArmedAt == null && profile.lastStage === 'proposal') {
    profile.lastStage = 'revealed';
    profile.updatedAt = new Date().toISOString();
    await store.save(profile);
  } else if (profile.revealArmedAt != null) {
    logger.info({
      event_type: 'sketchbot_sms.reveal_superseded',
      phone_last4: phoneLast4(phone),
      session_id: sessionId,
    });
  }

  const cutUrls = session.variations
    .map((variation) => variation.imageUrl)
    .filter((url): url is string => typeof url === 'string' && url.length > 0);

  // The bridge into the web session: a durable public share of the round's
  // cuts (/share/<id> — same store the web share flow writes). Falls back
  // to the design surface when no durable store is available.
  const link = await mintShareLink(session, profile, cutUrls);

  logger.info({
    event_type: 'sketchbot_sms.reveal_delivered',
    phone_last4: phoneLast4(phone),
    session_id: session.id,
    provider: session.provider,
    cuts: cutUrls.length,
  });

  // Round one of the pick-to-refine loop (ADR-0049): two cuts captioned by
  // their poles, then the A/B ask.
  const labels = roundPoleLabels(liveRound(session), session.variations);
  return {
    cuts: cutUrls.map((mediaUrl, index) => ({
      caption:
        index < 2
          ? roundCutCaption(index === 0 ? 'A' : 'B', labels[index])
          : cutCaption(index, cutUrls.length),
      mediaUrl,
    })),
    closingText: roundRevealText(labels[0], labels[1], link),
  };
}

async function mintShareLink(
  session: Awaited<ReturnType<typeof confirmProposal>>,
  profile: SmsProfile,
  cutUrls: string[]
): Promise<string> {
  const base = appBaseUrl();
  const fallback = `${base}/design`;
  if (cutUrls.length === 0) return fallback;
  const shareStore = resolveSharedDesignStore();
  if (!shareStore) return fallback;
  try {
    const shareId = randomUUID().slice(0, 10);
    const now = new Date().toISOString();
    const share: SharedDesign = {
      shareId,
      imageUrl: cutUrls[0],
      imageUrls: cutUrls,
      prompt: session.intake.subject || session.intake.meaning || session.variations[0].prompt,
      style: session.intake.styleTags[0],
      bodyPart: session.intake.placement,
      uid: profile.uid ?? null,
      generatedAt: now,
      sharedAt: now,
      shareUrl: `${base}/share/${shareId}`,
      views: 0,
    };
    await shareStore.save(share);
    return share.shareUrl;
  } catch (error) {
    logger.warn({
      event_type: 'sketchbot_sms.share_mint_failed',
      session_id: session.id,
      error: error instanceof Error ? error.message : String(error),
    });
    return fallback;
  }
}
