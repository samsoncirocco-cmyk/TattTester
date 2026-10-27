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

vi.mock('@/features/match-pulse/services/neo4jService', () => ({
  findArtistMatchesForPulse: vi.fn(async () => [
    { id: 'kenji', name: 'Kenji Sato', city: 'Los Angeles', styles: ['Traditional'], rating: 5 },
    { id: 'noor', name: 'Noor Hale', city: 'Los Angeles', styles: ['Fine Line'], rating: 5 },
  ]),
  getArtistsByIds: vi.fn(async () => []),
  isNeo4jEnabled: vi.fn(() => true),
}));

vi.mock('@/features/match-pulse/services/demoMatchService', () => ({
  findMatchingArtistsForDemo: vi.fn(async () => []),
}));

vi.mock('@/lib/budget-tracker', () => ({
  checkBudget: checkBudgetMock,
  recordSpend: recordSpendMock,
}));

const ENV_KEYS = ['TYPESAFE_RERANK', 'TYPESAFE_API_KEY'];
const originalEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

function scorePayload(style, placement, subject) {
  const answer = (score) => ({ type: 'score', score, confidence: 0.4 });
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
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  for (const key of ENV_KEYS) delete process.env[key];
  checkBudgetMock.mockResolvedValue({ allowed: true, spentCents: 0, remainingCents: 100 });
  recordSpendMock.mockResolvedValue(undefined);
  fetchMock.mockImplementation(async (_url, init) => {
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

describe('getHybridArtistMatches brief rerank', () => {
  const context = {
    style: 'Traditional',
    bodyPart: 'forearm',
    prompt: 'Fine-line botanical sprig on the inner forearm',
    embeddingVector: [0.2, 0.4],
  };

  it('keeps the fusion order when the flag is off', async () => {
    const { getHybridArtistMatches } = await import('../matchService.js');
    const result = await getHybridArtistMatches(context, { limit: 10 });
    expect(result.matches.map((artist) => artist.id)).toEqual(['kenji', 'noor']);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reorders by the design brief when the flag is on and leaves the embedding out of state', async () => {
    process.env.TYPESAFE_RERANK = 'true';
    process.env.TYPESAFE_API_KEY = 'ts_test_key_do_not_log';
    const { getHybridArtistMatches } = await import('../matchService.js');
    const result = await getHybridArtistMatches(context, { limit: 10 });
    expect(result.matches.map((artist) => artist.id)).toEqual(['noor', 'kenji']);
    const body = JSON.parse(String(fetchMock.mock.calls[0][1].body));
    expect(body.state.brief).toEqual({
      text: context.prompt,
      style: 'Traditional',
      placement: 'forearm',
      location: null,
      budget: null,
    });
    expect(JSON.stringify(body)).not.toContain('embeddingVector');
    expect(recordSpendMock).toHaveBeenCalledTimes(2);
  });
});
