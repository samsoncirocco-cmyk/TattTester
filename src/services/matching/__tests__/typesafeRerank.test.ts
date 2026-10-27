// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BRIEFS } from '../../../../scripts/fixtures/typesafe-rerank-briefs.js';
import { fitFromRawScores, rerankTopN, RERANK_WEIGHTS, scoreQuestions } from '../rerankOrder.js';

const { checkBudgetMock, recordSpendMock, infoMock, warnMock, fetchMock } = vi.hoisted(() => ({
  checkBudgetMock: vi.fn(),
  recordSpendMock: vi.fn(),
  infoMock: vi.fn(),
  warnMock: vi.fn(),
  fetchMock: vi.fn(),
}));

vi.mock('@/lib/budget-tracker', () => ({
  checkBudget: checkBudgetMock,
  recordSpend: recordSpendMock,
}));

vi.mock('@/lib/logger', () => ({
  logger: { info: infoMock, warn: warnMock, error: vi.fn(), debug: vi.fn() },
}));

import { searchDesignCandidates } from '../designSearch';
import {
  RERANK_COST_CENTS,
  TYPESAFE_SYSTEMONE_URL,
  artistCandidateProfile,
  buildPulseBrief,
  buildSemanticBrief,
  rerankArtistCandidates,
  resolveRerankTopN,
} from '../typesafeRerank';
import type { Design } from '@/services/designLibraryService';

const ENV_KEYS = [
  'TYPESAFE_RERANK',
  'TYPESAFE_API_KEY',
  'TYPESAFE_MODEL',
  'TYPESAFE_TIMEOUT_MS',
  'TYPESAFE_RERANK_TOP_N',
] as const;

const originalEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
const KEY = 'ts_test_key_do_not_log';

function restoreEnv(): void {
  for (const key of ENV_KEYS) {
    const previous = originalEnv[key];
    if (previous === undefined) delete process.env[key];
    else process.env[key] = previous;
  }
}

function enableRerank(): void {
  process.env.TYPESAFE_RERANK = 'true';
  process.env.TYPESAFE_API_KEY = KEY;
}

function jsonResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

function scorePayload(style: number, placement: number, subject: number) {
  const answer = (score: number) => ({ type: 'score', score, confidence: 0.4 });
  return {
    model: 'jev-1.14.0',
    answers: {
      style: answer(style),
      placement: answer(placement),
      subject: answer(subject),
    },
  };
}

const artists = [
  {
    id: 'kenji',
    name: 'Kenji Sato',
    styles: ['Traditional'],
    city: 'Los Angeles',
    portfolioImages: ['https://cdn.example/kenji.jpg'],
    claimedByUid: 'uid-secret',
    hourlyRate: 250,
  },
  { id: 'noor', name: 'Noor Hale', styles: ['Fine Line'], city: 'Los Angeles' },
  { id: 'alex', name: 'Alex Ruiz', styles: ['Blackwork'], city: 'Los Angeles' },
];

function loggedText(): string {
  return JSON.stringify(infoMock.mock.calls) + JSON.stringify(warnMock.mock.calls);
}

beforeEach(() => {
  for (const key of ENV_KEYS) delete process.env[key];
  checkBudgetMock.mockReset();
  recordSpendMock.mockReset();
  infoMock.mockReset();
  warnMock.mockReset();
  fetchMock.mockReset();
  checkBudgetMock.mockResolvedValue({ allowed: true, spentCents: 0, remainingCents: 100 });
  recordSpendMock.mockResolvedValue(undefined);
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  restoreEnv();
  vi.unstubAllGlobals();
});

describe('rerank weights', () => {
  it('weights sum to 1 and the offline fixtures reorder as published', () => {
    const sum = Object.values(RERANK_WEIGHTS).reduce((total, weight) => total + weight, 0);
    expect(sum).toBeCloseTo(1);

    for (const sample of BRIEFS) {
      const fits = sample.before.map((item: { id: string }) => fitFromRawScores(sample.mockedRaw[item.id]));
      const { items, applied } = rerankTopN(sample.before, fits, 20);
      expect(applied).toBe(true);
      expect(items.map((item: { id: string }) => item.id)).toEqual(sample.afterIds);
    }
  });

  it('keeps the original order when every composite ties', () => {
    const fits = artists.map(() => fitFromRawScores({ style: 1, placement: 1, subject: 1 }));
    const { items, applied } = rerankTopN(artists, fits, 20);
    expect(applied).toBe(true);
    expect(items.map((item) => item.id)).toEqual(['kenji', 'noor', 'alex']);
  });
});

describe('rerankArtistCandidates', () => {
  const brief = buildSemanticBrief('Fine-line botanical sprig on the inner forearm', {
    styles: ['Traditional'],
    location: 'Los Angeles',
    budget: 200,
  });

  it('returns the original order and does not call TypeSafe when the flag is off', async () => {
    const result = await rerankArtistCandidates(brief, artists);
    expect(result.map((artist) => artist.id)).toEqual(['kenji', 'noor', 'alex']);
    expect(result[0]).not.toHaveProperty('briefFit');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(checkBudgetMock).not.toHaveBeenCalled();
    expect(recordSpendMock).not.toHaveBeenCalled();
  });

  it('treats a malformed flag as off', async () => {
    process.env.TYPESAFE_RERANK = 'yes';
    process.env.TYPESAFE_API_KEY = KEY;
    const result = await rerankArtistCandidates(brief, artists);
    expect(result.map((artist) => artist.id)).toEqual(['kenji', 'noor', 'alex']);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns the original order when the key is missing', async () => {
    process.env.TYPESAFE_RERANK = 'true';
    const result = await rerankArtistCandidates(brief, artists);
    expect(result.map((artist) => artist.id)).toEqual(['kenji', 'noor', 'alex']);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(checkBudgetMock).not.toHaveBeenCalled();
  });

  it('returns the original order when the budget is spent or too small for the head', async () => {
    enableRerank();
    checkBudgetMock.mockResolvedValueOnce({ allowed: false, spentCents: 50000, remainingCents: 0 });
    const denied = await rerankArtistCandidates(brief, artists);
    expect(denied.map((artist) => artist.id)).toEqual(['kenji', 'noor', 'alex']);
    expect(fetchMock).not.toHaveBeenCalled();

    checkBudgetMock.mockResolvedValueOnce({ allowed: true, spentCents: 0, remainingCents: 1 });
    const short = await rerankArtistCandidates(brief, artists);
    expect(short.map((artist) => artist.id)).toEqual(['kenji', 'noor', 'alex']);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(recordSpendMock).not.toHaveBeenCalled();
  });

  it('reorders the head by weighted scores and meters one cent per 2xx', async () => {
    enableRerank();
    fetchMock.mockImplementation(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      const table: Record<string, [number, number, number]> = {
        'Kenji Sato': [0, 0, 0],
        'Noor Hale': [3, 3, 3],
        'Alex Ruiz': [1, 1, 0],
      };
      const scores = table[body.state.candidate.name];
      return jsonResponse(scorePayload(scores[0], scores[1], scores[2]));
    });

    const result = await rerankArtistCandidates(brief, artists);
    expect(result.map((artist) => artist.id)).toEqual(['noor', 'alex', 'kenji']);
    expect(result[0].briefFit?.composite).toBeCloseTo(1);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    for (const [url, init] of fetchMock.mock.calls) {
      expect(url).toBe(TYPESAFE_SYSTEMONE_URL);
      expect(init.method).toBe('POST');
      expect(init.headers).toMatchObject({
        Authorization: `Bearer ${KEY}`,
        'Content-Type': 'application/json',
      });
      const body = JSON.parse(String(init.body));
      expect(body.model).toBe('jev-latest');
      expect(body.questions).toEqual(scoreQuestions());
      expect(body.questions.style.options).toBeUndefined();
      expect(body.state.brief).toEqual(brief);
      expect(JSON.stringify(body.state.candidate)).not.toContain('cdn.example');
      expect(JSON.stringify(body.state.candidate)).not.toContain('uid-secret');
      expect(JSON.stringify(body.state.candidate)).not.toContain('hourlyRate');
    }
    expect(recordSpendMock).toHaveBeenCalledTimes(3);
    expect(recordSpendMock).toHaveBeenCalledWith(RERANK_COST_CENTS);
    expect(loggedText()).not.toContain(KEY);
  });

  it('scores only the configured head and leaves the tail in place', async () => {
    enableRerank();
    process.env.TYPESAFE_RERANK_TOP_N = '2';
    fetchMock.mockImplementation(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      const high = body.state.candidate.name === 'Noor Hale';
      return jsonResponse(scorePayload(high ? 3 : 0, high ? 3 : 0, high ? 3 : 0));
    });

    const result = await rerankArtistCandidates(brief, artists);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.map((artist) => artist.id)).toEqual(['noor', 'kenji', 'alex']);
    expect(result[2]).not.toHaveProperty('briefFit');
  });

  it('falls back to a top-N of 20 when the setting is outside 1..50', () => {
    process.env.TYPESAFE_RERANK_TOP_N = '100';
    expect(resolveRerankTopN()).toBe(20);
    process.env.TYPESAFE_RERANK_TOP_N = '0';
    expect(resolveRerankTopN()).toBe(20);
    delete process.env.TYPESAFE_RERANK_TOP_N;
    expect(resolveRerankTopN()).toBe(20);
    process.env.TYPESAFE_RERANK_TOP_N = '7';
    expect(resolveRerankTopN()).toBe(7);
  });

  it('sends the model override', async () => {
    enableRerank();
    process.env.TYPESAFE_MODEL = 'jev-1.14.0';
    fetchMock.mockResolvedValue(jsonResponse(scorePayload(1, 1, 1)));
    await rerankArtistCandidates(brief, [artists[0]]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse(String(fetchMock.mock.calls[0][1].body));
    expect(body.model).toBe('jev-1.14.0');
  });

  it('keeps the original order on timeout without metering', async () => {
    enableRerank();
    process.env.TYPESAFE_TIMEOUT_MS = '30';
    fetchMock.mockImplementation((_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
      const fail = () => {
        const error = new Error('The operation was aborted due to timeout');
        error.name = 'TimeoutError';
        reject(error);
      };
      if (init.signal?.aborted) fail();
      else init.signal?.addEventListener('abort', fail, { once: true });
    }));

    const result = await rerankArtistCandidates(brief, artists);
    expect(result.map((artist) => artist.id)).toEqual(['kenji', 'noor', 'alex']);
    expect(recordSpendMock).not.toHaveBeenCalled();
    expect(loggedText()).not.toContain(KEY);
  });

  it('keeps the original order on HTTP failure and does not log the body or the key', async () => {
    enableRerank();
    fetchMock.mockResolvedValue({
      ok: false,
      status: 502,
      text: async () => `upstream ${KEY}`,
      json: async () => ({}),
    });

    const result = await rerankArtistCandidates(brief, [artists[0]]);
    expect(result.map((artist) => artist.id)).toEqual(['kenji']);
    expect(recordSpendMock).not.toHaveBeenCalled();
    expect(loggedText()).not.toContain(KEY);
    expect(loggedText()).not.toContain('upstream');
  });

  it('meters an unparseable 2xx and still keeps the original order', async () => {
    enableRerank();
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => {
        throw new Error(`bad json ${KEY}`);
      },
      text: async () => 'not json',
    });

    const result = await rerankArtistCandidates(brief, [artists[0], artists[1]]);
    expect(result.map((artist) => artist.id)).toEqual(['kenji', 'noor']);
    expect(recordSpendMock).toHaveBeenCalledTimes(2);
    expect(loggedText()).not.toContain(KEY);
    expect(loggedText()).toContain('[redacted]');
  });

  it('discards a partial ranking when one candidate fails', async () => {
    enableRerank();
    fetchMock.mockImplementation(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      if (body.state.candidate.name === 'Noor Hale') {
        return jsonResponse(scorePayload(3, 3, 3));
      }
      return { ok: false, status: 500, text: async () => 'no', json: async () => ({}) };
    });

    const result = await rerankArtistCandidates(brief, [artists[0], artists[1]]);
    expect(result.map((artist) => artist.id)).toEqual(['kenji', 'noor']);
    expect(result[0]).not.toHaveProperty('briefFit');
    expect(recordSpendMock).toHaveBeenCalledTimes(1);
  });

  it('redacts the key when the transport error includes it', async () => {
    enableRerank();
    fetchMock.mockRejectedValue(new Error(`connect ${KEY} failed`));
    const result = await rerankArtistCandidates(brief, [artists[0]]);
    expect(result[0].id).toBe('kenji');
    expect(loggedText()).not.toContain(KEY);
    expect(loggedText()).toContain('[redacted]');
    expect(recordSpendMock).not.toHaveBeenCalled();
  });

  it('omits portfolio urls and claim ids from the artist profile', () => {
    const profile = artistCandidateProfile(artists[0]);
    expect(JSON.stringify(profile)).not.toContain('cdn.example');
    expect(JSON.stringify(profile)).not.toContain('uid-secret');
    expect(profile).toMatchObject({ name: 'Kenji Sato', styles: ['Traditional'], city: 'Los Angeles' });
  });
});

describe('searchDesignCandidates', () => {
  function design(id: string, subject: string, style: string, bodyPart: string): Design {
    return {
      id,
      imageUrl: `https://cdn.example/${id}.png`,
      metadata: { savedAt: '2026-01-01T00:00:00.000Z', prompt: `${style} ${subject} on the ${bodyPart}` },
      userInput: { subject, style, bodyPart },
      favorite: false,
      notes: '',
      tags: [],
    };
  }

  const designs = [
    design('wrist', 'raven quote', 'Script', 'wrist'),
    design('thigh', 'raven', 'Blackwork', 'thigh'),
    design('peony', 'peony', 'Traditional', 'arm'),
  ];

  it('keeps keyword order when the flag is off and drops non-matches', async () => {
    const result = await searchDesignCandidates('raven', designs);
    expect(result.map((item) => item.id)).toEqual(['wrist', 'thigh']);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reranks the keyword shortlist and does not send the image url', async () => {
    enableRerank();
    fetchMock.mockImplementation(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      const high = body.state.candidate.subject === 'raven';
      return jsonResponse(scorePayload(high ? 3 : 0, high ? 3 : 0, high ? 3 : 0));
    });

    const result = await searchDesignCandidates('raven', designs);
    expect(result.map((item) => item.id)).toEqual(['thigh', 'wrist']);
    expect(recordSpendMock).toHaveBeenCalledTimes(2);
    for (const [, init] of fetchMock.mock.calls) {
      const body = JSON.parse(String(init.body));
      expect(JSON.stringify(body.state.candidate)).not.toContain('cdn.example');
      expect(body.state.brief).toEqual({ text: 'raven' });
    }
  });
});

describe('brief builders', () => {
  it('carries the semantic query and the pulse prompt without the embedding', () => {
    expect(buildSemanticBrief('a koi', { styles: ['Japanese'], location: 'Austin', budget: 180 })).toEqual({
      text: 'a koi',
      styles: ['Japanese'],
      location: 'Austin',
      budget: 180,
    });
    expect(buildPulseBrief({
      prompt: 'koi on the calf',
      style: 'Japanese',
      bodyPart: 'calf',
      location: 'Austin',
      budget: 180,
      embeddingVector: [0.1, 0.2],
    })).toEqual({
      text: 'koi on the calf',
      style: 'Japanese',
      placement: 'calf',
      location: 'Austin',
      budget: 180,
    });
  });
});
