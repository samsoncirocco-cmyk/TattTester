// Seam tests for GET /api/v1/design-session/[id]: designSession service
// mocked; pins the read shape, the null → 404 mapping, and the auth gate.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';
import { makeGetRequest, makeSession, routeParams } from './helpers';

const { getSessionMock, rateLimitMock, rateLimitResponseMock, verifyApiAuthMock, verifyApiAuthWithUserMock } = vi.hoisted(() => ({
  getSessionMock: vi.fn(),
  verifyApiAuthWithUserMock: vi.fn(),
  rateLimitMock: vi.fn(),
  rateLimitResponseMock: vi.fn(),
  verifyApiAuthMock: vi.fn()
}));

vi.mock('@/services/designSession', () => ({
  startSession: vi.fn(),
  recordPick: vi.fn(),
  refine: vi.fn(),
  getSessionForResume: getSessionMock,
  DESIGN_SESSION_KEY_HEADER: 'x-design-session-key'
}));

vi.mock('@/lib/api-auth', () => ({
  verifyApiAuth: verifyApiAuthMock,
  verifyApiAuthWithUser: verifyApiAuthWithUserMock
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

import { GET } from '../[id]/route';

function signedIn(url: string) {
  return new NextRequest(url, { method: 'GET', headers: { Authorization: 'Bearer t' } });
}

const URL = 'http://localhost/api/v1/design-session/sess-1';

describe('GET /api/v1/design-session/[id] route adapter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    verifyApiAuthMock.mockResolvedValue(null);
    verifyApiAuthWithUserMock.mockResolvedValue({ error: null, user: { uid: 'uid-1' } });
    rateLimitMock.mockResolvedValue({ allowed: true });
  });

  it('returns the session', async () => {
    getSessionMock.mockResolvedValueOnce({ session: makeSession() });

    const res = await GET(signedIn(URL), routeParams('sess-1'));

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.session).toMatchObject({ id: 'sess-1', phase: 'revealed', provider: 'vertex-ai' });
    expect(getSessionMock).toHaveBeenCalledWith('sess-1', { uid: 'uid-1', resumeKey: null });
    // No resume view for a caller the service did not grant one.
    expect(json.resume).toBeUndefined();
  });

  it('returns 404 for an unknown session', async () => {
    getSessionMock.mockResolvedValueOnce(null);

    const res = await GET(
      signedIn('http://localhost/api/v1/design-session/nope'),
      routeParams('nope')
    );

    expect(res.status).toBe(404);
    const json = await res.json();
    expect(json.code).toBe('SESSION_NOT_FOUND');
  });

  it('also maps a thrown SESSION_NOT_FOUND to 404', async () => {
    getSessionMock.mockRejectedValueOnce(Object.assign(new Error('gone'), { code: 'SESSION_NOT_FOUND' }));

    const res = await GET(signedIn(URL), routeParams('sess-1'));

    expect(res.status).toBe(404);
  });

  it('returns the resume view beside the unchanged projection when the service grants it', async () => {
    const resume = { transcript: [{ role: 'user', text: 'a fox' }], stage: 'chatting' };
    getSessionMock.mockResolvedValueOnce({ session: makeSession(), resume });

    const res = await GET(signedIn(URL), routeParams('sess-1'));

    const json = await res.json();
    expect(json.session).toMatchObject({ id: 'sess-1' });
    expect(json.session.transcript).toBeUndefined();
    expect(json.resume).toEqual(resume);
    expect(res.headers.get('Cache-Control')).toContain('no-store');
  });

  it('lets a signed-out browser in with its resume key, and only with a matching one', async () => {
    const keyed = (key: string) =>
      new NextRequest(URL, { method: 'GET', headers: { 'x-design-session-key': key } });

    getSessionMock.mockResolvedValueOnce({ session: makeSession({ phase: 'intake' }), resume: { transcript: [] } });
    const ok = await GET(keyed('right-key'), routeParams('sess-1'));
    expect(ok.status).toBe(200);
    expect(getSessionMock).toHaveBeenLastCalledWith('sess-1', { uid: null, resumeKey: 'right-key' });
    expect(verifyApiAuthWithUserMock).not.toHaveBeenCalled();

    // Wrong key: the service grants no resume view, and a signed-out caller
    // gets nothing at all — 404, not the projection.
    getSessionMock.mockResolvedValueOnce({ session: makeSession({ phase: 'intake' }) });
    const wrong = await GET(keyed('wrong-key'), routeParams('sess-1'));
    expect(wrong.status).toBe(404);
  });

  it('refuses an invalid bearer token rather than downgrading it to anonymous', async () => {
    verifyApiAuthWithUserMock.mockResolvedValueOnce({
      error: NextResponse.json({ code: 'AUTH_INVALID' }, { status: 401 }),
    });
    const res = await GET(signedIn(URL), routeParams('sess-1'));
    expect(res.status).toBe(401);
    expect(getSessionMock).not.toHaveBeenCalled();
  });

  it('returns the auth failure untouched and never reaches the service', async () => {
    const denied = NextResponse.json({ error: 'Authorization header required', code: 'AUTH_REQUIRED' }, { status: 401 });
    verifyApiAuthMock.mockResolvedValueOnce(denied);

    const res = await GET(makeGetRequest(URL), routeParams('sess-1'));

    expect(res.status).toBe(401);
    expect(getSessionMock).not.toHaveBeenCalled();
  });

  // Setup runs inside the try, so a throwing dependency lands on the shared
  // structured envelope instead of escaping as an unstructured Next.js 500.
  it('returns the structured envelope when auth setup throws', async () => {
    verifyApiAuthMock.mockRejectedValueOnce(new Error('Firebase admin not configured'));

    const res = await GET(makeGetRequest(URL), routeParams('sess-1'));

    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ code: 'DESIGN_SESSION_FAILED', retryable: false });
    expect(getSessionMock).not.toHaveBeenCalled();
  });
});
