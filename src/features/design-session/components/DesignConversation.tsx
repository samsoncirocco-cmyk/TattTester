'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import Link from 'next/link';
import type { DesignSession } from '@/services/designSession/types';
import type {
  ConversationMessage,
  ConversationStage,
  SessionNotes,
} from '@/services/designConversation/types';
import { isConfirmationIntent } from '../services/confirmationIntent';
import {
  converse,
  confirmProposal,
  ConversationUnavailableError,
} from '../services/designSessionApi';
import { SignInRequiredError } from '@/lib/client-api-auth';
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
 */
export function DesignConversation({ initialPrompt }: { initialPrompt?: string } = {}) {
  const [mode, setMode] = useState<SurfaceMode>('conversation');
  const [messages, setMessages] = useState<ConversationMessage[]>([]);
  const [sessionId, setSessionId] = useState<string | undefined>();
  const [stage, setStage] = useState<ConversationStage>('chatting');
  const [playback, setPlayback] = useState<string | undefined>();
  const [handoffUrl, setHandoffUrl] = useState<string | undefined>();
  const [revealSession, setRevealSession] = useState<DesignSession | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The draw needs an account and there isn't one yet. Distinct from
  // `error`: this is the paywall beat, not a failure, so it gets the
  // account copy and a "draw it" button rather than a red line and RETRY.
  const [signInNeeded, setSignInNeeded] = useState(false);
  const [lastAction, setLastAction] = useState<ConversationAction | null>(null);
  // SketchBot's notepad (TAT-48): the latest whitelisted projection of the
  // brief — the ONLY record view the server sends, never raw telemetry.
  const [notes, setNotes] = useState<SessionNotes | undefined>();
  // Tap-to-fix prefill for the chat input; the nonce re-triggers the same
  // prefix on a second tap.
  const [prefill, setPrefill] = useState<{ text: string; nonce: number } | undefined>();
  const prefillCount = useRef(0);
  const openerRequested = useRef(false);

  const runAction = (action: ConversationAction) => {
    setError(null);
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
          setError(err instanceof Error ? err.message : 'Something snapped — try again.');
        })
        .finally(() => setPending(false));
      return;
    }

    converse(
      action.message === undefined ? { sessionId } : { sessionId, message: action.message }
    )
      .then((response) => {
        setSessionId(response.sessionId);
        setStage(response.stage);
        setPlayback(response.playback);
        setHandoffUrl(response.handoffUrl);
        if (response.notes) setNotes(response.notes);
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
        setError(err instanceof Error ? err.message : 'Something snapped — try again.');
      })
      .finally(() => setPending(false));
  };

  // Opener on mount — the bot speaks first (ADR-0019). A deep-linked prompt
  // (/design?prompt=…) is the user speaking first instead: it goes out as
  // the first message with no opener round-trip, so a complete prompt takes
  // the fast lane in a single turn (ADR-0028).
  useEffect(() => {
    if (openerRequested.current) return;
    openerRequested.current = true;
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

  const transcript = messages.map((message, i) => (
    <ChatBubble key={i} role={message.role}>
      {message.text}
    </ChatBubble>
  ));

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
        <DesignSessionFlow initialSession={revealSession} />
      </>,
      { locked: true, drawReady: false }
    );
  }

  const showProposal = stage === 'proposal' && !pending && !error && !signInNeeded;
  const showHandoff = stage === 'handoff' && !pending && !error && !signInNeeded;
  // The visible fast lane (TAT-48): the record could already generate
  // (ADR-0028 readiness, judged by the engine) but SketchBot still has
  // questions — surface the skip.
  const showFastLane =
    stage === 'chatting' && !pending && !error && !signInNeeded && notes?.sufficient === true;

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

      {error && (
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
      {firstRun && <StarterChips onPick={handleSend} disabled={pending} />}

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
          disabled={pending}
          prefill={prefill}
        />
      )}

      {firstRun && <ExampleStrip />}
    </>,
    { locked: false, drawReady: showProposal }
  );
}
