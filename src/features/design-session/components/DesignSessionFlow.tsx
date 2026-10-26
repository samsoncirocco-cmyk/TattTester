'use client';

import { useState } from 'react';
import type { DesignSession } from '@/services/designSession/types';
import { refineInviteLine } from '@/services/designSession/roundPlan';
import { settledAxes } from '@/services/intake/settledAxes';
import type { ConversationMessage } from '@/services/designConversation';
import {
  startSession,
  submitCritique,
  submitPick,
  submitRoundPick,
  runRefineRound,
  submitRefinement,
  DesignSessionRequestError,
} from '../services/designSessionApi';
import { CREDITS_EXHAUSTED_CODE } from '@/lib/generation-credits-shared';
import { creditSplitLabel, useCreditBalance } from '../services/creditBalance';
import { BuyCreditsLink } from './CreditBalance';
import type { SessionRendering } from '@/services/designSession/resumeContract';
import {
  LOST_RENDER_LINE,
  RENDER_DID_NOT_LAND_LINE,
  useSessionPoll,
  type ResumeFetchResult,
} from '../services/sessionResume';
import { revealNarration } from '../services/revealNarration';
import { ChatBubble } from './ChatBubble';
import { ChatInput } from './ChatInput';
import { ThinkingLine } from './ThinkingLine';
import { GeneratingBeat, REVEAL_BEAT_LINES, REFINE_BEAT_LINES } from './GeneratingBeat';
import { RevealGrid, type RevealMode } from './RevealGrid';
import { RefinementPrompt } from './RefinementPrompt';
import { HandoffCard } from './HandoffCard';
import { PlacementPreview } from './PlacementPreview';

// ADR-0009: exactly two opening questions — placement and meaning — rendered
// as conversation, never labeled form fields.
const QUESTION_PLACEMENT = 'Where does it go?';
const QUESTION_MEANING = 'And what do you want to feel when you look at it?';

/** The round prompt (ADR-0049 acceptance copy) — two cuts, one axis, one tap. */
export const ROUND_PROMPT = 'Two cuts. Tap the one that’s closer.';

/** The charged-round button (ADR-0049 acceptance copy). */
export const REFINE_BUTTON_LABEL = 'Refine — 1 credit';

/** "Refine — 1 credit · 18 left" once the balance is known (spec 8). */
export function refineButtonLabel(balance: { known: boolean; total: number }): string {
  return balance.known ? `${REFINE_BUTTON_LABEL} · ${balance.total} left` : REFINE_BUTTON_LABEL;
}

/**
 * The way OUT of the loop: locks the round pick as the session's pick (the
 * other cut is the implicit most-not-you) and opens the one ADR-0013
 * refinement question toward the Brief.
 */
export const LOCK_IN_LABEL = 'Lock it in';

/**
 * The ADR-0048 loud downgrade, on web: the round rendered off the pinned
 * lane, and the refund line is only spoken when the release actually
 * landed — same honesty rule as the SMS wording.
 */
export const ROUND_DOWNGRADED_REFUNDED_NOTICE =
  'heads up — this round came off my backup lane, so that credit is back.';
export const ROUND_DOWNGRADED_NOTICE =
  'heads up — this round came off my backup lane.';

/**
 * The invitation that keeps the chat alive past the reveal (ADR-0039). Says
 * the feature out loud with the exact kind of sentence it accepts — nobody
 * types criticism at a screen that never offered to hear it.
 */
export const CRITIQUE_INVITE =
  "and if something's off, just say it — ‘riku’s missing’, ‘too busy’, ‘the third one but less color’. i’ll re-cut it.";

export const CRITIQUE_PLACEHOLDER = 'tell me what’s wrong with it…';

/** Where a session handed in from outside opens (spec 7 resume). */
function initialStepFor(session: DesignSession, rendering?: SessionRendering): FlowStep {
  if (session.phase === 'complete') return 'complete';
  if (session.phase === 'picked') return 'refine';
  if (rendering?.kind === 'round' && !rendering.stale) return 'rounding';
  return 'reveal';
}

type FlowStep =
  | 'ask-placement'
  | 'ask-meaning'
  | 'starting'
  | 'reveal'
  | 'round-picking'
  | 'rounding'
  | 'picking'
  | 'refine'
  | 'refining'
  | 'complete';

/** The in-flight session call, kept around so a failed one can be retried. */
type SessionAction =
  | { kind: 'start'; placement: string; meaning: string }
  | { kind: 'round-pick'; sessionId: string; pickedId: string }
  | { kind: 'round'; sessionId: string }
  | { kind: 'pick'; sessionId: string; pickId: string; mostNotYouId: string }
  | { kind: 'refine'; sessionId: string; answer: string };

/**
 * The design session as one conversation: intake → working state → the
 * pick-to-refine loop (ADR-0049: two cuts a round, the tap picks a pole,
 * REFINE charges one credit and seeds the next round with the picked image)
 * → lock-in → one refinement round → hard-stop handoff (ADR-0013). State
 * only ever moves forward, except the loop itself, which the credit meter
 * ends.
 *
 * The scripted two-question intake here is the LLM-down degraded mode
 * (ADR-0019); the live conversational intake (DesignConversation) hands an
 * already-revealed session in via `initialSession`, which starts this flow
 * at the reveal with the intake transcript owned by the conversation.
 */
export function DesignSessionFlow({
  initialSession,
  resumeRendering,
}: {
  initialSession?: DesignSession;
  /** A render the server was still running when this session was resumed (spec 7). */
  resumeRendering?: SessionRendering;
} = {}) {
  const scriptedIntake = initialSession == null;
  const [step, setStep] = useState<FlowStep>(
    initialSession ? initialStepFor(initialSession, resumeRendering) : 'ask-placement'
  );
  // Spec 7: a resumed round that is still running is waited on by polling
  // the session; a round whose claim went stale is offered again instead.
  const [awaitingRound, setAwaitingRound] = useState(
    resumeRendering?.kind === 'round' && !resumeRendering.stale
  );
  const [placementAnswer, setPlacementAnswer] = useState('');
  const [meaningAnswer, setMeaningAnswer] = useState('');
  const [session, setSession] = useState<DesignSession | null>(initialSession ?? null);
  const [error, setError] = useState<string | null>(null);
  // The failed call's route code, so an empty meter gets the buy link
  // rather than a Retry that can only fail again (spec 8).
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const [lastAction, setLastAction] = useState<SessionAction | null>(null);
  const balance = useCreditBalance();
  const outOfCredits = balance.known && balance.total === 0;
  // The ADR-0048 downgrade notice for the latest charged round — spoken,
  // never swallowed; cleared by the next action.
  const [roundNotice, setRoundNotice] = useState<string | null>(
    resumeRendering?.kind === 'round' && resumeRendering.stale ? LOST_RENDER_LINE : null
  );
  // The critique lane (ADR-0039): its own transcript below the reveal, so the
  // round taps and the typed criticism read as one conversation.
  const [critiqueLog, setCritiqueLog] = useState<ConversationMessage[]>([]);
  const [critiquePending, setCritiquePending] = useState(false);
  // The critique lane hit an empty meter: its spoken line gets the link.
  const [critiqueBuyLink, setCritiqueBuyLink] = useState(false);

  // The live round (ADR-0049): the only one whose pick can still change.
  const liveRound = session?.rounds?.[session.rounds.length - 1];
  // Sessions revealed before rounds existed fall back to all variations.
  const roundCuts = session
    ? liveRound
      ? session.variations.filter((variation) => liveRound.variationIds.includes(variation.id))
      : session.variations
    : [];
  const roundPickId = liveRound?.pickedId;

  /** The resumed round settled: new cuts landed, or it failed or died. */
  const settleRound = (result: ResumeFetchResult) => {
    if (result.status !== 'found') return;
    const rendering = result.resume?.rendering;
    if (rendering && !rendering.stale) return;
    const landed = (result.session.rounds?.length ?? 0) > (session?.rounds?.length ?? 0);
    setAwaitingRound(false);
    setSession(result.session);
    setStep(initialStepFor(result.session));
    if (!landed) setRoundNotice(rendering?.stale ? LOST_RENDER_LINE : RENDER_DID_NOT_LAND_LINE);
  };
  useSessionPoll(session?.id, awaitingRound, settleRound);

  const runAction = (action: SessionAction) => {
    setError(null);
    setErrorCode(null);
    setLastAction(action);
    setRoundNotice(null);

    let call: Promise<DesignSession>;
    let nextStep: FlowStep;
    if (action.kind === 'start') {
      setStep('starting');
      call = startSession({ placementAnswer: action.placement, meaningAnswer: action.meaning });
      nextStep = 'reveal';
    } else if (action.kind === 'round-pick') {
      setStep('round-picking');
      call = submitRoundPick(action.sessionId, { pickedId: action.pickedId });
      nextStep = 'reveal';
    } else if (action.kind === 'round') {
      setStep('rounding');
      // The ADR-0048 facts ride the envelope: a downgraded round is said
      // out loud, and the refund is only claimed when it landed.
      call = runRefineRound(action.sessionId).then((result) => {
        if (result.downgraded) {
          setRoundNotice(
            result.creditReleased ? ROUND_DOWNGRADED_REFUNDED_NOTICE : ROUND_DOWNGRADED_NOTICE
          );
        }
        return result.session;
      });
      nextStep = 'reveal';
    } else if (action.kind === 'pick') {
      setStep('picking');
      call = submitPick(action.sessionId, {
        pickId: action.pickId,
        mostNotYouId: action.mostNotYouId,
      });
      nextStep = 'refine';
    } else {
      setStep('refining');
      call = submitRefinement(action.sessionId, { answer: action.answer });
      nextStep = 'complete';
    }

    call
      .then((next) => {
        setSession(next);
        setStep(nextStep);
      })
      .catch((err: unknown) => {
        setErrorCode(err instanceof DesignSessionRequestError ? err.code : null);
        setError(err instanceof Error ? err.message : 'Something snapped — try again.');
      });
  };

  const handlePlacement = (text: string) => {
    setPlacementAnswer(text);
    setStep('ask-meaning');
  };

  const handleMeaning = (text: string) => {
    setMeaningAnswer(text);
    runAction({ kind: 'start', placement: placementAnswer, meaning: text });
  };

  /**
   * A tap on a round cut records (or changes) the round's pick — free and
   * changeable until the next round is charged (ADR-0049). Cuts outside the
   * live round (critique re-cuts) re-target the pick only through the old
   * pick machinery at lock-in time, so a tap there is ignored here.
   */
  const handleGridSelect = (variationId: string) => {
    if (step !== 'reveal' || !session) return;
    if (!roundCuts.some((cut) => cut.id === variationId)) return;
    if (variationId === roundPickId) return;
    runAction({ kind: 'round-pick', sessionId: session.id, pickedId: variationId });
  };

  /** The charged next round — 1 credit, seeded by the picked cut. */
  const handleRefineRound = () => {
    if (!session) return;
    runAction({ kind: 'round', sessionId: session.id });
  };

  /**
   * Lock the round pick in as the session's pick and head for the Brief:
   * with two cuts the unpicked one IS the most-not-you — one clean negative
   * signal, no extra tap.
   */
  const handleLockIn = () => {
    if (!session || !roundPickId) return;
    const other = roundCuts.find((cut) => cut.id !== roundPickId);
    if (!other) return;
    runAction({
      kind: 'pick',
      sessionId: session.id,
      pickId: roundPickId,
      mostNotYouId: other.id,
    });
  };

  /**
   * One critique turn (ADR-0039). Deliberately outside `runAction`: it never
   * moves the phase machine, and a failed critique must not strand the reveal
   * behind the retry banner — the lane just says so and stays open.
   */
  const handleCritique = (text: string) => {
    if (!session || critiquePending) return;
    setCritiqueLog((prev) => [...prev, { role: 'user', text }]);
    setCritiquePending(true);
    submitCritique(session.id, { message: text })
      .then((result) => {
        setSession(result.session);
        setCritiqueLog((prev) => [...prev, { role: 'bot', text: result.reply }]);
        setCritiqueBuyLink(result.buyCredits === true);
      })
      .catch((err: unknown) => {
        setCritiqueLog((prev) => [
          ...prev,
          {
            role: 'bot',
            text: err instanceof Error ? err.message : 'that one snapped — say it again?',
          },
        ]);
      })
      .finally(() => setCritiquePending(false));
  };

  const gridMode: RevealMode = step === 'reveal' ? 'pick' : 'locked';
  const showGrid =
    session !== null &&
    (step === 'reveal' || step === 'round-picking' || step === 'picking');
  // Open from the reveal until the Brief exists — at 'complete' the ADR-0013
  // hard stop has fired and the handoff owns the screen.
  const showCritique =
    session !== null && (step === 'reveal' || step === 'refine');
  const critiqueCuts = session?.critiqueCuts ?? [];

  return (
    <div className="space-y-5">
      {/* Scripted intake transcript (skipped when the live conversation
          already ran intake and handed a revealed session in). */}
      {scriptedIntake && (
        <>
          <ChatBubble role="bot">{QUESTION_PLACEMENT}</ChatBubble>
          {placementAnswer && <ChatBubble role="user">{placementAnswer}</ChatBubble>}
          {step !== 'ask-placement' && <ChatBubble role="bot">{QUESTION_MEANING}</ChatBubble>}
          {meaningAnswer && <ChatBubble role="user">{meaningAnswer}</ChatBubble>}

          {step === 'ask-placement' && (
            <ChatInput
              placeholder="Forearm, ribs, behind the ear…"
              ariaLabel="Where does it go?"
              onSubmit={handlePlacement}
            />
          )}
          {step === 'ask-meaning' && (
            <ChatInput
              placeholder="Say it however it comes out…"
              ariaLabel="What do you want to feel?"
              onSubmit={handleMeaning}
            />
          )}
        </>
      )}

      {/* Working state → the bot narrates the reveal once it lands. The
          narration is in-voice, DERIVED from the axis selection — the raw
          axisSelection.rationale is an internal audit log (ADR-0012) and
          must never render as a chat message. */}
      {(step === 'starting' || step === 'rounding') && !error && (
        <GeneratingBeat lines={REVEAL_BEAT_LINES} />
      )}
      {showGrid && session && (
        <>
          <ChatBubble role="bot">{revealNarration(session.axisSelection)}</ChatBubble>
          {roundNotice && <ChatBubble role="bot">{roundNotice}</ChatBubble>}
          <ChatBubble role="bot">{ROUND_PROMPT}</ChatBubble>
          <RevealGrid
            variations={roundCuts}
            mode={gridMode}
            pickId={roundPickId}
            onSelect={handleGridSelect}
            indexOffset={Math.max(0, session.variations.findIndex((v) => v.id === roundCuts[0]?.id))}
          />
          {/* The pick landed: the invitation into the next round (ADR-0049).
              Copy computes the next axis from the ladder, never hardcoded.
              The pick stays changeable — tapping the other cut re-picks —
              until "Refine" charges the round and freezes it. */}
          {step === 'reveal' && roundPickId && session.rounds && (
            <>
              <ChatBubble role="bot">
                {refineInviteLine(
                  session.axisSelection.mode,
                  session.rounds.map((round) => round.axis),
                  // Rungs the brief settled are skipped server-side too
                  // (ADR-0049) — the invite must promise the axis the
                  // charged round will actually spread.
                  settledAxes(session.intake)
                )}
              </ChatBubble>
              <div className="flex gap-3">
                {/* An empty meter swaps Refine for the buy link instead of
                    letting the tap fail (spec 8). */}
                {outOfCredits ? (
                  <BuyCreditsLink />
                ) : (
                  <button
                    type="button"
                    onClick={handleRefineRound}
                    title={balance.known ? creditSplitLabel(balance.free, balance.paid) : undefined}
                    className="press font-body text-[10px] uppercase tracking-[0.2em] text-black bg-pink hover:bg-white px-3 py-2"
                  >
                    {refineButtonLabel(balance)}
                  </button>
                )}
                <button
                  type="button"
                  onClick={handleLockIn}
                  className="press font-body text-[10px] uppercase tracking-[0.2em] text-white/70 hover:text-black hover:bg-pink border hairline px-3 py-2"
                >
                  {LOCK_IN_LABEL}
                </button>
              </div>
            </>
          )}
        </>
      )}
      {(step === 'round-picking' || step === 'picking') && !error && (
        <ThinkingLine label="Reading your pick" />
      )}

      {/* One refinement round — then the hard stop (ADR-0013) */}
      {step === 'refine' && session?.refinementQuestion && (
        <>
          <ChatBubble role="bot">{session.refinementQuestion}</ChatBubble>
          <RefinementPrompt
            question={session.refinementQuestion}
            onAnswer={(answer) => runAction({ kind: 'refine', sessionId: session.id, answer })}
          />
        </>
      )}
      {step === 'refining' && !error && <GeneratingBeat lines={REFINE_BEAT_LINES} />}

      {/* The critique lane (ADR-0039): the chat survives the reveal, so plain
          criticism re-cuts the design instead of being discarded. Re-cuts
          render through the same grid. */}
      {showCritique && session && (
        <>
          <ChatBubble role="bot">{CRITIQUE_INVITE}</ChatBubble>
          {critiqueLog.map((message, i) => (
            <ChatBubble key={i} role={message.role}>
              {message.text}
            </ChatBubble>
          ))}
          {critiqueBuyLink && !critiquePending && <BuyCreditsLink />}
          {critiqueCuts.length > 0 && (
            <RevealGrid
              variations={critiqueCuts}
              mode="locked"
              pickId={roundPickId}
              indexOffset={session.variations.length}
            />
          )}
          {critiquePending ? (
            <GeneratingBeat lines={REFINE_BEAT_LINES} />
          ) : (
            <ChatInput
              placeholder={CRITIQUE_PLACEHOLDER}
              ariaLabel="Tell me what's wrong with it"
              onSubmit={handleCritique}
            />
          )}
        </>
      )}

      {step === 'complete' && session && (
        <>
          <ChatBubble role="bot">Done. One pass, one answer, one design.</ChatBubble>
          <HandoffCard session={session} />
          {/* Placement preview — a canvas artifact, not a regen, so it lives
              outside the ADR-0013 hard stop. Saving updates the session so
              the Brief carries the preview into the booking. */}
          <PlacementPreview session={session} onAttached={setSession} />
        </>
      )}

      {error && errorCode === CREDITS_EXHAUSTED_CODE && (
        <div className="space-y-3">
          <ChatBubble role="bot">{error}</ChatBubble>
          <BuyCreditsLink />
        </div>
      )}
      {error && errorCode !== CREDITS_EXHAUSTED_CODE && (
        <div className="space-y-3">
          <ChatBubble role="bot">{error}</ChatBubble>
          <button
            type="button"
            onClick={() => lastAction && runAction(lastAction)}
            className="press font-body text-[10px] uppercase tracking-[0.2em] text-white/70 hover:text-black hover:bg-pink border hairline px-3 py-2"
          >
            Retry
          </button>
        </div>
      )}
    </div>
  );
}
