/**
 * Design-session orchestrator — the reveal + refinement round
 * (ADR-0012, ADR-0013, ADR-0016).
 *
 * Drives the one-way phase machine intake → revealed → picked → complete
 * over the frozen DesignSession contract, consuming intake, council, and
 * generation strictly through their public entry points.
 */
import { randomUUID } from 'crypto';
import { logger } from '@/lib/logger';
import { signingBucketName } from '@/services/gcs-service';
import { DEMO_MOCK_IMAGES } from '@/lib/demo-images';
import { extractIntake } from '../../intake';
import type { IntakeRecord, VariationAxis } from '../../intake/types';
import { settledAxes } from '../../intake/settledAxes';
import { enhanceStructured, enhanceRound } from '../../council';
import type { RoundSpread, StructuredEnhanceResult } from '../../council';
import { generate, routeGeneration } from '../../generation';
import type { AspectRatio, GenerationRequest } from '../../generation';
import { resolveFixAllowance } from '@/lib/studio-fix-allowance';
import type {
  Variation,
  RefineRound,
  StartSessionRequest,
  PickRequest,
  RoundPickRequest,
  RefineRequest,
  CritiqueRequest,
  CritiqueResult,
} from '../types';
import {
  COMPOSITION_AXIS,
  currentRound,
  isLadderAxis,
  nextRoundAxis,
  roundAxisLabel,
} from '../roundPlan';
import { resolveSessionStore, ROUND_CLAIM_STALE_MS } from './store';
import type { RoundClaim, SessionStore, StoredSession } from './store';
import { deriveRefinementQuestion, adjustPromptForAnswer } from './refinement';
import { derivePlacementNotes } from './placementNotes';
import { deriveStencil } from './stencil';
import { durableRender } from './durableImage';
import { guardRenderBytes } from '@/lib/renderGuard';
import { referenceImagePaths } from './references';
import { deleteReferencePhotos, signedReferenceUrls } from './referencePhotos';
import { recordImageSpend } from './spend';
import {
  allCuts,
  cutLabel,
  classifyCritiqueTurn,
  answerAddsRequest,
  readPendingCritique,
  stashPendingCritique,
} from './critique';
import { nextTake } from '../cutIdentity';
import type { DesignState } from './designState';
import {
  applyCritique,
  deriveDesignState,
  hydrateDesignState,
  renderStatePrompt,
  stateOmissions,
  withPickedCut,
} from './designState';
import {
  checkPromptContract,
  explainPromptContract,
  type PromptContractField,
} from './promptContract';
import {
  ALLOWANCE_SPENT_LINE,
  CHATTER_LINE,
  NAMED_BUT_NO_CHANGE_LINE,
  NO_SUCH_CUT_LINE,
  REROLL_DOWNGRADED_NOTE,
  REROLL_DOWNGRADED_REFUNDED_NOTE,
  REROLL_NEEDS_ACCOUNT_LINE,
  ROUND_IN_FLIGHT_LINE,
  UNTRANSLATED_LOOK_LINE,
  WHICH_CUT_LINE,
  fixLandedLine,
  fixesLeftLine,
  rerollLandedLine,
  wrongRenderLine,
} from './critiqueVoice';

export type DesignSessionErrorCode =
  | 'SESSION_NOT_FOUND'
  | 'INVALID_PHASE'
  | 'INVALID_VARIATION'
  | 'REFINEMENT_CLOSED'
  | 'ROUND_PICK_FROZEN'
  | 'ROUND_UNPICKED'
  | 'ROUND_IN_FLIGHT'
  | 'CONVERSATION_UNAVAILABLE';

const ERROR_STATUS: Record<DesignSessionErrorCode, number> = {
  SESSION_NOT_FOUND: 404,
  INVALID_PHASE: 409,
  INVALID_VARIATION: 400,
  REFINEMENT_CLOSED: 409,
  // The round machinery (ADR-0049): a frozen pick can never change — a
  // render already consumed it — and a round can't refine before its pick.
  ROUND_PICK_FROZEN: 409,
  ROUND_UNPICKED: 409,
  // A second charged round while one is rendering loses the claim race —
  // it must never double-charge or clobber the winner's state.
  ROUND_IN_FLIGHT: 409,
  // Every conversation provider is down — the route maps this to 503 and
  // the UI downgrades to the scripted intake (ADR-0019 degraded mode).
  CONVERSATION_UNAVAILABLE: 503,
};

/** Domain error — carries a stable code and the HTTP status routes should map it to. */
export class DesignSessionError extends Error {
  readonly code: DesignSessionErrorCode;
  readonly status: number;

  constructor(code: DesignSessionErrorCode, message: string) {
    super(message);
    this.name = 'DesignSessionError';
    this.code = code;
    this.status = ERROR_STATUS[code];
  }
}

/**
 * Demo mode swaps every paid render for a stock demo image while everything
 * else — intake, council, route resolution/pinning, the phase machine, the
 * ADR-0013 hard stop, persistence — runs the real code paths. Read lazily
 * per call, same as the store seam in ./store.
 */
function isDemoMode(): boolean {
  return process.env.NEXT_PUBLIC_DEMO_MODE === 'true';
}

/** Load a stored session or throw SESSION_NOT_FOUND (shared with ./conversation). */
export async function loadSession(store: SessionStore, sessionId: string): Promise<StoredSession> {
  const session = await store.get(sessionId);
  if (!session) {
    throw new DesignSessionError('SESSION_NOT_FOUND', `No design session '${sessionId}'.`);
  }
  return session;
}

/**
 * The late-bind ownership gate (#338 item 1). Routes call this after
 * authenticating and BEFORE any credit reserve or render: a mismatch must
 * refuse pre-charge. `stamp` is true only on charged actions — the first
 * authenticated charge binds the session to that uid; uncharged mutating
 * routes guard without binding, so the anonymous pre-payment flow stays
 * open. A mismatch (and a missing session) throws SESSION_NOT_FOUND, never
 * 403 — a stranger probing ids must not learn that an id exists.
 */
export async function claimSessionOwnership(
  sessionId: string,
  uid: string,
  opts?: { stamp?: boolean }
): Promise<void> {
  const store = resolveSessionStore();
  const result = await store.claimOwnership(sessionId, uid, opts?.stamp === true);
  if (result === 'mismatch' || result === 'missing') {
    if (result === 'mismatch') {
      // The one log of the event: uid of the refused caller, never the
      // owner's — enough to spot probing without pairing the two.
      logger.warn({
        event_type: 'design_session.ownership_refused',
        session_id: sessionId,
        caller_uid: uid,
      });
    }
    throw new DesignSessionError('SESSION_NOT_FOUND', `No design session '${sessionId}'.`);
  }
  if (result === 'stamped') {
    logger.info({
      event_type: 'design_session.ownership_stamped',
      session_id: sessionId,
    });
  }
}

/**
 * The prompt-contract fields whose CONTRADICTION refuses a paid render.
 *
 * Deliberately a subset. A contradiction on these is a flat disagreement
 * about the design itself — a monochrome state against a prompt commanding
 * colour, a forearm state against a prompt placing it on the back, a subject
 * the prompt denies — and their terms are distinctive enough that a term-level
 * read is trustworthy. `exclusions`, `composition`, `action`, `aspect`,
 * `visualTarget` and `directives` are held to the same check but only LOGGED,
 * because their values are prose whose individual words recur innocently
 * elsewhere in the prompt (see the measured 'flat' collision at the call
 * site). Widening this set is a decision to make on logged evidence that a
 * field's contradictions are real, not on the principle that more guarding is
 * better: a false refusal costs the customer their re-cut.
 */
const CONTRACT_BLOCKING_FIELDS = new Set<PromptContractField>([
  'subject',
  'roster',
  'identities',
  'palette',
  'medium',
]);

/**
 * A generation request pinned to the session's resolved model (ADR-0016).
 * Passing modelId explicitly skips routing, and provider fallback is off:
 * a failed render must surface, never silently cross providers mid-session
 * and poison the pick signal.
 */
/**
 * Screen every customer-facing render for lettering nobody asked for (#297).
 *
 * ON by default since the ADR-0048 routing switch — the flag-OFF era's
 * written condition ("flag-ON ships only with the routing change, never
 * before") is met by the change that moved the cast lane to nano-banana-2,
 * whose #318 verification measured unsolicited lettering on 2/20 corpus
 * outputs. Opt-OUT by setting RENDER_TEXT_GUARD=false; the spend it gates
 * (one vision call per render, occasional re-roll) is bounded by the guard's
 * own budget checks.
 */
function textGuardEnabled(): boolean {
  return process.env.RENDER_TEXT_GUARD !== 'false';
}

function pinnedRequest(
  pin: { modelId: string; aspectRatio?: AspectRatio },
  prompt: string,
  negativePrompt?: string,
  opts?: {
    /**
     * Let the render fall back to the pinned model's configured chain when
     * the model itself fails (ADR-0048). Never silent: the result's
     * fallbackUsed metadata is surfaced as the session's `downgraded` flag,
     * the reveal says so in copy, and the round's credit is released. Only
     * the two-cut rounds (the reveal and refineRound) opt in — the regen and
     * re-cut keep the strict pin, since a mid-round provider change is what
     * ADR-0016 still forbids (one provider per ROUND after the ADR-0052
     * amendment).
     */
    allowDowngrade?: boolean;
    /**
     * Freshly signed URLs of the session's reference photos (ADR-0050).
     * The pin bypasses routing, so the photos must ride the request
     * explicitly — the provider refuses loudly if the pinned model cannot
     * take them, which cannot happen in practice: photos force the
     * nano-banana pin at session start.
     */
    referenceImages?: string[];
  }
): GenerationRequest {
  return {
    prompt,
    negativePrompt,
    numImages: 1,
    modelId: pin.modelId,
    aspectRatio: pin.aspectRatio,
    allowProviderFallback: opts?.allowDowngrade === true,
    ...(opts?.referenceImages?.length ? { referenceImages: opts.referenceImages } : {}),
    ...(textGuardEnabled() ? { screenText: {} } : {}),
  };
}

/** The image-generation tier: detailed, degrading only if the Council dropped it. */
function generationPrompt(prompts: { simple?: string; detailed?: string; ultra?: string }): string {
  return prompts.detailed ?? prompts.simple ?? prompts.ultra ?? '';
}

/**
 * Start a session from the two scripted intake answers: extraction, then
 * the shared reveal path. This IS the ADR-0019 degraded mode — it stays
 * load-bearing as the LLM-down fallback for the conversational intake.
 */
export async function startSession(request: StartSessionRequest): Promise<StoredSession> {
  const intake = await extractIntake({
    placementAnswer: request.placementAnswer,
    meaningAnswer: request.meaningAnswer,
  });
  return startFromRecord(intake);
}

/**
 * The pixel guard, at the acceptance point (ADR-0023's question, asked of the
 * bytes instead of the prompt).
 *
 * `designBackdrop` has always known how to tell flash art on white from a
 * photograph of skin, but it only ran on opt-in surfaces the customer might
 * never open — the AR preview, the SMS composite — minutes to days after the
 * render was paid for. A re-cut that came back as somebody's forearm sailed
 * into the reveal grid unremarked. This runs the same measurement the moment
 * the provider answers, inside the render closure so a reused staged image is
 * not re-measured: it was guarded when it was bought.
 *
 * IT MEASURES; IT DOES NOT REJECT. The bytes are already billed against
 * BUDGET_MAX_SPEND_CENTS and a re-cut costs again, so discarding on this
 * verdict trades a possible bad image for a certain double charge — the
 * renderGuard header makes that argument and it is not this change's to
 * overturn. What arming buys is knowing at acceptance time instead of never;
 * `border_backdrop_fraction` is logged so an operator (and the nightly
 * review) can answer "how close to the line" without re-fetching anything.
 *
 * ONLY INLINE RENDERS ARE MEASURED, and the gap is logged rather than hidden.
 * Vertex returns `data:` URLs — the bytes are already in memory, so the check
 * costs a decode and no network. Replicate returns a hosted URL, and
 * measuring it would mean fetching an image we are about to copy anyway, from
 * inside a paid render path. Rather than let that lane report a quiet green,
 * it reports `not-measured` with the reason: a guard that cannot see
 * something must say so, which is the whole lesson of the roster-only net.
 *
 * Never throws. A guard must not be the reason a paid render fails to reach
 * the customer.
 */
async function guardRenderedImage(
  sessionId: string,
  tag: string,
  image: string | undefined
): Promise<void> {
  try {
    if (!image || !image.startsWith('data:')) {
      logger.info({
        event_type: 'design_session.render_guard',
        session_id: sessionId,
        cut_id: tag,
        measured: false,
        reason: image
          ? 'render guard skipped: provider returned a hosted URL, not inline bytes'
          : 'render guard skipped: provider returned no image',
      });
      return;
    }
    const bytes = Buffer.from(image.slice(image.indexOf(',') + 1), 'base64');
    const verdict = await guardRenderBytes(new Uint8Array(bytes));
    logger[verdict.passed ? 'info' : 'warn']({
      event_type: 'design_session.render_guard',
      session_id: sessionId,
      cut_id: tag,
      measured: true,
      passed: verdict.passed,
      kind: verdict.kind,
      border_backdrop_fraction: verdict.borderBackdropFraction,
      reason: verdict.reason,
    });
  } catch (err) {
    logger.warn({
      event_type: 'design_session.render_guard_errored',
      session_id: sessionId,
      cut_id: tag,
      error: (err as Error)?.message ?? String(err),
    });
  }
}

/**
 * Render one image and capture it durably (TAT-57). Nothing a provider hands
 * back is persistable as-is: Replicate URLs expire within the hour and Vertex
 * inline base64 blows past Firestore's ~1MB document cap. Every URL that
 * leaves this function is an object in our own bucket.
 *
 * `onPurchase` fires the moment the provider answers — before the durable
 * copy — because that is when the money is gone. A copy that then fails must
 * still be billed (see ./spend); a render reused from a previous attempt must
 * not be.
 *
 * It reports HOW MANY renders were bought, not merely that a purchase
 * happened, because one generate() call is no longer one render: the text
 * guard re-rolls inside it (#297), so a lettered first attempt costs two. The
 * count comes from the result's own `textGuardRerolls` rather than from a
 * guess here — spend.ts's comment that the orchestrator is the only thing
 * that knows how many renders were bought stopped being true when the
 * re-roll moved into the generation module, and this is how it stays honest.
 */
async function renderDurably(
  session: { id: string },
  tag: string,
  request: GenerationRequest,
  onPurchase: (renders: number) => void,
  onDowngrade?: (reason: string) => void,
  // Stable storage paths, NOT the request's signed URLs — the identity
  // must survive a re-mint or a retry never recovers its staged render.
  referencePaths?: string[]
): Promise<string> {
  const outcome = await durableRender(
    {
      sessionId: session.id,
      tag,
      prompt: request.prompt,
      negativePrompt: request.negativePrompt,
      modelId: request.modelId ?? '',
      ...(referencePaths?.length ? { referenceImagePaths: referencePaths } : {}),
    },
    async () => {
      const result = await generate(request);
      await guardRenderedImage(session.id, tag, result.images[0]);
      // Optional-chained on purpose: this is a BILLING read, and spend.ts's
      // rule is that the ledger must never break a render. A provider always
      // returns metadata, so the fallback is for malformed results only —
      // undercounting a re-roll is a cheaper failure than a failed reveal.
      onPurchase(1 + (result.metadata?.textGuardRerolls ?? 0));
      return {
        image: result.images[0],
        // A downgrade is a property of the IMAGE, not of this attempt: the
        // staging fingerprint keys on the REQUESTED modelId, so the fact
        // that a fallback model actually served it must travel in the staged
        // object's own metadata or a retry that reuses the object loses it —
        // undisclosed and unrefunded, the exact ADR-0048 failure.
        ...(result.metadata?.fallbackUsed
          ? { metadata: { downgradeReason: result.metadata.fallbackReason || 'PRIMARY_FAILED' } }
          : {}),
      };
    }
  );
  // Fired from the durable outcome, not the render call, so a staged image
  // recovered on a retry reports the downgrade of the render it reuses.
  // onPurchase deliberately stays inside render(): purchase describes this
  // attempt (a reuse buys nothing), downgrade describes the artifact.
  if (outcome.metadata.downgradeReason) {
    onDowngrade?.(outcome.metadata.downgradeReason);
  }

  return outcome.imageUrl;
}

/**
 * INTERNAL shared reveal path — everything a start does once an
 * IntakeRecord exists: Council structured enhancement → one route resolved
 * and pinned for the whole session (ADR-0016) → round one's two renders
 * (ADR-0049; demo mode: free stock images) → persist at phase 'revealed'.
 *
 * `base` upgrades an existing stored session in place — the conversational
 * intake's confirm (ADR-0020) — preserving its id, createdAt, and internal
 * conversation logs (ADR-0022). Omitted, a fresh session is created (the
 * legacy scripted startSession).
 */
export async function startFromRecord(
  intake: IntakeRecord,
  base?: StoredSession
): Promise<StoredSession> {
  const store = resolveSessionStore();
  const enhanced = await enhanceStructured(intake);

  // Reference photos attached during intake (ADR-0050). Paths are stable
  // session state; the fetchable signed URLs are minted per reveal, right
  // before the renders that consume them.
  const referencePaths = referenceImagePaths(base?.conversation?.references ?? []);

  // ADR-0016: resolve the route exactly once. Every render in this session
  // — every round's two cuts AND the later refinement regen — uses this
  // model; the pin is persisted so later rounds never re-route.
  const route = routeGeneration({
    prompt: '',
    // Presence forces the nano-banana lane — the only model whose
    // image_input can carry the photos. Routing reads only the count, so
    // the stable paths stand in for the yet-unminted signed URLs here.
    ...(referencePaths.length ? { referenceImages: referencePaths } : {}),
    // Intake tags are ordered by conversation/extraction, not by routing
    // importance. Passing the full set means ['color', 'anime'] still reaches
    // the anime-capable model instead of falling through on the generic tag.
    style: intake.styleTags,
    bodyPart: intake.placement,
    // Conversation intake fills requestedCharacters; scripted extractIntake
    // only fills characterIdentities. Fall back so 3+ catalog casts still
    // pin to the Gemini lane (#293) on the ADR-0019 degraded path.
    castSize:
      intake.requestedCharacters?.length ?? intake.characterIdentities?.length,
  });

  const demo = isDemoMode();
  const now = new Date().toISOString();
  const shell = base ?? { id: randomUUID(), createdAt: now };

  // Settled in a finally: a render that succeeded before a sibling threw was
  // still paid for. allSettled (rather than all) so every in-flight render is
  // accounted for before the failure surfaces.
  let imagesPurchased = 0;
  // Set when any reveal render fell back off the pinned model (ADR-0048).
  // One flag for the whole reveal: the session is downgraded if ANY of its
  // cuts came from the fallback lane, because the promise broken is "these
  // cuts are from the model your request routed to."
  let downgradeReason: string | undefined;
  let variations: Variation[];
  try {
    // Minted once for the whole reveal, loudly: a photo the customer sent
    // that cannot be fetched must fail the render, not silently vanish
    // from it (ADR-0050). Demo mode renders stock images and signs nothing.
    const referenceImages =
      !demo && referencePaths.length ? await signedReferenceUrls(referencePaths) : undefined;
    const results = await Promise.allSettled(
      enhanced.variations.map(async (structured, index): Promise<Variation> => {
        const prompt = generationPrompt(structured.prompts);
        const id = `v${index + 1}`;
        // Demo mode: repo-local stock image instead of a paid render. It is
        // already a permanent same-origin asset, so nothing to capture.
        let imageUrl: string;
        if (demo) {
          imageUrl = DEMO_MOCK_IMAGES[index % DEMO_MOCK_IMAGES.length];
        } else {
          imageUrl = await renderDurably(
            shell,
            id,
            pinnedRequest(route, prompt, structured.negativePrompt, {
              allowDowngrade: true,
              referenceImages,
            }),
            (renders) => { imagesPurchased += renders; },
            (reason) => { downgradeReason ??= reason; },
            referencePaths
          );
        }
        return {
          id,
          axisPosition: structured.axisPosition as Record<string, string>,
          prompt,
          negativePrompt: structured.negativePrompt,
          imageUrl,
        };
      })
    );
    const failure = results.find(result => result.status === 'rejected');
    if (failure) throw (failure as PromiseRejectedResult).reason;
    variations = results.map(result => (result as PromiseFulfilledResult<Variation>).value);
  } finally {
    await recordImageSpend(route.provider, imagesPurchased);
  }

  const session: StoredSession = {
    ...shell,
    phase: 'revealed',
    intake,
    // The design's state, established the moment there is a design (ADR-0060).
    // Everything the critique lane re-renders from starts here.
    state: deriveDesignState(intake),
    axisSelection: enhanced.axisSelection,
    provider: route.provider,
    pinnedModelId: route.modelId,
    pinnedAspectRatio: route.aspectRatio,
    variations,
    // Round one of the pick-to-refine loop (ADR-0049): the reveal IS the
    // first round. Its pick stays changeable until a next round is charged.
    rounds: [
      {
        round: 1,
        axis:
          enhanced.axisSelection.mode === 'questionnaire'
            ? enhanced.axisSelection.axes[0]
            : COMPOSITION_AXIS,
        variationIds: variations.map(variation => variation.id),
      },
    ],
    // Spread so the fields are absent (not undefined) on the happy path —
    // Firestore rejects explicit undefined values.
    ...(downgradeReason ? { downgraded: true, downgradeReason } : {}),
    updatedAt: now,
  };

  await store.save(session);
  return session;
}

/**
 * Record the pick + most-not-you tap, derive the ONE refinement question
 * from the picked variation's axis position, and move to phase 'picked'.
 */
export async function recordPick(sessionId: string, request: PickRequest): Promise<StoredSession> {
  const store = resolveSessionStore();
  const session = await loadSession(store, sessionId);

  if (session.phase !== 'revealed' && session.phase !== 'picked') {
    throw new DesignSessionError(
      'INVALID_PHASE',
      `Cannot record a pick while the session is '${session.phase}' — a pick is only valid before the final refinement.`
    );
  }

  const { pickId, mostNotYouId } = request;
  if (pickId === mostNotYouId) {
    throw new DesignSessionError(
      'INVALID_VARIATION',
      'pickId and mostNotYouId must be two different variations.'
    );
  }
  // Cuts the critique lane produced are pickable too (ADR-0039) — a re-cut
  // the user asked for is the likeliest thing they want to take forward.
  const cuts = allCuts(session);
  const picked = cuts.find(variation => variation.id === pickId);
  const rejected = cuts.find(variation => variation.id === mostNotYouId);
  if (!picked || !rejected) {
    throw new DesignSessionError(
      'INVALID_VARIATION',
      `Unknown variation id '${!picked ? pickId : mostNotYouId}' for session '${sessionId}'.`
    );
  }

  session.pickId = pickId;
  session.mostNotYouId = mostNotYouId;
  session.refinementQuestion = deriveRefinementQuestion(session, picked);
  session.phase = 'picked';
  session.updatedAt = new Date().toISOString();

  await store.save(session);
  return session;
}

/**
 * Record (or change) the live round's pick (ADR-0049). The pick itself is
 * free — a silent tap becomes a recorded signal — and stays changeable
 * until the next round is charged: refineRound freezes it at that moment,
 * because a render then consumes the picked image as a reference.
 */
export async function recordRoundPick(
  sessionId: string,
  request: RoundPickRequest
): Promise<StoredSession> {
  const store = resolveSessionStore();
  const session = await loadSession(store, sessionId);

  if (session.phase !== 'revealed') {
    throw new DesignSessionError(
      'INVALID_PHASE',
      `Cannot pick a round cut while the session is '${session.phase}' — rounds live between the reveal and the handoff.`
    );
  }
  // A pick landing while a round renders would be consumed stale: the
  // render already read the old pick, and the round's whole-document save
  // would silently revert this one (#338). Refuse loudly instead — the
  // new cuts land in a moment and the pick reopens with them.
  const inFlight = session.roundInFlight;
  if (inFlight && Date.now() - (Date.parse(inFlight.at) || 0) < ROUND_CLAIM_STALE_MS) {
    throw new DesignSessionError(
      'ROUND_IN_FLIGHT',
      `Session '${sessionId}' has a round rendering from the earlier pick — pick again when its cuts land.`
    );
  }

  let round = currentRound(session.rounds);
  if (!round) {
    if (session.variations.length === 0) {
      throw new DesignSessionError(
        'INVALID_PHASE',
        `Session '${sessionId}' has no cuts to pick against.`
      );
    }
    // A session revealed before rounds existed (stored pre-ADR-0049) must
    // not dead-end at its own reveal: synthesize round one from the legacy
    // cuts on first pick, so the pick — and every refine round after it —
    // works exactly as on a fresh session.
    round = {
      round: 1,
      axis:
        session.axisSelection.mode === 'questionnaire' && session.axisSelection.axes[0]
          ? session.axisSelection.axes[0]
          : COMPOSITION_AXIS,
      variationIds: session.variations.map(variation => variation.id),
    };
    session.rounds = [round];
    logger.info({
      event_type: 'design_session.legacy_round_synthesized',
      session_id: session.id,
      axis: round.axis,
      cut_count: round.variationIds.length,
    });
  }
  if (round.frozen) {
    throw new DesignSessionError(
      'ROUND_PICK_FROZEN',
      `Round ${round.round}'s pick is frozen — the next round already rendered from it.`
    );
  }
  if (!round.variationIds.includes(request.pickedId)) {
    throw new DesignSessionError(
      'INVALID_VARIATION',
      `Variation '${request.pickedId}' is not one of round ${round.round}'s cuts.`
    );
  }

  const now = new Date().toISOString();
  round.pickedId = request.pickedId;
  round.pickedAt = now;
  session.updatedAt = now;

  await store.save(session);
  return session;
}

/** A public GCS object URL split into its bucket and object path. */
function parseBucketUrl(
  imageUrl: string | undefined
): { bucket: string; path: string } | undefined {
  if (!imageUrl) return undefined;
  try {
    const url = new URL(imageUrl);
    if (url.hostname !== 'storage.googleapis.com') return undefined;
    // Shape: /<bucket>/<object path>
    const [, bucket, ...rest] = url.pathname.split('/');
    const path = rest.join('/');
    return bucket && path ? { bucket, path: decodeURIComponent(path) } : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The picked cut's object path for the ADR-0050/#333 signed-URL plumbing.
 *
 * The cut's URL carries its own bucket (imageStorageService's env chain)
 * while getSignedUrl signs against gcs-service's — the chains CAN drift,
 * and a drifted config would seed the round with a signed URL that 404s at
 * the provider. That is a config failure, so it fails the round loudly
 * (before anything is half-shown; the route releases the credit) instead
 * of rendering an unseeded round that quietly ignores the pick.
 *
 * A cut with no usable GCS URL at all is logged, never silent: the round
 * still renders, but the pick could not seed it.
 */
function pickedCutReferencePath(
  sessionId: string,
  picked: Variation
): string | undefined {
  const parsed = parseBucketUrl(picked.imageUrl);
  if (!parsed) {
    logger.warn({
      event_type: 'design_session.round_reference_unavailable',
      session_id: sessionId,
      variation_id: picked.id,
      image_url_host: (() => {
        try {
          return picked.imageUrl ? new URL(picked.imageUrl).hostname : 'absent';
        } catch {
          return 'unparseable';
        }
      })(),
    });
    return undefined;
  }
  const signingBucket = signingBucketName();
  if (parsed.bucket !== signingBucket) {
    throw new Error(
      `Picked cut lives in bucket '${parsed.bucket}' but reference URLs are signed ` +
        `against '${signingBucket}' — refusing to seed the round with a reference that ` +
        'would 404 at the provider (check GCS_BUCKET_NAME / GCP_STORAGE_BUCKET drift).'
    );
  }
  return parsed.path;
}

/** What one charged refine round produced (ADR-0049). */
export interface RefineRoundOutcome {
  session: StoredSession;
  /** The round just appended — the session's new live round. */
  round: RefineRound;
  /** True when the round's renders fell back off the pinned model (ADR-0048). */
  downgraded: boolean;
  downgradeReason?: string;
}

/**
 * One charged refine round (ADR-0049): freeze the previous round's pick,
 * spread two new cuts on the next ladder axis while holding every pole
 * picked so far, and seed both renders with the picked cut's image — the
 * customer's own reference photos stay attached alongside it (the picked
 * cut leads, the photos persist).
 *
 * The CREDIT is the route's job (reserveGenerationCredit before this call,
 * releaseGenerationCredit on failure or downgrade — same split as the
 * confirm route). Pass the reservation id in `opts`: it is persisted inside
 * the round claim, so a reservation orphaned by a crash mid-render is
 * reconcilable from the session record. There is no partial-charge path:
 * the two renders settle together, and a round that cannot deliver both
 * cuts throws with nothing persisted — the pick stays changeable and the
 * credit goes back.
 *
 * CONCURRENCY: exactly one charged round per session at a time. The slot is
 * claimed atomically (store.claimRound — a Firestore transaction, never the
 * last-write-wins save) BEFORE anything renders; a concurrent call throws
 * ROUND_IN_FLIGHT so its caller releases the credit it reserved, instead of
 * two rounds double-charging and clobbering each other's variation ids.
 */
export async function refineRound(
  sessionId: string,
  opts?: { reservationId?: string }
): Promise<RefineRoundOutcome> {
  const store = resolveSessionStore();
  const session = await loadSession(store, sessionId);

  if (session.phase !== 'revealed') {
    throw new DesignSessionError(
      'INVALID_PHASE',
      `Cannot run a refine round while the session is '${session.phase}' — rounds live between the reveal and the handoff.`
    );
  }
  const live = currentRound(session.rounds);
  if (!live) {
    throw new DesignSessionError(
      'INVALID_PHASE',
      `Session '${sessionId}' predates the round machinery — nothing to refine from.`
    );
  }
  if (!live.pickedId) {
    throw new DesignSessionError(
      'ROUND_UNPICKED',
      `Round ${live.round} has no pick yet — the pick is the signal the next round refines from.`
    );
  }
  const picked = session.variations.find(variation => variation.id === live.pickedId);
  if (!picked) {
    throw new DesignSessionError(
      'INVALID_VARIATION',
      `Session '${sessionId}' round pick no longer matches its variations.`
    );
  }

  const claim = await claimRoundSlot(store, session.id, opts?.reservationId);
  try {
    return await runClaimedRound(store, session, live, picked);
  } catch (error) {
    await releaseRoundSlot(store, session.id, claim.id);
    throw error;
  }
}

/**
 * Claim the single charged-round slot before anything paid runs — shared by
 * refineRound and rerollRound, which meter identically (one credit, one
 * round, two cuts). A live claim refuses with ROUND_IN_FLIGHT; a stale one
 * (crashed instance) is evicted with its orphaned reservation logged for
 * reconciliation.
 */
async function claimRoundSlot(
  store: SessionStore,
  sessionId: string,
  reservationId?: string
): Promise<RoundClaim> {
  const claim: RoundClaim = {
    id: randomUUID(),
    ...(reservationId ? { reservationId } : {}),
    at: new Date().toISOString(),
  };
  const claimed = await store.claimRound(sessionId, claim, ROUND_CLAIM_STALE_MS);
  if (claimed.status === 'missing') {
    throw new DesignSessionError('SESSION_NOT_FOUND', `No design session '${sessionId}'.`);
  }
  if (claimed.status === 'held') {
    throw new DesignSessionError(
      'ROUND_IN_FLIGHT',
      `Session '${sessionId}' already has a round rendering — one charged round at a time.`
    );
  }
  if (claimed.evicted) {
    logger.warn({
      event_type: 'design_session.round_claim_evicted',
      session_id: sessionId,
      stale_claim_id: claimed.evicted.id,
      // The fact that makes an orphaned charge reconcilable.
      orphaned_reservation_id: claimed.evicted.reservationId ?? null,
      claimed_at: claimed.evicted.at,
    });
  }
  return claim;
}

/**
 * Free the round slot after a failed round so the promised retry can
 * actually run. Best-effort: a release failure must not mask the render
 * failure, and a stuck claim self-heals via the stale window.
 */
async function releaseRoundSlot(
  store: SessionStore,
  sessionId: string,
  claimId: string
): Promise<void> {
  await store.releaseRound(sessionId, claimId).catch((releaseError) => {
    logger.error({
      event_type: 'design_session.round_claim_release_failed',
      session_id: sessionId,
      claim_id: claimId,
      error: releaseError instanceof Error ? releaseError.message : String(releaseError),
    });
  });
}

/** The claimed body of refineRound — everything after the slot is won. */
async function runClaimedRound(
  store: SessionStore,
  session: StoredSession,
  live: RefineRound,
  picked: Variation
): Promise<RefineRoundOutcome> {
  // Every pole picked so far, in round order — the next round holds all of
  // them (ADR-0049). Read off each picked cut's own axisPosition, so a
  // re-picked round contributes the pole actually chosen.
  const lockedPoles: Partial<Record<VariationAxis, string>> = {};
  for (const round of session.rounds ?? []) {
    if (!round.pickedId || !isLadderAxis(round.axis)) continue;
    const cut = session.variations.find(variation => variation.id === round.pickedId);
    const pole = cut?.axisPosition[round.axis];
    if (pole) lockedPoles[round.axis] = pole;
  }

  const roundNumber = (session.rounds?.length ?? 0) + 1;
  // Next OPEN rung of the ladder — round one may have led with an axis the
  // customer explicitly requested, so progression skips axes already spread
  // rather than replaying the ladder by index; and it skips rungs the brief
  // itself settled (ADR-0049), so a blackwork-committed session never pays
  // a credit for a color-blackwork round that contradicts its own palette
  // clause. When every rung is asked or settled, the round re-rolls on the
  // locked poles as usual.
  const axis = nextRoundAxis(
    session.axisSelection.mode,
    (session.rounds ?? []).map(round => round.axis),
    settledAxes(session.intake)
  ) as RoundSpread['axis'];
  const enhanced = await enhanceRound(session.intake, { roundNumber, axis, lockedPoles });

  const { cuts, downgradeReason } = await renderRoundCuts(session, enhanced, picked);

  // Both cuts delivered: NOW the previous pick freezes (ADR-0049 — a pick
  // is changeable until the next round is charged, and a failed round above
  // threw before persisting anything).
  const now = new Date().toISOString();
  live.frozen = true;
  const round: RefineRound = {
    round: roundNumber,
    axis,
    variationIds: cuts.map(cut => cut.id),
    // Spread so the fields are absent (not undefined) on the happy path.
    ...(downgradeReason ? { downgraded: true, downgradeReason } : {}),
  };
  session.variations = [...session.variations, ...cuts];
  session.rounds = [...(session.rounds ?? []), round];
  session.updatedAt = now;

  // This save is also the claim release: `session` was loaded before the
  // slot was claimed, so it carries no roundInFlight, and save() replaces
  // the whole document — delivering the round and freeing the slot in one
  // write.
  await store.save(session);
  return { session, round, downgraded: Boolean(downgradeReason), downgradeReason };
}

/**
 * The two-cut render core shared by refineRound and rerollRound: sign the
 * reference chain (the lead cut, when there is one, rides ahead of the
 * customer's own photos), render both cuts durably on the model pinned at
 * session start (ADR-0016 as amended by ADR-0052: one provider per round)
 * with the ADR-0048 loud-downgrade opt-in, and record spend in a finally.
 * There is no partial delivery: either both cuts come back or this throws
 * with nothing persisted — the caller's claim release and the route's
 * credit release do the rest.
 */
async function renderRoundCuts(
  session: StoredSession,
  enhanced: StructuredEnhanceResult,
  // The cut whose image leads the reference chain — the previous round's
  // pick for a refine round, a PRIOR round's frozen pick for a re-roll,
  // absent when nothing was ever picked.
  leadCut?: Variation,
  // Optional customer freetext threaded into both prompts (re-roll only).
  hint?: string
): Promise<{ cuts: Variation[]; downgradeReason?: string }> {
  const demo = isDemoMode();
  const baseIndex = session.variations.length;
  // Settled in a finally, same as the reveal: a render that succeeded before
  // a sibling threw was still paid for.
  let imagesPurchased = 0;
  let downgradeReason: string | undefined;
  let cuts: Variation[];
  try {
    // The reference chain (ADR-0049): the lead cut FIRST — it is already a
    // GCS object in our bucket, so it rides the exact ADR-0050/#333 private
    // signed-URL plumbing the customer's own photos use — and those photos
    // stay attached after it (nano-banana-2 takes multiple references).
    const photoPaths = referenceImagePaths(session.conversation?.references ?? []);
    // Bucket-verified (never a signed URL that 404s) and logged when the
    // cut has no usable GCS path; demo stock images seed nothing by design.
    const leadPath =
      demo || !leadCut ? undefined : pickedCutReferencePath(session.id, leadCut);
    const referencePaths = [...(leadPath ? [leadPath] : []), ...photoPaths];
    const referenceImages =
      !demo && referencePaths.length ? await signedReferenceUrls(referencePaths) : undefined;
    const results = await Promise.allSettled(
      enhanced.variations.map(async (structured, index): Promise<Variation> => {
        const prompt = withStyleHint(generationPrompt(structured.prompts), hint);
        // Ids continue the session's running order, so a number spoken over
        // SMS keeps meaning the same cut the web shows in that position.
        const id = `v${baseIndex + index + 1}`;
        let imageUrl: string;
        if (demo) {
          imageUrl = DEMO_MOCK_IMAGES[(baseIndex + index) % DEMO_MOCK_IMAGES.length];
        } else {
          imageUrl = await renderDurably(
            session,
            id,
            pinnedRequest(
              { modelId: session.pinnedModelId, aspectRatio: session.pinnedAspectRatio },
              prompt,
              structured.negativePrompt,
              { allowDowngrade: true, referenceImages }
            ),
            (renders) => { imagesPurchased += renders; },
            (reason) => { downgradeReason ??= reason; },
            referencePaths
          );
        }
        return {
          id,
          axisPosition: structured.axisPosition as Record<string, string>,
          prompt,
          negativePrompt: structured.negativePrompt,
          imageUrl,
        };
      })
    );
    const failure = results.find(result => result.status === 'rejected');
    if (failure) throw (failure as PromiseRejectedResult).reason;
    cuts = results.map(result => (result as PromiseFulfilledResult<Variation>).value);
  } finally {
    await recordImageSpend(session.provider, imagesPurchased);
  }
  return { cuts, downgradeReason };
}

/**
 * Thread an optional customer style hint into a render prompt — additive
 * only: the hint rides after the Council's prompt in the customer's own
 * words (the same verbatim posture designState keeps for a directive),
 * never replacing
 * any of it. Blank hints are no-ops.
 */
function withStyleHint(prompt: string, hint?: string): string {
  const words = (hint ?? '').trim().replace(/\s+/g, ' ');
  return words ? `${prompt} Customer direction: "${words}".` : prompt;
}

/**
 * One charged RE-ROLL round (sprint fix #2, session 0f6234e9): the customer
 * rejected the whole live set — "new ones", "new samples" — so draw two
 * fresh cuts on the SAME axis as the rejected round. Both cuts were
 * rejected, which means the axis question is still unanswered: the new
 * round re-asks it, and the rejected round keeps NO pick — the absence of a
 * pick IS the recorded signal (ADR-0049: the pick is the signal).
 *
 * Costs ONE generation credit, exactly like any round (ADR-0049: one
 * credit, one round, two cuts) — it is NOT a critique fix and never touches
 * the fix allowance. The route owns the credit with the same split as the
 * refine round: reserve before this call, release on failure or downgrade,
 * reservation id persisted inside the round claim. No partial-charge path:
 * both cuts settle together or this throws with nothing persisted.
 *
 * References: a re-roll seeds from the same inputs the REJECTED round used
 * — a prior round's frozen pick (if any) still leads, the customer's own
 * photos persist — never from the rejected cuts themselves (nothing was
 * picked, so nothing leads from that round).
 *
 * CONCURRENCY: the same claimRound gate as refineRound — a re-roll while
 * any round is in flight throws ROUND_IN_FLIGHT.
 *
 * `hint` is optional customer freetext ("new ones, more cinematic")
 * threaded additively into both prompts.
 */
export async function rerollRound(
  sessionId: string,
  opts?: { reservationId?: string; hint?: string }
): Promise<RefineRoundOutcome> {
  const store = resolveSessionStore();
  const session = await loadSession(store, sessionId);

  if (session.phase !== 'revealed') {
    throw new DesignSessionError(
      'INVALID_PHASE',
      `Cannot re-roll while the session is '${session.phase}' — rounds live between the reveal and the handoff.`
    );
  }
  const rejected = currentRound(session.rounds);
  if (!rejected) {
    throw new DesignSessionError(
      'INVALID_PHASE',
      `Session '${sessionId}' predates the round machinery — nothing to re-roll.`
    );
  }
  // Deliberately NO pick requirement — rejecting the set is exactly the
  // move a customer makes when they cannot pick.

  const claim = await claimRoundSlot(store, session.id, opts?.reservationId);
  try {
    return await runClaimedReroll(store, session, rejected, opts?.hint);
  } catch (error) {
    await releaseRoundSlot(store, session.id, claim.id);
    throw error;
  }
}

/** The claimed body of rerollRound — everything after the slot is won. */
async function runClaimedReroll(
  store: SessionStore,
  session: StoredSession,
  rejected: RefineRound,
  hint?: string
): Promise<RefineRoundOutcome> {
  const rounds = session.rounds ?? [];
  // Every pole locked by EARLIER rounds' picks — the rejected round locks
  // nothing: its whole set was refused, so its axis question is still open.
  // (A stray pick recorded before the customer changed their mind and
  // rejected the set is cleared below, so it never poisons later rounds.)
  const lockedPoles: Partial<Record<VariationAxis, string>> = {};
  for (const round of rounds) {
    if (round === rejected || !round.pickedId || !isLadderAxis(round.axis)) continue;
    const cut = session.variations.find(variation => variation.id === round.pickedId);
    const pole = cut?.axisPosition[round.axis];
    if (pole) lockedPoles[round.axis] = pole;
  }

  const roundNumber = rounds.length + 1;
  // SAME axis as the rejected round — the question it asked was never
  // answered, so the re-roll asks it again with two fresh draws.
  const axis = rejected.axis as RoundSpread['axis'];
  const enhanced = await enhanceRound(session.intake, { roundNumber, axis, lockedPoles });

  // Same reference inputs as the rejected round: the round BEFORE it
  // contributed the leading picked cut (if it had one); the rejected cuts
  // themselves seed nothing.
  const prior = rounds[rounds.indexOf(rejected) - 1];
  const leadCut = prior?.pickedId
    ? session.variations.find(variation => variation.id === prior.pickedId)
    : undefined;

  const { cuts, downgradeReason } = await renderRoundCuts(session, enhanced, leadCut, hint);

  const now = new Date().toISOString();
  // The rejection unrecords any stray pick: no pick may stand on the
  // rejected round (absence of pick = the signal), and unlike a refine
  // round nothing freezes — no render consumed a pick from this round.
  delete rejected.pickedId;
  delete rejected.pickedAt;
  const round: RefineRound = {
    round: roundNumber,
    axis: rejected.axis,
    variationIds: cuts.map(cut => cut.id),
    // Spread so the fields are absent (not undefined) on the happy path.
    ...(downgradeReason ? { downgraded: true, downgradeReason } : {}),
  };
  session.variations = [...session.variations, ...cuts];
  session.rounds = [...rounds, round];
  session.updatedAt = now;

  // Same one-write delivery-and-release as the refine round: `session` was
  // loaded before the claim, so save() also frees the slot.
  await store.save(session);
  return { session, round, downgraded: Boolean(downgradeReason), downgradeReason };
}

/**
 * The single refinement round (ADR-0013 hard stop): adjust the picked
 * variation's prompt from the answer, regenerate ONE image on the pinned
 * model, assemble the Brief, and close the session at phase 'complete'.
 * Any call when the phase is not 'picked' is a domain error — there is
 * never a second regen.
 */
export async function refine(sessionId: string, request: RefineRequest): Promise<StoredSession> {
  const store = resolveSessionStore();
  const session = await loadSession(store, sessionId);

  if (session.phase !== 'picked') {
    if (session.phase === 'complete') {
      throw new DesignSessionError(
        'REFINEMENT_CLOSED',
        'This session already used its one refinement round (ADR-0013 hard stop) — the canvas and the artist consult own everything after.'
      );
    }
    throw new DesignSessionError(
      'INVALID_PHASE',
      `Cannot refine while the session is '${session.phase}' — refinement follows a recorded pick.`
    );
  }

  const cuts = allCuts(session);
  const picked = cuts.find(variation => variation.id === session.pickId);
  if (!picked) {
    throw new DesignSessionError(
      'INVALID_VARIATION',
      `Session '${sessionId}' pick no longer matches its variations.`
    );
  }
  const rejected = cuts.find(variation => variation.id === session.mostNotYouId);

  const adjustedPrompt = adjustPromptForAnswer(session, picked, request.answer);
  let imageUrl: string | undefined;
  if (isDemoMode()) {
    // Demo regen: the stock image after the picked one, so the refinement
    // visibly changes the design without a paid render.
    const pickedIndex = cuts.indexOf(picked);
    imageUrl = DEMO_MOCK_IMAGES[(pickedIndex + 1) % DEMO_MOCK_IMAGES.length];
  } else {
    let imagesPurchased = 0;
    try {
      // The same photos that informed the reveal inform the regen — the
      // pin already guarantees a reference-capable model when any exist.
      const referencePaths = referenceImagePaths(session.conversation?.references ?? []);
      // ADR-0016: the regen reuses the exact model pinned at session start.
      imageUrl = await renderDurably(
        session,
        `${picked.id}-refined`,
        pinnedRequest(
          { modelId: session.pinnedModelId, aspectRatio: session.pinnedAspectRatio },
          adjustedPrompt,
          picked.negativePrompt,
          referencePaths.length
            ? { referenceImages: await signedReferenceUrls(referencePaths) }
            : undefined
        ),
        (renders) => { imagesPurchased = renders; },
        undefined,
        referencePaths
      );
    } finally {
      await recordImageSpend(session.provider, imagesPurchased);
    }
  }

  session.refinementAnswer = request.answer;
  session.refinedVariation = {
    id: `${picked.id}-refined`,
    axisPosition: picked.axisPosition,
    prompt: adjustedPrompt,
    negativePrompt: picked.negativePrompt,
    imageUrl,
  };
  // The artist's half of the deliverable, derived from the image the
  // customer just approved rather than re-prompted from text — see
  // internal/stencil.ts. Never throws: a missing stencil costs the artist
  // convenience, a raised error would cost the customer the refinement they
  // already paid for.
  const stencilUrl = imageUrl
    ? await deriveStencil(session.id, session.refinedVariation.id, imageUrl)
    : null;

  session.brief = {
    placement: session.intake.placement,
    styleTags: session.intake.styleTags,
    // Verbatim from intake — the brief carries the user's own words (ADR-0010).
    meaning: session.intake.meaning,
    references: session.intake.references,
    finalImageUrl: session.refinedVariation.imageUrl,
    ...(stencilUrl ? { stencilUrl } : {}),
    axisSelection: session.axisSelection,
    placementNotes: derivePlacementNotes(
      session.intake.placement,
      session.intake.styleTags,
      picked.axisPosition
    ),
    rejectedAxisPosition: rejected?.axisPosition,
  };
  session.phase = 'complete';
  // Same session-lifetime retention as the photos (#334): the customer's
  // free text in the working state is dropped at close. ONLY the two text
  // fields — roster and identities stay, they are the cast, not prose, and
  // Brief-adjacent surfaces still read them. The ADR-0013 hard stop means
  // no render can ever read directives again after this save.
  if (session.state) {
    session.state = { ...session.state, directives: [], exclusions: [] };
  }
  session.updatedAt = new Date().toISOString();

  await store.save(session);

  // ADR-0050: reference photos live for the life of the session, and the
  // session just closed. The Brief keeps the customer's words and the
  // product-owned design/stencil images — never the photo objects (#334).
  // After the save on purpose: a failed save must not orphan a session
  // whose photos are already gone.
  await deleteReferencePhotos(
    session.id,
    (session.conversation?.references ?? []).map((reference) => reference.imagePath)
  );
  return session;
}

/**
 * One post-reveal critique turn (ADR-0039): the chat that used to die at the
 * reveal, kept alive so plain criticism — "riku's missing", "too busy", "the
 * third one but less color" — lands somewhere useful.
 *
 * Deterministic throughout (see ./critique): resolve which cut the critique is
 * about, fold the user's own words into that cut's prompt, and regenerate ONE
 * image on the session's pinned model (ADR-0016). Three turns spend nothing —
 * chatter, an unresolvable target, and a spent allowance — and each says so in
 * voice (ADR-0038's rule: the ceiling is spoken and ends in an artist).
 *
 * Open at phases 'revealed' and 'picked' only. At 'complete' the ADR-0013
 * round has fired and produced the Brief; the Studio and the artist own
 * everything after.
 */
/**
 * How the critique lane pays for a fresh round (ADR-0049 metering reached
 * through the ADR-0056 front door). The credit is the CALLER's job
 * everywhere else — the round route and the SMS round arm reserve before
 * calling and release on failure or downgrade — but only the classifier
 * inside `critique` knows a turn needs one, so the channel hands in a PORT
 * instead of a reservation. `reserve` is called only on the reroll-set arm,
 * after every free settle has had its chance; it throws the
 * generation-credit primitive's own exhaustion error (code
 * `GENERATION_CREDITS_EXHAUSTED`, message = the meter line the SMS round
 * lane already sends verbatim). `release` resolves true only when the
 * refund actually landed, because copy claims a refund only when it is
 * true. Structural on purpose: the orchestrator never imports the credits
 * module, same as it never imports auth.
 */
export interface RoundCreditPort {
  reserve(): Promise<{ id: string }>;
  release(reservation: { id: string }): Promise<boolean>;
}

export async function critique(
  sessionId: string,
  request: CritiqueRequest,
  opts?: { roundCredit?: RoundCreditPort }
): Promise<{ session: StoredSession } & Omit<CritiqueResult, 'session'>> {
  const store = resolveSessionStore();
  const session = await loadSession(store, sessionId);

  if (session.phase !== 'revealed' && session.phase !== 'picked') {
    throw new DesignSessionError(
      'INVALID_PHASE',
      session.phase === 'complete'
        ? 'This session already closed with its Brief (ADR-0013 hard stop) — the Studio and the artist consult own everything after.'
        : `Cannot critique while the session is '${session.phase}' — there is nothing revealed to talk about yet.`
    );
  }

  const message = request.message.trim();
  const allowance = resolveFixAllowance();
  const used = session.fixesUsed ?? 0;
  const remainingBefore = Math.max(0, allowance - used);

  /**
   * The sentence a previous turn could not place, if THIS is the turn that was
   * asked to place it (astronaut session, 2026-08-26).
   *
   * Read before anything else so every arm below sees the same answer, and
   * cleared unconditionally in `settle` — a pending critique is one turn's
   * patience, not a standing instruction. Sessions stored before this field
   * existed simply have none.
   */
  const pending = readPendingCritique(session);

  /** Record the turn and persist without spending anything. */
  const settle = async (
    reply: string,
    extra: { targetId?: string; cutId?: string; pendingCritique?: string[] } = {}
  ) => {
    const now = new Date().toISOString();
    const { pendingCritique, ...turnFields } = extra;
    session.critiqueTurns = [
      ...(session.critiqueTurns ?? []),
      { message, reply, ...turnFields, at: now },
    ];
    // Every turn either consumes the held sentence or drops it. Only an arm
    // that just asked "which one?" hands one back, bound to the turn that must
    // answer it — the index it is bound to is the one THIS turn just filled.
    if (pendingCritique?.length) {
      session.pendingCritique = stashPendingCritique(
        pendingCritique,
        session.critiqueTurns.length,
        now
      );
    } else {
      delete session.pendingCritique;
    }
    session.updatedAt = now;
    await store.save(session);
    const remaining = Math.max(0, allowance - (session.fixesUsed ?? 0));
    return {
      session,
      reply,
      fixesRemaining: remaining,
      exhausted: remaining <= 0,
      generated: false as boolean,
    };
  };

  /**
   * The wired reroll-set arm (sprint fix #2 meeting ADR-0056): the customer
   * rejected the whole set, so draw a fresh round through rerollRound — one
   * generation credit through the caller's port, never the fix allowance.
   *
   * Money first, then render, then record: reserve through the port (an
   * exhausted meter settles with the primitive's own line, spending
   * nothing), run the executor with the reservation riding the round claim,
   * release on any failure or on the ADR-0048 loud downgrade, and only then
   * record the turn — on the session the re-roll SAVED, because `session`
   * up here predates the new round and save() replaces the document whole:
   * settling on it would clobber the round just delivered.
   */
  const settleRerollSet = async (styleHint: string) => {
    // ADR-0060 reaches this arm too, and it matters more here than in the
    // per-cut lane: "i was thinking more like an unreal engine 5 look" names
    // no cut, so it routes to a FRESH ROUND — a generation credit, not a fix.
    // Left alone, the hint rode to the render as the customer's raw words
    // appended to the Council's prompt, which is the exact append this ADR
    // rejects and the exact reason that request never landed.
    //
    // So the hint goes through the state object first: translated to concrete
    // controls when we know the look, and ASKED about — before any credit is
    // reserved — when we do not.
    let translatedHint = styleHint;
    // Held, not written to `session` — rerollRound loads and saves its OWN
    // copy, so anything set here before it runs is clobbered by the round it
    // persists. This lands on `fresh` below, beside the critique turn, for the
    // same reason the turn does.
    let rerolledState: DesignState | undefined;
    if (styleHint.trim()) {
      const applied = applyCritique(
        hydrateDesignState(session.state ?? deriveDesignState(session.intake), session.intake),
        styleHint
      );
      if (applied.unresolvedStyle) {
        // Nothing was rendered and nothing will be, so this settle owns the
        // save — writing the resolved fields here is safe and keeps the
        // customer from having to say them twice.
        session.state = applied.state;
        return settle(UNTRANSLATED_LOOK_LINE);
      }
      rerolledState = applied.state;
      // Their words AND the translation — the same posture designState keeps
      // for a directive (ADR-0010). The words alone never landed; the controls
      // alone would put our vocabulary in the customer's mouth.
      const controls = [
        applied.state.visualTarget && `rendered with ${applied.state.visualTarget}`,
        applied.state.exclusions.length > 0 && `avoiding ${applied.state.exclusions.join(', ')}`,
      ]
        .filter(Boolean)
        .join(', ');
      translatedHint = controls ? `${styleHint} — ${controls}` : styleHint;
    }

    const demo = isDemoMode();
    let reservation: { id: string } | undefined;
    if (!demo) {
      if (!opts?.roundCredit) {
        // The channel could not stand a meter behind this turn (today: an
        // unlinked texter). Refuse toward the path that works — never the
        // "which one am i fixing?" deadlock this arm exists to end.
        return settle(REROLL_NEEDS_ACCOUNT_LINE);
      }
      try {
        reservation = await opts.roundCredit.reserve();
      } catch (error) {
        const shaped = error as { code?: string; name?: string; message?: string };
        if (
          shaped.code === 'GENERATION_CREDITS_EXHAUSTED' ||
          shaped.name === 'GenerationCreditsExhaustedError'
        ) {
          // The primitive's meter line IS the honest copy — the same
          // sentence the SMS round lane sends for the same refusal.
          return settle((error as Error).message);
        }
        throw error;
      }
    }

    /** Hand the credit back; true only when the refund actually landed. */
    const release = async (): Promise<boolean> => {
      if (!reservation || !opts?.roundCredit) return false;
      return opts.roundCredit.release(reservation);
    };

    let outcome: RefineRoundOutcome;
    try {
      outcome = await rerollRound(sessionId, {
        ...(reservation ? { reservationId: reservation.id } : {}),
        ...(translatedHint ? { hint: translatedHint } : {}),
      });
    } catch (error) {
      const released = await release();
      if (error instanceof DesignSessionError && error.code === 'ROUND_IN_FLIGHT') {
        // Honest capacity: the claim gate serialized this ask behind a
        // running round, and the credit just went back.
        return settle(ROUND_IN_FLIGHT_LINE);
      }
      logger.error({
        event_type: 'design_session.critique_reroll_failed',
        session_id: sessionId,
        credit_released: released,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }

    // ADR-0048 loud downgrade: delivered off the pinned lane → not charged.
    const refunded = outcome.downgraded ? await release() : false;
    const charged = Boolean(reservation) && !refunded;
    const reply = [
      rerollLandedLine(roundAxisLabel(outcome.round.axis), charged),
      ...(outcome.downgraded
        ? [refunded ? REROLL_DOWNGRADED_REFUNDED_NOTE : REROLL_DOWNGRADED_NOTE]
        : []),
    ].join(' ');

    const fresh = outcome.session;
    const now = new Date().toISOString();
    // `fresh` was loaded and saved by rerollRound from its own read, so the
    // clear `settle` would have done never reached it. A re-roll is a new set;
    // a sentence held against the old one has no cut left to land on.
    delete fresh.pendingCritique;
    // The look the customer just asked for is state, not a property of this
    // round — the next per-cut fix has to render with it too (ADR-0060).
    if (rerolledState) fresh.state = rerolledState;
    fresh.critiqueTurns = [...(fresh.critiqueTurns ?? []), { message, reply, at: now }];
    fresh.updatedAt = now;
    await store.save(fresh);

    const remaining = Math.max(0, allowance - (fresh.fixesUsed ?? 0));
    return {
      session: fresh,
      reply,
      fixesRemaining: remaining,
      exhausted: remaining <= 0,
      generated: true as boolean,
      round: outcome.round,
      // In display order — the round's own order, resolved to full cuts so
      // both channels can present images without re-deriving them.
      cuts: outcome.round.variationIds
        .map(id => fresh.variations.find(variation => variation.id === id))
        .filter((cut): cut is Variation => Boolean(cut)),
    };
  };

  // The whole front door, decided once (ADR-0056). Every arm that is not a
  // per-cut fix settles without spending: this lane may only ever charge for a
  // render it actually bought.
  const intent = classifyCritiqueTurn(session, message);

  if (intent.kind === 'commentary') return settle(CHATTER_LINE);

  // Asked for a fresh set: a NEW two-cut round on the rejected round's own
  // axis (the set was refused whole, so the axis question is still open).
  // Deliberately ahead of the fix allowance: a fresh set is a generation
  // round (ADR-0049, one credit), not a fix. Gating it on the fix allowance
  // would refuse it with the wrong ceiling, out of the wrong budget.
  if (intent.kind === 'reroll-set') return settleRerollSet(intent.styleHint);

  // Refused before any paid call, and spoken — never a silent no-op. Ahead of
  // the ambiguous arms because at the ceiling the true thing to say is that
  // this is what an artist is for (ADR-0038), not "which one am i fixing?".
  if (remainingBefore <= 0) return settle(ALLOWANCE_SPENT_LINE);

  if (intent.kind === 'ambiguous') {
    // Two different failures, two different replies. `unplaceable-name` means
    // they named a cut we could not place — asking "which one am i fixing?"
    // there reads as not listening, and guessing costs a paid render on a
    // design they did not ask for (the "totem" turn).
    //
    // Either way the sentence is HELD (astronaut session, 2026-08-26). Asking
    // the question used to throw the critique away: the customer answered by
    // tapping, the client sent the tapped cut's name as the next message, and
    // the words "The bold one" became the entire Customer direction of a paid
    // render, while "i'm thinking more realistic looking and i wanna be able
    // to see the artists face" reached no model at all. Holding a sentence
    // costs nothing, so this stays a free turn.
    //
    // A second unplaceable turn ADDS to what is held rather than replacing it:
    // "riku's missing", then "and make it bigger", both said before any cut is
    // named, are two requests and the customer said both. A turn that only
    // tries (and fails) to name a cut adds nothing to hold. Either way the
    // held set is re-bound to the turn that comes next, and nothing carries
    // past it (readPendingCritique).
    //
    // And when NOTHING has been held — the whole conversation so far is
    // addresses that resolved to no request — an empty hold is the truthful
    // outcome. Stashing the contentless turn as if it were content meant a
    // later bare-address answer rendered it: "cut 9" (an address naming a
    // cut that does not exist, so it reaches this arm) became the entire
    // Customer direction of a paid render (Sonnet grill, 2026-08-27) — the
    // same money-for-an-address defect this commit's headline kills. Not
    // every contentless phrase gets here: "the other one" matches
    // REROLL_PATTERN and leaves on the reroll lane first.
    // settle() already deletes the stash when handed an empty list.
    const held = answerAddsRequest(message) ? [...pending, message] : pending;
    return settle(
      intent.because === 'unplaceable-name' ? NO_SUCH_CUT_LINE : WHICH_CUT_LINE,
      { pendingCritique: held }
    );
  }

  const target = intent.target;

  /**
   * The words this re-cut is built from — which are not always the words of
   * this turn (astronaut session, 2026-08-26).
   *
   * - `regenerate`: the turn reported that the render came back as the wrong
   *   thing. Their description of OUR mistake is not a brief, so nothing from
   *   it reaches the state; the state already says what the design is and the
   *   answer is to draw it again. Deliberately whole-sentence rather than
   *   "keep the field updates and drop the rest": every field resolver in
   *   designState reads the sentence as a description of the DESIGN, so
   *   "that's not what i asked for" mines an exclusion of "what i asked for",
   *   and a report of the wrong image describes the wrong image into the
   *   state. If they also wanted a change, the next turn carries it — for
   *   free, since this arm never asks them to repeat themselves.
   * - a held critique: they answered "which one am i fixing?" and the ANSWER
   *   is an address, not a request. The held sentence is the critique; the
   *   answer is applied beside it only when it asks for something of its own.
   *
   * Applied as SEPARATE turns, never concatenated: `applyCritique` reads one
   * message as one change, so "more realistic" glued to "and lose the flag"
   * resolves to the exclusion alone and silently drops the sentence we were
   * holding — the same disappearance this fix exists to end, one layer down.
   */
  const answerAsks = answerAddsRequest(message, cutLabel(session, target));
  const critiqueTexts: string[] =
    intent.reading === 'regenerate'
      ? pending
      : pending.length > 0
        ? answerAsks
          ? [...pending, message]
          : pending
        : [message];

  // An address with no request behind it, and nothing held to put on it —
  // "the bold one" and nothing else. There is no change to make, so there is
  // nothing to buy: ask the question that is actually missing, for free.
  //
  // This is the money hole under the astronaut session, closed at the bottom.
  // A tap that reaches this lane as the words "The bold one" used to resolve a
  // cut, find no field to move, and fall through to a paid render whose entire
  // Customer direction was the name of a cut. Whatever any channel does with a
  // tap, a turn that asks for nothing can no longer cost anything.
  if (intent.reading === 'apply' && pending.length === 0 && !answerAsks) {
    return settle(NAMED_BUT_NO_CHANGE_LINE, { targetId: target.id });
  }

  // ADR-0060: the re-cut is rendered from the WHOLE state, not from the
  // target's prompt with the critique bolted on the end. The critique moves a
  // field; the prompt is then a pure function of the object.
  //
  // Sessions revealed before ADR-0060 have no state — derive one from their
  // intake rather than leaving them on the old append path, so the fix reaches
  // sessions that are already open.
  //
  // hydrate on top of that, for the sessions in between: revealed WITH a state
  // object, but before that object had a `subject`. Deriving does not reach
  // them — they have a state, so `??` never fires — and without the backfill
  // their next re-cut renders the subject-less prompt that cost the astronaut
  // session two paid images. The fix has to reach a design already open in
  // someone's browser, not just the ones started after the deploy.
  const priorState = hydrateDesignState(
    session.state ?? deriveDesignState(session.intake),
    session.intake
  );
  // The cut they are fixing is the composition they chose; that becomes state
  // and stays attached to every re-cut after it.
  let nextState = withPickedCut(priorState, target);
  let unresolvedStyle: string | undefined;
  for (const text of critiqueTexts) {
    const applied = applyCritique(nextState, text);
    nextState = applied.state;
    unresolvedStyle ??= applied.unresolvedStyle;
  }

  // A look we have no translation for. Ask — do not paste it into the prompt
  // and charge for a render of a guess (ADR-0060). Free, like every other
  // arm that does not buy an image, and the field updates that DID resolve
  // are still persisted so the customer never has to say them twice.
  if (unresolvedStyle) {
    session.state = nextState;
    return settle(UNTRANSLATED_LOOK_LINE);
  }

  const adjustedPrompt = renderStatePrompt(nextState);

  // A state naming four characters and a prompt naming two is the exact
  // contradiction that made this ADR, and it is detectable before the money
  // is spent. Renderer bug if it ever fires — fail loudly rather than buy the
  // broken image and let the customer find it.
  //
  // The SUBJECT is checked by the same guard and for the same reason. A roster
  // -only check could never have caught the astronaut session: that request
  // named no franchise character, so the roster was empty, zero members went
  // missing, and this guard waved through a prompt with no subject in it at
  // all — twice, for real money. An empty roster is not evidence that nothing
  // was dropped.
  const omissions = stateOmissions(nextState, adjustedPrompt);
  if (omissions.roster.length > 0 || omissions.subject || omissions.meaning) {
    const dropped = [
      ...omissions.roster,
      ...(omissions.subject ? [`the subject (${omissions.subject})`] : []),
      ...(omissions.meaning ? [`the meaning (${omissions.meaning})`] : []),
    ];
    throw new Error(
      `designState render dropped ${dropped.join(', ')} from a state carrying ` +
        `${nextState.roster.length} roster member(s)${nextState.subject ? ' and a subject' : ''} — ` +
        'refusing to spend a render on a prompt that contradicts the state object (ADR-0060).'
    );
  }

  // The same pre-spend question, widened. `stateOmissions` above is verbatim
  // containment over three fields; the contract asks it at term level over
  // every field the state asserts — palette, medium, composition, aspect,
  // exclusions, directives — and distinguishes a term that VANISHED from one
  // the prompt says with the opposite polarity. A roster-only net blessed the
  // astronaut prompt; a three-field net still blesses a state asserting
  // "blackwork, no color" against a prompt commanding "full color fills".
  //
  // WHY ONLY SOME CONTRADICTIONS REFUSE THE SPEND. Term-level matching cannot
  // tell which clause a word belongs to, and the fixed presentation lead
  // (ADR-0023) opens every prompt with "a flat scan of the artwork alone".
  // Measured on this branch: a state carrying the built-in exclusion
  // 'flat cel-shaded outlines' renders correctly as "Avoid: flat cel-shaded
  // outlines." and STILL reports contradicted:["flat"], because the word is
  // asserted elsewhere about the scan rather than the outlines. That is a
  // false positive on the happy path, and a guard that breaks live sessions
  // on one is a guard someone switches off. So the refusal is scoped to the
  // fields whose terms are distinctive enough for the read to be trustworthy;
  // everything else is logged with the same detail and escalates on evidence,
  // not on principle (#388 tracks the clause-scoped polarity fix).
  const contract = checkPromptContract(nextState, adjustedPrompt);
  const blocking = contract.violations.filter(
    violation =>
      violation.contradicted.length > 0 && CONTRACT_BLOCKING_FIELDS.has(violation.field)
  );
  if (contract.violations.length > 0) {
    // checked_fields rides along because "1 violation" over one checked field
    // and over eight are different claims about how much was verified.
    logger.warn({
      event_type: 'design_session.prompt_contract_violation',
      session_id: session.id,
      cut_id: target.id,
      blocking: blocking.length > 0,
      fields: contract.violations.map(violation => violation.field),
      checked_fields: contract.checkedFields,
      unverifiable_fields: contract.unverifiableFields,
      subject_assertion: contract.subjectAssertion,
      detail: explainPromptContract(contract),
    });
  }
  if (blocking.length > 0) {
    throw new Error(
      `designState render contradicts the state object on ${blocking
        .map(violation => violation.field)
        .join(', ')} — refusing to spend a render. ${explainPromptContract(contract)}`
    );
  }

  const cutId = `${target.id}-fix${used + 1}`;
  // A re-cut is a TAKE of the cut it revises, not a nameless copy of it. The
  // poles still describe the treatment — same design, one take later — so they
  // are still copied below; what changes is that the take number rides with
  // them, so `cutIdentity` can call this "the bold one, take 2" instead of a
  // second "the bold one". Two cuts sharing a name is a `missed` in the
  // resolver, which is how the astronaut session's re-cuts ended up reachable
  // by neither name nor number.
  const take = nextTake(session, target);

  let imageUrl: string | undefined;
  if (isDemoMode()) {
    // Demo re-cut: the stock image after the target's, so the fix visibly
    // changes the design without a paid render.
    const index = allCuts(session).indexOf(target);
    imageUrl = DEMO_MOCK_IMAGES[(index + 1) % DEMO_MOCK_IMAGES.length];
  } else {
    // ADR-0016: the re-cut reuses the exact model pinned at session start.
    // It goes through renderDurably for the same reason every other render
    // does — a provider URL dies in an hour, and a re-cut is the image the
    // customer asked for by name, so it is the LAST one that may expire.
    let purchased = 0;
    try {
      // The same photos that informed the reveal inform the re-cut.
      const referencePaths = referenceImagePaths(session.conversation?.references ?? []);
      imageUrl = await renderDurably(
        session,
        cutId,
        pinnedRequest(
          { modelId: session.pinnedModelId, aspectRatio: session.pinnedAspectRatio },
          adjustedPrompt,
          target.negativePrompt,
          referencePaths.length
            ? { referenceImages: await signedReferenceUrls(referencePaths) }
            : undefined
        ),
        (renders) => {
          purchased += renders;
        },
        undefined,
        referencePaths
      );
    } finally {
      // Billed at the moment of purchase, so a copy that fails after a paid
      // render still records the money; a reuse records nothing.
      await recordImageSpend(session.provider, purchased);
    }
  }

  const cut: Variation = {
    id: cutId,
    axisPosition: target.axisPosition,
    prompt: adjustedPrompt,
    negativePrompt: target.negativePrompt,
    imageUrl,
    // The lineage root, so a take of a take still points at the cut the whole
    // line came from.
    revisionOf: target.revisionOf ?? target.id,
    revision: take,
  };
  session.critiqueCuts = [...(session.critiqueCuts ?? []), cut];
  // The state that produced this cut is the state the session carries forward
  // — persisted only now, because a render that threw must not leave the
  // design claiming a change the customer never saw.
  session.state = nextState;
  // Only a render that came back counts against the allowance — same rule the
  // Studio's ledger follows.
  session.fixesUsed = used + 1;

  const remainingAfter = Math.max(0, allowance - session.fixesUsed);
  // Named with the same string the grid puts under the cut — including a take
  // number, now that re-cuts have one. The reply used to say "that last one"
  // for every re-cut, because `cutLabel` searched the reveal cuts only: the
  // one vocabulary this lane is supposed to share with the grid, unshared.
  const targetName = cutLabel(session, target);
  const settled = await settle(
    `${
      intent.reading === 'regenerate'
        ? wrongRenderLine(targetName)
        : fixLandedLine(targetName)
    } ${fixesLeftLine(remainingAfter)}`,
    { targetId: target.id, cutId }
  );
  return { ...settled, cut, generated: true };
}

/** Fetch a session by id. Throws SESSION_NOT_FOUND when it doesn't exist. */
export async function getSession(sessionId: string): Promise<StoredSession> {
  return loadSession(resolveSessionStore(), sessionId);
}

/**
 * Attach the placement-preview screenshot URL to a completed session's
 * Brief. The preview is a canvas artifact, not a regen — it does not touch
 * the ADR-0013 hard stop, and re-placing overwrites the previous preview.
 * Only allowed at phase 'complete': the Brief is what carries it into the
 * booking record, and the Brief only exists after the refinement round.
 */
export async function attachPlacementPreview(
  sessionId: string,
  previewUrl: string
): Promise<StoredSession> {
  const store = resolveSessionStore();
  const session = await loadSession(store, sessionId);

  if (session.phase !== 'complete' || !session.brief) {
    throw new DesignSessionError(
      'INVALID_PHASE',
      `Cannot attach a placement preview while the session is '${session.phase}' — the preview belongs to the finished Brief.`
    );
  }

  session.brief.placementPreviewUrl = previewUrl;
  session.updatedAt = new Date().toISOString();

  await store.save(session);
  return session;
}
