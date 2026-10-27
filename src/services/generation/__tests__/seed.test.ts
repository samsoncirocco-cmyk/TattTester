/**
 * Spec 12 at the generation seam: a seed reaches only the lanes that take
 * one, a seeded fan-out never sends one seed twice, and a text-guard re-roll
 * moves to the next seed so it cannot redraw the lettered picture it is
 * replacing. Fetch is stubbed; nothing reaches a provider.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/google-auth-edge', () => ({ getGcpAccessToken: vi.fn().mockResolvedValue('t') }));
vi.mock('@/lib/observability', () => ({ logEvent: vi.fn() }));
vi.mock('../internal/textGuard', () => ({ screenForText: vi.fn() }));

import { generate, rerollRequest } from '../index';
import { modelTakesSeed } from '../capabilities';
import { screenForText } from '../internal/textGuard';

const mockScreen = vi.mocked(screenForText);
const CLEAN = { intruded: false, words: [], screened: true };
const LETTERED = { intruded: true, words: ['GOKU'], screened: true };

function replicateResponse(n: number) {
  return {
    ok: true,
    json: async () => ({ id: `pred_${n}`, status: 'succeeded', output: [`https://img.example/${n}.png`] }),
  };
}

let fetchMock: ReturnType<typeof vi.fn>;
let served = 0;
const sentSeeds = () =>
  fetchMock.mock.calls.map(([, init]) => JSON.parse(init.body).input.seed as number | undefined);

beforeEach(() => {
  served = 0;
  fetchMock = vi.fn(async () => replicateResponse(++served));
  vi.stubGlobal('fetch', fetchMock);
  vi.stubEnv('REPLICATE_API_TOKEN', 'r8_test');
  mockScreen.mockResolvedValue(CLEAN);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe('which lanes take a seed', () => {
  it.each(['flux-dev', 'flux-schnell', 'krea2'])('%s receives and reports it', async (modelId) => {
    const result = await generate({ prompt: 'a fox', modelId, seed: 482910 });
    expect(sentSeeds()).toEqual([482910]);
    expect(result.metadata.seed).toBe(482910);
  });

  it('nano-banana-2 is never sent one and reports none', async () => {
    const result = await generate({ prompt: 'a fox', modelId: 'nano-banana-2', seed: 482910 });
    expect(sentSeeds()).toEqual([undefined]);
    expect(result.metadata.seed).toBeUndefined();
  });

  it('the capability answer matches the provider, Vertex included', () => {
    expect(modelTakesSeed('flux-dev')).toBe(true);
    expect(modelTakesSeed('flux-schnell')).toBe(true);
    expect(modelTakesSeed('krea2')).toBe(true);
    expect(modelTakesSeed('nano-banana-2')).toBe(false);
    expect(modelTakesSeed('imagen3')).toBe(false);
  });

  it('a seeded Krea fan-out steps the seed per prediction', async () => {
    await generate({ prompt: 'a fox', modelId: 'krea2', seed: 10, numImages: 3 });
    expect(sentSeeds()).toEqual([10, 11, 12]);
  });
});

describe('the text-guard re-roll varies a fixed seed', () => {
  it('re-rolls on the next seed and reports the seed of the kept attempt', async () => {
    mockScreen.mockResolvedValueOnce(LETTERED).mockResolvedValueOnce(CLEAN);

    const result = await generate({
      prompt: 'a fox',
      modelId: 'flux-dev',
      seed: 100,
      screenText: {},
    });

    expect(sentSeeds()).toEqual([100, 101]);
    expect(result.metadata.textGuardRerolls).toBe(1);
    expect(result.metadata.seed).toBe(101);
  });

  it('an unseeded request re-rolls unchanged, relying on provider randomness as before', () => {
    const request = { prompt: 'a fox' };
    expect(rerollRequest(request, 1)).toBe(request);
  });

  it('wraps inside the 31-bit range', () => {
    expect(rerollRequest({ prompt: 'p', seed: 2 ** 31 - 1 }, 1).seed).toBe(0);
  });
});
