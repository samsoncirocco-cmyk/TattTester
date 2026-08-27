// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, screen, fireEvent } from '@testing-library/react';
import type { ReactNode } from 'react';
import { createElement } from 'react';
import type { DesignSession } from '@/services/designSession/types';
import type { ConverseResponse, SessionNotes } from '@/services/designConversation/types';
import { DesignConversation, SIGN_IN_LINE } from '../components/DesignConversation';
import { getApiAuthHeaders, getOptionalApiAuthHeaders, SignInRequiredError } from '@/lib/client-api-auth';

// The in-voice reveal narration derived from the fixture's axisSelection —
// the raw audit rationale (ADR-0012) never renders in the chat.
const REVEAL_NARRATION =
  'I split these two on line weight — your pick tells me which way to lean.';

// The fetch client attaches Firebase bearer auth (matching the API routes'
// verifyApiAuth gate); stub it so tests need no signed-in user.
vi.mock('@/lib/client-api-auth', () => ({
  getApiAuthHeaders: vi.fn(async () => ({ Authorization: 'Bearer test-token' })),
  getOptionalApiAuthHeaders: vi.fn(async () => ({ Authorization: 'Bearer test-token' })),
  SignInRequiredError: class SignInRequiredError extends Error {},
}));

// Strip framer-motion down to plain elements so the reveal renders
// synchronously in jsdom.
vi.mock('framer-motion', () => {
  const MOTION_PROPS = ['initial', 'animate', 'exit', 'transition', 'variants', 'whileHover', 'whileTap', 'layout'];
  const strip = (props: Record<string, unknown>) => {
    const rest = { ...props };
    for (const key of MOTION_PROPS) delete rest[key];
    return rest;
  };
  return {
    motion: new Proxy(
      {},
      {
        get: (_target, tag) =>
          function MotionStub({ children, ...props }: { children?: ReactNode } & Record<string, unknown>) {
            return createElement(String(tag), strip(props), children);
          },
      }
    ),
    AnimatePresence: ({ children }: { children?: ReactNode }) => children,
  };
});

const OPENER = 'Where does it go — and what should it feel like when you catch it in the mirror?';

function converseResponse(overrides: Partial<ConverseResponse> = {}): ConverseResponse {
  return {
    sessionId: 'sess-1',
    reply: OPENER,
    stage: 'chatting',
    turn: 0,
    ...overrides,
  };
}

// One round's pair (ADR-0049): two cuts spread on one axis.
const variations = [1, 2].map((n) => ({
  id: `v${n}`,
  axisPosition: { 'bold-fine': n % 2 ? 'bold' : 'fine' },
  prompt: `prompt ${n}`,
  imageUrl: `https://img.test/design-${n}.png`,
}));

const revealedSession: DesignSession = {
  id: 'sess-1',
  phase: 'revealed',
  intake: {
    placement: 'inner forearm',
    styleTags: ['blackwork'],
    meaning: 'strength after a rough year',
    references: [],
    ambiguousAxes: ['bold-fine', 'minimal-ornate'],
  },
  axisSelection: {
    mode: 'questionnaire',
    axes: ['bold-fine'],
    rationale: 'Round one spreads on bold-fine, the first rung of the ladder.',
  },
  provider: 'replicate',
  variations,
  rounds: [{ round: 1, axis: 'bold-fine', variationIds: ['v1', 'v2'] }],
  createdAt: '2026-07-24T00:00:00Z',
  updatedAt: '2026-07-24T00:00:00Z',
};

const roundPickedSession: DesignSession = {
  ...revealedSession,
  rounds: [{ round: 1, axis: 'bold-fine', variationIds: ['v1', 'v2'], pickedId: 'v2', pickedAt: '2026-07-24T00:00:00Z' }],
};

const pickedSession: DesignSession = {
  ...roundPickedSession,
  phase: 'picked',
  pickId: 'v2',
  mostNotYouId: 'v1',
  refinementQuestion: 'Bolder lines or keep them fine?',
};

const completeSession: DesignSession = {
  ...pickedSession,
  phase: 'complete',
  refinementAnswer: 'Bolder lines',
  refinedVariation: {
    id: 'v-refined',
    axisPosition: { 'bold-fine': 'bold' },
    prompt: 'refined prompt',
    imageUrl: 'https://img.test/refined.png',
  },
};

function jsonResponse(body: unknown, status = 200) {
  return { ok: status < 400, status, json: async () => body } as Response;
}

const fetchMock = vi.fn();

const BEARER = { Authorization: 'Bearer test-token' };

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  // Reset the auth helpers per test: several tests below assert which of
  // the two a code path reached, and a leaked call count or a leftover
  // mockResolvedValue from a previous test would make those lie.
  vi.mocked(getApiAuthHeaders).mockClear().mockResolvedValue(BEARER);
  vi.mocked(getOptionalApiAuthHeaders).mockClear().mockResolvedValue(BEARER);
});

function sendReply(text: string) {
  fireEvent.change(screen.getByLabelText('Your reply'), { target: { value: text } });
  fireEvent.click(screen.getByRole('button', { name: /send/i }));
}

/** Walk opener → one detail turn → proposal, leaving the proposal on screen. */
async function reachProposal() {
  fetchMock
    .mockResolvedValueOnce(jsonResponse(converseResponse()))
    .mockResolvedValueOnce(
      jsonResponse(
        converseResponse({
          reply: 'A memorial for your dad — what did he love?',
          stage: 'chatting',
          turn: 1,
        })
      )
    )
    .mockResolvedValueOnce(
      jsonResponse(
        converseResponse({
          // The proposal reply embeds the playback (ADR-0020) — the UI must
          // render this bubble only, never a second raw-playback bubble.
          reply:
            "Here's what I'm hearing: Fine-line blackwork on the inner forearm — strength after a rough year. Want to see four takes, or did I miss something?",
          stage: 'proposal',
          playback: 'Fine-line blackwork on the inner forearm — strength after a rough year.',
          turn: 2,
        })
      )
    );

  render(<DesignConversation />);
  await screen.findByText(OPENER);

  sendReply('inner forearm, for my dad');
  await screen.findByText('A memorial for your dad — what did he love?');

  sendReply('old fishing trips, quiet strength');
  await screen.findByRole('button', { name: /show me/i });
}

describe('DesignConversation', () => {
  it('releases the first reply line when SketchBot never answers the opening request', async () => {
    vi.useFakeTimers();
    try {
      fetchMock.mockReturnValueOnce(new Promise<Response>(() => {}));

      render(<DesignConversation />);
      await act(async () => {
        await Promise.resolve();
        await vi.advanceTimersByTimeAsync(10_001);
      });

      expect(screen.getByText(/taking longer than expected/i)).toBeTruthy();
      expect(screen.getByRole('button', { name: /retry/i })).toBeTruthy();
      expect((screen.getByLabelText('Your reply') as HTMLInputElement).disabled).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  // ---------------------------------------------------------------------
  // The open front door. Before this, /design opened a "Welcome Back" modal
  // on load and the first chip tap failed client-side without a request
  // ever leaving the browser: an anonymous visitor could not reach a single
  // cut. ADR-0041 gates GENERATION; talking to SketchBot is not generating.
  // ---------------------------------------------------------------------

  it('opens for a signed-out visitor: no token demanded, no sign-in modal', async () => {
    // Signed out: the optional helper yields no headers and, crucially,
    // never calls promptSignIn or throws.
    vi.mocked(getOptionalApiAuthHeaders).mockResolvedValueOnce({});
    fetchMock.mockResolvedValueOnce(jsonResponse(converseResponse()));

    render(<DesignConversation />);

    expect(await screen.findByText(OPENER)).toBeTruthy();
    // The request went out — the old failure never reached the network.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBeUndefined();
    // The conversation path must never reach for the throwing helper.
    expect(getApiAuthHeaders).not.toHaveBeenCalled();
    expect(screen.getByLabelText('Your reply')).toBeTruthy();
  });

  it('lets a signed-out visitor hold a real conversation to the proposal', async () => {
    vi.mocked(getOptionalApiAuthHeaders).mockResolvedValue({});

    await reachProposal();

    expect(screen.getByRole('button', { name: /show me/i })).toBeTruthy();
    expect(getApiAuthHeaders).not.toHaveBeenCalled();
  });

  // The wall moves to the money: the account is asked for at the draw, and
  // it reads as an offer, not a failure.
  it('asks for an account at the draw — the account beat, not a red error', async () => {
    await reachProposal();

    vi.mocked(getApiAuthHeaders).mockRejectedValueOnce(new SignInRequiredError());
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /show me/i }));
    });

    expect(screen.getByText(SIGN_IN_LINE)).toBeTruthy();
    // Names what they get, having already seen the proposal it attaches to.
    expect(SIGN_IN_LINE).toMatch(/25 cuts are free/i);
    // Not a failure: no RETRY, and the raw 'Sign in to continue.' sentence
    // never reaches the transcript.
    expect(screen.queryByRole('button', { name: /retry/i })).toBeNull();
    expect(screen.queryByText(/sign in to continue/i)).toBeNull();
    // The conversation above it survives.
    expect(screen.getByText(OPENER)).toBeTruthy();
  });

  it('re-runs the same draw once the visitor is signed in', async () => {
    await reachProposal();

    vi.mocked(getApiAuthHeaders).mockRejectedValueOnce(new SignInRequiredError());
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /show me/i }));
    });
    await screen.findByText(SIGN_IN_LINE);

    // Signed in now: the beat's button replays the confirm that was refused.
    fetchMock.mockResolvedValueOnce(jsonResponse({ session: revealedSession }));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /draw it/i }));
    });

    expect(fetchMock).toHaveBeenLastCalledWith(
      '/api/v1/design-session/sess-1/confirm',
      expect.objectContaining({ method: 'POST' })
    );
    expect(screen.queryByText(SIGN_IN_LINE)).toBeNull();
  });

  it('opens the conversation on mount with the bot speaking first', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(converseResponse()));

    render(<DesignConversation />);

    expect(await screen.findByText(OPENER)).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v1/design-session/converse',
      expect.objectContaining({ method: 'POST' })
    );
    // Opening call carries no sessionId and no message.
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({});
    // Free-text reply line present, no scripted intake question.
    expect(screen.getByLabelText('Your reply')).toBeTruthy();
    expect(screen.queryByText('Where does it go?')).toBeNull();
  });

  it('holds a multi-turn exchange, disabling input and typing while a turn is in flight', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(converseResponse()));
    render(<DesignConversation />);
    await screen.findByText(OPENER);

    let resolveTurn!: (value: Response) => void;
    fetchMock.mockReturnValueOnce(
      new Promise<Response>((resolve) => {
        resolveTurn = resolve;
      })
    );

    sendReply('inner forearm, for my dad');

    // User bubble renders immediately; bot is "typing"; input disabled.
    expect(screen.getByText('inner forearm, for my dad')).toBeTruthy();
    expect(screen.getByRole('status', { name: 'Working' })).toBeTruthy();
    expect((screen.getByLabelText('Your reply') as HTMLInputElement).disabled).toBe(true);

    resolveTurn!(
      jsonResponse(
        converseResponse({ reply: 'A memorial for your dad — what did he love?', turn: 1 })
      )
    );
    await screen.findByText('A memorial for your dad — what did he love?');

    // Turn carried the sessionId + message; indicator gone; input live again.
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({
      sessionId: 'sess-1',
      message: 'inner forearm, for my dad',
    });
    expect(screen.queryByRole('status', { name: 'Working' })).toBeNull();
    expect((screen.getByLabelText('Your reply') as HTMLInputElement).disabled).toBe(false);
  });

  it('renders the proposal reply once (no duplicate playback bubble) and transitions confirm → existing reveal UI', async () => {
    await reachProposal();

    // The reply bubble embeds the playback and is the ONLY place it renders —
    // no second bot bubble repeating the raw playback.
    expect(screen.getAllByText(/Fine-line blackwork on the inner forearm/)).toHaveLength(1);

    fetchMock.mockResolvedValueOnce(jsonResponse(revealedSession));
    fireEvent.click(screen.getByRole('button', { name: /show me/i }));

    // Confirm hits the frozen contract path.
    await screen.findByText(REVEAL_NARRATION);
    expect(fetchMock).toHaveBeenLastCalledWith(
      '/api/v1/design-session/sess-1/confirm',
      expect.objectContaining({ method: 'POST' })
    );

    // The EXISTING reveal UI: the round's two cuts, pick affordances.
    expect(screen.getAllByAltText(/^Design \d$/)).toHaveLength(2);
    expect(screen.getAllByRole('button', { name: /pick design/i })).toHaveLength(2);
    // Conversation transcript kept above the reveal; no proposal CTA left.
    expect(screen.getByText(OPENER)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /show me/i })).toBeNull();
  });

  it('fast-lanes a complete first prompt: a turn-1 proposal auto-confirms into the reveal (ADR-0028)', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(converseResponse()))
      .mockResolvedValueOnce(
        jsonResponse(
          converseResponse({
            reply:
              "Here's what I'm hearing: Fine-line blackwork on the inner forearm — strength after a rough year. Want to see four takes, or did I miss something?",
            stage: 'proposal',
            playback: 'Fine-line blackwork on the inner forearm — strength after a rough year.',
            turn: 1,
          })
        )
      )
      .mockResolvedValueOnce(jsonResponse(revealedSession));

    render(<DesignConversation />);
    await screen.findByText(OPENER);

    sendReply('fine-line blackwork on my inner forearm — strength after a rough year');

    // Straight to the reveal — the confirm fired without a consent tap.
    await screen.findByText(REVEAL_NARRATION);
    expect(fetchMock.mock.calls[2][0]).toBe('/api/v1/design-session/sess-1/confirm');
    expect(screen.getAllByAltText(/^Design \d$/)).toHaveLength(2);
    expect(screen.queryByRole('button', { name: /show me/i })).toBeNull();
  });

  it('sends a deep-linked prompt as the first message instead of the opener (ADR-0028)', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(
        converseResponse({ reply: 'Where on your body is it going?', stage: 'chatting', turn: 1 })
      )
    );

    render(<DesignConversation initialPrompt="a dragon" />);

    // The prompt is the user's opening line — one round trip, no opener.
    await screen.findByText('Where on your body is it going?');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ message: 'a dragon' });
    expect(screen.getByText('a dragon')).toBeTruthy();
    expect(screen.queryByText(OPENER)).toBeNull();
  });

  it('treats typed confirmation intent as one confirm transition, never another proposal turn', async () => {
    await reachProposal();
    fetchMock.mockResolvedValueOnce(jsonResponse(revealedSession));

    sendReply('yes, show me');

    await screen.findByText(REVEAL_NARRATION);
    const confirmCalls = fetchMock.mock.calls.filter(
      ([path]) => path === '/api/v1/design-session/sess-1/confirm'
    );
    // Turns 0-2 walked to the proposal; nothing after it may re-converse.
    const repeatedConverseCalls = fetchMock.mock.calls.filter(
      ([path], index) => index >= 3 && path === '/api/v1/design-session/converse'
    );
    expect(confirmCalls).toHaveLength(1);
    expect(repeatedConverseCalls).toHaveLength(0);
    expect(screen.getAllByText(/Fine-line blackwork on the inner forearm/)).toHaveLength(1);
    expect(screen.queryByRole('button', { name: /show me/i })).toBeNull();
  });

  it('treats a correction at the proposal as another turn and keeps chatting', async () => {
    await reachProposal();

    fetchMock.mockResolvedValueOnce(
      jsonResponse(
        converseResponse({
          reply: 'Got it — upper arm, not forearm. What else did I get wrong?',
          stage: 'chatting',
          turn: 3,
        })
      )
    );

    // A correction is just another converse message (ADR-0020), not confirm.
    sendReply('actually, upper arm');
    await screen.findByText('Got it — upper arm, not forearm. What else did I get wrong?');

    expect(JSON.parse(fetchMock.mock.calls[3][1].body)).toEqual({
      sessionId: 'sess-1',
      message: 'actually, upper arm',
    });
    // Proposal affordance gone; the conversation continues.
    expect(screen.queryByRole('button', { name: /show me/i })).toBeNull();
    expect((screen.getByLabelText('Your reply') as HTMLInputElement).disabled).toBe(false);
  });

  it('renders the warm handoff with a CTA and no limit language', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(converseResponse()))
      .mockResolvedValueOnce(
        jsonResponse(
          converseResponse({
            reply:
              'Sounds like you’re still working out the concept — that’s actually a great reason to talk to an artist directly. Want me to find a few who do free consultations in your style?',
            stage: 'handoff',
            handoffUrl: '/smart-match?src=design-handoff',
            turn: 20,
          })
        )
      );

    render(<DesignConversation />);
    await screen.findByText(OPENER);
    sendReply('hmm, still not sure');

    // Warm bot bubble + CTA out — no dead end.
    await screen.findByText(/free consultations in your style/i);
    const cta = screen.getByRole('link', { name: /find my artist/i });
    expect(cta.getAttribute('href')).toBe('/smart-match?src=design-handoff');

    // Never framed as a limit the user hit (ADR-0021).
    expect(screen.queryByText(/limit|maximum|too many|out of turns|ran out/i)).toBeNull();
  });

  it('downgrades seamlessly to the scripted intake on 503', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ error: 'Conversation unavailable' }, 503)
    );

    render(<DesignConversation />);

    // Soft one-liner, then the existing scripted two-question intake.
    await screen.findByText(/two quick questions/i);
    expect(screen.getByText('Where does it go?')).toBeTruthy();
    expect(screen.getByLabelText('Where does it go?')).toBeTruthy();
    // No error surface, no retry — the downgrade is seamless.
    expect(screen.queryByRole('button', { name: /retry/i })).toBeNull();

    // The scripted flow is live: answering the first question advances it.
    fireEvent.change(screen.getByLabelText('Where does it go?'), {
      target: { value: 'inner forearm' },
    });
    fireEvent.click(screen.getByRole('button', { name: /send/i }));
    await screen.findByText('And what do you want to feel when you look at it?');
  });

  it('offers no second refinement affordance downstream of the conversation (ADR-0013 re-assert)', async () => {
    await reachProposal();

    fetchMock
      .mockResolvedValueOnce(jsonResponse(revealedSession))
      .mockResolvedValueOnce(jsonResponse(roundPickedSession))
      .mockResolvedValueOnce(jsonResponse(pickedSession))
      .mockResolvedValueOnce(jsonResponse(completeSession));

    fireEvent.click(screen.getByRole('button', { name: /show me/i }));
    await screen.findByText(REVEAL_NARRATION);

    // Round pick (free, ADR-0049) → lock it in (the other cut is the
    // implicit most-not-you) → the one ADR-0013 refinement.
    fireEvent.click(screen.getByRole('button', { name: /^Pick design 2 / }));
    fireEvent.click(await screen.findByRole('button', { name: 'Lock it in' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Bolder lines' }));
    await screen.findByAltText('Your refined design');

    // Hard stop: no regenerate/iterate controls, no free-text input (the
    // conversation's reply box included), no lingering grid taps.
    expect(screen.queryByRole('button', { name: /regenerate|try again|another|one more|refine|show me/i })).toBeNull();
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.queryByRole('button', { name: /pick design/i })).toBeNull();
  });

  it('scaffolds the empty state with starter chips + example strip, and a chip tap is just a normal first message', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(converseResponse()));
    render(<DesignConversation />);
    await screen.findByText(OPENER);

    // First-run scaffolding present: the stakes-lowering line, tappable
    // chips, and the honest example strip (real pipeline outputs, labeled).
    expect(screen.getByText(/no idea yet\? that’s the point/i)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'surprise me' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'a memorial piece for someone' })).toBeTruthy();
    expect(screen.getByTestId('example-strip')).toBeTruthy();
    expect(screen.getByText('AI-generated examples')).toBeTruthy();
    expect(screen.getAllByAltText(/AI-generated/)).toHaveLength(4);

    fetchMock.mockResolvedValueOnce(
      jsonResponse(
        converseResponse({ reply: 'Florals — where on your body?', stage: 'chatting', turn: 1 })
      )
    );
    fireEvent.click(screen.getByRole('button', { name: 'fine-line florals' }));

    // The chip text is the user's message, sent through the SAME converse
    // path as typing — no separate route, the engine's routing decides.
    await screen.findByText('Florals — where on your body?');
    expect(screen.getByText('fine-line florals')).toBeTruthy();
    expect(fetchMock.mock.calls[1][0]).toBe('/api/v1/design-session/converse');
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({
      sessionId: 'sess-1',
      message: 'fine-line florals',
    });

    // Once the user has spoken, the scaffolding is gone for good.
    expect(screen.queryByRole('button', { name: 'surprise me' })).toBeNull();
    expect(screen.queryByText(/no idea yet\? that’s the point/i)).toBeNull();
    expect(screen.queryByTestId('example-strip')).toBeNull();
  });

  it('shows no first-run scaffolding when a deep-linked prompt opens the session (ADR-0028)', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(
        converseResponse({ reply: 'Where on your body is it going?', stage: 'chatting', turn: 1 })
      )
    );

    render(<DesignConversation initialPrompt="a dragon" />);
    await screen.findByText('Where on your body is it going?');

    // The deep link already spoke for the user — no chips, no strip.
    expect(screen.queryByRole('button', { name: 'surprise me' })).toBeNull();
    expect(screen.queryByTestId('example-strip')).toBeNull();
  });

  it('shows no first-run scaffolding in the scripted fallback', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: 'Conversation unavailable' }, 503));

    render(<DesignConversation />);
    await screen.findByText(/two quick questions/i);

    // The scripted intake asks its own questions in order — a chip answer
    // like "fine-line florals" would collide with "Where does it go?".
    expect(screen.queryByRole('button', { name: 'surprise me' })).toBeNull();
    expect(screen.queryByTestId('example-strip')).toBeNull();
  });
});

/* ── SketchBot's live notepad + visible fast lane (TAT-48) ───────────────── */

const emptyNotes: SessionNotes = { cast: [], ipHeadsUp: false, sufficient: false };

// Five cast members across two series — the TAT-47 defect-6 regression
// shape: the notepad must enumerate every one, never a truncated pair.
const FULL_CAST = [
  'Gon (Hunter x Hunter)',
  'Killua (Hunter x Hunter)',
  'Hiei (Yu Yu Hakusho)',
  'Kurama (Yu Yu Hakusho)',
  'Yusuke (Yu Yu Hakusho)',
];

const populatedNotes: SessionNotes = {
  placement: 'arm sleeve',
  cast: FULL_CAST,
  style: 'anime + color',
  scene: 'mid-fight',
  vibe: 'the shows that raised me',
  ipHeadsUp: true,
  sufficient: true,
};

describe('DesignConversation — SketchBot notepad (TAT-48)', () => {
  async function openWithNotes(notes: SessionNotes) {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(converseResponse()))
      .mockResolvedValueOnce(
        jsonResponse(
          converseResponse({
            reply: 'That is a full Togashi lineup — which moment anchors it?',
            stage: 'chatting',
            turn: 1,
            notes,
          })
        )
      );
    render(<DesignConversation />);
    await screen.findByText(OPENER);
    sendReply('arm sleeve, gon killua hiei kurama yusuke');
    await screen.findByText('That is a full Togashi lineup — which moment anchors it?');
  }

  it('starts empty, in voice — nothing internal, nothing invented', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(converseResponse()));
    render(<DesignConversation />);
    await screen.findByText(OPENER);

    expect(screen.getByText(/nothing yet — talk to me/i)).toBeTruthy();
    expect(screen.getAllByText(/sketchbot's notes/i).length).toBeGreaterThan(0);
  });

  it('renders every brief field with the full cast enumerated, and never internal strings', async () => {
    await openWithNotes(populatedNotes);

    // Every cast member, one row each (TAT-47 defect 6 regression guard).
    for (const member of FULL_CAST) {
      expect(screen.getByText(member)).toBeTruthy();
    }
    expect(screen.getByText('arm sleeve')).toBeTruthy();
    expect(screen.getByText('anime + color')).toBeTruthy();
    expect(screen.getByText('mid-fight')).toBeTruthy();
    expect(screen.getByText('the shows that raised me')).toBeTruthy();
    // The IP heads-up line, in voice.
    expect(
      screen.getByText(/inspired-by take — your artist dials in the exact likeness/i)
    ).toBeTruthy();

    // HARD RULE (TAT-47 defect 8): internal machinery never renders —
    // no rationale, no confidence, no axis/questionnaire telemetry.
    expect(
      screen.queryByText(/rationale|confidence|questionnaire mode|ambiguous|axis/i)
    ).toBeNull();
  });

  it('tap-to-fix prefills a correction opener into the reply line', async () => {
    await openWithNotes(populatedNotes);

    fireEvent.click(screen.getByRole('button', { name: /fix placement/i }));
    expect((screen.getByLabelText('Your reply') as HTMLInputElement).value).toBe(
      'actually, the placement is '
    );

    fireEvent.click(screen.getByRole('button', { name: /fix vibe/i }));
    expect((screen.getByLabelText('Your reply') as HTMLInputElement).value).toBe(
      'actually, what it means is '
    );
  });

  it('shows the fast-lane chip only when the record is generation-sufficient, and the chip rides the normal converse path', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(converseResponse()))
      .mockResolvedValueOnce(
        jsonResponse(
          converseResponse({
            reply: 'Where on your body is it going?',
            stage: 'chatting',
            turn: 1,
            notes: emptyNotes,
          })
        )
      );
    render(<DesignConversation />);
    await screen.findByText(OPENER);

    sendReply('a hummingbird for my grandmother');
    await screen.findByText('Where on your body is it going?');
    // Not sufficient yet — no chip.
    expect(screen.queryByRole('button', { name: /skip the questions/i })).toBeNull();

    fetchMock.mockResolvedValueOnce(
      jsonResponse(
        converseResponse({
          reply: 'Left forearm it is. Delicate or bold?',
          stage: 'chatting',
          turn: 2,
          notes: { ...emptyNotes, placement: 'left forearm', sufficient: true },
        })
      )
    );
    sendReply('left forearm');
    await screen.findByText('Left forearm it is. Delicate or bold?');

    // Sufficient + still chatting → the chip surfaces.
    const chip = screen.getByRole('button', { name: /skip the questions — just draw/i });

    fetchMock.mockResolvedValueOnce(
      jsonResponse(
        converseResponse({
          reply:
            "Here's what I'm hearing: a piece on your left forearm — a hummingbird for my grandmother. Want to see four takes on this, or did I miss something?",
          stage: 'proposal',
          playback: 'a piece on your left forearm — a hummingbird for my grandmother',
          turn: 3,
          notes: { ...emptyNotes, placement: 'left forearm', sufficient: true },
        })
      )
    );
    fireEvent.click(chip);

    // The chip is a prefilled message through the SAME converse path.
    await screen.findByRole('button', { name: /show me/i });
    const converseCalls = fetchMock.mock.calls.filter(
      ([path]) => path === '/api/v1/design-session/converse'
    );
    expect(JSON.parse(converseCalls[converseCalls.length - 1][1].body)).toEqual({
      sessionId: 'sess-1',
      message: 'skip the questions — just draw',
    });
    // At the proposal the chip is gone — the draw CTA anchors the notepad.
    expect(screen.queryByRole('button', { name: /skip the questions/i })).toBeNull();

    // The anchored CTA fires the confirm path into the reveal.
    fetchMock.mockResolvedValueOnce(jsonResponse(revealedSession));
    fireEvent.click(screen.getByRole('button', { name: /draw 2 cuts/i }));
    await screen.findByText(REVEAL_NARRATION);
    expect(fetchMock).toHaveBeenLastCalledWith(
      '/api/v1/design-session/sess-1/confirm',
      expect.objectContaining({ method: 'POST' })
    );
  });

  it('locks the notepad once the reveal fires — a static brief, no fix taps, no draw CTA', async () => {
    await openWithNotes(populatedNotes);

    fetchMock.mockResolvedValueOnce(
      jsonResponse(
        converseResponse({
          reply:
            "Here's what I'm hearing: the full lineup. Want to see four takes on this, or did I miss something?",
          stage: 'proposal',
          playback: 'the full lineup',
          turn: 2,
          notes: populatedNotes,
        })
      )
    );
    sendReply('that is everything');
    await screen.findByRole('button', { name: /show me/i });

    fetchMock.mockResolvedValueOnce(jsonResponse(revealedSession));
    fireEvent.click(screen.getByRole('button', { name: /show me/i }));
    await screen.findByText(REVEAL_NARRATION);

    // The brief still reads back — but nothing is tappable and the CTA is done.
    expect(screen.getByText('Gon (Hunter x Hunter)')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /fix / })).toBeNull();
    expect(screen.queryByRole('button', { name: /draw 2 cuts/i })).toBeNull();
  });

  it('pull-up sheet: peeking by default, expands and collapses on tap', async () => {
    await openWithNotes(populatedNotes);

    const toggle = screen.getByRole('button', { name: /sketchbot's notes — expand/i });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    // Collapsed: values render once (the desktop card only).
    expect(screen.getAllByText('Gon (Hunter x Hunter)')).toHaveLength(1);

    fireEvent.click(toggle);
    expect(
      screen
        .getByRole('button', { name: /sketchbot's notes — collapse/i })
        .getAttribute('aria-expanded')
    ).toBe('true');
    // Expanded: the sheet renders the same brief — twice in the DOM now.
    expect(screen.getAllByText('Gon (Hunter x Hunter)')).toHaveLength(2);

    fireEvent.click(screen.getByRole('button', { name: /sketchbot's notes — collapse/i }));
    expect(screen.getAllByText('Gon (Hunter x Hunter)')).toHaveLength(1);
  });
});
