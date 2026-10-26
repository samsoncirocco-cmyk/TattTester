// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import type { ReactNode } from 'react';
import { createElement } from 'react';
import type { DesignSession } from '@/services/designSession/types';
import { DesignConversation } from '../components/DesignConversation';
import { DesignSessionFlow } from '../components/DesignSessionFlow';
import {
  LOST_RENDER_LINE,
  NOT_FOUND_LINE,
  RESUME_LINE,
  STILL_DRAWING_LINE,
  rememberResumeKey,
} from '../services/sessionResume';

vi.mock('@/lib/client-api-auth', () => ({
  getApiAuthHeaders: vi.fn(async () => ({ Authorization: 'Bearer test-token' })),
  getOptionalApiAuthHeaders: vi.fn(async () => ({})),
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

const OPENER = 'Where does it go?';

const variations = [1, 2].map((n) => ({
  id: `v${n}`,
  axisPosition: { 'bold-fine': n % 2 ? 'bold' : 'fine' },
  prompt: `prompt ${n}`,
  imageUrl: `https://img.test/design-${n}.png`,
}));

const revealed: DesignSession = {
  id: 'sess-1',
  phase: 'revealed',
  intake: { placement: 'forearm', styleTags: [], meaning: 'm', references: [], ambiguousAxes: ['bold-fine'] },
  axisSelection: { mode: 'questionnaire', axes: ['bold-fine'], rationale: 'r' },
  provider: 'replicate',
  variations,
  rounds: [{ round: 1, axis: 'bold-fine', variationIds: ['v1', 'v2'], pickedId: 'v2', pickedAt: 'x' }],
  createdAt: '2026-07-24T00:00:00Z',
  updatedAt: '2026-07-24T00:00:00Z',
};
const intake: DesignSession = { ...revealed, phase: 'intake', variations: [], rounds: [] };
const transcript = [
  { role: 'bot' as const, text: OPENER },
  { role: 'user' as const, text: 'a fox on my forearm' },
];

function jsonResponse(body: unknown, status = 200) {
  return { ok: status < 400, status, json: async () => body } as Response;
}

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  window.localStorage.clear();
  window.history.replaceState(null, '', '/design');
});

afterEach(() => {
  vi.useRealTimers();
});

describe('session id in the URL', () => {
  it('writes ?ds= from the first converse response and keeps its resume key', async () => {
    window.history.replaceState(null, '', '/design?prompt=a%20fox');
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ sessionId: 'sess-9', reply: OPENER, stage: 'chatting', turn: 0, resumeKey: 'k-9' })
    );

    render(<DesignConversation />);

    await screen.findByText(OPENER);
    expect(window.location.search).toBe('?ds=sess-9');
    expect(window.localStorage.getItem('tattester:design-session-key:sess-9')).toBe('k-9');
  });
});

describe('resume on load', () => {
  it('opens a revealed session on its cuts with the earlier chat above', async () => {
    rememberResumeKey('sess-1', 'k-1');
    fetchMock.mockResolvedValueOnce(jsonResponse({ session: revealed, resume: { transcript, stage: 'proposal' } }));

    render(<DesignConversation initialSessionId="sess-1" />);

    expect(await screen.findByText(RESUME_LINE)).toBeTruthy();
    expect(screen.getByText('a fox on my forearm')).toBeTruthy();
    expect(screen.getAllByAltText(/^Design \d$/)).toHaveLength(2);
    // The GET carried this browser's key; no converse call was made.
    const [path, init] = fetchMock.mock.calls[0];
    expect(path).toBe('/api/v1/design-session/sess-1');
    expect(init.headers['x-design-session-key']).toBe('k-1');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('starts fresh with one quiet line when the session is missing', async () => {
    window.history.replaceState(null, '', '/design?ds=gone');
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ code: 'SESSION_NOT_FOUND' }, 404))
      .mockResolvedValueOnce(jsonResponse({ sessionId: 'sess-2', reply: OPENER, stage: 'chatting', turn: 0 }));

    render(<DesignConversation initialSessionId="gone" />);

    expect(await screen.findByText(NOT_FOUND_LINE)).toBeTruthy();
    expect(await screen.findByText(OPENER)).toBeTruthy();
    expect(fetchMock.mock.calls[1][0]).toBe('/api/v1/design-session/converse');
  });

  it("never shows a session it may not resume, even when the projection came back", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ session: revealed }))
      .mockResolvedValueOnce(jsonResponse({ sessionId: 'sess-3', reply: OPENER, stage: 'chatting', turn: 0 }));

    render(<DesignConversation initialSessionId="sess-1" />);

    expect(await screen.findByText(NOT_FOUND_LINE)).toBeTruthy();
    expect(screen.queryAllByAltText(/^Design \d$/)).toHaveLength(0);
  });

  it('waits on a live reveal claim, then shows the cuts when they land', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const rendering = { kind: 'reveal', since: new Date().toISOString(), stale: false };
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ session: intake, resume: { transcript, stage: 'proposal', rendering } }))
      .mockResolvedValueOnce(jsonResponse({ session: revealed, resume: { transcript } }));

    render(<DesignConversation initialSessionId="sess-1" />);

    expect(await screen.findByText(STILL_DRAWING_LINE)).toBeTruthy();
    // No second consent button while the paid render is still running.
    expect(screen.queryByRole('button', { name: /show me/i })).toBeNull();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3100);
    });
    await waitFor(() => expect(screen.getAllByAltText(/^Design \d$/)).toHaveLength(2));
    expect(screen.queryByText(STILL_DRAWING_LINE)).toBeNull();
  });

  it('a stale claim is a lost render: say so and offer the re-run as the confirm', async () => {
    const rendering = { kind: 'reveal', since: '2026-07-24T00:00:00Z', stale: true };
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ session: intake, resume: { transcript, stage: 'proposal', rendering } }))
      .mockResolvedValueOnce(jsonResponse({ session: revealed }));

    render(<DesignConversation initialSessionId="sess-1" />);

    expect(await screen.findByText(LOST_RENDER_LINE)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /retry/i }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(fetchMock.mock.calls[1][0]).toBe('/api/v1/design-session/sess-1/confirm');
  });
});

describe('DesignSessionFlow opens a handed-in session on its own step', () => {
  it('picked → the refinement question', () => {
    const picked = { ...revealed, phase: 'picked' as const, pickId: 'v2', mostNotYouId: 'v1', refinementQuestion: 'Bolder or finer?' };
    render(<DesignSessionFlow initialSession={picked} />);
    expect(screen.getAllByText('Bolder or finer?').length).toBeGreaterThan(0);
  });

  it('complete → the finished design, not the reveal', () => {
    const complete = {
      ...revealed,
      phase: 'complete' as const,
      pickId: 'v2',
      brief: {
        placement: 'forearm',
        styleTags: [],
        meaning: 'm',
        references: [],
        axisSelection: revealed.axisSelection,
        placementNotes: [],
        rejectedAxisPosition: {},
      },
    };
    render(<DesignSessionFlow initialSession={complete} />);
    expect(screen.getByText('Done. One pass, one answer, one design.')).toBeTruthy();
  });

  it('a stale round claim offers the round again', () => {
    render(
      <DesignSessionFlow
        initialSession={revealed}
        resumeRendering={{ kind: 'round', since: '2026-07-24T00:00:00Z', stale: true }}
      />
    );
    expect(screen.getByText(LOST_RENDER_LINE)).toBeTruthy();
    expect(screen.getByRole('button', { name: /refine/i })).toBeTruthy();
  });
});
