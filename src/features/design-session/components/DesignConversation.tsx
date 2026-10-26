'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import Link from 'next/link';
import type { DesignSession } from '@/services/designSession/types';
import type {
  ConversationMessage,
  ConversationStage,
  GateState,
  SessionNotes,
} from '@/services/designConversation/types';
import { isConfirmationIntent } from '../services/confirmationIntent';
import {
  converse,
  confirmProposal,
  ConversationUnavailableError,
  DesignSessionRequestError,
} from '../services/designSessionApi';
import { SignInRequiredError } from '@/lib/client-api-auth';
import { CREDITS_EXHAUSTED_CODE } from '@/lib/generation-credits-shared';
import { useAuthStore } from '@/store/useAuthStore';
import { refreshCreditBalance } from '../services/creditBalance';
import { BuyCreditsLink, CreditCountLine } from './CreditBalance';
import { GeneratingBeat, REVEAL_BEAT_LINES } from './GeneratingBeat';
import type { SessionRendering } from '@/services/designSession/resumeContract';
import {
  LOST_RENDER_LINE,
  NEW_SKETCH_LABEL,
  NOT_FOUND_LINE,
  RENDER_DID_NOT_LAND_LINE,
  RESUME_LINE,
  STILL_DRAWING_LINE,
  clearSessionIdFromUrl,
  fetchSessionForResume,
  rememberResumeKey,
  useSessionPoll,
  writeSessionIdToUrl,
  type ResumeFetchResult,
} from '../services/sessionResume';
import { ChatBubble } from './ChatBubble';
import { ChatInput } from './ChatInput';
import { ExampleStrip } from './ExampleStrip';
import { StarterChips } from './StarterChips';
import { ThinkingLine } from './ThinkingLine';
import { DesignSessionFlow } from './DesignSessionFlow';
import { SketchbotNotesCard, MobileNotesSheet } from './SketchbotNotes';

// The one-liner shown when every conversation provider is down and we
// degrade to the scripted two-question intake (ADR-0019). Soft — never an
// error screen, never an apology essay.
const FALLBACK_LINE = 'Keeping it simple today — two quick questions and we’re off.';

/**
 * The account beat, shown at the moment the visitor asks for cuts and not
 * a second earlier (ADR-0041 gates generation; conversation is free).
 * Deliberately not an error: nothing went wrong, and the conversation above
 * it is still there. It names what they get and what it costs, because they
 * have already seen the proposal it is attached to.
 */
export const SIGN_IN_LINE =
  'One thing before I draw — make an account so these are yours. First 25 cuts are free, and everything we just worked out comes with you.';

/**
 * The visible fast lane's canonical message (TAT-48): the chip sends it
 * through the normal converse path, and the engine's deterministic
 * draw-request detection fires the proposal (never a separate API).
 */
export const FAST_LANE_MESSAGE = 'skip the questions — just draw';
export const FAST_LANE_CHIP_LABEL = 'skip the questions — just draw ▸';

/** The one-door input line (TAT-48): a sentence or a whole vision. */
export const INPUT_PLACEHOLDER = 'describe your tattoo — a sentence or a whole vision';

/**
 * How the surface is rendered right now.
 * 'conversation' — the live intake chat (ADR-0019).
 * 'reveal'       — proposal confirmed (ADR-0020); the existing reveal flow
 *                  owns everything from here, seeded with the session.
 * 'fallback'     — every provider down; the scripted intake takes over.
 */
type SurfaceMode = 'conversation' | 'reveal' | 'fallback';

/** The in-flight call, kept around so a failed one can be retried. */
type ConversationAction =
  | { kind: 'converse'; message?: string }
  | { kind: 'confirm' };

/**
 * The conversational intake (ADR-0019–0022): a real chat that fills the
 * intake record as a side effect. Opens on mount, proposes with playback +
 * consent (ADR-0020), warm-handoffs at the cadence cap (ADR-0021), and
 * degrades to the scripted two-question intake if the conversation engine
 * is unavailable. TurnLog stays server-side — telemetry is never rendered.
 *
 * One door, fast lane (ADR-0028): when the engine's proposal fires on the
 * very first user turn — the existing readiness detection judged the first
 * input a complete prompt — the consent tap is skipped and the confirm
 * fires immediately, landing straight on the two-cut reveal. The confirm
 * route keeps owning budget/rate policy and spend recording, and the
 * Council still runs inside it (never the raw-prompt bypass). An
 * `initialPrompt` (the /design?prompt= deep link) is sent as the user's
 * first message instead of requesting the opener.
 *
 * Resume (spec 7): every session puts its id in the address bar as `?ds=`.
 * Mounted with `initialSessionId`, the conversation re-reads that session
 * and opens on its last completed state — the chat, or the reveal — and
 * waits on a render only while its claim is still live. A lost render
 * (stale claim) or a stranger's/missing session never shows a half state:
 * the first offers a re-run, the second starts fresh.
 */
export function DesignConversation({
  initialPrompt,
  initialSessionId,
}: { initialPrompt?: string; initialSessionId?: string } = {}) {
  const [mode, setMode] = useState<SurfaceMode>('conversation');
  const [messages, setMessages] = useState<ConversationMessage[]>([]);
  const [sessionId, setSessionId] = useState<string | undefined>();
  const [stage, setStage] = useState<ConversationStage>('chatting');
  const [playback, setPlayback] = useState<string | undefined>();
  const [handoffUrl, setHandoffUrl] = useState<string | undefined>();
  const [revealSession, setRevealSession] = useState<DesignSession | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // An empty meter (402) gets the buy link instead of Retry (spec 8).
  const [creditsExhausted, setCreditsExhausted] = useState(false);
  // The draw needs an account and there isn't one yet. Distinct from
  // `error`: this is the paywall beat, not a failure, so it gets the
  // account copy and a "draw it" button rather than a red line and RETRY.
  const [signInNeeded, setSignInNeeded] = useState(false);
  const [lastAction, setLastAction] = useState<ConversationAction | null>(null);
  // SketchBot's notepad (TAT-48): the latest whitelisted projection of the
  // brief — the ONLY record view the server sends, never raw telemetry.
  const [notes, setNotes] = useState<SessionNotes | undefined>();
  // The proposal gate's spoken state (#376): set from every converse
  // response, cleared when the response carries none (the field settled, or
  // the stage moved on). Only its `line` ever renders — the field name is
  // data for the stalled check, never copy.
  const [gate, setGate] = useState<GateState | undefined>();
  // Tap-to-fix prefill for the chat input; the nonce re-triggers the same
  // prefix on a second tap.
  const [prefill, setPrefill] = useState<{ text: string; nonce: number } | undefined>();
  const prefillCount = useRef(0);
  const openerRequested = useRef(false);
  // Spec 7 resume state: the one quiet line, a reveal still rendering on the
  // server, and a round render handed on to the reveal flow.
  const [resumeNotice, setResumeNotice] = useState<string | null>(null);
  const [awaitingReveal, setAwaitingReveal] = useState(false);
  const [resumeRendering, setResumeRendering] = useState<SessionRendering | undefined>();
  const uid = useAuthStore((s) => s.user?.uid);

  // Spec 8: a signed-in customer sees what they have left. One read when
  // the account is known (and again after a sign-in on this page); every
  // charged response keeps it current after that, with no extra request.
  useEffect(() => {
    if (uid) void refreshCreditBalance();
  }, [uid]);

  const runAction = (action: ConversationAction) => {
    setError(null);
    setCreditsExhausted(false);
    setSignInNeeded(false);
    setLastAction(action);
    setPending(true);

    if (action.kind === 'confirm') {
      confirmProposal(sessionId!)
        .then((session) => {
          setRevealSession(session);
          setMode('reveal');
        })
        .catch((err: unknown) => {
          if (err instanceof SignInRequiredError) {
            setSignInNeeded(true);
            return;
          }
          setCreditsExhausted(
            err instanceof DesignSessionRequestError && err.code === CREDITS_EXHAUSTED_CODE
          );
          setError(err instanceof Error ? err.message : 'Something snapped — try again.');
        })
        .finally(() => setPending(false));
      return;
    }

    converse(
      action.message === undefined ? { sessionId } : { sessionId, message: action.message }
    )
      .then((response) => {
        if (response.resumeKey) rememberResumeKey(response.sessionId, response.resumeKey);
        writeSessionIdToUrl(response.sessionId);
        setSessionId(response.sessionId);
        setStage(response.stage);
        setPlayback(response.playback);
        setHandoffUrl(response.handoffUrl);
        if (response.notes) setNotes(response.notes);
        setGate(response.gate);
        setMessages((prev) => [...prev, { role: 'bot', text: response.reply }]);
        // Fast lane (ADR-0028): a proposal on turn 1 means the first input
        // was already a complete prompt — the reply above is the announce
        // beat, and the reveal fires without waiting for a tap. Returning
        // the promise keeps `pending` true until the renders land.
        if (response.stage === 'proposal' && response.turn === 1) {
          setLastAction({ kind: 'confirm' });
          return confirmProposal(response.sessionId).then((session) => {
            setRevealSession(session);
            setMode('reveal');
          });
        }
      })
      .catch((err: unknown) => {
        if (err instanceof ConversationUnavailableError) {
          setMode('fallback');
          return;
        }
        // The fast lane (ADR-0028) chains a confirm inside this same
        // promise, so a signed-out visitor whose first message was already
        // a complete prompt lands here rather than in the confirm branch.
        if (err instanceof SignInRequiredError) {
          setSignInNeeded(true);
          return;
        }
        setCreditsExhausted(
          err instanceof DesignSessionRequestError && err.code === CREDITS_EXHAUSTED_CODE
        );
        setError(err instanceof Error ? err.message : 'Something snapped — try again.');
      })
      .finally(() => setPending(false));
  };

  /** A missing or foreign session: say so once, drop `ds`, open fresh. */
  const startFresh = () => {
    clearSessionIdFromUrl();
    setResumeNotice(NOT_FOUND_LINE);
    runAction({ kind: 'converse' });
  };

  /**
   * A reveal render the page was waiting on has settled one way or another.
   * Revealed: hand over to the reveal flow. Still in intake with no claim:
   * the render failed and its credit went back through the route, so offer
   * the re-run. A claim gone stale: the render died, offer the re-run.
   */
  const settleReveal = (result: ResumeFetchResult) => {
    if (result.status !== 'found') return;
    const { session, resume } = result;
    if (session.phase !== 'intake') {
      setAwaitingReveal(false);
      setRevealSession(session);
      setMode('reveal');
      return;
    }
    const rendering = resume?.rendering;
    if (rendering && !rendering.stale) return;
    setAwaitingReveal(false);
    setLastAction({ kind: 'confirm' });
    setError(rendering?.stale ? LOST_RENDER_LINE : RENDER_DID_NOT_LAND_LINE);
  };

  const hydrate = (id: string) => {
    setPending(true);
    fetchSessionForResume(id)
      .then((result) => {
        // No resume view means this browser may not see the chat — either
        // nobody here owns it or it is gone. Never show someone else's cuts.
        if (result.status !== 'found' || !result.resume) {
          setPending(false);
          startFresh();
          return;
        }
        const { session, resume } = result;
        setResumeNotice(RESUME_LINE);
        setSessionId(session.id);
        setMessages(resume.transcript);
        setStage(resume.stage ?? 'chatting');
        setPlayback(resume.playback);
        setHandoffUrl(resume.handoffUrl);
        if (resume.notes) setNotes(resume.notes);
        setPending(false);
        if (session.phase !== 'intake') {
          setResumeRendering(resume.rendering);
          setRevealSession(session);
          setMode('reveal');
          return;
        }
        if (resume.rendering && !resume.rendering.stale) {
          setAwaitingReveal(true);
          return;
        }
        if (resume.rendering?.stale) {
          setLastAction({ kind: 'confirm' });
          setError(LOST_RENDER_LINE);
        }
      })
      .catch(() => {
        setPending(false);
        startFresh();
      });
  };

  useSessionPoll(sessionId, awaitingReveal, settleReveal);

  // Opener on mount — the bot speaks first (ADR-0019). A deep-linked prompt
  // (/design?prompt=…) is the user speaking first instead: it goes out as
  // the first message with no opener round-trip, so a complete prompt takes
  // the fast lane in a single turn (ADR-0028).
  useEffect(() => {
    if (openerRequested.current) return;
    openerRequested.current = true;
    // `ds` wins over `prompt` (spec 7): a reload resumes, never re-sends.
    if (initialSessionId) {
      hydrate(initialSessionId);
      return;
    }
    const prompt = initialPrompt?.trim();
    if (prompt) {
      setMessages([{ role: 'user', text: prompt }]);
      runAction({ kind: 'converse', message: prompt });
    } else {
      runAction({ kind: 'converse' });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount-only opener
  }, []);

  const handleSend = (text: string) => {
    setMessages((prev) => [...prev, { role: 'user', text }]);
    // At the proposal beat a typed "yes" is consent, not another turn —
    // routing it to /converse re-emits the same proposal (ADR-0020).
    runAction(
      stage === 'proposal' && isConfirmationIntent(text)
        ? { kind: 'confirm' }
        : { kind: 'converse', message: text }
    );
  };

  // Tap-to-fix (TAT-48): a notepad entry prefills a correction opener into
  // the reply line — the correction is just another converse message.
  const handleFix = (text: string) => {
    prefillCount.current += 1;
    setPrefill({ text, nonce: prefillCount.current });
  };

  // Every provider down → the scripted intake carries the session
  // (ADR-0019). Degraded mode gets degraded chrome: the scripted flow owns
  // its own answers, so no notepad rather than one that lies "nothing yet".
  if (mode === 'fallback') {
    return (
      <div className="space-y-5">
        {messages.map((message, i) => (
          <ChatBubble key={i} role={message.role}>
            {message.text}
          </ChatBubble>
        ))}
        <ChatBubble role="bot">{FALLBACK_LINE}</ChatBubble>
        <DesignSessionFlow />
      </div>
    );
  }

  // Spec 7: the one quiet resume (or not-found) line, with a way out to a
  // clean sketch — a full load, so no resumed state survives it.
  const resumeBanner = resumeNotice ? (
    <div
      role="status"
      data-testid="resume-notice"
      className="flex flex-wrap items-baseline justify-between gap-3 font-body text-[12px] uppercase tracking-[0.18em] text-white/55"
    >
      <span>{resumeNotice}</span>
      {resumeNotice === RESUME_LINE && (
        <a href="/design" className="underline underline-offset-4 hover:text-pink">
          {NEW_SKETCH_LABEL}
        </a>
      )}
    </div>
  ) : null;

  const transcript = (
    <>
      {resumeBanner}
      {messages.map((message, i) => (
        <ChatBubble key={i} role={message.role}>
          {message.text}
        </ChatBubble>
      ))}
    </>
  );

  // Desktop: persistent panel beside the chat. Mobile: pull-up sheet,
  // default peeking. Locked once the reveal fires — the notepad becomes the
  // static brief (no chat input left to fix into).
  const withNotepad = (column: ReactNode, opts: { locked: boolean; drawReady: boolean }) => (
    <div className="md:grid md:grid-cols-[minmax(0,1fr)_300px] md:items-start md:gap-10">
      <div className="space-y-5 pb-16 md:pb-0">{column}</div>
      <aside className="hidden md:block md:sticky md:top-24">
        <SketchbotNotesCard
          notes={notes}
          locked={opts.locked}
          onFix={handleFix}
          drawReady={opts.drawReady}
          onDraw={() => runAction({ kind: 'confirm' })}
        />
      </aside>
      <MobileNotesSheet
        notes={notes}
        locked={opts.locked}
        onFix={handleFix}
        drawReady={opts.drawReady}
        onDraw={() => runAction({ kind: 'confirm' })}
      />
    </div>
  );

  // Confirmed — the existing reveal → pick → refine → handoff flow takes
  // over, with the conversation transcript kept above it.
  if (mode === 'reveal' && revealSession) {
    return withNotepad(
      <>
        {transcript}
        <DesignSessionFlow initialSession={revealSession} resumeRendering={resumeRendering} />
      </>,
      { locked: true, drawReady: false }
    );
  }

  // A reveal still rendering on the server after a reload is as busy as a
  // request in flight: no second consent tap, no input (spec 7).
  const busy = pending || awaitingReveal;
  const showProposal = stage === 'proposal' && !busy && !error && !signInNeeded;
  const showHandoff = stage === 'handoff' && !busy && !error && !signInNeeded;
  // The visible fast lane (TAT-48): the record could already generate
  // (ADR-0028 readiness, judged by the engine) but SketchBot still has
  // questions — surface the skip.
  const showFastLane =
    stage === 'chatting' && !busy && !error && !signInNeeded && notes?.sufficient === true;
  // A stalled gate (#376): the same field has held the proposal back for
  // two turns running, so the session says why there is no render yet —
  // one consultant line under the bot's direct ask, never the rationale.
  const showGateLine =
    stage === 'chatting' && !busy && !error && !signInNeeded && gate?.stalled === true;

  // First-run empty state: the user hasn't spoken yet (neither typed nor
  // deep-linked). Starter chips + example strip scaffold the blank box; the
  // moment a user message exists — chip tap included — they're gone and the
  // conversation owns the screen.
  const firstRun = !messages.some((message) => message.role === 'user');

  return withNotepad(
    <>
      {transcript}

      {/* Proposal beat (ADR-0020): the bot's reply bubble above already
          carries the playback, so only the consent CTA renders here. A
          correction is just another message through the same reply box
          below. */}
      {showProposal && playback && (
        <button
          type="button"
          onClick={() => runAction({ kind: 'confirm' })}
          className="tape press inline-flex items-center px-6 py-4 font-display text-[20px] leading-none tracking-[0.02em] uppercase"
        >
          Show me<span className="ml-3 text-[14px]">▸</span>
        </button>
      )}

      {/* Warm handoff (ADR-0021): the bot's judgment call, never a limit. */}
      {showHandoff && handoffUrl && (
        <Link
          href={handoffUrl}
          className="tape press inline-flex items-center px-6 py-4 font-display text-[20px] leading-none tracking-[0.02em] uppercase"
        >
          Find my artist<span className="ml-3 text-[14px]">▸</span>
        </Link>
      )}

      {pending && <ThinkingLine label="Typing" />}

      {awaitingReveal && (
        <>
          <ChatBubble role="bot">{STILL_DRAWING_LINE}</ChatBubble>
          <GeneratingBeat lines={REVEAL_BEAT_LINES} />
        </>
      )}

      {/* Gate state (#376): why SketchBot has not offered cuts yet. Status,
          not a second question — the bot's bubble above already asked. */}
      {showGateLine && gate && (
        <p
          role="status"
          data-testid="gate-line"
          className="font-body text-[12px] uppercase tracking-[0.18em] text-white/55"
        >
          {gate.line}
        </p>
      )}

      {/* The account beat (ADR-0041). getApiAuthHeaders already opened the
          sign-in modal on its way out; this is what the conversation looks
          like behind it, and the button re-runs the same draw once they're
          in. */}
      {signInNeeded && !pending && (
        <div className="space-y-3">
          <ChatBubble role="bot">{SIGN_IN_LINE}</ChatBubble>
          <button
            type="button"
            onClick={() => lastAction && runAction(lastAction)}
            className="tape press inline-flex items-center px-6 py-4 font-display text-[20px] leading-none tracking-[0.02em] uppercase"
          >
            Draw it<span className="ml-3 text-[14px]">▸</span>
          </button>
        </div>
      )}

      {error && creditsExhausted && (
        <div className="space-y-3">
          <ChatBubble role="bot">{error}</ChatBubble>
          <BuyCreditsLink />
        </div>
      )}
      {error && !creditsExhausted && (
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

      {/* First-run scaffolding: a chip is just a prefilled first message —
          it goes through handleSend like typed text, and the engine's own
          routing decides conversation vs fast lane (ADR-0028). */}
      {/* Spec 8: signed in, the opener says what is left; signed out, the
          static "first 25 cuts are free" beat still belongs to sign-in. */}
      {firstRun && uid && <CreditCountLine />}
      {firstRun && <StarterChips onPick={handleSend} disabled={busy} />}

      {/* The visible fast lane (TAT-48): one tap sends the canonical skip
          message through the SAME converse path — the engine's draw-request
          detection fires the proposal, so consent still happens (ADR-0020). */}
      {showFastLane && (
        <button
          type="button"
          onClick={() => handleSend(FAST_LANE_MESSAGE)}
          className="press bg-pink text-black font-body text-[13px] px-4 py-2.5 min-h-[44px]"
        >
          {FAST_LANE_CHIP_LABEL}
        </button>
      )}

      {/* The reply line — doubles as the proposal's correction box. Hidden
          at the handoff: the CTA is the way forward, not more chat. */}
      {stage !== 'handoff' && (
        <ChatInput
          placeholder={INPUT_PLACEHOLDER}
          ariaLabel="Your reply"
          onSubmit={handleSend}
          disabled={busy}
          prefill={prefill}
        />
      )}

      {firstRun && <ExampleStrip />}
    </>,
    { locked: false, drawReady: showProposal }
  );
}
