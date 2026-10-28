// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { checkBudgetMock, recordSpendMock, fetchMock } = vi.hoisted(() => ({
  checkBudgetMock: vi.fn(),
  recordSpendMock: vi.fn(),
  fetchMock: vi.fn(),
}));

vi.mock('@/services/vectorDbService', () => ({
  searchSimilar: vi.fn(async () => []),
}));

vi.mock('@/services/embeddingService', () => ({
  generateQueryEmbedding: vi.fn(async () => new Array(768).fill(0.1)),
}));

vi.mock('@/features/match-pulse/services/neo4jService', () => ({
  findMatchingArtists: vi.fn(async () => [
    { id: 'kenji', name: 'Kenji Sato', city: 'Los Angeles', styles: ['Traditional'], rating: 5 },
    { id: 'noor', name: 'Noor Hale', city: 'Los Angeles', styles: ['Fine Line'], rating: 5 },
  ]),
  findArtistsByEmbeddingIds: vi.fn(async () => []),
  isNeo4jEnabled: vi.fn(() => true),
}));

vi.mock('@/lib/budget-tracker', () => ({
  checkBudget: checkBudgetMock,
  recordSpend: recordSpendMock,
}));

const ENV_KEYS = ['TYPESAFE_RERANK', 'TYPESAFE_API_KEY', 'TYPESAFE_TIMEOUT_MS'] as const;
const originalEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

function scorePayload(style: number, placement: number, subject: number) {
  const answer = (score: number) => ({ type: 'score', score, confidence: 0.4 });
  return {
    ok: true,
    status: 200,
    json: async () => ({
      model: 'jev-1.14.0',
      answers: { style: answer(style), placement: answer(placement), subject: answer(subject) },
    }),
    text: async () => '',
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(Math, 'random').mockReturnValue(0);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  for (const key of ENV_KEYS) delete process.env[key];
  checkBudgetMock.mockResolvedValue({ allowed: true, spentCents: 0, remainingCents: 100 });
  recordSpendMock.mockResolvedValue(undefined);
  fetchMock.mockImplementation(async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    const high = body.state.candidate.name === 'Noor Hale';
    return scorePayload(high ? 3 : 0, high ? 3 : 0, high ? 3 : 0);
  });
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    const previous = originalEnv[key];
    if (previous === undefined) delete process.env[key];
    else process.env[key] = previous;
  }
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('findMatchingArtists brief rerank', () => {
  const query = 'Fine-line botanical sprig on the inner forearm';

  it('keeps the style-score order when the flag is off', async () => {
    const { findMatchingArtists, clearCache } = await import('../hybridMatchService');
    clearCache();
    const result = await findMatchingArtists(query, { styles: ['Traditional'] }, 10);
    expect(result.matches.map((artist) => artist.id)).toEqual(['kenji', 'noor']);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('puts the brief-fit artist first when the flag is on', async () => {
    process.env.TYPESAFE_RERANK = 'true';
    process.env.TYPESAFE_API_KEY = 'ts_test_key_do_not_log';
    const { findMatchingArtists, clearCache } = await import('../hybridMatchService');
    clearCache();
    const result = await findMatchingArtists(query, { styles: ['Traditional'] }, 10);
    expect(result.matches.map((artist) => artist.id)).toEqual(['noor', 'kenji']);
    expect(result.matches[0].briefFit?.composite).toBeCloseTo(1);
    const body = JSON.parse(String(fetchMock.mock.calls[0][1].body));
    expect(body.state.brief.text).toBe(query);
    expect(body.state.brief.styles).toEqual(['Traditional']);
    expect(recordSpendMock).toHaveBeenCalledTimes(2);
  });
});
