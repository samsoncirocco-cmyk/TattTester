// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

const { authMock, rateLimitMock, recordMock, removeMock } = vi.hoisted(() => ({
  authMock: vi.fn(),
  rateLimitMock: vi.fn(),
  recordMock: vi.fn(),
  removeMock: vi.fn(),
}));

vi.mock('@/lib/api-auth', () => ({ verifyApiAuthWithUser: authMock }));
vi.mock('@/lib/rate-limit', () => ({
  rateLimit: rateLimitMock,
  rateLimitResponse: () => NextResponse.json({ error: 'Too Many Requests' }, { status: 429 }),
}));
vi.mock('@/features/match-pulse/services/matchDecisionsPersistence', () => ({
  recordDecision: recordMock,
  removeDecision: removeMock,
}));

import { POST, DELETE } from './route';

const UID = 'uid-1';
const DS = '123e4567-e89b-12d3-a456-426614174000';

function post(body: unknown) {
  return new NextRequest('http://localhost/api/v1/match/decision', {
    method: 'POST',
    headers: { authorization: 'Bearer t', 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}
function del(qs: string) {
  return new NextRequest(`http://localhost/api/v1/match/decision${qs}`, {
    method: 'DELETE',
    headers: { authorization: 'Bearer t' },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  authMock.mockResolvedValue({ error: null, user: { uid: UID } });
  rateLimitMock.mockResolvedValue({ allowed: true, limit: 120, remaining: 1, reset: 0 });
  recordMock.mockResolvedValue(true);
  removeMock.mockResolvedValue(true);
});

describe('POST /api/v1/match/decision', () => {
  it('requires auth', async () => {
    authMock.mockResolvedValue({ error: NextResponse.json({}, { status: 401 }) });
    const res = await POST(post({ artistId: 'a1', decision: 'pin' }));
    expect(res.status).toBe(401);
    expect(recordMock).not.toHaveBeenCalled();
  });

  it('takes the uid from the token and ignores a body uid', async () => {
    const res = await POST(post({ artistId: 'a1', decision: 'pin', uid: 'someone-else' }));
    expect(res.status).toBe(204);
    expect(recordMock).toHaveBeenCalledWith({
      uid: UID,
      artistId: 'a1',
      decision: 'pin',
      dsId: null,
    });
  });

  it('passes a UUID dsId through', async () => {
    const res = await POST(post({ artistId: 'a1', decision: 'pass', dsId: DS }));
    expect(res.status).toBe(204);
    expect(recordMock).toHaveBeenCalledWith(expect.objectContaining({ dsId: DS }));
  });

  it('rejects an invalid decision, oversized or malformed ids and a bad dsId', async () => {
    expect((await POST(post({ artistId: 'a1', decision: 'maybe' }))).status).toBe(400);
    expect((await POST(post({ artistId: 'x'.repeat(129), decision: 'pin' }))).status).toBe(400);
    expect((await POST(post({ artistId: 'a/b', decision: 'pin' }))).status).toBe(400);
    expect((await POST(post({ artistId: '', decision: 'pin' }))).status).toBe(400);
    expect((await POST(post({ artistId: 'a1', decision: 'pin', dsId: 'nope' }))).status).toBe(400);
    expect((await POST(post('{not json'))).status).toBe(400);
    expect(recordMock).not.toHaveBeenCalled();
  });

  it('rate limits per uid', async () => {
    rateLimitMock.mockResolvedValue({ allowed: false, limit: 120, remaining: 0, reset: 0 });
    const res = await POST(post({ artistId: 'a1', decision: 'pin' }));
    expect(res.status).toBe(429);
    expect(rateLimitMock).toHaveBeenCalledWith(expect.anything(), 'match-decision', UID);
    expect(recordMock).not.toHaveBeenCalled();
  });

  it('answers 503 when the store is unavailable', async () => {
    recordMock.mockResolvedValue(false);
    expect((await POST(post({ artistId: 'a1', decision: 'pin' }))).status).toBe(503);
  });
});

describe('DELETE /api/v1/match/decision', () => {
  it('removes the caller\'s decision for the artist', async () => {
    const res = await DELETE(del('?artistId=a1'));
    expect(res.status).toBe(204);
    expect(removeMock).toHaveBeenCalledWith(UID, 'a1');
  });

  it('requires artistId', async () => {
    expect((await DELETE(del(''))).status).toBe(400);
    expect(removeMock).not.toHaveBeenCalled();
  });

  it('requires auth', async () => {
    authMock.mockResolvedValue({ error: NextResponse.json({}, { status: 401 }) });
    expect((await DELETE(del('?artistId=a1'))).status).toBe(401);
  });
});
