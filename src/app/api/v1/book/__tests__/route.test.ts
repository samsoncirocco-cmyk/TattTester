// Seam tests for POST /api/v1/book — the Brief attach path (design session →
// booking record). designSession service, Neo4j artist check, auth, and
// Firestore are all mocked at the module boundary; the assertions pin the
// exact document shape written to booking_requests.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import type { Brief, DesignSession } from '@/services/designSession/types';

const {
  getSessionMock,
  verifyApiAuthMock,
  verifyFirebaseTokenMock,
  ensureAdminAppMock,
  firestoreSetMock,
  getRosterArtistByIdMock,
} = vi.hoisted(() => ({
  getSessionMock: vi.fn(),
  verifyApiAuthMock: vi.fn(),
  verifyFirebaseTokenMock: vi.fn(),
  ensureAdminAppMock: vi.fn(),
  firestoreSetMock: vi.fn(),
  getRosterArtistByIdMock: vi.fn(),
}));

vi.mock('@/services/designSession', () => ({
  getSession: getSessionMock,
}));

vi.mock('@/lib/api-auth', () => ({
  verifyApiAuth: verifyApiAuthMock,
}));

vi.mock('@/lib/auth-dal', () => ({
  verifyFirebaseToken: verifyFirebaseTokenMock,
}));

vi.mock('@/lib/firebase-admin', () => ({
  ensureAdminApp: ensureAdminAppMock,
}));

vi.mock('firebase-admin/firestore', () => ({
  getFirestore: () => ({
    collection: () => ({
      doc: () => ({ set: firestoreSetMock }),
    }),
  }),
}));

vi.mock('@/lib/artists-graph', () => ({ getRosterArtistById: getRosterArtistByIdMock }));

import { POST } from '../route';

// Each test uses a distinct IP so the route's in-module rate limiter
// (5/hour per IP) never trips across tests.
let ipCounter = 0;

function makeRequest(body: Record<string, unknown>) {
  ipCounter += 1;
  return new NextRequest('http://localhost/api/v1/book', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-forwarded-for': `10.0.0.${ipCounter}`,
    },
    body: JSON.stringify(body),
  });
}

const VALID_BODY = {
  clientName: 'Sam C',
  clientEmail: 'sam@example.com',
  description: 'Fine line fern on the forearm',
  budget: '300-600',
};

function makeBrief(overrides: Partial<Brief> = {}): Brief {
  return {
    placement: 'forearm',
    styleTags: ['blackwork'],
    meaning: 'for my grandmother',
    references: ['https://img/ref-1.png'],
    finalImageUrl: 'https://img/refined.png',
    axisSelection: {
      mode: 'questionnaire',
      axes: ['bold-fine', 'color-blackwork'],
      rationale: 'intake left line weight and color unresolved',
    },
    placementNotes: ['inner forearm fine-line ages faster near the wrist'],
    rejectedAxisPosition: { 'bold-fine': 'fine', 'color-blackwork': 'color' },
    ...overrides,
  };
}

function makeCompleteSession(overrides: Partial<DesignSession> = {}): DesignSession {
  return {
    id: 'sess-1',
    phase: 'complete',
    intake: {
      placement: 'forearm',
      styleTags: ['blackwork'],
      meaning: 'for my grandmother',
      references: [],
      ambiguousAxes: ['bold-fine', 'color-blackwork'],
    },
    axisSelection: {
      mode: 'questionnaire',
      axes: ['bold-fine', 'color-blackwork'],
      rationale: 'intake left line weight and color unresolved',
    },
    provider: 'vertex-ai',
    variations: [],
    brief: makeBrief(),
    createdAt: '2026-07-24T00:00:00.000Z',
    updatedAt: '2026-07-24T00:00:00.000Z',
    ...overrides,
  } as DesignSession;
}

function savedDoc(): Record<string, unknown> {
  expect(firestoreSetMock).toHaveBeenCalledTimes(1);
  return firestoreSetMock.mock.calls[0][0] as Record<string, unknown>;
}

/** Recursively assert no undefined values anywhere — Firestore rejects them. */
function assertNoUndefined(value: unknown, path = 'doc'): void {
  if (Array.isArray(value)) {
    value.forEach((v, i) => assertNoUndefined(v, `${path}[${i}]`));
    return;
  }
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      expect(v, `${path}.${k} must not be undefined`).not.toBeUndefined();
      assertNoUndefined(v, `${path}.${k}`);
    }
  }
}

describe('POST /api/v1/book — design-session Brief attach', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    verifyApiAuthMock.mockResolvedValue(null);
    verifyFirebaseTokenMock.mockResolvedValue({ uid: 'user-1' });
    ensureAdminAppMock.mockReturnValue('env');
    firestoreSetMock.mockResolvedValue(undefined);
    getRosterArtistByIdMock.mockResolvedValue({ id: 'artist_10021', bookingTier: 'bookable' });
  });

  it('embeds the brief and designSessionId when the session is complete', async () => {
    getSessionMock.mockResolvedValueOnce(makeCompleteSession());

    const res = await POST(
      makeRequest({ ...VALID_BODY, artistId: 'artist_10021', designSessionId: 'sess-1' })
    );

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(getSessionMock).toHaveBeenCalledWith('sess-1');

    const doc = savedDoc();
    expect(doc.designSessionId).toBe('sess-1');
    expect(doc.brief).toEqual({
      placement: 'forearm',
      styleTags: ['blackwork'],
      meaning: 'for my grandmother',
      references: ['https://img/ref-1.png'],
      finalImageUrl: 'https://img/refined.png',
      axisSelection: {
        mode: 'questionnaire',
        axes: ['bold-fine', 'color-blackwork'],
        rationale: 'intake left line weight and color unresolved',
      },
      placementNotes: ['inner forearm fine-line ages faster near the wrist'],
      rejectedAxisPosition: { 'bold-fine': 'fine', 'color-blackwork': 'color' },
    });
    assertNoUndefined(doc);
  });

  it('strips undefined optional brief fields before the Firestore write', async () => {
    getSessionMock.mockResolvedValueOnce(
      makeCompleteSession({
        brief: makeBrief({ finalImageUrl: undefined, rejectedAxisPosition: undefined }),
      })
    );

    const res = await POST(makeRequest({ ...VALID_BODY, designSessionId: 'sess-1' }));

    expect(res.status).toBe(200);
    const doc = savedDoc();
    const brief = doc.brief as Record<string, unknown>;
    expect('finalImageUrl' in brief).toBe(false);
    expect('rejectedAxisPosition' in brief).toBe(false);
    expect(brief.placement).toBe('forearm');
    assertNoUndefined(doc);
  });

  it('fails open when the session fetch errors — booking captured without brief', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    getSessionMock.mockRejectedValueOnce(
      Object.assign(new Error('gone'), { code: 'SESSION_NOT_FOUND' })
    );

    const res = await POST(makeRequest({ ...VALID_BODY, designSessionId: 'sess-missing' }));

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.bookingId).toMatch(/^BK-/);

    const doc = savedDoc();
    expect('brief' in doc).toBe(false);
    expect(doc.designSessionId).toBe('sess-missing');
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('fails open when the session is not complete — no brief embedded', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    getSessionMock.mockResolvedValueOnce(
      makeCompleteSession({ phase: 'revealed', brief: undefined })
    );

    const res = await POST(makeRequest({ ...VALID_BODY, designSessionId: 'sess-1' }));

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.success).toBe(true);

    const doc = savedDoc();
    expect('brief' in doc).toBe(false);
    assertNoUndefined(doc);
    warnSpy.mockRestore();
  });

  it('leaves no-session bookings unchanged and never calls the service', async () => {
    const res = await POST(makeRequest(VALID_BODY));

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(getSessionMock).not.toHaveBeenCalled();

    const doc = savedDoc();
    expect('brief' in doc).toBe(false);
    expect('designSessionId' in doc).toBe(false);
    expect(doc.clientName).toBe('Sam C');
    expect(doc.status).toBe('pending');
    assertNoUndefined(doc);
  });
});

// An artist who asked to be removed must not be bookable. The existing
// existence check deliberately fails OPEN on a Neo4j error so an outage never
// drops a real booking — but the artist lookup itself now excludes removed
// artists, so a takedown reads as "unknown artist" and the booking is refused.
// See docs/adr/0025.
describe('POST /api/v1/book — taken-down artists are not bookable', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    verifyApiAuthMock.mockResolvedValue(null);
    verifyFirebaseTokenMock.mockResolvedValue({ uid: 'user-1' });
    ensureAdminAppMock.mockReturnValue('env');
    firestoreSetMock.mockResolvedValue(undefined);
  });

  it('refuses the booking and writes nothing when the artist lookup returns no rows', async () => {
    // A removed artist is absent from the public roster accessor.
    getRosterArtistByIdMock.mockResolvedValue(null);

    const res = await POST(makeRequest({ ...VALID_BODY, artistId: 'artist_removed' }));

    expect(res.status).toBe(400);
    expect(firestoreSetMock).not.toHaveBeenCalled();
  });

  it('returns 503, not unknown-artist, when the graph lookup is unavailable', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    getRosterArtistByIdMock.mockRejectedValueOnce(new Error('neo4j unavailable'));

    const res = await POST(makeRequest({ ...VALID_BODY, artistId: 'artist_10021' }));

    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ success: false });
    expect(firestoreSetMock).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('uses the public roster accessor for the canonical artist id', async () => {
    getRosterArtistByIdMock.mockResolvedValue({ id: 'artist_10021', bookingTier: 'bookable' });

    await POST(makeRequest({ ...VALID_BODY, artistId: 'artist_10021' }));

    expect(getRosterArtistByIdMock).toHaveBeenCalledWith('artist_10021');
  });

  it('refuses a browse-only artist before writing a booking', async () => {
    getRosterArtistByIdMock.mockResolvedValue({ id: 'artist_intro_only', bookingTier: 'browse-only' });

    const res = await POST(makeRequest({ ...VALID_BODY, artistId: 'artist_intro_only' }));

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({
      code: 'ARTIST_INTRO_REQUIRED',
      introUrl: '/intro?artistId=artist_intro_only',
    });
    expect(firestoreSetMock).not.toHaveBeenCalled();
  });

  it('preserves designSessionId on the browse-only introUrl', async () => {
    getRosterArtistByIdMock.mockResolvedValue({ id: 'artist_intro_only', bookingTier: 'browse-only' });

    const res = await POST(
      makeRequest({
        ...VALID_BODY,
        artistId: 'artist_intro_only',
        designSessionId: 'sess-1',
      }),
    );

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({
      code: 'ARTIST_INTRO_REQUIRED',
      introUrl: '/intro?artistId=artist_intro_only&ds=sess-1',
    });
    expect(firestoreSetMock).not.toHaveBeenCalled();
  });

  it('returns 503 when the roster lookup throws (graph outage)', async () => {
    getRosterArtistByIdMock.mockRejectedValueOnce(new Error('Neo4j driver not configured server-side'));

    const res = await POST(makeRequest({ ...VALID_BODY, artistId: 'artist_10021' }));

    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ success: false });
    expect(firestoreSetMock).not.toHaveBeenCalled();
  });
});

// Spec 5: an Idempotency-Key makes a retried capture one booking.
describe('POST /api/v1/book — idempotency key (spec 5)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    verifyApiAuthMock.mockResolvedValue(null);
    verifyFirebaseTokenMock.mockResolvedValue({ uid: 'uid-1' });
    ensureAdminAppMock.mockReturnValue('sa-json');
    firestoreSetMock.mockResolvedValue(undefined);
  });

  function keyed(body: Record<string, unknown>, key: string, ip: string) {
    return new NextRequest('http://localhost/api/v1/book', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-forwarded-for': ip, 'Idempotency-Key': key },
      body: JSON.stringify(body),
    });
  }

  it('same key twice creates one booking and does not consume the limit twice', async () => {
    const { createMemoryStore, setIdempotencyStoreForTests } = await import('@/lib/idempotency');
    const store = createMemoryStore();
    setIdempotencyStoreForTests(store);
    try {
      const ip = '10.9.9.1';
      const a = await POST(keyed(VALID_BODY, 'attempt-1', ip));
      const b = await POST(keyed(VALID_BODY, 'attempt-1', ip));
      expect(await b.json()).toEqual(await a.json());
      expect(firestoreSetMock).toHaveBeenCalledTimes(1);
      // Only 1 of the 5 per hour was used: four more attempts succeed, the sixth trips.
      for (let i = 2; i <= 5; i++) {
        expect((await POST(keyed(VALID_BODY, `attempt-${i}`, ip))).status).toBe(200);
      }
      const limited = await POST(keyed(VALID_BODY, 'attempt-6', ip));
      expect(limited.status).toBe(429);
      // The 429 is not stored, so it can never be replayed as the answer.
      expect([...store.records.values()].every((r) => r.status === 'done')).toBe(true);
      expect(store.records.size).toBe(5);
    } finally {
      setIdempotencyStoreForTests(undefined);
    }
  });
});
