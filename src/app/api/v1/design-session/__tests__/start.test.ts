// Seam tests for POST /api/v1/design-session: the designSession service is
// mocked at its public entry point; these tests pin the route's policy
// (auth gate, budget, spend recording, validation, demo mode) and shapes.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextResponse } from 'next/server';
import { makeRequest, makeSession } from './helpers';

const {
  startSessionMock,
  recordSpendMock,
  checkBudgetMock,
  rateLimitMock,
  rateLimitResponseMock,
  verifyApiAuthMock,
  claimSessionOwnershipMock,
  reserveCreditMock,
  releaseCreditMock,
} = vi.hoisted(() => ({
  startSessionMock: vi.fn(),
  recordSpendMock: vi.fn(),
  checkBudgetMock: vi.fn(),
  rateLimitMock: vi.fn(),
  rateLimitResponseMock: vi.fn(),
  verifyApiAuthMock: vi.fn(),
  claimSessionOwnershipMock: vi.fn(),
  reserveCreditMock: vi.fn(),
  releaseCreditMock: vi.fn()
}));

vi.mock('@/services/designSession', () => ({
  startSession: startSessionMock,
  recordPick: vi.fn(),
  refine: vi.fn(),
  claimSessionOwnership: claimSessionOwnershipMock,
  getSession: vi.fn()
}));

vi.mock('@/lib/api-auth', () => ({
  verifyApiAuthWithUser: verifyApiAuthMock
}));

vi.mock('@/lib/generation-credits', () => ({
  reserveGenerationCredit: reserveCreditMock,
  releaseGenerationCredit: releaseCreditMock,
  GenerationCreditsExhaustedError: class GenerationCreditsExhaustedError extends Error {}
}));

vi.mock('@/lib/rate-limit', () => ({
  rateLimit: rateLimitMock,
  rateLimitResponse: rateLimitResponseMock
}));

vi.mock('@/lib/budget-tracker', () => ({
  checkBudget: checkBudgetMock,
  recordSpend: recordSpendMock,
  VERTEX_IMAGEN_COST_CENTS: 4
}));

vi.mock('@/lib/logger', () => ({
  createRequestLogger: () => ({
    start: vi.fn(),
    complete: vi.fn(),
    error: vi.fn()
  })
}));

import { POST } from '../route';

/** Matches the real error by `code`, which is what the route branches on. */
class FakeExhausted extends Error {
  readonly code = 'GENERATION_CREDITS_EXHAUSTED';
}

const URL = 'http://localhost/api/v1/design-session';

describe('POST /api/v1/design-session route adapter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    verifyApiAuthMock.mockResolvedValue({ error: null, user: { uid: 'uid-1' } });
    rateLimitMock.mockResolvedValue({ allowed: true });
    checkBudgetMock.mockResolvedValue({ allowed: true });
    recordSpendMock.mockResolvedValue(undefined);
    claimSessionOwnershipMock.mockResolvedValue(undefined);
    reserveCreditMock.mockResolvedValue({ id: 'res-1', source: 'free', freeRemaining: 24, paidRemaining: 0 });
    releaseCreditMock.mockResolvedValue(undefined);
    delete process.env.NEXT_PUBLIC_DEMO_MODE;
  });

  afterEach(() => {
    delete process.env.NEXT_PUBLIC_DEMO_MODE;
  });

  it('returns the session and records vertex spend for the 4 reveal images', async () => {
    const session = makeSession();
    startSessionMock.mockResolvedValueOnce(session);

    const res = await POST(makeRequest(URL, {
      placementAnswer: '  inner forearm  ',
      meaningAnswer: 'for my grandmother'
    }));

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.session).toMatchObject({ id: 'sess-1', phase: 'revealed' });
    expect(json.session.variations).toHaveLength(2);

    // The route trims answers before handing them to the service.
    expect(startSessionMock).toHaveBeenCalledWith({
      placementAnswer: 'inner forearm',
      meaningAnswer: 'for my grandmother'
    });

    // Spend belongs to the service, which alone knows how many renders it
    // actually bought — the route must not add a second charge.
    expect(recordSpendMock).not.toHaveBeenCalled();
  });

  it('rejects a missing placementAnswer with 400 before calling the service', async () => {
    const res = await POST(makeRequest(URL, { meaningAnswer: 'memorial piece' }));

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.code).toBe('INVALID_PLACEMENT_ANSWER');
    expect(startSessionMock).not.toHaveBeenCalled();
    expect(recordSpendMock).not.toHaveBeenCalled();
  });

  it('rejects a blank meaningAnswer with 400', async () => {
    const res = await POST(makeRequest(URL, { placementAnswer: 'forearm', meaningAnswer: '   ' }));

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.code).toBe('INVALID_MEANING_ANSWER');
    expect(startSessionMock).not.toHaveBeenCalled();
  });

  it('returns the auth failure untouched and never reaches the service', async () => {
    const denied = NextResponse.json({ error: 'Authorization header required', code: 'AUTH_REQUIRED' }, { status: 401 });
    verifyApiAuthMock.mockResolvedValueOnce({ error: denied });

    const res = await POST(makeRequest(URL, { placementAnswer: 'forearm', meaningAnswer: 'x y z' }));

    expect(res.status).toBe(401);
    expect(startSessionMock).not.toHaveBeenCalled();
  });

  // Setup runs inside the try, so a throwing dependency lands on the shared
  // structured envelope instead of escaping as an unstructured Next.js 500.
  it('returns the structured envelope when auth setup throws', async () => {
    verifyApiAuthMock.mockRejectedValueOnce(new Error('Firebase admin not configured'));

    const res = await POST(makeRequest(URL, { placementAnswer: 'forearm', meaningAnswer: 'x y z' }));

    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ code: 'DESIGN_SESSION_FAILED', retryable: false });
    expect(startSessionMock).not.toHaveBeenCalled();
  });

  it('returns 402 when the budget is exhausted', async () => {
    checkBudgetMock.mockResolvedValueOnce({ allowed: false, spentCents: 50_000, remainingCents: 0 });

    const res = await POST(makeRequest(URL, { placementAnswer: 'forearm', meaningAnswer: 'x y z' }));

    expect(res.status).toBe(402);
    const json = await res.json();
    expect(json).toMatchObject({ error: 'Budget limit reached', spentCents: 50_000 });
    expect(startSessionMock).not.toHaveBeenCalled();
  });

  it('returns the rate-limit response when the limiter denies', async () => {
    rateLimitMock.mockResolvedValueOnce({ allowed: false, limit: 10, remaining: 0, reset: 1 });
    rateLimitResponseMock.mockReturnValueOnce(
      NextResponse.json({ error: 'Too Many Requests' }, { status: 429 })
    );

    const res = await POST(makeRequest(URL, { placementAnswer: 'forearm', meaningAnswer: 'x y z' }));

    expect(res.status).toBe(429);
    expect(startSessionMock).not.toHaveBeenCalled();
  });

  it('maps unknown service failures to 500 without recording spend', async () => {
    startSessionMock.mockRejectedValueOnce(Object.assign(new Error('council exploded'), { code: 'COUNCIL_FAILED' }));

    const res = await POST(makeRequest(URL, { placementAnswer: 'forearm', meaningAnswer: 'x y z' }));

    expect(res.status).toBe(500);
    const json = await res.json();
    expect(json.code).toBe('COUNCIL_FAILED');
    expect(recordSpendMock).not.toHaveBeenCalled();
  });

  it('demo mode delegates to the real service (persisted session) and skips rate/budget/spend', async () => {
    process.env.NEXT_PUBLIC_DEMO_MODE = 'true';
    const session = makeSession();
    startSessionMock.mockResolvedValueOnce(session);

    const res = await POST(makeRequest(URL, { placementAnswer: '  wrist  ', meaningAnswer: 'my dog' }));

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.session).toMatchObject({ id: 'sess-1', phase: 'revealed' });

    // The REAL service runs (and persists) — no fabricated session.
    expect(startSessionMock).toHaveBeenCalledWith({
      placementAnswer: 'wrist',
      meaningAnswer: 'my dog'
    });

    // Demo renders are free stock images: no rate/budget policy, no spend.
    expect(rateLimitMock).not.toHaveBeenCalled();
    expect(checkBudgetMock).not.toHaveBeenCalled();
    expect(recordSpendMock).not.toHaveBeenCalled();
  }, 10_000);

  it('demo mode still validates input with 400 before calling the service', async () => {
    process.env.NEXT_PUBLIC_DEMO_MODE = 'true';

    const res = await POST(makeRequest(URL, { meaningAnswer: 'my dog' }));

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.code).toBe('INVALID_PLACEMENT_ANSWER');
    expect(startSessionMock).not.toHaveBeenCalled();
  });
  // ---------------------------------------------------------------------
  // Generation credits (ADR-0041). This route renders; before these tests
  // it never touched the ledger, so a signed-in customer could take an
  // unlimited number of free reveals by starting a new session instead of
  // paying. The lifetime allowance is only real if EVERY generating route
  // debits it.
  // ---------------------------------------------------------------------

  it('reserves one generation credit before the renders and stamps the new session', async () => {
    const session = makeSession();
    startSessionMock.mockResolvedValueOnce(session);

    const res = await POST(makeRequest(URL, { placementAnswer: 'forearm', meaningAnswer: 'my dog' }));

    expect(res.status).toBe(200);
    expect(reserveCreditMock).toHaveBeenCalledWith('uid-1');
    expect(releaseCreditMock).not.toHaveBeenCalled();
    // First charged action on a session created unowned (#357) — it stamps.
    expect(claimSessionOwnershipMock).toHaveBeenCalledWith('sess-1', 'uid-1', { stamp: true });
    expect((await res.json()).credits).toMatchObject({ id: 'res-1', source: 'free' });
  });

  it('refuses with 402 when the lifetime allowance is spent, without rendering', async () => {
    reserveCreditMock.mockRejectedValueOnce(new FakeExhausted());

    const res = await POST(makeRequest(URL, { placementAnswer: 'forearm', meaningAnswer: 'my dog' }));

    expect(res.status).toBe(402);
    expect((await res.json()).code).toBe('GENERATION_CREDITS_EXHAUSTED');
    expect(startSessionMock).not.toHaveBeenCalled();
    // Nothing was reserved, so nothing may be handed back.
    expect(releaseCreditMock).not.toHaveBeenCalled();
  });

  it('returns the credit when the renders never land', async () => {
    startSessionMock.mockRejectedValueOnce(new Error('provider exploded'));

    const res = await POST(makeRequest(URL, { placementAnswer: 'forearm', meaningAnswer: 'my dog' }));

    expect(res.status).toBe(500);
    expect(releaseCreditMock).toHaveBeenCalledWith('uid-1', expect.objectContaining({ id: 'res-1' }));
  });

  // The customer already has the cuts they paid for; a store hiccup while
  // stamping must not turn a delivered reveal into a 500.
  it('still returns the reveal when ownership stamping fails', async () => {
    startSessionMock.mockResolvedValueOnce(makeSession());
    claimSessionOwnershipMock.mockRejectedValueOnce(new Error('store unavailable'));

    const res = await POST(makeRequest(URL, { placementAnswer: 'forearm', meaningAnswer: 'my dog' }));

    expect(res.status).toBe(200);
    expect(releaseCreditMock).not.toHaveBeenCalled();
  });

  it('demo mode never touches the credit ledger', async () => {
    process.env.NEXT_PUBLIC_DEMO_MODE = 'true';
    startSessionMock.mockResolvedValueOnce(makeSession());

    const res = await POST(makeRequest(URL, { placementAnswer: 'forearm', meaningAnswer: 'my dog' }));

    expect(res.status).toBe(200);
    expect(reserveCreditMock).not.toHaveBeenCalled();
    expect(releaseCreditMock).not.toHaveBeenCalled();
  }, 10_000);
});
