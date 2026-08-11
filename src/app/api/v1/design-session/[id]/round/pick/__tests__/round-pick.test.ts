// Seam tests for POST /api/v1/design-session/[id]/round/pick (ADR-0049):
// the FREE round pick — no budget, no credit, just auth/rate/validation and
// the { success, round, session } shape.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextResponse } from 'next/server';
import { makeRequest, makeSession, routeParams } from '../../../../__tests__/helpers';

const {
  recordRoundPickMock,
  claimOwnershipMock,
  rateLimitMock,
  rateLimitResponseMock,
  verifyApiAuthMock,
  loggerErrorMock,
} = vi.hoisted(() => ({
  recordRoundPickMock: vi.fn(),
  claimOwnershipMock: vi.fn(),
  rateLimitMock: vi.fn(),
  rateLimitResponseMock: vi.fn(),
  verifyApiAuthMock: vi.fn(),
  loggerErrorMock: vi.fn(),
}));

vi.mock('@/services/designSession', () => ({
  recordRoundPick: recordRoundPickMock,
  claimSessionOwnership: claimOwnershipMock,
}));
vi.mock('@/lib/api-auth', () => ({ verifyApiAuthWithUser: verifyApiAuthMock }));
vi.mock('@/lib/rate-limit', () => ({
  rateLimit: rateLimitMock,
  rateLimitResponse: rateLimitResponseMock,
}));
vi.mock('@/lib/logger', () => ({
  createRequestLogger: () => ({
    start: vi.fn(),
    complete: vi.fn(),
    error: loggerErrorMock,
  }),
}));

import { POST } from '../route';

const URL = 'http://localhost/api/v1/design-session/sess-1/round/pick';

describe('POST /api/v1/design-session/[id]/round/pick route adapter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    verifyApiAuthMock.mockResolvedValue({ error: null, user: { uid: 'uid-1' } });
    rateLimitMock.mockResolvedValue({ allowed: true });
  });

  it('records the pick and returns the live round with the session', async () => {
    recordRoundPickMock.mockResolvedValueOnce(
      makeSession({
        rounds: [
          {
            round: 1,
            axis: 'bold-fine',
            variationIds: ['var-1', 'var-2'],
            pickedId: 'var-2',
            pickedAt: '2026-08-05T00:00:00.000Z',
          },
        ],
      })
    );

    const res = await POST(makeRequest(URL, { pickedId: 'var-2' }), routeParams('sess-1'));

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.round).toMatchObject({ round: 1, pickedId: 'var-2' });
    expect(recordRoundPickMock).toHaveBeenCalledWith('sess-1', { pickedId: 'var-2' });
    // The pick is free — the default rate bucket, never the generation one.
    expect(rateLimitMock).toHaveBeenCalledWith(expect.anything(), 'default');
  });

  it('rejects a missing pickedId with 400 before the service', async () => {
    const res = await POST(makeRequest(URL, {}), routeParams('sess-1'));

    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('INVALID_PICKED_ID');
    expect(recordRoundPickMock).not.toHaveBeenCalled();
  });

  it('maps a frozen round to 409 — the pick can no longer change', async () => {
    recordRoundPickMock.mockRejectedValueOnce(
      Object.assign(new Error('frozen'), { code: 'ROUND_PICK_FROZEN', status: 409 })
    );

    const res = await POST(makeRequest(URL, { pickedId: 'var-1' }), routeParams('sess-1'));

    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('ROUND_PICK_FROZEN');
  });

  it('returns the auth failure untouched and never reaches the service', async () => {
    verifyApiAuthMock.mockResolvedValueOnce({
      error: NextResponse.json({ error: 'Authorization header required' }, { status: 401 }),
    });

    const res = await POST(makeRequest(URL, { pickedId: 'var-1' }), routeParams('sess-1'));

    expect(res.status).toBe(401);
    expect(recordRoundPickMock).not.toHaveBeenCalled();
  });
});
