// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import type { ReactNode } from 'react';
import { createElement } from 'react';
import type { DesignSession } from '@/services/designSession/types';
import { getOptionalApiAuthHeaders } from '@/lib/client-api-auth';
import { useAuthStore } from '@/store/useAuthStore';
import { CREDITS_EXHAUSTED_MESSAGE } from '@/lib/generation-credits-shared';
import {
  applyCreditsFromResponse,
  markCreditsExhausted,
  refreshCreditBalance,
  resetCreditBalance,
  useCreditBalanceStore,
} from '../services/creditBalance';
import { confirmProposal, runRefineRound } from '../services/designSessionApi';
import { DesignSessionFlow, REFINE_BUTTON_LABEL } from '../components/DesignSessionFlow';
import { DesignConversation } from '../components/DesignConversation';

vi.mock('@/lib/client-api-auth', () => ({
  getApiAuthHeaders: vi.fn(async () => ({ Authorization: 'Bearer test-token' })),
  getOptionalApiAuthHeaders: vi.fn(async () => ({ Authorization: 'Bearer test-token' })),
  SignInRequiredError: class SignInRequiredError extends Error {},
}));

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

const variations = [1, 2].map((n) => ({
  id: `v${n}`,
  axisPosition: { 'bold-fine': n % 2 ? 'bold' : 'fine' },
  prompt: `prompt ${n}`,
  imageUrl: `https://img.test/design-${n}.png`,
}));

const pickedRound: DesignSession = {
  id: 'sess-1',
  phase: 'revealed',
  intake: {
    placement: 'inner forearm',
    styleTags: ['blackwork'],
    meaning: 'strength',
    references: [],
    ambiguousAxes: ['bold-fine'],
  },
  axisSelection: { mode: 'questionnaire', axes: ['bold-fine'], rationale: 'r' },
  provider: 'replicate',
  variations,
  rounds: [{ round: 1, axis: 'bold-fine', variationIds: ['v1', 'v2'], pickedId: 'v2', pickedAt: 'x' }],
  createdAt: '2026-07-24T00:00:00Z',
  updatedAt: '2026-07-24T00:00:00Z',
};

function jsonResponse(body: unknown, status = 200) {
  return { ok: status < 400, status, json: async () => body } as Response;
}

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  resetCreditBalance();
  useAuthStore.setState({ user: null });
  vi.mocked(getOptionalApiAuthHeaders).mockResolvedValue({ Authorization: 'Bearer test-token' });
});

describe('credit balance store', () => {
  it('takes the post-debit balance from a charged response with no extra request', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        session: pickedRound,
        credits: { id: 'r1', source: 'free', freeRemaining: 11, paidRemaining: 6 },
        creditReleased: false,
      })
    );

    await confirmProposal('sess-1');

    expect(useCreditBalanceStore.getState()).toEqual({ free: 11, paid: 6, known: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('puts a released credit back on the source it came from', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        session: pickedRound,
        round: { downgraded: true },
        credits: { id: 'r1', source: 'paid', freeRemaining: 0, paidRemaining: 4 },
        creditReleased: true,
      })
    );

    const result = await runRefineRound('sess-1');

    expect(result.credits).toMatchObject({ paidRemaining: 4 });
    expect(useCreditBalanceStore.getState()).toEqual({ free: 0, paid: 5, known: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('ignores a malformed credits object rather than showing a wrong number', () => {
    applyCreditsFromResponse({ source: 'free', freeRemaining: -1, paidRemaining: 2 });
    expect(useCreditBalanceStore.getState().known).toBe(false);
  });

  it('records an exhausted meter from a 402', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ error: CREDITS_EXHAUSTED_MESSAGE, code: 'GENERATION_CREDITS_EXHAUSTED' }, 402)
    );
    await expect(runRefineRound('sess-1')).rejects.toThrow(CREDITS_EXHAUSTED_MESSAGE);
    expect(useCreditBalanceStore.getState()).toEqual({ free: 0, paid: 0, known: true });
  });

  it('reads the balance endpoint only when signed in', async () => {
    vi.mocked(getOptionalApiAuthHeaders).mockResolvedValueOnce({});
    await refreshCreditBalance();
    expect(fetchMock).not.toHaveBeenCalled();

    fetchMock.mockResolvedValueOnce(jsonResponse({ freeRemaining: 3, paidRemaining: 25 }));
    await refreshCreditBalance();
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v1/billing/credits',
      expect.objectContaining({ method: 'GET' })
    );
    expect(useCreditBalanceStore.getState()).toEqual({ free: 3, paid: 25, known: true });
  });

  it('stays unknown when the read fails', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: 'down' }, 503));
    await refreshCreditBalance();
    expect(useCreditBalanceStore.getState().known).toBe(false);
  });
});

describe('Refine button and buy link', () => {
  it('keeps the plain label while the balance is unknown', () => {
    render(<DesignSessionFlow initialSession={pickedRound} />);
    expect(screen.getByRole('button', { name: REFINE_BUTTON_LABEL })).toBeTruthy();
  });

  it('shows the total beside Refine with the split on hover', () => {
    act(() => applyCreditsFromResponse({ source: 'free', freeRemaining: 12, paidRemaining: 6 }));
    render(<DesignSessionFlow initialSession={pickedRound} />);
    const button = screen.getByRole('button', { name: 'Refine — 1 credit · 18 left' });
    expect(button.getAttribute('title')).toBe('12 free, 6 bought');
  });

  it('replaces Refine with a link to /pricing once nothing is left', () => {
    act(() => markCreditsExhausted());
    render(<DesignSessionFlow initialSession={pickedRound} />);
    expect(screen.queryByRole('button', { name: /refine/i })).toBeNull();
    const link = screen.getByRole('link', { name: 'Get 25 more cuts' });
    expect(link.getAttribute('href')).toBe('/pricing');
  });

  it('a 402 on a round shows the buy link, not a Retry that can only fail again', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ error: CREDITS_EXHAUSTED_MESSAGE, code: 'GENERATION_CREDITS_EXHAUSTED' }, 402)
    );
    render(<DesignSessionFlow initialSession={pickedRound} />);
    fireEvent.click(screen.getByRole('button', { name: REFINE_BUTTON_LABEL }));

    expect(await screen.findByText(CREDITS_EXHAUSTED_MESSAGE)).toBeTruthy();
    expect(screen.getAllByRole('link', { name: 'Get 25 more cuts' }).length).toBeGreaterThan(0);
    expect(screen.queryByRole('button', { name: /retry/i })).toBeNull();
  });
});

describe('DesignConversation', () => {
  it('a 402 on confirm renders "Get 25 more cuts" linking to /pricing', async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({ sessionId: 'sess-1', reply: 'On it.', stage: 'proposal', turn: 1, playback: 'p' })
      )
      .mockResolvedValueOnce(
        jsonResponse({ error: CREDITS_EXHAUSTED_MESSAGE, code: 'GENERATION_CREDITS_EXHAUSTED' }, 402)
      );

    render(<DesignConversation initialPrompt="a dragon on my forearm" />);

    expect(await screen.findByText(CREDITS_EXHAUSTED_MESSAGE)).toBeTruthy();
    const link = screen.getByRole('link', { name: 'Get 25 more cuts' });
    expect(link.getAttribute('href')).toBe('/pricing');
    expect(screen.queryByRole('button', { name: /retry/i })).toBeNull();
  });

  it('a signed-in opener reads the balance once and says what is left', async () => {
    useAuthStore.setState({ user: { uid: 'u1', email: null, displayName: null, photoURL: null } });
    fetchMock.mockImplementation(async (path: string) =>
      path === '/api/v1/billing/credits'
        ? jsonResponse({ freeRemaining: 20, paidRemaining: 0 })
        : jsonResponse({ sessionId: 'sess-1', reply: 'Hey.', stage: 'chatting', turn: 0 })
    );

    render(<DesignConversation />);

    expect(await screen.findByText('20 cuts left.')).toBeTruthy();
    await waitFor(() =>
      expect(fetchMock.mock.calls.filter(([p]) => p === '/api/v1/billing/credits')).toHaveLength(1)
    );
  });

  it('signed out, no balance read and no count', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ sessionId: 'sess-1', reply: 'Hey.', stage: 'chatting', turn: 0 })
    );
    render(<DesignConversation />);
    await screen.findByText('Hey.');
    expect(fetchMock.mock.calls.some(([p]) => p === '/api/v1/billing/credits')).toBe(false);
    expect(screen.queryByTestId('credit-count-line')).toBeNull();
  });
});
