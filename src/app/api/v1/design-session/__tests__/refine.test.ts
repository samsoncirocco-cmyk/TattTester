// Seam tests for POST /api/v1/design-session/[id]/refine: designSession
// service mocked; pins the {refinedVariation, brief, session} shape, the
// single-image spend, and the ADR-0013 hard-stop → 409 mapping.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextResponse } from 'next/server';
import { makeBrief, makeRequest, makeSession, routeParams } from './helpers';

const { refineMock, recordSpendMock, checkBudgetMock, rateLimitMock, rateLimitResponseMock, verifyApiAuthMock } = vi.hoisted(() => ({
  refineMock: vi.fn(),
  recordSpendMock: vi.fn(),
  checkBudgetMock: vi.fn(),
  rateLimitMock: vi.fn(),
  rateLimitResponseMock: vi.fn(),
  verifyApiAuthMock: vi.fn()
}));

vi.mock('@/services/designSession', () => ({
  startSession: vi.fn(),
  recordPick: vi.fn(),
  refine: refineMock,
  claimSessionOwnership: vi.fn(),
  getSession: vi.fn()
}));

vi.mock('@/lib/api-auth', () => ({
  verifyApiAuthWithUser: verifyApiAuthMock
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

import { POST } from '../[id]/refine/route';

const URL = 'http://localhost/api/v1/design-session/sess-1/refine';

function completeSession() {
  return makeSession({
    phase: 'complete',
    pickId: 'var-2',
    mostNotYouId: 'var-3',
    refinementQuestion: 'Heavier linework?',
    refinementAnswer: 'yes, as bold as it gets',
    refinedVariation: {
      id: 'var-refined',
      axisPosition: { 'bold-fine': 'bold', 'color-blackwork': 'blackwork' },
      prompt: 'refined prompt',
      imageUrl: 'https://img/refined.png'
    },
    brief: makeBrief()
  });
}

describe('POST /api/v1/design-session/[id]/refine route adapter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    verifyApiAuthMock.mockResolvedValue({ error: null, user: { uid: 'uid-1' } });
    rateLimitMock.mockResolvedValue({ allowed: true });
    checkBudgetMock.mockResolvedValue({ allowed: true });
    recordSpendMock.mockResolvedValue(undefined);
    delete process.env.NEXT_PUBLIC_DEMO_MODE;
  });

  afterEach(() => {
    delete process.env.NEXT_PUBLIC_DEMO_MODE;
  });

  it('returns refinedVariation + brief + session and records single-image spend', async () => {
    refineMock.mockResolvedValueOnce(completeSession());

    const res = await POST(
      makeRequest(URL, { answer: '  yes, as bold as it gets  ' }),
      routeParams('sess-1')
    );

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.refinedVariation).toMatchObject({ id: 'var-refined', imageUrl: 'https://img/refined.png' });
    expect(json.brief).toMatchObject({ placement: 'forearm', styleTags: ['blackwork'] });
    expect(json.session.phase).toBe('complete');

    // The route trims the answer before handing it to the service.
    expect(refineMock).toHaveBeenCalledWith('sess-1', { answer: 'yes, as bold as it gets' });

    // Spend belongs to the service, which alone knows how many renders it
    // actually bought — the route must not add a second charge.
    expect(recordSpendMock).not.toHaveBeenCalled();
  });

  it('rejects a missing answer with 400 before calling the service', async () => {
    const res = await POST(makeRequest(URL, {}), routeParams('sess-1'));

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.code).toBe('INVALID_ANSWER');
    expect(refineMock).not.toHaveBeenCalled();
    expect(recordSpendMock).not.toHaveBeenCalled();
  });

  it('maps the ADR-0013 hard-stop domain error to 409 without recording spend', async () => {
    refineMock.mockRejectedValueOnce(Object.assign(
      new Error('refinement already used — one round, hard stop'),
      { code: 'REFINEMENT_CLOSED', status: 409 }
    ));

    const res = await POST(makeRequest(URL, { answer: 'one more?' }), routeParams('sess-1'));

    expect(res.status).toBe(409);
    const json = await res.json();
    expect(json.code).toBe('REFINEMENT_CLOSED');
    expect(recordSpendMock).not.toHaveBeenCalled();
  });

  it('maps SESSION_NOT_FOUND to 404', async () => {
    refineMock.mockRejectedValueOnce(Object.assign(new Error('no such session'), { code: 'SESSION_NOT_FOUND' }));

    const res = await POST(
      makeRequest('http://localhost/api/v1/design-session/nope/refine', { answer: 'bolder' }),
      routeParams('nope')
    );

    expect(res.status).toBe(404);
    const json = await res.json();
    expect(json.code).toBe('SESSION_NOT_FOUND');
  });

  it('returns 402 when the budget is exhausted', async () => {
    checkBudgetMock.mockResolvedValueOnce({ allowed: false, spentCents: 50_000, remainingCents: 0 });

    const res = await POST(makeRequest(URL, { answer: 'bolder' }), routeParams('sess-1'));

    expect(res.status).toBe(402);
    expect(refineMock).not.toHaveBeenCalled();
  });

  it('returns the auth failure untouched and never reaches the service', async () => {
    const denied = NextResponse.json({ error: 'Authorization header required', code: 'AUTH_REQUIRED' }, { status: 401 });
    verifyApiAuthMock.mockResolvedValueOnce({ error: denied });

    const res = await POST(makeRequest(URL, { answer: 'bolder' }), routeParams('sess-1'));

    expect(res.status).toBe(401);
    expect(refineMock).not.toHaveBeenCalled();
  });

  // Setup runs inside the try, so a throwing dependency lands on the shared
  // structured envelope instead of escaping as an unstructured Next.js 500.
  it('returns the structured envelope when auth setup throws', async () => {
    verifyApiAuthMock.mockRejectedValueOnce(new Error('Firebase admin not configured'));

    const res = await POST(makeRequest(URL, { answer: 'bolder' }), routeParams('sess-1'));

    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ code: 'DESIGN_SESSION_FAILED', retryable: false });
    expect(refineMock).not.toHaveBeenCalled();
    expect(recordSpendMock).not.toHaveBeenCalled();
  });

  it('demo mode delegates to the real service and skips rate/budget/spend', async () => {
    process.env.NEXT_PUBLIC_DEMO_MODE = 'true';
    refineMock.mockResolvedValueOnce(completeSession());

    const res = await POST(makeRequest(URL, { answer: 'bolder' }), routeParams('sess-1'));

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.session.phase).toBe('complete');

    // The REAL service runs — the demo regen is a free stock image, so
    // rate/budget policy and spend recording are skipped.
    expect(refineMock).toHaveBeenCalledWith('sess-1', { answer: 'bolder' });
    expect(rateLimitMock).not.toHaveBeenCalled();
    expect(checkBudgetMock).not.toHaveBeenCalled();
    expect(recordSpendMock).not.toHaveBeenCalled();
  }, 10_000);
});
