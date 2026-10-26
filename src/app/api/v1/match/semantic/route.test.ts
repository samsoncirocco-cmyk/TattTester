// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

const { authMock, rateLimitMock, findMock } = vi.hoisted(() => ({
  authMock: vi.fn(),
  rateLimitMock: vi.fn(),
  findMock: vi.fn(),
}));

vi.mock('@/lib/api-auth', () => ({ verifyApiAuthWithUser: authMock }));
vi.mock('@/lib/rate-limit', () => ({
  rateLimit: rateLimitMock,
  rateLimitResponse: () => NextResponse.json({ error: 'Too Many Requests' }, { status: 429 }),
}));
vi.mock('@/features/match-pulse/services/hybridMatchService', () => ({
  findMatchingArtists: findMock,
}));

import { POST } from './route';
import { validatePreferences } from './validate';

const UID = 'uid-1';

function post(body: unknown) {
  return new NextRequest('http://localhost/api/v1/match/semantic', {
    method: 'POST',
    headers: { authorization: 'Bearer t', 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  authMock.mockResolvedValue({ error: null, user: { uid: UID } });
  rateLimitMock.mockResolvedValue({ allowed: true, limit: 100, remaining: 1, reset: 0 });
  findMock.mockResolvedValue({
    matches: [],
    broadened: [],
    totalCandidates: 0,
    queryInfo: { graphSource: 'live' },
  });
});

describe('validatePreferences', () => {
  it('rejects budget 0, negative, NaN and 5000; accepts the range', () => {
    expect(validatePreferences({ budget: 0 }).ok).toBe(false);
    expect(validatePreferences({ budget: -5 }).ok).toBe(false);
    expect(validatePreferences({ budget: Number.NaN }).ok).toBe(false);
    expect(validatePreferences({ budget: 5000 }).ok).toBe(false);
    expect(validatePreferences({ budget: '150' }).ok).toBe(false);
    expect(validatePreferences({ budget: 150 })).toMatchObject({ ok: true, budget: 150 });
  });

  it('rejects radius out of range and keeps the default when absent', () => {
    expect(validatePreferences({ radius: 0 }).ok).toBe(false);
    expect(validatePreferences({ radius: 501 }).ok).toBe(false);
    expect(validatePreferences({ radius: 'near' }).ok).toBe(false);
    expect(validatePreferences({})).toMatchObject({ ok: true, radius: 25, budget: null, hasPortfolio: false });
  });

  it('requires has_portfolio to be a boolean', () => {
    expect(validatePreferences({ has_portfolio: 'yes' }).ok).toBe(false);
    expect(validatePreferences({ has_portfolio: 1 }).ok).toBe(false);
    expect(validatePreferences({ has_portfolio: true })).toMatchObject({ ok: true, hasPortfolio: true });
  });
});

describe('POST /api/v1/match/semantic', () => {
  it('passes validated values into findMatchingArtists', async () => {
    const res = await POST(
      post({ query: 'blackwork', style_preferences: ['Blackwork'], budget: 250, has_portfolio: true, max_results: 20 }),
    );
    expect(res.status).toBe(200);
    expect(findMock).toHaveBeenCalledWith(
      'blackwork',
      { location: null, styles: ['Blackwork'], budget: 250, distance: 25, hasPortfolio: true },
      20,
    );
  });

  it('answers 400 INVALID_PREFERENCES with the reason instead of clamping', async () => {
    const res = await POST(post({ query: 'x', budget: 5000 }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe('INVALID_PREFERENCES');
    expect(body.error).toMatch(/budget/);
    expect(findMock).not.toHaveBeenCalled();
  });

  it('applies the semantic-match limiter per uid', async () => {
    rateLimitMock.mockResolvedValue({ allowed: false, limit: 100, remaining: 0, reset: 0 });
    const res = await POST(post({ query: 'x' }));
    expect(res.status).toBe(429);
    expect(rateLimitMock).toHaveBeenCalledWith(expect.anything(), 'semantic-match', UID);
    expect(findMock).not.toHaveBeenCalled();
  });

  it('requires auth', async () => {
    authMock.mockResolvedValue({ error: NextResponse.json({}, { status: 401 }) });
    expect((await POST(post({ query: 'x' }))).status).toBe(401);
  });
});
