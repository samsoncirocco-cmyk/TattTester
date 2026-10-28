import { beforeEach, describe, expect, it, vi } from 'vitest';
import { POST } from '../route';
import { searchDesignCandidates } from '@/services/matching/designSearch';
import { NextResponse } from 'next/server';

const { authMock, rateLimitMock } = vi.hoisted(() => ({
  authMock: vi.fn(),
  rateLimitMock: vi.fn(),
}));
vi.mock('@/lib/api-auth', () => ({ verifyApiAuthWithUser: authMock }));
vi.mock('@/lib/rate-limit', () => ({
  rateLimit: rateLimitMock,
  rateLimitResponse: () => NextResponse.json({ error: 'Too Many Requests' }, { status: 429 }),
}));

vi.mock('@/services/matching/designSearch', () => ({
  searchDesignCandidates: vi.fn(async (_brief: string, designs: Array<{ id: string }>) => designs),
}));

const searchMock = vi.mocked(searchDesignCandidates);

function request(body: unknown) {
  return new Request('http://localhost/api/v1/designs/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }) as unknown as Parameters<typeof POST>[0];
}

beforeEach(() => {
  authMock.mockReset();
  authMock.mockResolvedValue({ error: null, user: { uid: 'u1' } });
  rateLimitMock.mockReset();
  rateLimitMock.mockResolvedValue({ allowed: true });
  searchMock.mockReset();
  searchMock.mockImplementation(async (_brief, designs) => designs);
});

describe('POST /api/v1/designs/search', () => {
  it('rejects an unauthenticated caller before any rerank', async () => {
    authMock.mockResolvedValueOnce({ error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }), user: null });
    const response = await POST(request({ brief: 'raven', designs: [{ id: 'a' }] }));
    expect(response.status).toBe(401);
    expect(searchMock).not.toHaveBeenCalled();
  });

  it('stops at the rate limit before any rerank', async () => {
    rateLimitMock.mockResolvedValueOnce({ allowed: false });
    const response = await POST(request({ brief: 'raven', designs: [{ id: 'a' }] }));
    expect(response.status).toBe(429);
    expect(searchMock).not.toHaveBeenCalled();
  });

  it('reranks the submitted shortlist and does not echo a provider key', async () => {
    searchMock.mockResolvedValueOnce([
      { id: 'b' },
      { id: 'a' },
    ] as never);

    const response = await POST(request({
      brief: 'fine line raven',
      designs: [
        { id: 'a', subject: 'tiger' },
        { id: 'b', subject: 'raven' },
      ],
    }));
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json.ids).toEqual(['b', 'a']);
    expect(searchMock).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(json)).not.toMatch(/api[_-]?key/i);
  });

  it('keeps the submitted order when rerank returns nothing usable', async () => {
    searchMock.mockRejectedValueOnce(new Error('down'));
    const response = await POST(request({
      brief: 'rose',
      designs: [{ id: 'a', subject: 'rose' }],
    }));
    const json = await response.json();
    expect(json).toEqual({ ids: ['a'], applied: false });
  });
});
