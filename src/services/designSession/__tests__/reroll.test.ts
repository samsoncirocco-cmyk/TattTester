/**
 * The re-roll round (sprint fix #2, session 0f6234e9): "new ones / new
 * samples" rejects the whole live set and draws two fresh cuts on the SAME
 * axis — no pick required, no pick recorded on the rejected round (absence
 * of pick = the signal, ADR-0049), one generation credit, same claim gate
 * and no-partial-charge rules as refineRound, and the same reference
 * inputs the rejected round used (a prior round's frozen pick still leads,
 * the customer's photos persist — the rejected cuts seed nothing).
 *
 * Same seams as rounds.test.ts: every module boundary is mocked,
 * persistence runs on the in-memory store.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { DEMO_MOCK_IMAGES } from '@/lib/demo-images';
import {
  startSession,
  recordRoundPick,
  refineRound,
  rerollRound,
  getSession,
} from '../index';
import { memorySessionStore, clearMemorySessions } from '../internal/store';
import type { StoredSession } from '../internal/store';
import { extractIntake } from '../../intake';
import { enhanceStructured, enhanceRound } from '../../council';
import { generate, routeGeneration } from '../../generation';
import {
  copyImageToPath,
  recoverImageAtPath,
  uploadImageToPath,
} from '@/services/storage/imageStorageService';
import { getSignedUrl } from '@/services/gcs-service';
import { recordSpend } from '@/lib/budget-tracker';
import type { IntakeRecord } from '../../intake/types';

vi.mock('../../intake', () => ({ extractIntake: vi.fn() }));
vi.mock('../../council', () => ({ enhanceStructured: vi.fn(), enhanceRound: vi.fn() }));
vi.mock('../../generation', () => ({ generate: vi.fn(), routeGeneration: vi.fn() }));
vi.mock('@/lib/firebase-admin', () => ({ ensureAdminApp: vi.fn(() => false) }));
vi.mock('@/services/storage/imageStorageService', () => ({
  recoverImageAtPath: vi.fn(),
  copyImageToPath: vi.fn(),
  uploadImageToPath: vi.fn(),
}));
// The ADR-0050/#333 signed-URL plumbing a leading cut rides on. The signing
// bucket matches the fixture bucket, same as rounds.test.ts.
vi.mock('@/services/gcs-service', () => ({
  getSignedUrl: vi.fn(async (path: string) => `https://signed.test/${path}`),
  uploadToGCS: vi.fn(),
  signingBucketName: vi.fn(() => 'tatt-pro-assets'),
}));
vi.mock('@/lib/budget-tracker', () => ({
  recordSpend: vi.fn(),
  VERTEX_IMAGEN_COST_CENTS: 4,
}));

const mockExtractIntake = vi.mocked(extractIntake);
const mockEnhanceStructured = vi.mocked(enhanceStructured);
const mockEnhanceRound = vi.mocked(enhanceRound);
const mockGenerate = vi.mocked(generate);
const mockRouteGeneration = vi.mocked(routeGeneration);
const mockRecoverImageAtPath = vi.mocked(recoverImageAtPath);
const mockCopyImageToPath = vi.mocked(copyImageToPath);
const mockUploadImageToPath = vi.mocked(uploadImageToPath);
const mockGetSignedUrl = vi.mocked(getSignedUrl);
vi.mocked(recordSpend).mockResolvedValue(undefined);

/** Where a durable copy lands — the shape imageStorageService returns. */
const BUCKET_URL = 'https://storage.googleapis.com/tatt-pro-assets';
const durableUrl = (objectPath: string) => `${BUCKET_URL}/${objectPath}`;

const intakeRecord: IntakeRecord = {
  placement: 'ribs',
  styleTags: ['fine-line'],
  meaning: 'a sparrow for my grandmother, exactly as I said it',
  references: [],
  ambiguousAxes: ['bold-fine', 'color-blackwork'],
};

/** Council round one: two cuts on the ladder's first axis (ADR-0049). */
const roundOneEnhance = {
  axisSelection: {
    mode: 'questionnaire' as const,
    axes: ['bold-fine' as const],
    rationale: 'round one spreads the first ladder rung',
  },
  variations: [
    {
      axisPosition: { 'bold-fine': 'bold' },
      prompts: { detailed: 'd1' },
      negativePrompt: 'n1',
    },
    {
      axisPosition: { 'bold-fine': 'fine' },
      prompts: { detailed: 'd2' },
      negativePrompt: 'n2',
    },
  ],
};

/** What the council hands a later round: the spread axis + locked poles. */
function roundEnhance(axis: string, lockedPoles: Record<string, string>) {
  const poles =
    axis === 'reroll'
      ? [lockedPoles, lockedPoles]
      : [
          { [axis]: axis.split('-')[0], ...lockedPoles },
          { [axis]: axis.split('-')[1], ...lockedPoles },
        ];
  return {
    axisSelection: {
      mode: 'questionnaire' as const,
      axes: axis === 'reroll' ? [] : [axis as 'bold-fine'],
      rationale: 'test round',
    },
    variations: poles.map((axisPosition, index) => ({
      axisPosition,
      prompts: { detailed: `${axis}-d${index + 1}` },
      negativePrompt: `${axis}-n${index + 1}`,
    })),
  };
}

const vertexRoute = {
  modelId: 'imagen3',
  provider: 'vertex-ai' as const,
  aspectRatio: '9:16' as const,
  negativePrompt: '',
  fallbackChain: [],
  reasoning: 'test route',
};

let imageCounter = 0;

/** A successful generate() answer on the pinned model. */
function generatedImage(modelId?: string) {
  return {
    images: [`https://replicate.delivery/pbxt/${++imageCounter}/out.png`],
    metadata: {
      model: modelId ?? 'unknown',
      provider: 'vertex-ai' as const,
      generatedAt: new Date().toISOString(),
      durationMs: 1,
      attempts: 1,
      fallbackUsed: false,
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  clearMemorySessions();
  imageCounter = 0;

  mockExtractIntake.mockResolvedValue(intakeRecord);
  mockEnhanceStructured.mockResolvedValue(roundOneEnhance);
  mockEnhanceRound.mockImplementation(async (_record, spread) =>
    roundEnhance(spread.axis, spread.lockedPoles as Record<string, string>)
  );
  mockRouteGeneration.mockReturnValue(vertexRoute);
  mockRecoverImageAtPath.mockResolvedValue(null);
  mockCopyImageToPath.mockImplementation(async objectPath => durableUrl(objectPath));
  mockUploadImageToPath.mockImplementation(async objectPath => durableUrl(objectPath));
  mockGetSignedUrl.mockImplementation(async (path: string) => `https://signed.test/${path}`);
  mockGenerate.mockImplementation(async request => generatedImage(request.modelId));
});

afterEach(() => {
  delete process.env.NEXT_PUBLIC_DEMO_MODE;
});

const startRequest = { placementAnswer: 'on my ribs', meaningAnswer: 'a sparrow' };

describe('rerollRound — reject the set, draw fresh on the same axis', () => {
  it('re-rolls the reveal without any pick: same axis, fresh cuts, no pick recorded', async () => {
    const session = await startSession(startRequest);
    const { session: next, round } = await rerollRound(session.id);

    // SAME axis as the rejected round — its question was never answered —
    // with nothing locked: round one's set was refused whole.
    expect(mockEnhanceRound).toHaveBeenCalledWith(intakeRecord, {
      roundNumber: 2,
      axis: 'bold-fine',
      lockedPoles: {},
    });
    expect(round).toMatchObject({ round: 2, axis: 'bold-fine', variationIds: ['v3', 'v4'] });
    expect(next.variations.map(v => v.id)).toEqual(['v1', 'v2', 'v3', 'v4']);
    // The rejected round keeps NO pick — the absence IS the signal — and
    // does not freeze: no render consumed a pick from it.
    expect(next.rounds?.[0].pickedId).toBeUndefined();
    expect(next.rounds?.[0].frozen).toBeUndefined();
    // Two fresh renders on the pinned model, loud-downgrade opted in.
    expect(mockGenerate).toHaveBeenCalledTimes(4); // 2 reveal + 2 re-roll
    for (const [request] of mockGenerate.mock.calls.slice(2)) {
      expect(request.modelId).toBe('imagen3');
      expect(request.allowProviderFallback).toBe(true);
    }
  });

  it('unrecords a stray pick on the rejected round — it locks nothing later', async () => {
    const session = await startSession(startRequest);
    // The customer tapped v2, then changed their mind: "no — new ones".
    await recordRoundPick(session.id, { pickedId: 'v2' });
    const { session: next } = await rerollRound(session.id);

    // No pole locked from the rejected round…
    expect(mockEnhanceRound).toHaveBeenCalledWith(intakeRecord, {
      roundNumber: 2,
      axis: 'bold-fine',
      lockedPoles: {},
    });
    // …and the stray pick is gone from the record: absence is the signal.
    expect(next.rounds?.[0].pickedId).toBeUndefined();
    expect(next.rounds?.[0].pickedAt).toBeUndefined();
    // The rejected cuts seed nothing: no reference signing happened at all
    // (the picked cut would otherwise lead).
    expect(mockGetSignedUrl).not.toHaveBeenCalled();
    for (const [request] of mockGenerate.mock.calls.slice(2)) {
      expect(request.referenceImages).toBeUndefined();
    }
  });

  it('seeds from the same references the rejected round used — prior pick leads, photos persist', async () => {
    const session = await startSession(startRequest);

    // Attach a customer reference photo the way the conversation does.
    const stored = (await memorySessionStore.get(session.id)) as StoredSession;
    stored.conversation = {
      transcript: [],
      turnCount: 0,
      record: {},
      turnLogs: [],
      stage: 'chatting',
      references: [
        {
          id: 'ref-1',
          source: 'web',
          summary: 'their own sparrow photo',
          subjects: [],
          characters: [],
          styleTags: [],
          styleDescriptors: [],
          palette: [],
          composition: '',
          confidence: 1,
          createdAt: new Date().toISOString(),
          imagePath: `design-sessions/${session.id}/references/photo.jpg`,
        },
      ],
    };
    await memorySessionStore.save(stored);

    // Round 1 picked v2; round 2 rendered from it and is now rejected.
    await recordRoundPick(session.id, { pickedId: 'v2' });
    await refineRound(session.id);
    mockGetSignedUrl.mockClear();
    const { round } = await rerollRound(session.id);

    // Round 3 re-asks round 2's axis, holding round 1's frozen pole.
    expect(mockEnhanceRound).toHaveBeenLastCalledWith(intakeRecord, {
      roundNumber: 3,
      axis: 'color-blackwork',
      lockedPoles: { 'bold-fine': 'fine' },
    });
    expect(round).toMatchObject({ round: 3, axis: 'color-blackwork', variationIds: ['v5', 'v6'] });

    // Reference parity with the rejected round: round 1's picked cut (v2)
    // still LEADS and the photo persists — v3/v4 (the rejected cuts) seed
    // nothing.
    const pickedUrl = stored.variations[1].imageUrl!;
    const pickedPath = pickedUrl.replace(`${BUCKET_URL}/`, '');
    expect(mockGetSignedUrl.mock.calls.map(([path]) => path)).toEqual([
      pickedPath,
      `design-sessions/${session.id}/references/photo.jpg`,
    ]);
    for (const [request] of mockGenerate.mock.calls.slice(4)) {
      expect(request.referenceImages).toEqual([
        `https://signed.test/${pickedPath}`,
        `https://signed.test/design-sessions/${session.id}/references/photo.jpg`,
      ]);
    }
  });

  it('threads an optional style hint into both prompts, additively', async () => {
    const session = await startSession(startRequest);
    await rerollRound(session.id, { hint: '  new ones,   more cinematic ' });

    // The Council's prompt survives untouched; the customer's words ride
    // after it, whitespace-normalized — the verbatim-words posture (ADR-0010).
    const prompts = mockGenerate.mock.calls.slice(2).map(([request]) => request.prompt);
    expect(prompts).toEqual([
      'bold-fine-d1 Customer direction: "new ones, more cinematic".',
      'bold-fine-d2 Customer direction: "new ones, more cinematic".',
    ]);

    // A blank hint is a no-op, never an empty suffix.
    await rerollRound(session.id, { hint: '   ' });
    const bare = mockGenerate.mock.calls.slice(4).map(([request]) => request.prompt);
    expect(bare).toEqual(['bold-fine-d1', 'bold-fine-d2']);
  });

  it('does NOT touch the critique fix allowance — a re-roll is a round', async () => {
    const session = await startSession(startRequest);
    const { session: next } = await rerollRound(session.id);
    expect(next.fixesUsed ?? 0).toBe(0);
    expect(next.critiqueCuts ?? []).toEqual([]);
  });

  it('fails the whole round atomically — nothing persisted, slot freed, retry runs', async () => {
    const session = await startSession(startRequest);

    let call = 0;
    mockGenerate.mockImplementation(async request => {
      if (++call === 2) throw new Error('provider blew up');
      return generatedImage(request.modelId);
    });

    await expect(rerollRound(session.id)).rejects.toThrow('provider blew up');

    // No half-shown round, no partial charge surface: one round, two cuts.
    const stored = (await memorySessionStore.get(session.id)) as StoredSession;
    expect(stored.rounds).toHaveLength(1);
    expect(stored.variations).toHaveLength(2);
    expect(stored.roundInFlight).toBeUndefined();

    // The retry is not locked out.
    mockGenerate.mockImplementation(async request => generatedImage(request.modelId));
    const { round } = await rerollRound(session.id);
    expect(round.round).toBe(2);
  });

  it('reports an ADR-0048 downgrade on the round for the route to refund', async () => {
    const session = await startSession(startRequest);

    mockGenerate.mockImplementation(async request => ({
      images: [`https://replicate.delivery/pbxt/${++imageCounter}/out.png`],
      metadata: {
        model: request.modelId ?? 'unknown',
        provider: 'replicate' as const,
        generatedAt: new Date().toISOString(),
        durationMs: 1,
        attempts: 1,
        fallbackUsed: true,
        fallbackReason: 'REPLICATE_ERROR',
      },
    }));

    const result = await rerollRound(session.id);

    expect(result.downgraded).toBe(true);
    expect(result.downgradeReason).toBe('REPLICATE_ERROR');
    expect(result.round.downgraded).toBe(true);
    // Delivered all the same — the loud downgrade ships the cuts.
    expect(result.round.variationIds).toHaveLength(2);
  });

  it('refuses outside phase revealed and on unknown sessions', async () => {
    await expect(rerollRound('missing')).rejects.toMatchObject({
      code: 'SESSION_NOT_FOUND',
      status: 404,
    });

    const session = await startSession(startRequest);
    const stored = (await memorySessionStore.get(session.id)) as StoredSession;
    stored.phase = 'complete';
    await memorySessionStore.save(stored);
    await expect(rerollRound(session.id)).rejects.toMatchObject({
      code: 'INVALID_PHASE',
      status: 409,
    });
  });

  it('demo mode re-rolls render stock images with zero paid calls', async () => {
    process.env.NEXT_PUBLIC_DEMO_MODE = 'true';
    const session = await startSession(startRequest);
    const { session: next } = await rerollRound(session.id);

    expect(mockGenerate).not.toHaveBeenCalled();
    expect(mockGetSignedUrl).not.toHaveBeenCalled();
    expect(next.variations[2].imageUrl).toBe(DEMO_MOCK_IMAGES[2 % DEMO_MOCK_IMAGES.length]);
  });
});

describe('one charged round at a time — the re-roll shares the claim gate', () => {
  it('a re-roll while a refine round is in flight gets ROUND_IN_FLIGHT', async () => {
    const session = await startSession(startRequest);
    await recordRoundPick(session.id, { pickedId: 'v2' });

    // Hold the refine round's first render open so the re-roll arrives
    // while the round is mid-flight.
    let releaseRender!: () => void;
    const gate = new Promise<void>((resolve) => { releaseRender = resolve; });
    mockGenerate.mockImplementation(async request => {
      await gate;
      return generatedImage(request.modelId);
    });

    const winner = refineRound(session.id, { reservationId: 'res-winner' });
    await new Promise((resolve) => setImmediate(resolve));
    const loser = rerollRound(session.id, { reservationId: 'res-loser' });

    await expect(loser).rejects.toMatchObject({
      code: 'ROUND_IN_FLIGHT',
      status: 409,
    });
    releaseRender();
    const { round } = await winner;

    // Exactly one round delivered on exactly two renders — the loser spent
    // nothing and clobbered nothing.
    expect(round.round).toBe(2);
    expect(mockGenerate).toHaveBeenCalledTimes(4); // 2 reveal + 2 round
    const stored = (await memorySessionStore.get(session.id)) as StoredSession;
    expect(stored.rounds).toHaveLength(2);
    expect(stored.roundInFlight).toBeUndefined();
  });

  it('persists the credit reservation id inside the claim while rendering', async () => {
    const session = await startSession(startRequest);

    let midRenderClaim: unknown;
    mockGenerate.mockImplementation(async request => {
      midRenderClaim ??= ((await memorySessionStore.get(session.id)) as StoredSession)
        .roundInFlight;
      return generatedImage(request.modelId);
    });

    await rerollRound(session.id, { reservationId: 'res-reroll-42' });

    // The charge is reconcilable from the session record mid-flight.
    expect(midRenderClaim).toMatchObject({ reservationId: 'res-reroll-42' });
  });
});

describe('the loop continues after a re-roll', () => {
  it('picking a fresh cut and refining walks the ladder from the re-rolled answer', async () => {
    const session = await startSession(startRequest);
    await rerollRound(session.id); // v3/v4 re-ask bold-fine

    // The fresh set answered the question the rejected one could not.
    await recordRoundPick(session.id, { pickedId: 'v4' });
    const { round } = await refineRound(session.id);

    // Round 3 moves to the next unasked rung, holding the re-rolled pick.
    expect(round.axis).toBe('color-blackwork');
    expect(mockEnhanceRound).toHaveBeenLastCalledWith(intakeRecord, {
      roundNumber: 3,
      axis: 'color-blackwork',
      lockedPoles: { 'bold-fine': 'fine' },
    });
    const fetched = await getSession(session.id);
    expect(fetched.rounds?.map(r => r.axis)).toEqual([
      'bold-fine',
      'bold-fine',
      'color-blackwork',
    ]);
  });
});
