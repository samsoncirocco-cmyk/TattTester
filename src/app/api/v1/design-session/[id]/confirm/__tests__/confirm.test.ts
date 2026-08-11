// Seam tests for POST /api/v1/design-session/[id]/confirm: the designSession
// service is mocked at its public entry point; these tests pin the route's
// policy (auth gate, generation rate bucket, budget, spend recording,
// domain-error mapping, demo mode) and the { success, session } shape.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextResponse } from 'next/server';
import { makeRequest, makeSession, routeParams } from '../../../__tests__/helpers';

const {
  confirmProposalMock,
  claimOwnershipMock,
  recordSpendMock,
  checkBudgetMock,
  rateLimitMock,
  rateLimitResponseMock,
  verifyApiAuthMock,
  verifyFirebaseTokenMock,
  reserveGenerationCreditMock,
  releaseGenerationCreditMock,
  loggerErrorMock,
} = vi.hoisted(() => ({
  confirmProposalMock: vi.fn(),
  claimOwnershipMock: vi.fn(),
  recordSpendMock: vi.fn(),
  checkBudgetMock: vi.fn(),
  rateLimitMock: vi.fn(),
  rateLimitResponseMock: vi.fn(),
  verifyApiAuthMock: vi.fn(),
  verifyFirebaseTokenMock: vi.fn(),
  reserveGenerationCreditMock: vi.fn(),
  releaseGenerationCreditMock: vi.fn(),
  loggerErrorMock: vi.fn(),
}));

vi.mock('@/services/designSession', () => ({
  confirmProposal: confirmProposalMock,
  claimSessionOwnership: claimOwnershipMock,
  converse: vi.fn(),
  startSession: vi.fn(),
  recordPick: vi.fn(),
  refine: vi.fn(),
  getSession: vi.fn(),
}));

vi.mock('@/lib/api-auth', () => ({
  verifyApiAuth: verifyApiAuthMock,
}));

vi.mock('@/lib/auth-dal', () => ({ verifyFirebaseToken: verifyFirebaseTokenMock }));
vi.mock('@/lib/generation-credits', () => ({
  reserveGenerationCredit: reserveGenerationCreditMock,
  releaseGenerationCredit: releaseGenerationCreditMock,
  GenerationCreditsExhaustedError: class GenerationCreditsExhaustedError extends Error {},
}));

vi.mock('@/lib/rate-limit', () => ({
  rateLimit: rateLimitMock,
  rateLimitResponse: rateLimitResponseMock,
}));

vi.mock('@/lib/budget-tracker', () => ({
  checkBudget: checkBudgetMock,
  recordSpend: recordSpendMock,
  VERTEX_IMAGEN_COST_CENTS: 4,
}));

vi.mock('@/lib/logger', () => ({
  createRequestLogger: () => ({
    start: vi.fn(),
    complete: vi.fn(),
    error: loggerErrorMock,
  }),
}));

import { POST } from '../route';

const URL = 'http://localhost/api/v1/design-session/sess-1/confirm';

describe('POST /api/v1/design-session/[id]/confirm route adapter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    verifyApiAuthMock.mockResolvedValue(null);
    verifyFirebaseTokenMock.mockResolvedValue({ uid: 'uid_customer' });
    reserveGenerationCreditMock.mockResolvedValue({ source: 'free', freeRemaining: 24, paidRemaining: 0 });
    releaseGenerationCreditMock.mockResolvedValue(undefined);
    rateLimitMock.mockResolvedValue({ allowed: true });
    checkBudgetMock.mockResolvedValue({ allowed: true });
    recordSpendMock.mockResolvedValue(undefined);
    delete process.env.NEXT_PUBLIC_DEMO_MODE;
  });

  afterEach(() => {
    delete process.env.NEXT_PUBLIC_DEMO_MODE;
  });

  it('confirms the proposal and returns the two-cut reveal (ADR-0049)', async () => {
    const session = makeSession();
    confirmProposalMock.mockResolvedValueOnce(session);

    const res = await POST(makeRequest(URL, {}), routeParams('sess-1'));

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.session).toMatchObject({ id: 'sess-1', phase: 'revealed' });
    expect(json.session.variations).toHaveLength(2);

    expect(confirmProposalMock).toHaveBeenCalledWith('sess-1');
    // Generation-tier rate bucket — the confirm fires the round's paid renders.
    expect(rateLimitMock).toHaveBeenCalledWith(expect.anything(), 'generation');
    // Spend belongs to the service, which alone knows how many renders it
    // actually bought — the route must not add a second charge.
    expect(recordSpendMock).not.toHaveBeenCalled();
  });

  it('returns the auth failure untouched and never reaches the service', async () => {
    const denied = NextResponse.json({ error: 'Authorization header required' }, { status: 401 });
    verifyApiAuthMock.mockResolvedValueOnce(denied);

    const res = await POST(makeRequest(URL, {}), routeParams('sess-1'));

    expect(res.status).toBe(401);
    expect(confirmProposalMock).not.toHaveBeenCalled();
  });

  it('returns 402 when the budget is exhausted', async () => {
    checkBudgetMock.mockResolvedValueOnce({ allowed: false, spentCents: 50_000, remainingCents: 0 });

    const res = await POST(makeRequest(URL, {}), routeParams('sess-1'));

    expect(res.status).toBe(402);
    const json = await res.json();
    expect(json).toMatchObject({ error: 'Budget limit reached', spentCents: 50_000 });
    expect(confirmProposalMock).not.toHaveBeenCalled();
  });

  it('does not fire the reveal when the account has no cuts left', async () => {
    reserveGenerationCreditMock.mockRejectedValueOnce(
      Object.assign(new Error('No cuts left'), { code: 'GENERATION_CREDITS_EXHAUSTED' })
    );

    const res = await POST(makeRequest(URL, {}), routeParams('sess-1'));

    expect(res.status).toBe(402);
    expect(confirmProposalMock).not.toHaveBeenCalled();
  });

  it('returns the reserved cut if the reveal fails before it produces a design', async () => {
    confirmProposalMock.mockRejectedValueOnce(new Error('provider unavailable'));

    await POST(makeRequest(URL, {}), routeParams('sess-1'));

    expect(releaseGenerationCreditMock).toHaveBeenCalledWith(
      'uid_customer',
      { source: 'free', freeRemaining: 24, paidRemaining: 0 }
    );
  });

  // ADR-0048's loud downgrade: the reveal succeeded but on a fallback lane,
  // so the round is not charged — the credit goes back and the response says
  // so for the reveal copy.
  it('releases the credit and flags the response when the reveal downgraded', async () => {
    confirmProposalMock.mockResolvedValueOnce({
      ...makeSession(),
      downgraded: true,
      downgradeReason: 'REPLICATE_ERROR',
    });

    const res = await POST(makeRequest(URL, {}), routeParams('sess-1'));

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.session.downgraded).toBe(true);
    expect(json.creditReleased).toBe(true);
    expect(releaseGenerationCreditMock).toHaveBeenCalledWith(
      'uid_customer',
      { source: 'free', freeRemaining: 24, paidRemaining: 0 }
    );
  });

  it('keeps the charge and never calls release on an undowngraded reveal', async () => {
    confirmProposalMock.mockResolvedValueOnce(makeSession());

    const res = await POST(makeRequest(URL, {}), routeParams('sess-1'));

    const json = await res.json();
    expect(json.creditReleased).toBe(false);
    expect(releaseGenerationCreditMock).not.toHaveBeenCalled();
  });

  // A failed release must not fail a reveal the customer already has — the
  // ledger errs against us, never them.
  it('still returns the downgraded reveal when the credit release itself fails', async () => {
    confirmProposalMock.mockResolvedValueOnce({ ...makeSession(), downgraded: true });
    releaseGenerationCreditMock.mockRejectedValueOnce(new Error('firestore down'));

    const res = await POST(makeRequest(URL, {}), routeParams('sess-1'));

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.creditReleased).toBe(false);
  });

  it('returns the rate-limit response when the limiter denies', async () => {
    rateLimitMock.mockResolvedValueOnce({ allowed: false, limit: 10, remaining: 0, reset: 1 });
    rateLimitResponseMock.mockReturnValueOnce(
      NextResponse.json({ error: 'Too Many Requests' }, { status: 429 })
    );

    const res = await POST(makeRequest(URL, {}), routeParams('sess-1'));

    expect(res.status).toBe(429);
    expect(confirmProposalMock).not.toHaveBeenCalled();
  });

  it('maps a confirm before the proposal to 409 without recording spend', async () => {
    confirmProposalMock.mockRejectedValueOnce(
      Object.assign(new Error('The conversation has not reached its proposal yet'), {
        name: 'DesignSessionError',
        code: 'INVALID_PHASE',
        status: 409,
      })
    );

    const res = await POST(makeRequest(URL, {}), routeParams('sess-1'));

    expect(res.status).toBe(409);
    const json = await res.json();
    expect(json.code).toBe('INVALID_PHASE');
    expect(recordSpendMock).not.toHaveBeenCalled();
  });

  it('maps an unknown session to 404', async () => {
    confirmProposalMock.mockRejectedValueOnce(
      Object.assign(new Error('missing'), { code: 'SESSION_NOT_FOUND', status: 404 })
    );

    const res = await POST(makeRequest(URL, {}), routeParams('missing'));

    expect(res.status).toBe(404);
    expect((await res.json()).code).toBe('SESSION_NOT_FOUND');
  });

  it('maps unknown service failures to 500 without recording spend', async () => {
    confirmProposalMock.mockRejectedValueOnce(
      Object.assign(new Error('council exploded'), { code: 'COUNCIL_FAILED' })
    );

    const res = await POST(makeRequest(URL, {}), routeParams('sess-1'));

    expect(res.status).toBe(500);
    expect((await res.json()).code).toBe('COUNCIL_FAILED');
    expect(recordSpendMock).not.toHaveBeenCalled();
  });

  it('maps a throttled provider to a retryable 503 with a retry-after hint', async () => {
    confirmProposalMock.mockRejectedValueOnce(
      Object.assign(new Error('Replicate API Error: 429'), {
        code: 'REPLICATE_ERROR',
        status: 429,
        details: { retry_after: 12 },
      })
    );

    const res = await POST(makeRequest(URL, {}), routeParams('sess-1'));
    const body = await res.json();

    expect(res.status).toBe(503);
    expect(body.code).toBe('GENERATION_UNAVAILABLE');
    expect(body.retryable).toBe(true);
    expect(body.retryAfterMs).toBe(12000);
    expect(res.headers.get('Retry-After')).toBe('12');
    expect(recordSpendMock).not.toHaveBeenCalled();
  });

  it('marks unknown failures NOT retryable so the client cannot double-spend', async () => {
    confirmProposalMock.mockRejectedValueOnce(
      Object.assign(new Error('council exploded'), { code: 'COUNCIL_FAILED' })
    );

    const res = await POST(makeRequest(URL, {}), routeParams('sess-1'));
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body.retryable).toBe(false);
  });

  it('marks phase conflicts NOT retryable', async () => {
    confirmProposalMock.mockRejectedValueOnce(
      Object.assign(new Error('wrong phase'), { code: 'INVALID_PHASE', status: 409 })
    );

    const res = await POST(makeRequest(URL, {}), routeParams('sess-1'));

    expect((await res.json()).retryable).toBe(false);
  });

  // Setup (auth, rate, budget, `await params`) throwing used to escape the
  // route as an unstructured Next.js 500: no `code` for the client to branch
  // on and no logged error. It runs inside the try now, so it lands on the
  // same envelope as a service failure.
  it('returns the structured envelope and logs when auth setup throws', async () => {
    verifyApiAuthMock.mockRejectedValueOnce(new Error('Firebase admin not configured'));

    const res = await POST(makeRequest(URL, {}), routeParams('sess-1'));
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body).toMatchObject({
      error: 'Design session request failed',
      code: 'DESIGN_SESSION_FAILED',
      retryable: false,
    });
    expect(confirmProposalMock).not.toHaveBeenCalled();
    expect(recordSpendMock).not.toHaveBeenCalled();

    expect(loggerErrorMock).toHaveBeenCalledWith(
      'design_session.confirm.failed',
      expect.any(Error),
      // params never resolved, so the seeded fallback carries the log line.
      expect.objectContaining({ session_id: 'unknown', error_code: 'DESIGN_SESSION_FAILED' })
    );
  });

  it('returns the structured envelope when the rate limiter store is unavailable', async () => {
    rateLimitMock.mockRejectedValueOnce(new Error('rate limit store unavailable'));

    const res = await POST(makeRequest(URL, {}), routeParams('sess-1'));

    expect(res.status).toBe(500);
    expect((await res.json()).code).toBe('DESIGN_SESSION_FAILED');
    expect(confirmProposalMock).not.toHaveBeenCalled();
  });

  it('demo mode delegates to the real service and skips rate/budget/spend', async () => {
    process.env.NEXT_PUBLIC_DEMO_MODE = 'true';
    confirmProposalMock.mockResolvedValueOnce(makeSession());

    const res = await POST(makeRequest(URL, {}), routeParams('sess-1'));

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.session).toMatchObject({ id: 'sess-1', phase: 'revealed' });

    // Demo renders are free stock images: no rate/budget policy, no spend.
    expect(rateLimitMock).not.toHaveBeenCalled();
    expect(checkBudgetMock).not.toHaveBeenCalled();
    expect(recordSpendMock).not.toHaveBeenCalled();
  }, 10_000);

  it('refuses a stranger with 404 before reserving a credit (#338 item 1)', async () => {
    claimOwnershipMock.mockRejectedValueOnce(
      Object.assign(new Error('No design session'), { code: 'SESSION_NOT_FOUND', status: 404 })
    );

    const res = await POST(makeRequest(URL, {}), routeParams('sess-1'));

    expect(res.status).toBe(404);
    // The charged action stamps — and the refusal happened pre-charge.
    expect(claimOwnershipMock).toHaveBeenCalledWith('sess-1', 'uid_customer', { stamp: true });
    expect(reserveGenerationCreditMock).not.toHaveBeenCalled();
    expect(confirmProposalMock).not.toHaveBeenCalled();
  });
});
