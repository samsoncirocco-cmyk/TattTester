// @vitest-environment jsdom
/**
 * Spec 9 in the browser: the elapsed count on every wait, the first cut
 * shown the moment it lands (never pickable on its own), and the poll that
 * reads it stopping when the POST resolves.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import type { ReactNode } from 'react';
import { createElement } from 'react';
import type { DesignSession, Variation } from '@/services/designSession/types';
import {
  GeneratingBeat,
  REVEAL_BEAT_LINES,
  SLOW_LINE,
  formatElapsed,
} from '../components/GeneratingBeat';
import { PENDING_CUT_LINE, RevealGrid } from '../components/RevealGrid';
import { DesignConversation } from '../components/DesignConversation';
import { DesignSessionFlow } from '../components/DesignSessionFlow';
import { previewPollDelay, PREVIEW_POLL_MS, PREVIEW_POLL_SLOW_MS } from '../services/renderPreview';

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

const cut = (n: number): Variation => ({
  id: `v${n}`,
  axisPosition: { 'bold-fine': n % 2 ? 'bold' : 'fine' },
  prompt: `prompt ${n}`,
  imageUrl: `https://storage.googleapis.com/tatt-pro-assets/design-${n}.png`,
});

const revealed: DesignSession = {
  id: 'sess-1',
  phase: 'revealed',
  intake: { placement: 'forearm', styleTags: [], meaning: 'm', references: [], ambiguousAxes: ['bold-fine'] },
  axisSelection: { mode: 'questionnaire', axes: ['bold-fine'], rationale: 'r' },
  provider: 'replicate',
  variations: [cut(1), cut(2)],
  rounds: [{ round: 1, axis: 'bold-fine', variationIds: ['v1', 'v2'], pickedId: 'v2', pickedAt: 'x' }],
  createdAt: '2026-07-24T00:00:00Z',
  updatedAt: '2026-07-24T00:00:00Z',
};
const intake: DesignSession = { ...revealed, phase: 'intake', variations: [], rounds: [] };

function jsonResponse(body: unknown, status = 200) {
  return { ok: status < 400, status, json: async () => body } as Response;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

const fetchMock = vi.fn();
const getCalls = () =>
  fetchMock.mock.calls.filter(([, init]) => (init?.method ?? 'GET') === 'GET');

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  window.localStorage.clear();
  window.history.replaceState(null, '', '/design');
});

afterEach(() => {
  vi.useRealTimers();
});

describe('the elapsed count', () => {
  it('formats a plain count, never an estimate', () => {
    expect(formatElapsed(14_400)).toBe('14s');
    expect(formatElapsed(125_000)).toBe('2m 05s');
    expect(formatElapsed(-5)).toBe('0s');
  });

  it('counts from startedAt, not from mount, and says so after 90s', () => {
    vi.useFakeTimers();
    const startedAt = Date.now() - 85_000;
    render(<GeneratingBeat lines={REVEAL_BEAT_LINES} startedAt={startedAt} />);

    expect(screen.getByTestId('elapsed').textContent).toBe('1m 25s');
    expect(screen.queryByText(SLOW_LINE)).toBeNull();
    act(() => vi.advanceTimersByTime(6000));
    expect(screen.getByTestId('elapsed').textContent).toBe('1m 31s');
    expect(screen.getByText(SLOW_LINE)).toBeTruthy();
  });

  it('starts at mount without a startedAt', () => {
    vi.useFakeTimers();
    render(<GeneratingBeat lines={REVEAL_BEAT_LINES} />);
    expect(screen.getByTestId('elapsed').textContent).toBe('0s');
    act(() => vi.advanceTimersByTime(14_000));
    expect(screen.getByTestId('elapsed').textContent).toBe('14s');
  });
});

describe('the grid with one cut landed', () => {
  it('shows the cut at full strength beside a waiting tile, openable but not pickable', () => {
    render(<RevealGrid variations={[cut(3)]} mode="preview" pendingSlots={1} indexOffset={2} />);

    const pick = screen.getByRole('button', { name: /pick design 3/i });
    expect((pick as HTMLButtonElement).disabled).toBe(true);
    expect(pick.className).not.toContain('opacity-40');
    expect(screen.getByRole('button', { name: /see design 3 full size/i })).toBeTruthy();
    expect(screen.getByText(PENDING_CUT_LINE)).toBeTruthy();
  });
});

describe('the poll cadence', () => {
  it('reads every 2s for the first minute, then every 3s', () => {
    expect(previewPollDelay(0)).toBe(PREVIEW_POLL_MS);
    expect(previewPollDelay(59_999)).toBe(PREVIEW_POLL_MS);
    expect(previewPollDelay(60_000)).toBe(PREVIEW_POLL_SLOW_MS);
  });
});

describe('the reveal shows its first cut as it lands', () => {
  it('previews v1 mid-confirm, then hands over and stops polling when the POST resolves', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const confirm = deferred<Response>();
    const rendering = {
      kind: 'reveal',
      since: new Date().toISOString(),
      stale: false,
      preview: [cut(1)],
    };
    fetchMock.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path.endsWith('/converse')) {
        return jsonResponse({
          sessionId: 'sess-1',
          reply: 'a fox, bold lines. want to see it?',
          stage: 'proposal',
          playback: 'a fox, bold lines',
          turn: 2,
        });
      }
      if (path.endsWith('/confirm')) return confirm.promise;
      if ((init?.method ?? 'GET') === 'GET') {
        return jsonResponse({ session: intake, resume: { transcript: [], rendering } });
      }
      throw new Error(`unexpected ${path}`);
    });

    render(<DesignConversation />);
    fireEvent.click(await screen.findByRole('button', { name: /show me/i }));

    expect(await screen.findByTestId('elapsed')).toBeTruthy();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2100);
    });
    await waitFor(() => expect(screen.getAllByAltText(/^Design \d$/)).toHaveLength(1));
    expect(screen.getByText(PENDING_CUT_LINE)).toBeTruthy();
    expect(
      (screen.getByRole('button', { name: /pick design 1/i }) as HTMLButtonElement).disabled
    ).toBe(true);

    await act(async () => {
      confirm.resolve(jsonResponse({ session: revealed }));
    });
    await waitFor(() => expect(screen.getAllByAltText(/^Design \d$/)).toHaveLength(2));
    expect(screen.queryByText(PENDING_CUT_LINE)).toBeNull();

    const polled = getCalls().length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(6000);
    });
    expect(getCalls().length).toBe(polled);
  });
});

describe('a refine round shows its first cut as it lands', () => {
  it('previews v3 while the round renders and keeps the pick closed', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const round = deferred<Response>();
    const rendering = { kind: 'round', since: new Date().toISOString(), stale: false, preview: [cut(3)] };
    fetchMock.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path.endsWith('/round')) return round.promise;
      if ((init?.method ?? 'GET') === 'GET') {
        return jsonResponse({ session: revealed, resume: { transcript: [], rendering } });
      }
      throw new Error(`unexpected ${path}`);
    });

    render(<DesignSessionFlow initialSession={revealed} />);
    fireEvent.click(screen.getByRole('button', { name: /refine/i }));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2100);
    });
    await waitFor(() => expect(screen.getByAltText('Design 3')).toBeTruthy());
    expect(screen.getByText(PENDING_CUT_LINE)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /lock it in/i })).toBeNull();

    const next: DesignSession = {
      ...revealed,
      variations: [cut(1), cut(2), cut(3), cut(4)],
      rounds: [
        { ...revealed.rounds![0], frozen: true },
        { round: 2, axis: 'color-blackwork', variationIds: ['v3', 'v4'] },
      ],
    };
    await act(async () => {
      round.resolve(jsonResponse({ session: next, round: {} }));
    });
    await waitFor(() => expect(screen.getByAltText('Design 4')).toBeTruthy());
    expect(screen.queryByText(PENDING_CUT_LINE)).toBeNull();
  });

  it('a resumed round shows the cut its claim already carries', () => {
    render(
      <DesignSessionFlow
        initialSession={revealed}
        resumeRendering={{ kind: 'round', since: new Date().toISOString(), stale: false, preview: [cut(3)] }}
      />
    );
    expect(screen.getByAltText('Design 3')).toBeTruthy();
    expect(screen.getByText(PENDING_CUT_LINE)).toBeTruthy();
  });
});
