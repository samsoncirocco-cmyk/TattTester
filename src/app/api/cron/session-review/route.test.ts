// Guard + sweep tests for the session-review cron.
//
// Two properties matter here. First, the same one every cron in this repo has:
// nobody without CRON_SECRET can make the server do work, and an unset secret
// fails closed rather than open. Second — and this is why the route exists —
// the sweep must actually FIND the two failures it claims to find, and must
// stay quiet on a session where neither happened. A review job that reports
// zero findings because it looked at nothing is worse than no review job,
// because it reads as reassurance.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { DesignState } from '@/services/designSession/internal/designState';
import type { StoredSession } from '@/services/designSession/internal/store';

const { listRecentlyUpdatedMock } = vi.hoisted(() => ({
  listRecentlyUpdatedMock: vi.fn(),
}));

vi.mock('@/services/designSession/internal/store', () => ({
  resolveSessionStore: () => ({
    listRecentlyUpdated: listRecentlyUpdatedMock,
  }),
}));

import { reviewSession } from '@/services/designSession/internal/sessionReview';

import { GET, POST } from './route';

const SECRET = 'cron-secret-value';

function makeRequest(authorization?: string, query = '') {
  return new Request(`http://localhost/api/cron/session-review${query}`, {
    method: 'POST',
    headers: authorization ? { authorization } : {},
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as any;
}

function state(overrides: Partial<DesignState> = {}): DesignState {
  return {
    roster: ['Sora'],
    // Deliberately empty. `identities` is a checked field in its own right
    // (name AND source), so leaving it populated would make every fixture
    // below quietly also a test of the identity check.
    identities: [],
    medium: 'tattoo sleeve on the forearm',
    palette: 'full color',
    exclusions: [],
    directives: [],
    ...overrides,
  };
}

/** A session shell with only the fields the reviewer reads. */
function session(overrides: Partial<StoredSession> = {}): StoredSession {
  return {
    id: 'sess-1',
    phase: 'revealed',
    // The reviewer never reads intake or the axis selection; keeping the
    // fixture to what is actually under test is deliberate.
    intake: {},
    axisSelection: {},
    provider: 'vertex',
    variations: [],
    pinnedModelId: 'model-x',
    createdAt: '2026-08-25T00:00:00.000Z',
    updatedAt: '2026-08-25T01:00:00.000Z',
    ...overrides,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any as StoredSession;
}

function cut(id: string, prompt: string, imageUrl?: string) {
  return { id, axisPosition: {}, prompt, ...(imageUrl ? { imageUrl } : {}) };
}

const originalSecret = process.env.CRON_SECRET;

beforeEach(() => {
  vi.clearAllMocks();
  process.env.CRON_SECRET = SECRET;
  listRecentlyUpdatedMock.mockResolvedValue([]);
});

afterEach(() => {
  if (originalSecret === undefined) delete process.env.CRON_SECRET;
  else process.env.CRON_SECRET = originalSecret;
});

describe('cron/session-review — authorization', () => {
  it('401s with no Authorization header', async () => {
    const res = await POST(makeRequest());
    expect(res.status).toBe(401);
    expect(listRecentlyUpdatedMock).not.toHaveBeenCalled();
  });

  it('401s on a wrong secret', async () => {
    expect((await POST(makeRequest('Bearer not-the-secret'))).status).toBe(401);
    expect(listRecentlyUpdatedMock).not.toHaveBeenCalled();
  });

  it('401s on a right-length-but-wrong secret (constant-time compare still rejects)', async () => {
    const wrong = 'x'.repeat(SECRET.length);
    expect((await POST(makeRequest(`Bearer ${wrong}`))).status).toBe(401);
  });

  it('401s on the raw secret without the Bearer scheme', async () => {
    expect((await POST(makeRequest(SECRET))).status).toBe(401);
  });

  it('FAILS CLOSED: 401s when CRON_SECRET is unset, even with a Bearer header', async () => {
    delete process.env.CRON_SECRET;
    const res = await POST(makeRequest('Bearer anything'));
    expect(res.status).toBe(401);
    expect(listRecentlyUpdatedMock).not.toHaveBeenCalled();
  });

  it('accepts GET too — Vercel cron issues GET', async () => {
    const req = new Request('http://localhost/api/cron/session-review', {
      method: 'GET',
      headers: { authorization: `Bearer ${SECRET}` },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) as any;
    expect((await GET(req)).status).toBe(200);
    expect(listRecentlyUpdatedMock).toHaveBeenCalledTimes(1);
  });

  it('rejects an unauthorized GET as well', async () => {
    const req = new Request('http://localhost/api/cron/session-review', {
      method: 'GET',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) as any;
    expect((await GET(req)).status).toBe(401);
  });
});

describe('cron/session-review — the sweep window', () => {
  it('queries a bounded, recent window rather than the whole collection', async () => {
    const before = Date.now();
    await POST(makeRequest(`Bearer ${SECRET}`));

    const [sinceIso, limit] = listRecentlyUpdatedMock.mock.calls[0];
    const since = Date.parse(sinceIso);
    expect(Number.isNaN(since)).toBe(false);
    expect(since).toBeLessThan(before);
    // A lookback that collapsed to "now" would review nothing every night.
    expect(before - since).toBeGreaterThan(23 * 60 * 60 * 1000);
    expect(limit).toBeGreaterThan(0);
  });

  it('honours an operator-supplied window and caps the page size', async () => {
    await POST(makeRequest(`Bearer ${SECRET}`, '?hours=168&limit=99999'));
    const [sinceIso, limit] = listRecentlyUpdatedMock.mock.calls[0];
    expect(Date.now() - Date.parse(sinceIso)).toBeGreaterThan(167 * 60 * 60 * 1000);
    expect(limit).toBeLessThanOrEqual(1000);
  });

  it('ignores a nonsense window instead of widening it', async () => {
    await POST(makeRequest(`Bearer ${SECRET}`, '?hours=-5&limit=abc'));
    const [sinceIso, limit] = listRecentlyUpdatedMock.mock.calls[0];
    expect(Date.now() - Date.parse(sinceIso)).toBeGreaterThan(0);
    expect(limit).toBe(200);
  });
});

describe('cron/session-review — findings', () => {
  it('reports nothing for a clean session, but still says how much it checked', async () => {
    const prompt =
      'Sora mid-stride, a full color tattoo sleeve on the forearm, bold linework.';
    listRecentlyUpdatedMock.mockResolvedValue([
      session({
        state: state(),
        variations: [cut('v1', prompt, 'https://cdn/v1.png'), cut('v2', prompt, 'https://cdn/v2.png')],
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        conversation: { transcript: [], turnCount: 4, record: {}, turnLogs: [], stage: 'proposal' } as any,
      }),
    ]);

    const res = await POST(makeRequest(`Bearer ${SECRET}`));
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.reviewed).toBe(1);
    expect(body.flagged).toBe(0);
    expect(body.sessions).toEqual([]);
    expect(body.counts).toEqual({
      promptContract: 0,
      promptContractAdvisory: 0,
      zeroRenderStall: 0,
      contractNotCheckable: 0,
    });
  });

  it('flags a re-cut whose prompt dropped something the state asserts', async () => {
    listRecentlyUpdatedMock.mockResolvedValue([
      session({
        id: 'sess-drift',
        state: state(),
        variations: [
          cut('v1', 'Sora in full color on the forearm sleeve tattoo.', 'https://cdn/v1.png'),
          cut('v2', 'Sora in full color on the forearm sleeve tattoo.', 'https://cdn/v2.png'),
        ],
        // The critique lane renders FROM the state, so a drop here is a real
        // contract break, not an advisory note about a Council-authored prompt.
        critiqueCuts: [
          cut('c1', 'Sora on the forearm, a sleeve tattoo, heavy blackwork.', 'https://cdn/c1.png'),
        ],
      }),
    ]);

    const body = await (await POST(makeRequest(`Bearer ${SECRET}`))).json();

    expect(body.flagged).toBe(1);
    expect(body.counts.promptContract).toBe(1);
    expect(body.counts.promptContractAdvisory).toBe(0);

    const [report] = body.sessions;
    expect(report.sessionId).toBe('sess-drift');
    const [finding] = report.findings;
    expect(finding.kind).toBe('prompt-contract');
    expect(finding.cutId).toBe('c1');
    expect(finding.lane).toBe('critique');
    expect(finding.field).toBe('palette');
    expect(finding.missing).toEqual(['full', 'color']);
    expect(finding.advisory).toBe(false);
    expect(finding.explanation).toContain('full color');
  });

  it('marks reveal-lane contract findings advisory — those prompts come from the Council', async () => {
    listRecentlyUpdatedMock.mockResolvedValue([
      session({
        state: state({ roster: ['Sora', 'Riku'] }),
        variations: [
          cut('v1', 'Sora alone, a full color tattoo sleeve on the forearm.', 'https://cdn/v1.png'),
        ],
      }),
    ]);

    const body = await (await POST(makeRequest(`Bearer ${SECRET}`))).json();
    const [finding] = body.sessions[0].findings;
    expect(finding.field).toBe('roster');
    expect(finding.missing).toEqual(['Riku']);
    expect(finding.lane).toBe('reveal');
    expect(finding.advisory).toBe(true);
    expect(body.counts.promptContractAdvisory).toBe(1);
    expect(body.counts.promptContract).toBe(0);
  });

  it('flags a session that took turns and never rendered (#376)', async () => {
    listRecentlyUpdatedMock.mockResolvedValue([
      session({
        id: 'sess-stalled',
        phase: 'intake',
        variations: [],
        conversation: {
          transcript: [
            { role: 'bot', text: 'what are we making?' },
            { role: 'user', text: 'an astronaut with a cracked visor' },
            { role: 'bot', text: 'where does it sit?' },
            { role: 'user', text: 'forearm' },
          ],
          turnCount: 2,
          record: {},
          turnLogs: [],
          stage: 'chatting',
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any,
      }),
    ]);

    const body = await (await POST(makeRequest(`Bearer ${SECRET}`))).json();

    expect(body.counts.zeroRenderStall).toBe(1);
    const [report] = body.sessions;
    expect(report.sessionId).toBe('sess-stalled');
    expect(report.cutsRendered).toBe(0);
    const finding = report.findings.find(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (f: any) => f.kind === 'zero-render-stall'
    );
    expect(finding.turnCount).toBe(2);
    expect(finding.phase).toBe('intake');
    expect(finding.stage).toBe('chatting');
    expect(finding.explanation).toContain('never rendered');
    expect(finding.quietForHours).toBeGreaterThanOrEqual(2);
    // The check cannot separate a stall from an abandonment, and the copy must
    // not pretend otherwise — an operator triaging this needs to know that up
    // front, not after chasing a tester who closed a tab.
    expect(finding.explanation).toContain('cannot tell those apart');
  });

  it('does not call a stall on a session that rendered, however few cuts', async () => {
    listRecentlyUpdatedMock.mockResolvedValue([
      session({
        state: state(),
        variations: [cut('v1', 'Sora, a full color tattoo sleeve on the forearm.', 'https://cdn/v1.png')],
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        conversation: { transcript: [], turnCount: 6, record: {}, turnLogs: [], stage: 'proposal' } as any,
      }),
    ]);

    const body = await (await POST(makeRequest(`Bearer ${SECRET}`))).json();
    expect(body.counts.zeroRenderStall).toBe(0);
    expect(body.flagged).toBe(0);
  });

  it('reports a stateless session as UNCHECKED, not as clean', async () => {
    listRecentlyUpdatedMock.mockResolvedValue([
      session({
        id: 'sess-legacy',
        variations: [cut('v1', 'anything at all', 'https://cdn/v1.png')],
      }),
    ]);

    const body = await (await POST(makeRequest(`Bearer ${SECRET}`))).json();
    expect(body.counts.contractNotCheckable).toBe(1);
    const [finding] = body.sessions[0].findings;
    expect(finding.kind).toBe('contract-not-checkable');
    expect(finding.cutsRecorded).toBe(1);
  });

  it('keeps sweeping when one document is malformed', async () => {
    // The previous fixture for this test had `variations` missing, which
    // short-circuits before `rounds` is ever read — so it never threw, and the
    // test passed identically with the try/catch deleted. This one really does
    // throw inside reviewSession: `rounds` is a number, so iterating it is a
    // TypeError, and `variations` is present so the iteration is reached.
    const boom = {
      id: 'sess-bad',
      phase: 'revealed',
      rounds: 42,
      variations: [cut('v1', 'anything', 'https://cdn/v1.png')],
      createdAt: '2026-08-25T00:00:00.000Z',
      updatedAt: '2026-08-25T00:00:00.000Z',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;
    // Pre-condition, so this test can never silently go back to not throwing.
    expect(() => reviewSession(boom)).toThrow();

    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    listRecentlyUpdatedMock.mockResolvedValue([
      boom,
      session({
        id: 'sess-good',
        state: state(),
        variations: [cut('v1', 'Sora, a full color tattoo sleeve on the forearm.', 'https://cdn/v1.png')],
      }),
    ]);

    const res = await POST(makeRequest(`Bearer ${SECRET}`));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.scanned).toBe(2);
    // Exactly one: the bad document was dropped, the good one survived. A
    // `>= 1` here would pass whether or not the catch existed.
    expect(body.reviewed).toBe(1);
    expect(body.sessions.map((report: { sessionId: string }) => report.sessionId)).toEqual([]);
    expect(consoleError).toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it('does not call a stall on a session that is still in progress', async () => {
    // The sweep window is 25h wide and includes sessions written seconds ago.
    // Without a quiescence gate, a customer mid-intake at 10:00 — still
    // typing, the render still ahead of them — is reported as a silent
    // failure, and the operator learns to ignore the check.
    listRecentlyUpdatedMock.mockResolvedValue([
      session({
        id: 'sess-live',
        phase: 'intake',
        variations: [],
        updatedAt: new Date(Date.now() - 60 * 1000).toISOString(),
        conversation: {
          transcript: [{ role: 'user', text: 'an astronaut with a cracked visor' }],
          turnCount: 1,
          record: {},
          turnLogs: [],
          stage: 'chatting',
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any,
      }),
    ]);

    const body = await (await POST(makeRequest(`Bearer ${SECRET}`))).json();
    expect(body.reviewed).toBe(1);
    expect(body.counts.zeroRenderStall).toBe(0);
    expect(body.flagged).toBe(0);
  });

  it('holds only the last critique cut against the state, not the whole history', async () => {
    // `session.state` is the LATEST state — the orchestrator overwrites it on
    // every critique turn. Earlier cuts rendered from an earlier state, so
    // judging them against this one manufactures findings on correct work and
    // buries the real one. Here the state says blackwork at 9:11; the reveal
    // cuts and the first re-cut are simply older, and only the last re-cut is
    // evidence of anything.
    listRecentlyUpdatedMock.mockResolvedValue([
      session({
        id: 'sess-drifted',
        state: state({ palette: 'blackwork, no color', aspect: '9:11' }),
        variations: [
          cut('v1', 'Sora, a full color tattoo sleeve on the forearm.', 'https://cdn/v1.png'),
        ],
        critiqueCuts: [
          cut('c1', 'Sora, a full color tattoo sleeve on the forearm.', 'https://cdn/c1.png'),
          cut('c2', 'Sora, a tattoo sleeve on the forearm. Framed at 9:11.', 'https://cdn/c2.png'),
        ],
      }),
    ]);

    const body = await (await POST(makeRequest(`Bearer ${SECRET}`))).json();
    const [report] = body.sessions;
    const hard = report.findings.filter(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (finding: any) => finding.kind === 'prompt-contract' && !finding.advisory
    );
    // c2 is the only cut this state rendered, and it dropped the palette.
    expect(hard.map((finding: { cutId: string }) => finding.cutId)).toEqual(['c2']);
    expect(hard[0].field).toBe('palette');
    expect(body.counts.promptContract).toBe(1);
    // v1 and c1 still show up, honestly labelled as what they are.
    expect(body.counts.promptContractAdvisory).toBeGreaterThan(0);
  });
});
