/**
 * Spec 12: every cut records the lane that actually drew it and, on a lane
 * that honors one, the seed it was drawn with. Both travel in the staged
 * object's metadata so a retry that reuses a staged render keeps them, the
 * same way the downgrade reason already does. Every paid boundary is mocked.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { startSession, recordRoundPick, refineRound } from '../index';
import { clearMemorySessions } from '../internal/store';
import { seedFor } from '../internal/seed';
import { extractIntake } from '../../intake';
import { enhanceStructured, enhanceRound } from '../../council';
import { generate, routeGeneration } from '../../generation';
import type { GenerationRequest } from '../../generation';
import {
  copyImageToPath,
  recoverImageAtPath,
  uploadImageToPath,
} from '@/services/storage/imageStorageService';
import { recordSpend } from '@/lib/budget-tracker';
import type { IntakeRecord } from '../../intake/types';

vi.mock('../../intake', () => ({ extractIntake: vi.fn() }));
vi.mock('../../council', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  enhanceStructured: vi.fn(),
  enhanceRound: vi.fn(),
}));
vi.mock('../../generation', () => ({ generate: vi.fn(), routeGeneration: vi.fn() }));
vi.mock('@/lib/firebase-admin', () => ({ ensureAdminApp: vi.fn(() => false) }));
vi.mock('@/services/storage/imageStorageService', () => ({
  recoverImageAtPath: vi.fn(),
  copyImageToPath: vi.fn(),
  uploadImageToPath: vi.fn(),
}));
vi.mock('@/services/gcs-service', () => ({
  getSignedUrl: vi.fn(async (path: string) => `https://signed.test/${path}`),
  uploadToGCS: vi.fn(),
  signingBucketName: vi.fn(() => 'tatt-pro-assets'),
}));
vi.mock('@/lib/budget-tracker', () => ({ recordSpend: vi.fn(), VERTEX_IMAGEN_COST_CENTS: 4 }));
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  createRequestLogger: vi.fn(),
}));

const mockGenerate = vi.mocked(generate);
const mockCopy = vi.mocked(copyImageToPath);
const mockRecover = vi.mocked(recoverImageAtPath);
const BUCKET_URL = 'https://storage.googleapis.com/tatt-pro-assets';

const intakeRecord: IntakeRecord = {
  placement: 'ribs',
  styleTags: ['fine-line'],
  meaning: 'a sparrow',
  references: [],
  ambiguousAxes: ['bold-fine'],
};

const twoCuts = (axis: string) => ({
  axisSelection: { mode: 'questionnaire' as const, axes: [axis as 'bold-fine'], rationale: 't' },
  variations: [
    { axisPosition: { [axis]: 'a' }, prompts: { detailed: `${axis}-1` }, negativePrompt: 'n' },
    { axisPosition: { [axis]: 'b' }, prompts: { detailed: `${axis}-2` }, negativePrompt: 'n' },
  ],
});

function route(modelId: string) {
  return {
    modelId,
    provider: 'replicate' as const,
    aspectRatio: '9:16' as const,
    negativePrompt: '',
    fallbackChain: [],
    reasoning: 'test',
  };
}

/** A provider that echoes what a real one reports: the seed only if sent. */
function serve(overrides: Partial<{ model: string; fallbackUsed: boolean; fallbackReason: string }> = {}) {
  let n = 0;
  mockGenerate.mockImplementation(async (request: GenerationRequest) => ({
    images: [`https://replicate.delivery/pbxt/${++n}/out.png`],
    metadata: {
      model: overrides.model ?? request.modelId ?? 'unknown',
      provider: 'replicate' as const,
      generatedAt: new Date().toISOString(),
      durationMs: 1,
      attempts: 1,
      fallbackUsed: overrides.fallbackUsed ?? false,
      ...(overrides.fallbackReason ? { fallbackReason: overrides.fallbackReason } : {}),
      ...(request.seed !== undefined ? { seed: request.seed } : {}),
    },
  }));
}

const start = () => startSession({ placementAnswer: 'ribs', meaningAnswer: 'sparrow' });

beforeEach(() => {
  vi.clearAllMocks();
  clearMemorySessions();
  vi.mocked(extractIntake).mockResolvedValue(intakeRecord);
  vi.mocked(enhanceStructured).mockResolvedValue(twoCuts('bold-fine'));
  vi.mocked(enhanceRound).mockImplementation(async (_record, spread) => twoCuts(spread.axis));
  vi.mocked(routeGeneration).mockReturnValue(route('flux-dev'));
  mockRecover.mockResolvedValue(null);
  mockCopy.mockImplementation(async (path) => `${BUCKET_URL}/${path}`);
  vi.mocked(uploadImageToPath).mockImplementation(async (path) => `${BUCKET_URL}/${path}`);
  vi.mocked(recordSpend).mockResolvedValue(undefined);
  serve();
});

describe('a Flux pin is seeded and records lane and seed', () => {
  it('sends seedFor(session, cut) and stores it on each cut, in staged metadata too', async () => {
    const session = await start();

    const seeds = mockGenerate.mock.calls.map(([request]) => request.seed);
    expect(seeds).toEqual([seedFor(session.id, 'v1'), seedFor(session.id, 'v2')]);
    expect(session.variations.map(({ lane, seed }) => ({ lane, seed }))).toEqual([
      { lane: 'flux-dev', seed: seedFor(session.id, 'v1') },
      { lane: 'flux-dev', seed: seedFor(session.id, 'v2') },
    ]);
    // Staged with the object, so a reuse can recover it.
    expect(mockCopy.mock.calls[0][2]).toMatchObject({
      lane: 'flux-dev',
      seed: String(seedFor(session.id, 'v1')),
    });
  });

  it('a refine round seeds its cuts on their own ids', async () => {
    const session = await start();
    await recordRoundPick(session.id, { pickedId: 'v1' });
    const { session: next } = await refineRound(session.id);

    expect(next.variations[2]).toMatchObject({ lane: 'flux-dev', seed: seedFor(session.id, 'v3') });
    expect(next.variations[3]).toMatchObject({ lane: 'flux-dev', seed: seedFor(session.id, 'v4') });
  });
});

describe('a lane without a seed', () => {
  it('nano-banana-2 is sent no seed and stores none, but records its lane', async () => {
    vi.mocked(routeGeneration).mockReturnValue(route('nano-banana-2'));
    const session = await start();

    for (const [request] of mockGenerate.mock.calls) expect(request.seed).toBeUndefined();
    expect(session.variations[0].lane).toBe('nano-banana-2');
    expect(session.variations[0].seed).toBeUndefined();
  });
});

describe('the lane that actually drew the cut', () => {
  it('after a downgrade, the cut names the fallback lane, not the pin', async () => {
    serve({ model: 'flux-schnell', fallbackUsed: true, fallbackReason: 'REPLICATE_ERROR' });
    const session = await start();

    expect(session.downgraded).toBe(true);
    expect(session.variations[0].lane).toBe('flux-schnell');
    expect(mockCopy.mock.calls[0][2]).toMatchObject({
      lane: 'flux-schnell',
      downgradeReason: 'REPLICATE_ERROR',
    });
  });

  it('a reused staged render restores lane, seed and the downgrade from its metadata', async () => {
    mockRecover.mockResolvedValue({
      imageUrl: `${BUCKET_URL}/staged.png`,
      metadata: { lane: 'flux-schnell', seed: '77', downgradeReason: 'REPLICATE_ERROR' },
    });
    const session = await start();

    expect(mockGenerate).not.toHaveBeenCalled();
    expect(session.variations[0]).toMatchObject({ lane: 'flux-schnell', seed: 77 });
    expect(session.downgraded).toBe(true);
  });

  it('a staged object from before provenance falls back to the requested model and no seed', async () => {
    mockRecover.mockResolvedValue({ imageUrl: `${BUCKET_URL}/old.png`, metadata: {} });
    const session = await start();

    expect(session.variations[0].lane).toBe('flux-dev');
    expect(session.variations[0].seed).toBeUndefined();
  });
});
