import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

const { resolveMock, dismissMock, verifyMock, rateLimitMock } = vi.hoisted(() => ({
  resolveMock: vi.fn(),
  dismissMock: vi.fn(),
  verifyMock: vi.fn(),
  rateLimitMock: vi.fn(),
}));

vi.mock('@/services/designSession', () => ({
  resolveDesignResume: resolveMock,
  dismissDesignResume: dismissMock,
}));

vi.mock('@/lib/api-auth', () => ({
  verifyApiAuthWithUser: verifyMock,
}));

vi.mock('@/lib/rate-limit', () => ({
  rateLimit: rateLimitMock,
  rateLimitResponse: () => NextResponse.json({ error: 'limited' }, { status: 429 }),
}));

vi.mock('@/lib/logger', () => ({
  createRequestLogger: () => ({
    start: vi.fn(),
    complete: vi.fn(),
    error: vi.fn(),
  }),
}));

import { GET, POST } from './route';

beforeEach(() => {
  resolveMock.mockReset();
  dismissMock.mockReset();
  verifyMock.mockReset();
  rateLimitMock.mockReset().mockResolvedValue({ allowed: true, limit: 60, remaining: 59, reset: 0 });
});

describe('GET /api/v1/design-session/resume', () => {
  it('does not require a token, and passes a hinted id through', async () => {
    resolveMock.mockResolvedValue(null);
    const res = await GET(
      new NextRequest('http://localhost/api/v1/design-session/resume?sessionId=sess-1')
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ resume: null });
    expect(verifyMock).not.toHaveBeenCalled();
    expect(resolveMock).toHaveBeenCalledWith({ uid: null, hintedSessionId: 'sess-1' });
  });

  it('refuses a bad bearer instead of treating it as anonymous', async () => {
    verifyMock.mockResolvedValue({
      error: NextResponse.json({ error: 'Invalid authorization token' }, { status: 401 }),
    });
    const res = await GET(
      new NextRequest('http://localhost/api/v1/design-session/resume', {
        headers: { authorization: 'Bearer nope' },
      })
    );
    expect(res.status).toBe(401);
    expect(resolveMock).not.toHaveBeenCalled();
  });

  it('uses the verified uid for the account lookup', async () => {
    verifyMock.mockResolvedValue({ error: null, user: { uid: 'uid-a' } });
    resolveMock.mockResolvedValue({ sessionId: 'sess-9', phase: 'picked' });
    const res = await GET(new NextRequest('http://localhost/api/v1/design-session/resume', {
      headers: { authorization: 'Bearer good' },
    }));
    expect(res.status).toBe(200);
    expect(resolveMock).toHaveBeenCalledWith({ uid: 'uid-a', hintedSessionId: null });
  });
});

describe('POST /api/v1/design-session/resume', () => {
  it('dismisses the session the caller named', async () => {
    const res = await POST(
      new NextRequest('http://localhost/api/v1/design-session/resume', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId: 'sess-1' }),
      })
    );
    expect(res.status).toBe(200);
    expect(dismissMock).toHaveBeenCalledWith({ uid: null, sessionId: 'sess-1' });
  });
});
