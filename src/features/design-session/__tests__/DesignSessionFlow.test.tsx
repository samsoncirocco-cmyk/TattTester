// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { createElement } from 'react';
import type { DesignSession } from '@/services/designSession/types';
import { DesignSessionFlow } from '../components/DesignSessionFlow';
import { parseBinaryChoices } from '../components/RefinementPrompt';

// What the user HEARS at the reveal — derived, in-voice. The raw
// axisSelection.rationale is an internal audit log (ADR-0012) and must
// never render in the chat.
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

// Round one's pair (ADR-0049): two cuts spread on one axis.
const variations = [1, 2].map((n) => ({
  id: `v${n}`,
  axisPosition: { 'bold-fine': n % 2 ? 'bold' : 'fine' },
  prompt: `prompt ${n}`,
  imageUrl: `https://img.test/design-${n}.png`,
}));

const baseSession: DesignSession = {
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
    rationale: 'Questionnaire mode: round one spreads on bold-fine, the first ladder rung.',
  },
  provider: 'replicate',
  variations,
  rounds: [{ round: 1, axis: 'bold-fine', variationIds: ['v1', 'v2'] }],
  createdAt: '2026-07-24T00:00:00Z',
  updatedAt: '2026-07-24T00:00:00Z',
};

/** Round one with its pick landed — still changeable (ADR-0049). */
const roundPickedSession: DesignSession = {
  ...baseSession,
  rounds: [
    {
      round: 1,
      axis: 'bold-fine',
      variationIds: ['v1', 'v2'],
      pickedId: 'v2',
      pickedAt: '2026-07-24T00:01:00Z',
    },
  ],
};

/**
 * A charged second round: round 1 frozen, two new cuts on the next OPEN
 * axis. The intake's blackwork tag settled color-blackwork (ADR-0049), so
 * the ladder skips that rung — round two spreads literal-abstract, never a
 * color cut against a brief that said blackwork.
 */
const roundTwoSession: DesignSession = {
  ...baseSession,
  variations: [
    ...variations,
    {
      id: 'v3',
      axisPosition: { 'literal-abstract': 'literal', 'bold-fine': 'fine' },
      prompt: 'prompt 3',
      imageUrl: 'https://img.test/design-3.png',
    },
    {
      id: 'v4',
      axisPosition: { 'literal-abstract': 'abstract', 'bold-fine': 'fine' },
      prompt: 'prompt 4',
      imageUrl: 'https://img.test/design-4.png',
    },
  ],
  rounds: [
    {
      round: 1,
      axis: 'bold-fine',
      variationIds: ['v1', 'v2'],
      pickedId: 'v2',
      pickedAt: '2026-07-24T00:01:00Z',
      frozen: true,
    },
    { round: 2, axis: 'literal-abstract', variationIds: ['v3', 'v4'] },
  ],
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
  brief: {
    placement: 'inner forearm',
    styleTags: ['blackwork'],
    meaning: 'strength after a rough year',
    references: [],
    axisSelection: baseSession.axisSelection,
    placementNotes: ['Fine detail near the wrist crease may blur within a few years.'],
    rejectedAxisPosition: { 'bold-fine': 'fine' },
  },
};

function jsonResponse(body: unknown) {
  return { ok: true, status: 200, json: async () => body } as Response;
}

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

async function answerIntake() {
  fireEvent.change(screen.getByLabelText('Where does it go?'), {
    target: { value: 'inner forearm' },
  });
  fireEvent.click(screen.getByRole('button', { name: /send/i }));

  fireEvent.change(await screen.findByLabelText('What do you want to feel?'), {
    target: { value: 'strength after a rough year' },
  });
  fireEvent.click(screen.getByRole('button', { name: /send/i }));
}

describe('DesignSessionFlow', () => {
  it('walks intake → reveal → round pick → lock-in → refine → complete', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(baseSession))
      .mockResolvedValueOnce(jsonResponse(roundPickedSession))
      .mockResolvedValueOnce(jsonResponse(pickedSession))
      .mockResolvedValueOnce(jsonResponse(completeSession));

    render(<DesignSessionFlow />);

    // Intake reads as conversation — two bot turns, no labeled form fields.
    expect(screen.getByText('Where does it go?')).toBeTruthy();
    await answerIntake();

    // Start call hits the frozen contract path with both answers.
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v1/design-session',
      expect.objectContaining({ method: 'POST' })
    );
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      placementAnswer: 'inner forearm',
      meaningAnswer: 'strength after a rough year',
    });

    // Reveal: in-voice narration + the round prompt + 2 cuts (ADR-0049).
    // The raw audit rationale must never reach the transcript.
    await screen.findByText(REVEAL_NARRATION);
    expect(screen.getByText('Two cuts. Tap the one that’s closer.')).toBeTruthy();
    expect(screen.queryByText(baseSession.axisSelection.rationale)).toBeNull();
    expect(screen.queryByText(/questionnaire mode/i)).toBeNull();
    expect(screen.getAllByAltText(/^Design \d$/)).toHaveLength(2);

    // Tap → the FREE round pick (ADR-0049) → the computed next-axis invite.
    // The intake's blackwork tag settled color-blackwork, so the invite
    // skips that rung — it must promise the axis the charged round will
    // actually spread, never a color round against a blackwork brief.
    fireEvent.click(screen.getByRole('button', { name: /^Pick design 2 / }));
    await screen.findByText(
      'Good eye. Refine it? Next round is literal vs abstract — 1 credit.'
    );
    expect(screen.getByText('Your pick')).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v1/design-session/sess-1/round/pick',
      expect.objectContaining({ method: 'POST' })
    );
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({ pickedId: 'v2' });
    expect(screen.getByRole('button', { name: 'Refine — 1 credit' })).toBeTruthy();

    // Lock it in → old pick POST with the other cut as the implicit
    // most-not-you (one clean negative signal, no extra tap).
    fireEvent.click(screen.getByRole('button', { name: 'Lock it in' }));
    await screen.findByText(pickedSession.refinementQuestion!);
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v1/design-session/sess-1/pick',
      expect.objectContaining({ method: 'POST' })
    );
    expect(JSON.parse(fetchMock.mock.calls[2][1].body)).toEqual({
      pickId: 'v2',
      mostNotYouId: 'v1',
    });

    // Binary question renders as two choices; answering triggers refine POST.
    fireEvent.click(screen.getByRole('button', { name: 'Bolder lines' }));
    await screen.findByAltText('Your refined design');
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v1/design-session/sess-1/refine',
      expect.objectContaining({ method: 'POST' })
    );
    expect(JSON.parse(fetchMock.mock.calls[3][1].body)).toEqual({ answer: 'Bolder lines' });

    // Handoff card: brief summary quoted back + honest placement note (ADR-0014).
    // ("inner forearm" also appears in the intake transcript, hence getAllByText.)
    expect(screen.getAllByText('inner forearm').length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText(/“strength after a rough year”/)).toBeTruthy();
    expect(screen.getByText(/wrist crease may blur/i)).toBeTruthy();

    // CTAs out — AR mirror, artist matching, and the refinery (which only
    // appears once the refined cut has landed in the local library, and
    // carries that design id into /studio — ADR-0038).
    expect(screen.getByRole('link', { name: /see it on your skin/i }).getAttribute('href')).toContain('/visualize?');
    expect(screen.getByRole('link', { name: /see it on your skin/i }).getAttribute('href')).toContain('ds=sess-1');
    expect(screen.getByRole('link', { name: /find your artist/i }).getAttribute('href')).toBe('/smart-match?ds=sess-1');
    await waitFor(() =>
      expect(
        screen.getByRole('link', { name: /fine-tune in the studio/i }).getAttribute('href'),
      ).toMatch(/^\/studio\?design=/),
    );
  });

  // The pick-to-refine loop itself (ADR-0049): a charged round renders two
  // NEW cuts on the next ladder axis and the grid moves to them.
  describe('refine rounds (ADR-0049)', () => {
    async function reachRoundPicked() {
      fetchMock
        .mockResolvedValueOnce(jsonResponse(baseSession))
        .mockResolvedValueOnce(jsonResponse(roundPickedSession));
      render(<DesignSessionFlow />);
      await answerIntake();
      await screen.findByText(REVEAL_NARRATION);
      fireEvent.click(screen.getByRole('button', { name: /^Pick design 2 / }));
      await screen.findByRole('button', { name: 'Refine — 1 credit' });
    }

    it('charges a round and reveals the next pair on the next axis', async () => {
      await reachRoundPicked();

      fetchMock.mockResolvedValueOnce(
        jsonResponse({ success: true, session: roundTwoSession, round: roundTwoSession.rounds![1] })
      );
      fireEvent.click(screen.getByRole('button', { name: 'Refine — 1 credit' }));

      // The round POST fired, and the grid now shows round two's cuts.
      await screen.findByRole('button', { name: /^Pick design 3 / });
      expect(fetchMock).toHaveBeenLastCalledWith(
        '/api/v1/design-session/sess-1/round',
        expect.objectContaining({ method: 'POST' })
      );
      expect(screen.getAllByAltText(/^Design \d$/)).toHaveLength(2);
      expect(screen.getByRole('button', { name: /^Pick design 4 / })).toBeTruthy();
      // Round two has no pick yet — no invite, no charged button.
      expect(screen.queryByRole('button', { name: 'Refine — 1 credit' })).toBeNull();
    });

    it('lets the pick change until the round is charged', async () => {
      await reachRoundPicked();

      const repicked: DesignSession = {
        ...baseSession,
        rounds: [
          {
            round: 1,
            axis: 'bold-fine',
            variationIds: ['v1', 'v2'],
            pickedId: 'v1',
            pickedAt: '2026-07-24T00:02:00Z',
          },
        ],
      };
      fetchMock.mockResolvedValueOnce(jsonResponse(repicked));

      // Tapping the other cut re-picks — same endpoint, no charge.
      fireEvent.click(screen.getByRole('button', { name: /^Pick design 1 / }));
      await waitFor(() =>
        expect(JSON.parse(fetchMock.mock.calls[2][1].body)).toEqual({ pickedId: 'v1' })
      );
      expect(fetchMock).toHaveBeenLastCalledWith(
        '/api/v1/design-session/sess-1/round/pick',
        expect.objectContaining({ method: 'POST' })
      );
    });

    it('speaks the ADR-0048 downgrade and the refund when a round came off the backup lane', async () => {
      await reachRoundPicked();

      const downgradedRound = {
        ...roundTwoSession.rounds![1],
        downgraded: true,
        downgradeReason: 'REPLICATE_ERROR',
      };
      fetchMock.mockResolvedValueOnce(
        jsonResponse({
          success: true,
          session: { ...roundTwoSession, rounds: [roundTwoSession.rounds![0], downgradedRound] },
          round: downgradedRound,
          creditReleased: true,
        })
      );
      fireEvent.click(screen.getByRole('button', { name: 'Refine — 1 credit' }));

      // Delivered, said, and the refund only claimed because it landed.
      await screen.findByText('heads up — this round came off my backup lane, so that credit is back.');
      expect(screen.getByRole('button', { name: /^Pick design 3 / })).toBeTruthy();
    });

    it('announces the downgrade without the refund claim when the release failed', async () => {
      await reachRoundPicked();

      const downgradedRound = { ...roundTwoSession.rounds![1], downgraded: true };
      fetchMock.mockResolvedValueOnce(
        jsonResponse({
          success: true,
          session: { ...roundTwoSession, rounds: [roundTwoSession.rounds![0], downgradedRound] },
          round: downgradedRound,
          creditReleased: false,
        })
      );
      fireEvent.click(screen.getByRole('button', { name: 'Refine — 1 credit' }));

      await screen.findByText('heads up — this round came off my backup lane.');
      expect(
        screen.queryByText('heads up — this round came off my backup lane, so that credit is back.')
      ).toBeNull();
    });

    it('shows the decided failure copy and a retry when the round dies', async () => {
      await reachRoundPicked();

      fetchMock.mockResolvedValueOnce({
        ok: false,
        status: 502,
        json: async () => ({
          error: "That round didn't take — your credit is back. Run it again?",
          code: 'ROUND_FAILED',
          creditReleased: true,
        }),
      } as Response);
      fireEvent.click(screen.getByRole('button', { name: 'Refine — 1 credit' }));

      await screen.findByText("That round didn't take — your credit is back. Run it again?");
      expect(screen.getByRole('button', { name: /retry/i })).toBeTruthy();
    });
  });

  it('offers no second refinement affordance after completion (ADR-0013 hard stop)', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(baseSession))
      .mockResolvedValueOnce(jsonResponse(roundPickedSession))
      .mockResolvedValueOnce(jsonResponse(pickedSession))
      .mockResolvedValueOnce(jsonResponse(completeSession));

    render(<DesignSessionFlow />);
    await answerIntake();
    await screen.findByText(REVEAL_NARRATION);
    fireEvent.click(screen.getByRole('button', { name: /^Pick design 2 / }));
    fireEvent.click(await screen.findByRole('button', { name: 'Lock it in' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Bolder lines' }));
    await screen.findByAltText('Your refined design');

    // No regenerate/iterate controls, no free-text input, no lingering grid taps.
    expect(screen.queryByRole('button', { name: /regenerate|try again|another|one more|refine/i })).toBeNull();
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.queryByRole('button', { name: /pick design/i })).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  // ADR-0039: the chat used to die at the reveal — there was no reply box at
  // all, so "riku's missing" had nowhere to go. These pin that it survives
  // the two-cut rounds and still closes at the Brief.
  describe('critique lane (ADR-0039)', () => {
    async function reachReveal() {
      fetchMock.mockResolvedValueOnce(jsonResponse(baseSession));
      render(<DesignSessionFlow />);
      await answerIntake();
      await screen.findByText(REVEAL_NARRATION);
    }

    it('keeps the reply box open at the reveal and re-cuts on plain criticism', async () => {
      await reachReveal();

      const box = screen.getByLabelText("Tell me what's wrong with it");
      expect(screen.getByText(/if something.s off, just say it/i)).toBeTruthy();

      const recut = {
        id: 'v1-fix1',
        axisPosition: { 'bold-fine': 'bold' },
        prompt: 'prompt 1 recut',
        imageUrl: 'https://img.test/recut.png',
      };
      fetchMock.mockResolvedValueOnce(
        jsonResponse({
          success: true,
          session: { ...baseSession, critiqueCuts: [recut], fixesUsed: 1 },
          reply: 're-cut cut one with that. 5 more re-cuts before i hand you over.',
          cut: recut,
          fixesRemaining: 5,
          exhausted: false,
          generated: true,
        })
      );

      fireEvent.change(box, { target: { value: 'the first one but less color' } });
      fireEvent.submit(box.closest('form')!);

      await screen.findByText(/re-cut cut one with that/i);
      expect(fetchMock).toHaveBeenLastCalledWith(
        '/api/v1/design-session/sess-1/critique',
        expect.objectContaining({ method: 'POST' })
      );
      expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({
        message: 'the first one but less color',
      });

      // The user's words are echoed back, and the re-cut renders beside the
      // round's pair, numbered on from it.
      expect(screen.getByText('the first one but less color')).toBeTruthy();
      expect(screen.getAllByAltText(/^Design \d$/)).toHaveLength(3);
      expect(screen.getByAltText('Design 3')).toBeTruthy();
    });

    it('speaks the ceiling instead of silently refusing, and never renders past it', async () => {
      await reachReveal();

      fetchMock.mockResolvedValueOnce(
        jsonResponse({
          success: true,
          session: baseSession,
          reply: "you've been round this a few times now — that's your artist's job, honestly.",
          fixesRemaining: 0,
          exhausted: true,
          generated: false,
        })
      );

      const box = screen.getByLabelText("Tell me what's wrong with it");
      fireEvent.change(box, { target: { value: 'one more, less color' } });
      fireEvent.submit(box.closest('form')!);

      await screen.findByText(/that.s your artist.s job/i);
      // Refusal spoken, no new cut — the pair is still all there is.
      expect(screen.getAllByAltText(/^Design \d$/)).toHaveLength(2);
    });

    it('keeps the reveal usable when a critique turn fails', async () => {
      await reachReveal();

      fetchMock.mockResolvedValueOnce({
        ok: false,
        status: 503,
        json: async () => ({ error: 'The image provider is busy right now — retrying shortly usually clears it.', code: 'GENERATION_UNAVAILABLE', retryable: true }),
      } as Response);

      const box = screen.getByLabelText("Tell me what's wrong with it");
      fireEvent.change(box, { target: { value: 'too busy' } });
      fireEvent.submit(box.closest('form')!);

      await screen.findByText(/image provider is busy/i);
      // The failure is a line in the lane, not a banner over the reveal: the
      // round's cuts are still tappable.
      expect(screen.getByRole('button', { name: /^Pick design 2 / })).toBeTruthy();
      expect(screen.getByLabelText("Tell me what's wrong with it")).toBeTruthy();
    });
  });

  it('shows a thinking line while the session starts, then the rationale', async () => {
    let resolveStart!: (value: Response) => void;
    fetchMock.mockReturnValueOnce(
      new Promise<Response>((resolve) => {
        resolveStart = resolve;
      })
    );

    render(<DesignSessionFlow />);
    await answerIntake();

    expect(screen.getByRole('status', { name: 'Working' })).toBeTruthy();
    resolveStart!(jsonResponse(baseSession));
    await screen.findByText(REVEAL_NARRATION);
    expect(screen.queryByRole('status', { name: 'Working' })).toBeNull();
  });
});

describe('parseBinaryChoices', () => {
  it('splits a binary question into two choices', () => {
    expect(parseBinaryChoices('Bolder lines or keep them fine?')).toEqual([
      'Bolder lines',
      'keep them fine',
    ]);
  });

  it('returns null for open questions', () => {
    expect(parseBinaryChoices('What should change about the linework?')).toBeNull();
  });
});
