/**
 * Spec 9: the first cut as it lands. While a two-cut render runs, each cut
 * that has landed durably is recorded on the render's claim; the final save
 * drops it, a failed render's release clears it, and a stale writer can
 * never append to a newer claim. Every paid boundary is mocked and
 * persistence runs on the in-memory store.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { startSession, recordRoundPick, refineRound } from '../index';
import { claimRevealSlot, startFromRecord } from '../internal/orchestrator';
import { memorySessionStore, clearMemorySessions, ROUND_CLAIM_STALE_MS } from '../internal/store';
import type { StoredSession } from '../internal/store';
import { renderingFromClaim } from '../internal/resume';
import { landPreviewCut } from '../internal/preview';
import { extractIntake } from '../../intake';
import { enhanceStructured, enhanceRound } from '../../council';
import { generate, routeGeneration } from '../../generation';
import {
  copyImageToPath,
  recoverImageAtPath,
  uploadImageToPath,
} from '@/services/storage/imageStorageService';
import { recordSpend } from '@/lib/budget-tracker';
import { logger } from '@/lib/logger';
import type { IntakeRecord } from '../../intake/types';
import type { GenerationRequest } from '../../generation';

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
const BUCKET_URL = 'https://storage.googleapis.com/tatt-pro-assets';

const intakeRecord: IntakeRecord = {
  placement: 'ribs',
  styleTags: ['fine-line'],
  meaning: 'a sparrow for my grandmother',
  references: [],
  ambiguousAxes: ['bold-fine'],
};

const twoCuts = (axis: string) => ({
  axisSelection: { mode: 'questionnaire' as const, axes: [axis as 'bold-fine'], rationale: 't' },
  variations: [
    { axisPosition: { [axis]: 'a' }, prompts: { detailed: `${axis}-first` }, negativePrompt: 'n' },
    { axisPosition: { [axis]: 'b' }, prompts: { detailed: `${axis}-second` }, negativePrompt: 'n' },
  ],
});

let counter = 0;
const rendered = (request: GenerationRequest) => ({
  images: [`https://replicate.delivery/pbxt/${++counter}/out.png`],
  metadata: {
    model: request.modelId ?? 'unknown',
    provider: 'vertex-ai' as const,
    generatedAt: new Date().toISOString(),
    durationMs: 1,
    attempts: 1,
    fallbackUsed: false,
  },
});

/** A generate mock whose "-second" render waits until released. */
function holdSecondCut() {
  let release!: () => void;
  let fail!: (error: Error) => void;
  const gate = new Promise<void>((resolve, reject) => {
    release = resolve;
    fail = reject;
  });
  mockGenerate.mockImplementation(async (request) => {
    if (request.prompt.includes('-second')) await gate;
    return rendered(request);
  });
  return { release, fail };
}

async function claimOf(sessionId: string) {
  return ((await memorySessionStore.get(sessionId)) as StoredSession).roundInFlight;
}

/** Wait until the claim's preview holds `count` cuts. */
async function previewHas(sessionId: string, count: number) {
  for (let i = 0; i < 50; i++) {
    if (((await claimOf(sessionId))?.preview?.length ?? 0) >= count) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error(`preview never reached ${count}`);
}

beforeEach(() => {
  vi.clearAllMocks();
  clearMemorySessions();
  counter = 0;
  vi.mocked(extractIntake).mockResolvedValue(intakeRecord);
  vi.mocked(enhanceStructured).mockResolvedValue(twoCuts('bold-fine'));
  vi.mocked(enhanceRound).mockImplementation(async (_record, spread) => twoCuts(spread.axis));
  vi.mocked(routeGeneration).mockReturnValue({
    modelId: 'imagen3',
    provider: 'vertex-ai',
    aspectRatio: '9:16',
    negativePrompt: '',
    fallbackChain: [],
    reasoning: 'test',
  });
  vi.mocked(recoverImageAtPath).mockResolvedValue(null);
  vi.mocked(copyImageToPath).mockImplementation(async (path) => `${BUCKET_URL}/${path}`);
  vi.mocked(uploadImageToPath).mockImplementation(async (path) => `${BUCKET_URL}/${path}`);
  vi.mocked(recordSpend).mockResolvedValue(undefined);
  mockGenerate.mockImplementation(async (request) => rendered(request));
});

afterEach(() => {
  delete process.env.NEXT_PUBLIC_DEMO_MODE;
});

describe('appendPreview (memory store)', () => {
  const variation = { id: 'v3', axisPosition: {}, prompt: 'p', imageUrl: `${BUCKET_URL}/x.png` };

  async function claimedSession() {
    const session = await startSession({ placementAnswer: 'ribs', meaningAnswer: 'sparrow' });
    await memorySessionStore.claimRound(
      session.id,
      { id: 'claim-1', at: new Date().toISOString() },
      ROUND_CLAIM_STALE_MS
    );
    return session.id;
  }

  it('refuses a claim id that is not the live one', async () => {
    const id = await claimedSession();
    expect(await memorySessionStore.appendPreview(id, 'claim-old', variation)).toBe(false);
    expect((await claimOf(id))?.preview).toBeUndefined();
  });

  it('is idempotent per variation id', async () => {
    const id = await claimedSession();
    expect(await memorySessionStore.appendPreview(id, 'claim-1', variation)).toBe(true);
    expect(await memorySessionStore.appendPreview(id, 'claim-1', variation)).toBe(true);
    expect((await claimOf(id))?.preview).toEqual([variation]);
  });

  it('goes away with the claim on release', async () => {
    const id = await claimedSession();
    await memorySessionStore.appendPreview(id, 'claim-1', variation);
    await memorySessionStore.releaseRound(id, 'claim-1');
    expect(await claimOf(id)).toBeUndefined();
  });

  it('a failing store never breaks the render', async () => {
    const store = { ...memorySessionStore, appendPreview: vi.fn().mockRejectedValue(new Error('down')) };
    await expect(
      landPreviewCut({ store, sessionId: 's', claimId: 'c' }, variation)
    ).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ event_type: 'design_session.preview_write_failed' })
    );
  });
});

describe('a refine round previews its first cut', () => {
  it('records the landed cut with its final id, then the final save drops the preview', async () => {
    const session = await startSession({ placementAnswer: 'ribs', meaningAnswer: 'sparrow' });
    await recordRoundPick(session.id, { pickedId: 'v1' });
    const { release } = holdSecondCut();

    const round = refineRound(session.id);
    await previewHas(session.id, 1);

    const mid = (await memorySessionStore.get(session.id)) as StoredSession;
    const preview = mid.roundInFlight?.preview ?? [];
    expect(preview.map((cut) => cut.id)).toEqual(['v3']);
    // Durable before it is shown: the URL is our bucket, never the provider's.
    expect(preview[0].imageUrl?.startsWith(BUCKET_URL)).toBe(true);
    expect(renderingFromClaim(mid)?.preview?.map((cut) => cut.id)).toEqual(['v3']);
    // Nothing else moved: the phase and the cuts are untouched mid-render.
    expect(mid.phase).toBe('revealed');
    expect(mid.variations).toHaveLength(2);

    release();
    const { session: done } = await round;
    expect(done.variations.map((cut) => cut.id)).toEqual(['v1', 'v2', 'v3', 'v4']);
    expect(done.variations[2]).toEqual(preview[0]);
    expect(await claimOf(session.id)).toBeUndefined();
  });

  it('a failed sibling clears the preview with the claim', async () => {
    const session = await startSession({ placementAnswer: 'ribs', meaningAnswer: 'sparrow' });
    await recordRoundPick(session.id, { pickedId: 'v1' });
    const { fail } = holdSecondCut();

    const round = refineRound(session.id);
    await previewHas(session.id, 1);
    fail(new Error('provider blew up'));

    await expect(round).rejects.toThrow('provider blew up');
    const stored = (await memorySessionStore.get(session.id)) as StoredSession;
    expect(stored.roundInFlight).toBeUndefined();
    expect(stored.variations).toHaveLength(2);
  });

  it('demo mode previews nothing', async () => {
    process.env.NEXT_PUBLIC_DEMO_MODE = 'true';
    const session = await startSession({ placementAnswer: 'ribs', meaningAnswer: 'sparrow' });
    await recordRoundPick(session.id, { pickedId: 'v1' });
    const append = vi.spyOn(memorySessionStore, 'appendPreview');
    await refineRound(session.id);
    expect(append).not.toHaveBeenCalled();
    append.mockRestore();
  });
});

describe('the reveal previews its first cut', () => {
  it('records on the reveal claim and the reveal save clears it', async () => {
    const shell = await startSession({ placementAnswer: 'ribs', meaningAnswer: 'sparrow' });
    // Stand the stored session back to intake: the confirm path's state.
    const base = { ...(await memorySessionStore.get(shell.id))!, phase: 'intake' as const };
    await memorySessionStore.save(base);
    const claim = await claimRevealSlot(memorySessionStore, base.id);
    const { release } = holdSecondCut();

    const reveal = startFromRecord(intakeRecord, base, { claimId: claim.id });
    await previewHas(base.id, 1);
    const mid = (await memorySessionStore.get(base.id)) as StoredSession;
    expect(renderingFromClaim(mid)).toMatchObject({ kind: 'reveal', stale: false });
    expect(renderingFromClaim(mid)?.preview?.map((cut) => cut.id)).toEqual(['v1']);

    release();
    const done = await reveal;
    expect(done.phase).toBe('revealed');
    expect(await claimOf(base.id)).toBeUndefined();
  });

  it('a stale claim offers no preview', () => {
    const at = new Date(Date.now() - ROUND_CLAIM_STALE_MS - 1000).toISOString();
    const session = {
      phase: 'intake',
      roundInFlight: { id: 'c', at, preview: [{ id: 'v1', axisPosition: {}, prompt: 'p' }] },
    } as unknown as StoredSession;
    expect(renderingFromClaim(session)).toEqual({ kind: 'reveal', since: at, stale: true });
  });
});
