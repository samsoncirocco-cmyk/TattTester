/**
 * The pick-to-refine loop (ADR-0049): round bookkeeping at the reveal, the
 * free changeable pick, the freeze at the moment a next round is charged,
 * axis progression up the ladder, and the reference chain — the picked cut
 * leads, the customer's own photos persist.
 *
 * Same seams as designSessionService.test.ts: every module boundary is
 * mocked, persistence runs on the in-memory store.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { DEMO_MOCK_IMAGES } from '@/lib/demo-images';
import {
  startSession,
  recordRoundPick,
  refineRound,
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
// Partial mock: the paid council calls are stubbed, but the module's pure
// exports (PRESENTATION_LEAD, stripChromaticWords) stay real — designState
// renders prompts from them, so a stubbed constant would make prompt
// assertions assert the test's own invention.
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
// The ADR-0050/#333 signed-URL plumbing the picked cut rides on. The
// signing bucket matches the fixture bucket, so the drift guard only fires
// in the test that deliberately drifts it.
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
  mockGenerate.mockImplementation(async request => ({
    images: [`https://replicate.delivery/pbxt/${++imageCounter}/out.png`],
    metadata: {
      model: request.modelId ?? 'unknown',
      provider: 'vertex-ai' as const,
      generatedAt: new Date().toISOString(),
      durationMs: 1,
      attempts: 1,
      fallbackUsed: false,
    },
  }));
});

afterEach(() => {
  delete process.env.NEXT_PUBLIC_DEMO_MODE;
});

const startRequest = { placementAnswer: 'on my ribs', meaningAnswer: 'a sparrow' };

describe('round one is recorded at the reveal', () => {
  it('persists round 1 with its axis and both variation ids, unpicked', async () => {
    const session = await startSession(startRequest);

    expect(session.variations).toHaveLength(2);
    expect(session.rounds).toEqual([
      { round: 1, axis: 'bold-fine', variationIds: ['v1', 'v2'] },
    ]);
  });
});

describe('recordRoundPick — free, recorded server-side, changeable', () => {
  it('records the pick with a timestamp and survives persistence', async () => {
    const session = await startSession(startRequest);
    const picked = await recordRoundPick(session.id, { pickedId: 'v2' });

    const round = picked.rounds?.[0];
    expect(round).toMatchObject({ round: 1, axis: 'bold-fine', pickedId: 'v2' });
    expect(typeof round?.pickedAt).toBe('string');
    // No render, no spend: the pick is the free signal.
    expect(mockGenerate).toHaveBeenCalledTimes(2);

    const fetched = await getSession(session.id);
    expect(fetched.rounds?.[0].pickedId).toBe('v2');
  });

  it('lets the pick change until the next round is charged', async () => {
    const session = await startSession(startRequest);
    await recordRoundPick(session.id, { pickedId: 'v2' });
    const repicked = await recordRoundPick(session.id, { pickedId: 'v1' });

    expect(repicked.rounds?.[0].pickedId).toBe('v1');
  });

  it('rejects a cut outside the live round', async () => {
    const session = await startSession(startRequest);
    await expect(recordRoundPick(session.id, { pickedId: 'v9' })).rejects.toMatchObject({
      code: 'INVALID_VARIATION',
    });
  });

  it('freezes after a charged round — the pick can never change again', async () => {
    const session = await startSession(startRequest);
    await recordRoundPick(session.id, { pickedId: 'v2' });
    await refineRound(session.id);

    // The stored round is frozen…
    const stored = (await memorySessionStore.get(session.id)) as StoredSession;
    expect(stored.rounds?.[0].frozen).toBe(true);
    // …and only the NEW round is pickable: v1 belongs to the frozen one.
    await expect(recordRoundPick(session.id, { pickedId: 'v1' })).rejects.toMatchObject({
      code: 'INVALID_VARIATION',
    });
    const repicked = await recordRoundPick(session.id, { pickedId: 'v3' });
    expect(repicked.rounds?.[1].pickedId).toBe('v3');
  });

  it('throws SESSION_NOT_FOUND for an unknown session', async () => {
    await expect(recordRoundPick('missing', { pickedId: 'v1' })).rejects.toMatchObject({
      code: 'SESSION_NOT_FOUND',
      status: 404,
    });
  });

  it('refuses a pick while a round renders instead of silently reverting it (#338)', async () => {
    const session = await startSession(startRequest);
    await recordRoundPick(session.id, { pickedId: 'v2' });

    // Hold the round's render open so the re-pick arrives mid-flight — the
    // race where the round's stale-loaded save used to eat the new pick.
    let releaseRender!: () => void;
    const gate = new Promise<void>((resolve) => { releaseRender = resolve; });
    mockGenerate.mockImplementation(async request => {
      await gate;
      return {
        images: [`https://replicate.delivery/pbxt/${++imageCounter}/out.png`],
        metadata: {
          model: request.modelId ?? 'unknown',
          provider: 'vertex-ai' as const,
          generatedAt: new Date().toISOString(),
          durationMs: 1,
          attempts: 1,
          fallbackUsed: false,
        },
      };
    });

    const inFlight = refineRound(session.id);
    await new Promise((resolve) => setImmediate(resolve));

    await expect(recordRoundPick(session.id, { pickedId: 'v1' })).rejects.toMatchObject({
      code: 'ROUND_IN_FLIGHT',
      status: 409,
    });

    releaseRender();
    await inFlight;
    // The refusal is transient: the new round's cuts pick normally.
    const repicked = await recordRoundPick(session.id, { pickedId: 'v3' });
    expect(repicked.rounds?.[1].pickedId).toBe('v3');
  });

  it('ignores a stale claim from a crashed instance — picks stay free', async () => {
    const session = await startSession(startRequest);
    const stored = (await memorySessionStore.get(session.id)) as StoredSession;
    stored.roundInFlight = {
      id: 'dead-claim',
      at: new Date(Date.now() - 11 * 60 * 1000).toISOString(),
    };
    await memorySessionStore.save(stored);

    const picked = await recordRoundPick(session.id, { pickedId: 'v2' });
    expect(picked.rounds?.[0].pickedId).toBe('v2');
  });
});

describe('refineRound — the charged next round', () => {
  it('refuses to run before a pick — the pick is the signal', async () => {
    const session = await startSession(startRequest);
    await expect(refineRound(session.id)).rejects.toMatchObject({
      code: 'ROUND_UNPICKED',
      status: 409,
    });
    expect(mockGenerate).toHaveBeenCalledTimes(2);
  });

  it('renders two new cuts on the next ladder axis, holding the picked pole', async () => {
    const session = await startSession(startRequest);
    await recordRoundPick(session.id, { pickedId: 'v2' });
    const { session: next, round } = await refineRound(session.id);

    // Axis progression (ADR-0049): round 2 spreads the second rung and
    // holds the pole round 1 picked.
    expect(mockEnhanceRound).toHaveBeenCalledWith(intakeRecord, {
      roundNumber: 2,
      axis: 'color-blackwork',
      lockedPoles: { 'bold-fine': 'fine' },
    });
    expect(round).toMatchObject({
      round: 2,
      axis: 'color-blackwork',
      variationIds: ['v3', 'v4'],
    });
    expect(next.variations.map(v => v.id)).toEqual(['v1', 'v2', 'v3', 'v4']);
    expect(mockGenerate).toHaveBeenCalledTimes(4);
    // ADR-0016 (per ADR-0052: one provider per round) — the pinned model,
    // with the ADR-0048 loud-downgrade opt-in.
    for (const [request] of mockGenerate.mock.calls.slice(2)) {
      expect(request.modelId).toBe('imagen3');
      expect(request.allowProviderFallback).toBe(true);
    }
  });

  it('walks the whole ladder and then re-rolls on locked poles — no cap', async () => {
    const session = await startSession(startRequest);
    let cutIndex = 2;
    for (const expectedAxis of [
      'color-blackwork',
      'literal-abstract',
      'minimal-ornate',
      'reroll',
      'reroll',
    ]) {
      const live = (await getSession(session.id)).rounds!.at(-1)!;
      await recordRoundPick(session.id, { pickedId: live.variationIds[1] });
      const { round } = await refineRound(session.id);
      expect(round.axis).toBe(expectedAxis);
      cutIndex += 2;
      expect(round.variationIds).toEqual([`v${cutIndex - 1}`, `v${cutIndex}`]);
    }
  });

  it('skips a rung the brief already settled — a blackwork brief never buys a color round', async () => {
    // The live-bug shape: intake resolved the palette to blackwork ("zero
    // color"), yet the old ladder still charged round two as color-blackwork
    // — a credit spent on a prompt that says "zero color" and "vibrant
    // full-color" at once. settledAxes(intake) now removes the rung
    // (ADR-0049).
    mockExtractIntake.mockResolvedValue({
      ...intakeRecord,
      styleTags: ['blackwork'],
      ambiguousAxes: ['bold-fine', 'minimal-ornate'],
    });
    const session = await startSession(startRequest);
    await recordRoundPick(session.id, { pickedId: 'v2' });
    const { round } = await refineRound(session.id);

    expect(round.axis).toBe('literal-abstract');
    expect(mockEnhanceRound).toHaveBeenCalledWith(
      expect.objectContaining({ styleTags: ['blackwork'] }),
      expect.objectContaining({ axis: 'literal-abstract' })
    );
  });

  it('falls through to the re-roll when every remaining rung is asked or settled', async () => {
    // Everything the ladder could still ask, the brief already answered:
    // blackwork settles the palette, the named subject settles
    // literal-abstract, minimalist settles the density. After round one's
    // bold-fine, the charged round re-rolls on the locked pole instead of
    // contradicting any of it.
    mockExtractIntake.mockResolvedValue({
      ...intakeRecord,
      styleTags: ['blackwork', 'minimalist'],
      subject: 'a sparrow mid-flight',
      ambiguousAxes: [],
    });
    const session = await startSession(startRequest);
    await recordRoundPick(session.id, { pickedId: 'v2' });
    const { round } = await refineRound(session.id);

    expect(round.axis).toBe('reroll');
    expect(mockEnhanceRound).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ axis: 'reroll', lockedPoles: { 'bold-fine': 'fine' } })
    );
  });

  it('chains the picked cut as the LEADING reference, photos persisting after it', async () => {
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

    await recordRoundPick(session.id, { pickedId: 'v2' });
    await refineRound(session.id);

    // The picked cut is already a GCS object — its bucket path rides the
    // same signed-URL plumbing as the photo (#333), and it LEADS.
    const pickedUrl = stored.variations[1].imageUrl!;
    const pickedPath = pickedUrl.replace(`${BUCKET_URL}/`, '');
    expect(mockGetSignedUrl.mock.calls.map(([path]) => path)).toEqual([
      pickedPath,
      `design-sessions/${session.id}/references/photo.jpg`,
    ]);
    for (const [request] of mockGenerate.mock.calls.slice(2)) {
      expect(request.referenceImages).toEqual([
        `https://signed.test/${pickedPath}`,
        `https://signed.test/design-sessions/${session.id}/references/photo.jpg`,
      ]);
    }
  });

  it('fails the whole round atomically — nothing persisted, pick unfrozen', async () => {
    const session = await startSession(startRequest);
    await recordRoundPick(session.id, { pickedId: 'v2' });

    let call = 0;
    mockGenerate.mockImplementation(async () => {
      if (++call === 2) throw new Error('provider blew up');
      return {
        images: [`https://replicate.delivery/pbxt/${++imageCounter}/out.png`],
        metadata: {
          model: 'imagen3',
          provider: 'vertex-ai' as const,
          generatedAt: new Date().toISOString(),
          durationMs: 1,
          attempts: 1,
          fallbackUsed: false,
        },
      };
    });

    await expect(refineRound(session.id)).rejects.toThrow('provider blew up');

    // No half-shown round: the session still has one round, two cuts, and a
    // changeable pick.
    const stored = (await memorySessionStore.get(session.id)) as StoredSession;
    expect(stored.rounds).toHaveLength(1);
    expect(stored.rounds?.[0].frozen).toBeUndefined();
    expect(stored.variations).toHaveLength(2);
    const repicked = await recordRoundPick(session.id, { pickedId: 'v1' });
    expect(repicked.rounds?.[0].pickedId).toBe('v1');
  });

  it('reports an ADR-0048 downgrade on the round for the route to refund', async () => {
    const session = await startSession(startRequest);
    await recordRoundPick(session.id, { pickedId: 'v2' });

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

    const result = await refineRound(session.id);

    expect(result.downgraded).toBe(true);
    expect(result.downgradeReason).toBe('REPLICATE_ERROR');
    expect(result.round.downgraded).toBe(true);
    // Delivered all the same — the loud downgrade ships the cuts.
    expect(result.round.variationIds).toHaveLength(2);
  });

  it('demo mode rounds render stock images with zero paid calls', async () => {
    process.env.NEXT_PUBLIC_DEMO_MODE = 'true';
    const session = await startSession(startRequest);
    await recordRoundPick(session.id, { pickedId: 'v1' });
    const { session: next } = await refineRound(session.id);

    expect(mockGenerate).not.toHaveBeenCalled();
    expect(mockGetSignedUrl).not.toHaveBeenCalled();
    expect(next.variations[2].imageUrl).toBe(DEMO_MOCK_IMAGES[2 % DEMO_MOCK_IMAGES.length]);
  });
});

describe('one charged round at a time (claim race)', () => {
  it('serializes two concurrent rounds — the loser never renders or persists', async () => {
    const session = await startSession(startRequest);
    await recordRoundPick(session.id, { pickedId: 'v2' });

    // Hold the winner's first render open so the second call arrives while
    // the round is mid-flight — the web double-click / web+SMS interleaving.
    let releaseRender!: () => void;
    const gate = new Promise<void>((resolve) => { releaseRender = resolve; });
    mockGenerate.mockImplementation(async request => {
      await gate;
      return {
        images: [`https://replicate.delivery/pbxt/${++imageCounter}/out.png`],
        metadata: {
          model: request.modelId ?? 'unknown',
          provider: 'vertex-ai' as const,
          generatedAt: new Date().toISOString(),
          durationMs: 1,
          attempts: 1,
          fallbackUsed: false,
        },
      };
    });

    const winner = refineRound(session.id, { reservationId: 'res-winner' });
    // Let the winner claim the slot before the loser arrives.
    await new Promise((resolve) => setImmediate(resolve));
    const loser = refineRound(session.id, { reservationId: 'res-loser' });

    await expect(loser).rejects.toMatchObject({
      code: 'ROUND_IN_FLIGHT',
      status: 409,
    });
    releaseRender();
    const { round } = await winner;

    // Exactly one round delivered, on exactly two renders — the loser spent
    // nothing and clobbered nothing.
    expect(round.round).toBe(2);
    expect(mockGenerate).toHaveBeenCalledTimes(4); // 2 reveal + 2 round
    const stored = (await memorySessionStore.get(session.id)) as StoredSession;
    expect(stored.rounds).toHaveLength(2);
    expect(stored.variations.map(v => v.id)).toEqual(['v1', 'v2', 'v3', 'v4']);
    // The delivered round's final save also freed the slot.
    expect(stored.roundInFlight).toBeUndefined();
  });

  it('persists the credit reservation id inside the claim while rendering', async () => {
    const session = await startSession(startRequest);
    await recordRoundPick(session.id, { pickedId: 'v2' });

    let midRenderClaim: unknown;
    mockGenerate.mockImplementation(async request => {
      midRenderClaim ??= ((await memorySessionStore.get(session.id)) as StoredSession)
        .roundInFlight;
      return {
        images: [`https://replicate.delivery/pbxt/${++imageCounter}/out.png`],
        metadata: {
          model: request.modelId ?? 'unknown',
          provider: 'vertex-ai' as const,
          generatedAt: new Date().toISOString(),
          durationMs: 1,
          attempts: 1,
          fallbackUsed: false,
        },
      };
    });

    await refineRound(session.id, { reservationId: 'res-42' });

    // The charge is reconcilable from the session record mid-flight, not
    // only from the caller's in-memory closure.
    expect(midRenderClaim).toMatchObject({ reservationId: 'res-42' });
  });

  it('frees the slot on failure so the promised retry can run', async () => {
    const session = await startSession(startRequest);
    await recordRoundPick(session.id, { pickedId: 'v2' });

    mockGenerate.mockRejectedValue(new Error('provider blew up'));
    await expect(refineRound(session.id)).rejects.toThrow('provider blew up');

    const stored = (await memorySessionStore.get(session.id)) as StoredSession;
    expect(stored.roundInFlight).toBeUndefined();

    // The retry is not locked out.
    mockGenerate.mockImplementation(async request => ({
      images: [`https://replicate.delivery/pbxt/${++imageCounter}/out.png`],
      metadata: {
        model: request.modelId ?? 'unknown',
        provider: 'vertex-ai' as const,
        generatedAt: new Date().toISOString(),
        durationMs: 1,
        attempts: 1,
        fallbackUsed: false,
      },
    }));
    const { round } = await refineRound(session.id);
    expect(round.round).toBe(2);
  });
});

describe('an explicitly requested axis leads round one (ADR-0049)', () => {
  it('resumes the ladder on the first rung not yet asked', async () => {
    // The conversation promised color vs blackwork, so round one spread it.
    mockEnhanceStructured.mockResolvedValue({
      axisSelection: {
        mode: 'questionnaire' as const,
        axes: ['color-blackwork' as const],
        rationale: 'the customer explicitly asked to see both poles',
      },
      variations: [
        { axisPosition: { 'color-blackwork': 'color' }, prompts: { detailed: 'd1' }, negativePrompt: 'n1' },
        { axisPosition: { 'color-blackwork': 'blackwork' }, prompts: { detailed: 'd2' }, negativePrompt: 'n2' },
      ],
    });

    const session = await startSession(startRequest);
    expect(session.rounds?.[0].axis).toBe('color-blackwork');

    await recordRoundPick(session.id, { pickedId: 'v1' });
    await refineRound(session.id);

    // Round two spreads bold-fine — the first UNASKED rung, never a repeat
    // of the split round one already answered.
    expect(mockEnhanceRound).toHaveBeenCalledWith(intakeRecord, {
      roundNumber: 2,
      axis: 'bold-fine',
      lockedPoles: { 'color-blackwork': 'color' },
    });
  });
});

describe('legacy sessions (revealed before rounds existed)', () => {
  it('synthesizes round one from the legacy cuts on first pick', async () => {
    const session = await startSession(startRequest);
    // Simulate a pre-ADR-0049 stored session: four cuts, no rounds.
    const stored = (await memorySessionStore.get(session.id)) as StoredSession;
    delete stored.rounds;
    stored.variations = [1, 2, 3, 4].map(n => ({
      id: `v${n}`,
      axisPosition: { 'bold-fine': n % 2 ? 'bold' : 'fine' },
      prompt: `p${n}`,
      imageUrl: durableUrl(`design-sessions/${session.id}/v${n}-abc.png`),
    }));
    await memorySessionStore.save(stored);

    const picked = await recordRoundPick(session.id, { pickedId: 'v3' });

    // The pick did not dead-end: round one now exists over ALL legacy cuts.
    expect(picked.rounds).toEqual([
      expect.objectContaining({
        round: 1,
        axis: 'bold-fine',
        variationIds: ['v1', 'v2', 'v3', 'v4'],
        pickedId: 'v3',
      }),
    ]);

    // And the loop continues from it: the next round holds the picked pole.
    const { round } = await refineRound(session.id);
    expect(round.round).toBe(2);
    expect(mockEnhanceRound).toHaveBeenCalledWith(intakeRecord, {
      roundNumber: 2,
      axis: 'color-blackwork',
      lockedPoles: { 'bold-fine': 'bold' },
    });
  });
});

describe('the picked-cut reference is bucket-verified (config drift guard)', () => {
  it('fails the round loudly when the cut lives in a different bucket than signing', async () => {
    const session = await startSession(startRequest);
    const stored = (await memorySessionStore.get(session.id)) as StoredSession;
    stored.variations = stored.variations.map(variation => ({
      ...variation,
      imageUrl: `https://storage.googleapis.com/some-other-bucket/${variation.id}.png`,
    }));
    await memorySessionStore.save(stored);
    await recordRoundPick(session.id, { pickedId: 'v2' });

    await expect(refineRound(session.id)).rejects.toThrow(/some-other-bucket/);

    // Loud and clean: nothing rendered, nothing persisted, slot freed.
    expect(mockGenerate).toHaveBeenCalledTimes(2); // reveal only
    const after = (await memorySessionStore.get(session.id)) as StoredSession;
    expect(after.rounds).toHaveLength(1);
    expect(after.roundInFlight).toBeUndefined();
  });

  it('carries a typed code so the route can classify config drift', async () => {
    const session = await startSession(startRequest);
    const stored = (await memorySessionStore.get(session.id)) as StoredSession;
    stored.variations = stored.variations.map(variation => ({
      ...variation,
      imageUrl: `https://storage.googleapis.com/some-other-bucket/${variation.id}.png`,
    }));
    await memorySessionStore.save(stored);
    await recordRoundPick(session.id, { pickedId: 'v2' });

    // A bare Error reaches the client as an unclassified failure; the drift is
    // ours, so it is a 500 with a code the UI can branch on — not a 4xx that
    // blames the caller for a request they cannot fix by changing.
    await expect(refineRound(session.id)).rejects.toMatchObject({
      name: 'DesignSessionError',
      code: 'REFERENCE_BUCKET_MISMATCH',
      status: 500,
    });
  });

  it('refuses the round when our own object key will not decode', async () => {
    const session = await startSession(startRequest);
    const stored = (await memorySessionStore.get(session.id)) as StoredSession;
    // On our storage host and in the signing bucket, but the key carries a
    // malformed percent-escape. Silently seeding nothing here would drop the
    // customer's pick behind a log line, so it fails the round instead.
    stored.variations = stored.variations.map(variation => ({
      ...variation,
      imageUrl: 'https://storage.googleapis.com/tatt-pro-assets/cuts/%zz.png',
    }));
    await memorySessionStore.save(stored);
    await recordRoundPick(session.id, { pickedId: 'v2' });

    await expect(refineRound(session.id)).rejects.toMatchObject({
      code: 'REFERENCE_PATH_UNREADABLE',
      status: 500,
    });

    // Same guarantee as the drift case: nothing rendered, nothing persisted.
    expect(mockGenerate).toHaveBeenCalledTimes(2); // reveal only
    const after = (await memorySessionStore.get(session.id)) as StoredSession;
    expect(after.rounds).toHaveLength(1);
    expect(after.roundInFlight).toBeUndefined();
  });

  it('renders unseeded (and logs) when the cut has no usable GCS URL at all', async () => {
    const session = await startSession(startRequest);
    const stored = (await memorySessionStore.get(session.id)) as StoredSession;
    stored.variations = stored.variations.map(variation => ({
      ...variation,
      imageUrl: `https://replicate.delivery/pbxt/expired/${variation.id}.png`,
    }));
    await memorySessionStore.save(stored);
    await recordRoundPick(session.id, { pickedId: 'v2' });

    const { round } = await refineRound(session.id);

    // Delivered — a missing reference degrades the seed, not the round —
    // but with no reference images attached and nothing signed.
    expect(round.round).toBe(2);
    expect(mockGetSignedUrl).not.toHaveBeenCalled();
    for (const [request] of mockGenerate.mock.calls.slice(2)) {
      expect(request.referenceImages).toBeUndefined();
    }
  });
});
