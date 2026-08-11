// Seam tests for POST /api/v1/design-session/[id]/round/reroll (sprint fix
// #2): the designSession service is mocked at its public entry point; these
// pin the route's policy — auth gate, generation rate bucket, budget, the
// ONE credit reserved per re-roll and released on failure or downgrade, the
// optional hint threading, and the { success, session, round } shape.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextResponse } from 'next/server';
import { makeRequest, makeSession, routeParams } from '../../../../__tests__/helpers';

const {
  rerollRoundMock,
  claimOwnershipMock,
  checkBudgetMock,
  rateLimitMock,
  rateLimitResponseMock,
  verifyApiAuthMock,
  verifyFirebaseTokenMock,
  reserveGenerationCreditMock,
  releaseGenerationCreditMock,
  loggerErrorMock,
} = vi.hoisted(() => ({
  rerollRoundMock: vi.fn(),
  claimOwnershipMock: vi.fn(),
  checkBudgetMock: vi.fn(),
  rateLimitMock: vi.fn(),
  rateLimitResponseMock: vi.fn(),
  verifyApiAuthMock: vi.fn(),
  verifyFirebaseTokenMock: vi.fn(),
  reserveGenerationCreditMock: vi.fn(),
  releaseGenerationCreditMock: vi.fn(),
  loggerErrorMock: vi.fn(),
}));

vi.mock('@/services/designSession', () => {
  class DesignSessionError extends Error {
    readonly code: string;
    // Every round domain refusal is a conflict — same as the real class.
    readonly status = 409;
    constructor(code: string, message = code) {
      super(message);
      this.name = 'DesignSessionError';
      this.code = code;
    }
  }
  return {
    rerollRound: rerollRoundMock,
    claimSessionOwnership: claimOwnershipMock,
    DesignSessionError,
  };
});

vi.mock('@/lib/api-auth', () => ({ verifyApiAuth: verifyApiAuthMock }));
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
vi.mock('@/lib/budget-tracker', () => ({ checkBudget: checkBudgetMock }));
vi.mock('@/lib/logger', () => ({
  createRequestLogger: () => ({
    start: vi.fn(),
    complete: vi.fn(),
    error: loggerErrorMock,
  }),
}));

import { POST } from '../route';
import { DesignSessionError } from '@/services/designSession';

const URL = 'http://localhost/api/v1/design-session/sess-1/round/reroll';
const RESERVATION = { id: 'res-1', source: 'free', freeRemaining: 24, paidRemaining: 0 };

/** A delivered re-roll result — the service's RefineRoundResult shape. */
function rerollResult(overrides: Partial<{ downgraded: boolean; downgradeReason: string }> = {}) {
  // Same axis as the rejected round — the axis question is still open.
  const round = {
    round: 2,
    axis: 'bold-fine',
    variationIds: ['var-3', 'var-4'],
    ...(overrides.downgraded
      ? { downgraded: true, downgradeReason: overrides.downgradeReason }
      : {}),
  };
  return {
    session: makeSession({
      rounds: [
        // The rejected round: no pick recorded, not frozen.
        { round: 1, axis: 'bold-fine', variationIds: ['var-1', 'var-2'] },
        round,
      ],
    }),
    round,
    downgraded: overrides.downgraded === true,
    ...(overrides.downgradeReason ? { downgradeReason: overrides.downgradeReason } : {}),
  };
}

describe('POST /api/v1/design-session/[id]/round/reroll route adapter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    verifyApiAuthMock.mockResolvedValue(null);
    verifyFirebaseTokenMock.mockResolvedValue({ uid: 'uid_customer' });
    reserveGenerationCreditMock.mockResolvedValue(RESERVATION);
    releaseGenerationCreditMock.mockResolvedValue(undefined);
    rateLimitMock.mockResolvedValue({ allowed: true });
    checkBudgetMock.mockResolvedValue({ allowed: true });
    delete process.env.NEXT_PUBLIC_DEMO_MODE;
  });

  afterEach(() => {
    delete process.env.NEXT_PUBLIC_DEMO_MODE;
  });

  it('reserves ONE credit, runs the re-roll, and returns session + round', async () => {
    rerollRoundMock.mockResolvedValueOnce(rerollResult());

    const res = await POST(makeRequest(URL, {}), routeParams('sess-1'));

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.round).toMatchObject({ round: 2, axis: 'bold-fine' });
    expect(json.creditReleased).toBe(false);

    // One credit exactly, reserved before the renders, reservation id
    // riding into the round claim — a re-roll meters like any round, never
    // like a critique fix.
    expect(reserveGenerationCreditMock).toHaveBeenCalledTimes(1);
    expect(reserveGenerationCreditMock).toHaveBeenCalledWith('uid_customer');
    expect(releaseGenerationCreditMock).not.toHaveBeenCalled();
    expect(rerollRoundMock).toHaveBeenCalledWith('sess-1', { reservationId: 'res-1' });
    expect(rateLimitMock).toHaveBeenCalledWith(expect.anything(), 'generation');
  });

  it('threads the optional hint through to the service, ignoring non-strings', async () => {
    rerollRoundMock.mockResolvedValueOnce(rerollResult());
    await POST(makeRequest(URL, { hint: 'more cinematic' }), routeParams('sess-1'));
    expect(rerollRoundMock).toHaveBeenCalledWith('sess-1', {
      reservationId: 'res-1',
      hint: 'more cinematic',
    });

    rerollRoundMock.mockResolvedValueOnce(rerollResult());
    await POST(makeRequest(URL, { hint: 42 as unknown as string }), routeParams('sess-1'));
    expect(rerollRoundMock).toHaveBeenLastCalledWith('sess-1', { reservationId: 'res-1' });
  });

  it('returns the auth failure untouched and never reaches the service', async () => {
    const denied = NextResponse.json({ error: 'Authorization header required' }, { status: 401 });
    verifyApiAuthMock.mockResolvedValueOnce(denied);

    const res = await POST(makeRequest(URL, {}), routeParams('sess-1'));

    expect(res.status).toBe(401);
    expect(rerollRoundMock).not.toHaveBeenCalled();
    expect(reserveGenerationCreditMock).not.toHaveBeenCalled();
  });

  it('refuses with 402 before rendering when the meter is empty', async () => {
    reserveGenerationCreditMock.mockRejectedValueOnce(
      Object.assign(new Error('No cuts left'), { code: 'GENERATION_CREDITS_EXHAUSTED' })
    );

    const res = await POST(makeRequest(URL, {}), routeParams('sess-1'));

    expect(res.status).toBe(402);
    expect((await res.json()).code).toBe('GENERATION_CREDITS_EXHAUSTED');
    expect(rerollRoundMock).not.toHaveBeenCalled();
  });

  it('releases the credit and answers with the decided copy when the re-roll dies', async () => {
    rerollRoundMock.mockRejectedValueOnce(new Error('provider blew up'));

    const res = await POST(makeRequest(URL, {}), routeParams('sess-1'));

    // No partial charge (ADR-0049): both-or-nothing, credit back, said so.
    expect(releaseGenerationCreditMock).toHaveBeenCalledWith('uid_customer', RESERVATION);
    const json = await res.json();
    expect(json.error).toBe("That re-roll didn't take — your credit is back. Run it again?");
    expect(json.code).toBe('REROLL_FAILED');
    expect(json.creditReleased).toBe(true);
  });

  // ADR-0048's loud downgrade: delivered off the pinned lane → refunded and
  // flagged, never silent.
  it('releases the credit and flags the response when the re-roll downgraded', async () => {
    rerollRoundMock.mockResolvedValueOnce(
      rerollResult({ downgraded: true, downgradeReason: 'REPLICATE_ERROR' })
    );

    const res = await POST(makeRequest(URL, {}), routeParams('sess-1'));

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.round.downgraded).toBe(true);
    expect(json.creditReleased).toBe(true);
    expect(releaseGenerationCreditMock).toHaveBeenCalledWith('uid_customer', RESERVATION);
  });

  it('maps a concurrent round to 409 ROUND_IN_FLIGHT and releases the credit', async () => {
    rerollRoundMock.mockRejectedValueOnce(
      new DesignSessionError('ROUND_IN_FLIGHT', 'already rendering')
    );

    const res = await POST(makeRequest(URL, {}), routeParams('sess-1'));

    // The loser of the claim race spends nothing: its own reservation goes
    // straight back and the winner's round is untouched.
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('ROUND_IN_FLIGHT');
    expect(releaseGenerationCreditMock).toHaveBeenCalledWith('uid_customer', RESERVATION);
  });

  it('uses the neutral failure copy when the release itself fails', async () => {
    rerollRoundMock.mockRejectedValueOnce(new Error('provider blew up'));
    releaseGenerationCreditMock.mockRejectedValueOnce(new Error('firestore down'));

    const res = await POST(makeRequest(URL, {}), routeParams('sess-1'));

    // "your credit is back" is only said when it is true.
    const json = await res.json();
    expect(json.error).toBe("That re-roll didn't take. Run it again?");
    expect(json.creditReleased).toBe(false);
  });

  it('returns 402 when the budget is exhausted, before the credit', async () => {
    checkBudgetMock.mockResolvedValueOnce({ allowed: false, spentCents: 50_000, remainingCents: 0 });

    const res = await POST(makeRequest(URL, {}), routeParams('sess-1'));

    expect(res.status).toBe(402);
    expect(reserveGenerationCreditMock).not.toHaveBeenCalled();
    expect(rerollRoundMock).not.toHaveBeenCalled();
  });

  it('returns the rate-limit response when the limiter denies', async () => {
    rateLimitMock.mockResolvedValueOnce({ allowed: false, limit: 10, remaining: 0, reset: 1 });
    rateLimitResponseMock.mockReturnValueOnce(
      NextResponse.json({ error: 'Too Many Requests' }, { status: 429 })
    );

    const res = await POST(makeRequest(URL, {}), routeParams('sess-1'));

    expect(res.status).toBe(429);
    expect(reserveGenerationCreditMock).not.toHaveBeenCalled();
  });

  it('demo mode delegates to the real service and skips rate/budget/credit', async () => {
    process.env.NEXT_PUBLIC_DEMO_MODE = 'true';
    rerollRoundMock.mockResolvedValueOnce(rerollResult());

    const res = await POST(makeRequest(URL, {}), routeParams('sess-1'));

    expect(res.status).toBe(200);
    expect(rateLimitMock).not.toHaveBeenCalled();
    expect(checkBudgetMock).not.toHaveBeenCalled();
    expect(reserveGenerationCreditMock).not.toHaveBeenCalled();
  });

  it('refuses a stranger with 404 before reserving a credit (#338 item 1)', async () => {
    claimOwnershipMock.mockRejectedValueOnce(
      new DesignSessionError('SESSION_NOT_FOUND', 'No design session')
    );

    const res = await POST(makeRequest(URL, {}), routeParams('sess-1'));

    expect(res.status).toBe(404);
    expect(claimOwnershipMock).toHaveBeenCalledWith('sess-1', 'uid_customer', { stamp: true });
    expect(reserveGenerationCreditMock).not.toHaveBeenCalled();
    expect(rerollRoundMock).not.toHaveBeenCalled();
  });
});
