import { beforeEach, describe, expect, it, vi } from 'vitest';
import { POST } from '../route';
import { searchDesignCandidates } from '@/services/matching/designSearch';

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
  searchMock.mockReset();
  searchMock.mockImplementation(async (_brief, designs) => designs);
});

describe('POST /api/v1/designs/search', () => {
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
