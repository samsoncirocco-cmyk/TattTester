import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const { findMatchingArtistsMock, verifyApiAuthMock } = vi.hoisted(() => ({
  findMatchingArtistsMock: vi.fn(),
  verifyApiAuthMock: vi.fn(),
}));

vi.mock('@/features/match-pulse/services/hybridMatchService', () => ({
  findMatchingArtists: findMatchingArtistsMock,
}));
vi.mock('@/lib/api-auth', () => ({ verifyApiAuth: verifyApiAuthMock }));

import { POST } from './route';

function makeRequest(body: unknown) {
  return new NextRequest('http://localhost/api/v1/match/semantic', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  verifyApiAuthMock.mockResolvedValue(null);
  findMatchingArtistsMock.mockResolvedValue({
    matches: [],
    broadened: [],
    totalCandidates: 0,
    queryInfo: { query: '', visualConcepts: [], keywords: [], vectorResultCount: 0, graphResultCount: 0, degraded: true, graphSource: 'mock' },
    performance: { totalTime: 1, vectorTime: 0, mergeTime: 0 },
  });
});

describe('POST /api/v1/match/semantic (#363)', () => {
  it('passes canonical styles to the matcher, not the raw spellings', async () => {
    const res = await POST(makeRequest({
      query: 'irezumi sleeve',
      style_preferences: ['japanese-irezumi', 'old school'],
      location: 'Austin',
      budget: 200,
      radius: 40,
      max_results: 8,
      has_portfolio: true,
    }));

    expect(res.status).toBe(200);
    expect(findMatchingArtistsMock).toHaveBeenCalledWith(
      'irezumi sleeve',
      {
        location: 'Austin',
        styles: ['Japanese', 'Traditional'],
        budget: 200,
        distance: 40,
        hasPortfolio: true,
      },
      8
    );
  });

  it('does not search when every style is outside the vocabulary', async () => {
    const res = await POST(makeRequest({
      query: 'a dagger',
      style_preferences: ['Vaporwave'],
    }));

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: 'UNKNOWN_STYLES' });
    expect(findMatchingArtistsMock).not.toHaveBeenCalled();
  });
});
