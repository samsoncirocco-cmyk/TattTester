// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

const { authMock, rateLimitMock, listMock } = vi.hoisted(() => ({
  authMock: vi.fn(),
  rateLimitMock: vi.fn(),
  listMock: vi.fn(),
}));

vi.mock('@/lib/api-auth', () => ({ verifyApiAuthWithUser: authMock }));
vi.mock('@/lib/rate-limit', () => ({
  rateLimit: rateLimitMock,
  rateLimitResponse: () => NextResponse.json({ error: 'Too Many Requests' }, { status: 429 }),
}));
vi.mock('@/features/match-pulse/services/matchDecisionsPersistence', () => ({
  listDecisions: listMock,
}));

import { GET } from './route';

const UID = 'uid-1';
const DS = '123e4567-e89b-12d3-a456-426614174000';

function get(qs = '') {
  return new NextRequest(`http://localhost/api/v1/match/decisions${qs}`, {
    headers: { authorization: 'Bearer t' },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  authMock.mockResolvedValue({ error: null, user: { uid: UID } });
  rateLimitMock.mockResolvedValue({ allowed: true, limit: 120, remaining: 1, reset: 0 });
  listMock.mockResolvedValue([
    { artistId: 'a2', decision: 'pass', dsId: null, updatedAt: 2 },
    { artistId: 'a1', decision: 'pin', dsId: null, updatedAt: 1 },
  ]);
});

describe('GET /api/v1/match/decisions', () => {
  it('returns only the caller\'s decisions', async () => {
    const res = await GET(get());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.decisions.map((d: { artistId: string }) => d.artistId)).toEqual(['a2', 'a1']);
    expect(listMock).toHaveBeenCalledWith(UID, { dsId: null });
  });

  it('scopes to a design session when ds is given', async () => {
    await GET(get(`?ds=${DS}`));
    expect(listMock).toHaveBeenCalledWith(UID, { dsId: DS });
  });

  it('rejects a malformed ds', async () => {
    expect((await GET(get('?ds=abc'))).status).toBe(400);
    expect(listMock).not.toHaveBeenCalled();
  });

  it('requires auth', async () => {
    authMock.mockResolvedValue({ error: NextResponse.json({}, { status: 401 }) });
    expect((await GET(get())).status).toBe(401);
  });
});
