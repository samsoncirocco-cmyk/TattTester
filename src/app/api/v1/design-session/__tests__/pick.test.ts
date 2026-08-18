// Seam tests for POST /api/v1/design-session/[id]/pick: designSession service
// mocked; pins validation, the {refinementQuestion, session} shape, and the
// 404/409 domain-error mapping.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextResponse } from 'next/server';
import { makeRequest, makeSession, routeParams } from './helpers';

const { recordPickMock, claimOwnershipMock, rateLimitMock, rateLimitResponseMock, verifyApiAuthMock } = vi.hoisted(() => ({
  recordPickMock: vi.fn(),
  claimOwnershipMock: vi.fn(),
  rateLimitMock: vi.fn(),
  rateLimitResponseMock: vi.fn(),
  verifyApiAuthMock: vi.fn()
}));

vi.mock('@/services/designSession', () => ({
  startSession: vi.fn(),
  recordPick: recordPickMock,
  claimSessionOwnership: claimOwnershipMock,
  refine: vi.fn(),
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
  checkBudget: vi.fn(),
  recordSpend: vi.fn(),
  VERTEX_IMAGEN_COST_CENTS: 4
}));

vi.mock('@/lib/logger', () => ({
  createRequestLogger: () => ({
    start: vi.fn(),
    complete: vi.fn(),
    error: vi.fn()
  })
}));

import { POST } from '../[id]/pick/route';

const URL = 'http://localhost/api/v1/design-session/sess-1/pick';

describe('POST /api/v1/design-session/[id]/pick route adapter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    verifyApiAuthMock.mockResolvedValue({ error: null, user: { uid: 'uid-1' } });
    rateLimitMock.mockResolvedValue({ allowed: true });
  });

  it('returns the refinement question with the picked session', async () => {
    const picked = makeSession({
      phase: 'picked',
      pickId: 'var-2',
      mostNotYouId: 'var-3',
      refinementQuestion: 'You leaned bold — should the regen push even heavier linework?'
    });
    recordPickMock.mockResolvedValueOnce(picked);

    const res = await POST(
      makeRequest(URL, { pickId: 'var-2', mostNotYouId: 'var-3' }),
      routeParams('sess-1')
    );

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.refinementQuestion).toBe('You leaned bold — should the regen push even heavier linework?');
    expect(json.session).toMatchObject({ id: 'sess-1', phase: 'picked', pickId: 'var-2', mostNotYouId: 'var-3' });

    expect(recordPickMock).toHaveBeenCalledWith('sess-1', { pickId: 'var-2', mostNotYouId: 'var-3' });
  });

  it('rejects a missing pickId with 400 before calling the service', async () => {
    const res = await POST(makeRequest(URL, { mostNotYouId: 'var-3' }), routeParams('sess-1'));

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.code).toBe('INVALID_PICK_ID');
    expect(recordPickMock).not.toHaveBeenCalled();
  });

  it('rejects a missing mostNotYouId with 400', async () => {
    const res = await POST(makeRequest(URL, { pickId: 'var-2' }), routeParams('sess-1'));

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.code).toBe('INVALID_MOST_NOT_YOU_ID');
    expect(recordPickMock).not.toHaveBeenCalled();
  });

  it('rejects pickId === mostNotYouId with 400', async () => {
    const res = await POST(
      makeRequest(URL, { pickId: 'var-2', mostNotYouId: 'var-2' }),
      routeParams('sess-1')
    );

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.code).toBe('PICK_IDS_IDENTICAL');
    expect(recordPickMock).not.toHaveBeenCalled();
  });

  it('maps SESSION_NOT_FOUND to 404', async () => {
    recordPickMock.mockRejectedValueOnce(Object.assign(new Error('no such session'), { code: 'SESSION_NOT_FOUND' }));

    const res = await POST(
      makeRequest('http://localhost/api/v1/design-session/nope/pick', { pickId: 'var-2', mostNotYouId: 'var-3' }),
      routeParams('nope')
    );

    expect(res.status).toBe(404);
    const json = await res.json();
    expect(json.code).toBe('SESSION_NOT_FOUND');
  });

  it('maps a phase-conflict domain error to 409', async () => {
    recordPickMock.mockRejectedValueOnce(Object.assign(new Error('session already complete'), { code: 'INVALID_PHASE' }));

    const res = await POST(
      makeRequest(URL, { pickId: 'var-2', mostNotYouId: 'var-3' }),
      routeParams('sess-1')
    );

    expect(res.status).toBe(409);
    const json = await res.json();
    expect(json.code).toBe('INVALID_PHASE');
  });

  it('maps an unknown variation id domain error to 400', async () => {
    recordPickMock.mockRejectedValueOnce(Object.assign(
      new Error("pickId 'var-9' is not one of the session's variations"),
      { code: 'INVALID_VARIATION', status: 400 }
    ));

    const res = await POST(
      makeRequest(URL, { pickId: 'var-9', mostNotYouId: 'var-3' }),
      routeParams('sess-1')
    );

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.code).toBe('INVALID_VARIATION');
  });

  it('returns the auth failure untouched and never reaches the service', async () => {
    const denied = NextResponse.json({ error: 'Invalid authorization token', code: 'AUTH_INVALID' }, { status: 401 });
    verifyApiAuthMock.mockResolvedValueOnce({ error: denied });

    const res = await POST(
      makeRequest(URL, { pickId: 'var-2', mostNotYouId: 'var-3' }),
      routeParams('sess-1')
    );

    expect(res.status).toBe(401);
    expect(recordPickMock).not.toHaveBeenCalled();
  });

  // Setup runs inside the try, so a throwing dependency lands on the shared
  // structured envelope instead of escaping as an unstructured Next.js 500.
  it('returns the structured envelope when auth setup throws', async () => {
    verifyApiAuthMock.mockRejectedValueOnce(new Error('Firebase admin not configured'));

    const res = await POST(
      makeRequest(URL, { pickId: 'var-2', mostNotYouId: 'var-3' }),
      routeParams('sess-1')
    );

    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ code: 'DESIGN_SESSION_FAILED', retryable: false });
    expect(recordPickMock).not.toHaveBeenCalled();
  });

  it('guards ownership without stamping — a stranger gets 404, an unowned session stays unbound (#338 item 1)', async () => {
    claimOwnershipMock.mockRejectedValueOnce(
      Object.assign(new Error('No design session'), { code: 'SESSION_NOT_FOUND', status: 404 })
    );

    const res = await POST(
      makeRequest(URL, { pickId: 'var-1', mostNotYouId: 'var-2' }),
      routeParams('sess-1')
    );

    expect(res.status).toBe(404);
    // A free pick guards but never binds — stamping is a charged-action right.
    expect(claimOwnershipMock).toHaveBeenCalledWith('sess-1', 'uid-1', { stamp: false });
    expect(recordPickMock).not.toHaveBeenCalled();
  });
});
