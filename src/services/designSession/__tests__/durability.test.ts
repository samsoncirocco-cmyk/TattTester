/**
 * Design-session image durability (TAT-57).
 *
 * Replicate deletes the output files of an API-created prediction about an
 * hour after it runs, so a `replicate.delivery` URL is transport, not storage.
 * These tests pin the product rule: nothing that leaves a design session — a
 * variation, the refined cut, the Brief the handoff saves into "My Designs" —
 * may point at a provider host, and a session is never persisted as a success
 * with one.
 *
 * Boundaries mocked: intake, council, generation, the durable image store,
 * the budget ledger, and Firebase Admin (off, so persistence is in-memory).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { startSession, recordPick, refine, getSession } from '../index';
import { memorySessionStore, clearMemorySessions } from '../internal/store';
import { durableObjectPath } from '../internal/durableImage';
import { extractIntake } from '../../intake';
import { enhanceStructured } from '../../council';
import { generate, routeGeneration } from '../../generation';
import {
  copyImageToPath,
  recoverImageAtPath,
  uploadImageToPath,
} from '@/services/storage/imageStorageService';
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
}));
vi.mock('../../generation', () => ({ generate: vi.fn(), routeGeneration: vi.fn() }));
vi.mock('@/lib/firebase-admin', () => ({ ensureAdminApp: vi.fn(() => false) }));
vi.mock('@/services/storage/imageStorageService', () => ({
  recoverImageAtPath: vi.fn(),
  copyImageToPath: vi.fn(),
  uploadImageToPath: vi.fn(),
}));
vi.mock('@/lib/budget-tracker', () => ({
  recordSpend: vi.fn(),
  VERTEX_IMAGEN_COST_CENTS: 4,
}));

const mockExtractIntake = vi.mocked(extractIntake);
const mockEnhanceStructured = vi.mocked(enhanceStructured);
const mockGenerate = vi.mocked(generate);
const mockRouteGeneration = vi.mocked(routeGeneration);
const mockRecoverImageAtPath = vi.mocked(recoverImageAtPath);
const mockCopyImageToPath = vi.mocked(copyImageToPath);
const mockUploadImageToPath = vi.mocked(uploadImageToPath);
const mockRecordSpend = vi.mocked(recordSpend);

const BUCKET_URL = 'https://storage.googleapis.com/tatt-pro-assets';
const durableUrl = (objectPath: string) => `${BUCKET_URL}/${objectPath}`;

/** Hosts whose URLs die on their own — none may ever be persisted. */
const PROVIDER_HOST = /replicate\.delivery|api\.replicate\.com|googleusercontent\.com/;

const intakeRecord: IntakeRecord = {
  placement: 'ribs',
  styleTags: ['fine-line'],
  meaning: 'a sparrow for my grandmother',
  references: [],
  ambiguousAxes: ['bold-fine', 'color-blackwork'],
};

const enhance = {
  axisSelection: {
    mode: 'questionnaire' as const,
    axes: ['color-blackwork' as const, 'bold-fine' as const],
    rationale: 'test',
  },
  variations: [
    { axisPosition: { 'color-blackwork': 'color', 'bold-fine': 'bold' }, prompts: { detailed: 'd1' }, negativePrompt: 'n1' },
    { axisPosition: { 'color-blackwork': 'color', 'bold-fine': 'fine' }, prompts: { detailed: 'd2' }, negativePrompt: 'n2' },
    { axisPosition: { 'color-blackwork': 'blackwork', 'bold-fine': 'bold' }, prompts: { detailed: 'd3' }, negativePrompt: 'n3' },
    { axisPosition: { 'color-blackwork': 'blackwork', 'bold-fine': 'fine' }, prompts: { detailed: 'd4' }, negativePrompt: 'n4' },
  ],
};

const replicateRoute = {
  modelId: 'sdxl',
  provider: 'replicate' as const,
  aspectRatio: '9:16' as const,
  negativePrompt: '',
  fallbackChain: [],
  reasoning: 'test route',
};

let renderCounter = 0;

beforeEach(() => {
  vi.clearAllMocks();
  clearMemorySessions();
  renderCounter = 0;

  mockExtractIntake.mockResolvedValue(intakeRecord);
  mockEnhanceStructured.mockResolvedValue(enhance);
  mockRouteGeneration.mockReturnValue(replicateRoute);
  mockRecordSpend.mockResolvedValue(undefined);
  mockRecoverImageAtPath.mockResolvedValue(null);
  mockCopyImageToPath.mockImplementation(async objectPath => durableUrl(objectPath));
  mockUploadImageToPath.mockImplementation(async objectPath => durableUrl(objectPath));

  // What Replicate actually returns: a file on replicate.delivery that stops
  // resolving about an hour later.
  mockGenerate.mockImplementation(async () => ({
    images: [`https://replicate.delivery/pbxt/${++renderCounter}/out.png`],
    metadata: {
      model: 'sdxl',
      provider: 'replicate' as const,
      generatedAt: new Date().toISOString(),
      durationMs: 1,
      attempts: 1,
      fallbackUsed: false,
    },
  }));
});

const startRequest = { placementAnswer: 'ribs', meaningAnswer: 'a sparrow' };

describe('no provider URL survives a design session', () => {
  it('copies every reveal image into the bucket and persists only that URL', async () => {
    const session = await startSession(startRequest);

    expect(mockCopyImageToPath).toHaveBeenCalledTimes(4);
    for (const [objectPath, sourceUrl] of mockCopyImageToPath.mock.calls) {
      expect(sourceUrl).toMatch(PROVIDER_HOST);
      expect(objectPath).toMatch(new RegExp(`^design-sessions/${session.id}/v[1-4]-[0-9a-f]{16}\\.png$`));
    }

    for (const variation of session.variations) {
      expect(variation.imageUrl).not.toMatch(PROVIDER_HOST);
      expect(variation.imageUrl?.startsWith(BUCKET_URL)).toBe(true);
    }

    // …and what actually hit the store, not just what was returned.
    const stored = await memorySessionStore.get(session.id);
    expect(JSON.stringify(stored)).not.toMatch(PROVIDER_HOST);
  });

  it('carries a durable URL through the refined cut and into the Brief', async () => {
    const started = await startSession(startRequest);
    await recordPick(started.id, { pickId: 'v3', mostNotYouId: 'v2' });
    const completed = await refine(started.id, { answer: 'not stark enough' });

    expect(completed.refinedVariation?.imageUrl).not.toMatch(PROVIDER_HOST);
    // The Brief's finalImageUrl is what HandoffCard hands to "My Designs".
    expect(completed.brief?.finalImageUrl).toBe(completed.refinedVariation?.imageUrl);
    expect(completed.brief?.finalImageUrl?.startsWith(BUCKET_URL)).toBe(true);
    expect(JSON.stringify(await getSession(started.id))).not.toMatch(PROVIDER_HOST);
  });

  it('uploads inline Vertex output instead of trying to persist megabytes of base64', async () => {
    mockGenerate.mockResolvedValue({
      images: ['data:image/png;base64,aGVsbG8='],
      metadata: {
        model: 'imagen3',
        provider: 'vertex-ai' as const,
        generatedAt: new Date().toISOString(),
        durationMs: 1,
        attempts: 1,
        fallbackUsed: false,
      },
    });

    const session = await startSession(startRequest);

    expect(mockCopyImageToPath).not.toHaveBeenCalled();
    expect(mockUploadImageToPath).toHaveBeenCalledTimes(4);
    expect(mockUploadImageToPath.mock.calls[0][1]).toEqual(Buffer.from('hello'));
    for (const variation of session.variations) {
      expect(variation.imageUrl?.startsWith('data:')).toBe(false);
    }
  });
});

describe('a failed durable copy is a failed generation', () => {
  it('rejects rather than falling back to the expiring provider URL', async () => {
    mockCopyImageToPath.mockRejectedValue(new Error('GCS unavailable'));

    await expect(startSession(startRequest)).rejects.toThrow('GCS unavailable');
  });

  it('persists no session at all when a copy fails', async () => {
    mockCopyImageToPath.mockImplementation(async (objectPath: string) => {
      if (objectPath.includes('/v3-')) throw new Error('GCS unavailable');
      return durableUrl(objectPath);
    });

    await expect(startSession(startRequest)).rejects.toThrow('GCS unavailable');
    // Nothing reached the store, so nothing can be listed with a dead image.
    await expect(getSession('any')).rejects.toMatchObject({ code: 'SESSION_NOT_FOUND' });
  });

  it('still records spend for the renders it already paid for', async () => {
    mockCopyImageToPath.mockRejectedValue(new Error('GCS unavailable'));

    await expect(startSession(startRequest)).rejects.toThrow('GCS unavailable');

    // All four parallel Replicate renders answered before one durable copy
    // failed, so all four purchases remain billable.
    expect(mockRecordSpend).toHaveBeenCalledWith(4);
  });

  it('bills every render a text-guard re-roll bought, not just the one returned', async () => {
    /*
     * The re-roll happens INSIDE generate() (#297), so one call can cost two
     * paid renders while handing back one image. onPurchase reports the count
     * from the result rather than assuming one, or a lettered first attempt
     * would be silently free — a mystery invoice a month later.
     */
    let call = 0;
    mockGenerate.mockImplementation(async () => ({
      images: [`https://replicate.delivery/pbxt/${++renderCounter}/out.png`],
      metadata: {
        model: 'sdxl',
        provider: 'replicate' as const,
        generatedAt: new Date().toISOString(),
        durationMs: 1,
        attempts: 1,
        fallbackUsed: false,
        // One of the four cuts came back lettered and was re-rolled once.
        ...(++call === 2 ? { textGuardRerolls: 1 } : {}),
      },
    }));

    await startSession(startRequest);

    // Four cuts, one of which cost two renders.
    expect(mockRecordSpend).toHaveBeenCalledWith(5);
  });

  it('leaves the refined cut unset and the session refinable when the regen copy fails', async () => {
    const started = await startSession(startRequest);
    await recordPick(started.id, { pickId: 'v3', mostNotYouId: 'v2' });
    mockCopyImageToPath.mockRejectedValue(new Error('GCS unavailable'));

    await expect(refine(started.id, { answer: 'bolder' })).rejects.toThrow('GCS unavailable');

    const stored = await getSession(started.id);
    expect(stored.phase).toBe('picked');
    expect(stored.refinedVariation).toBeUndefined();
    expect(stored.brief).toBeUndefined();
  });
});

describe('idempotency — a retry reuses the staged object', () => {
  it('derives the object path from the render inputs, not the clock', () => {
    const identity = {
      sessionId: 'sess-1',
      tag: 'v1',
      prompt: 'a sparrow',
      negativePrompt: 'blurry',
      modelId: 'sdxl',
    };
    expect(durableObjectPath(identity)).toBe(durableObjectPath({ ...identity }));
    expect(durableObjectPath(identity)).not.toBe(
      durableObjectPath({ ...identity, prompt: 'a different sparrow' })
    );
    expect(durableObjectPath(identity)).toMatch(/^design-sessions\/sess-1\/v1-[0-9a-f]{16}\.png$/);

    // Attached photos change what the image looks like (ADR-0050): a render
    // with photos must not collide with — and silently recover — a
    // photo-less render staged at the same prompt/model. Stable paths key
    // the fingerprint, so re-minting signed URLs cannot break recovery.
    const withPhotos = {
      ...identity,
      referenceImagePaths: ['design-sessions/sess-1/references/r1.jpg'],
    };
    expect(durableObjectPath(withPhotos)).toBe(durableObjectPath({ ...withPhotos }));
    expect(durableObjectPath(withPhotos)).not.toBe(durableObjectPath(identity));
  });

  it('does not re-buy or re-upload a render that is already staged', async () => {
    // A conversational confirm retries the reveal on the SAME session id
    // (startFromRecord's `base`), which is where a retry can hit objects an
    // earlier attempt already paid for.
    const { startFromRecord } = await import('../internal/orchestrator');
    const shell = { id: 'sess-retry', createdAt: new Date().toISOString() } as never;

    // First attempt: all four renders bought and staged, then it fails on the
    // last copy — the classic "paid for, never delivered" interruption.
    const staged = new Map<string, string>();
    mockCopyImageToPath.mockImplementation(async (objectPath: string) => {
      if (objectPath.includes('/v4-')) throw new Error('interrupted');
      staged.set(objectPath, durableUrl(objectPath));
      return durableUrl(objectPath);
    });
    await expect(startFromRecord(intakeRecord, shell)).rejects.toThrow('interrupted');
    expect(mockGenerate).toHaveBeenCalledTimes(4);

    // Second attempt, same session and same prompts: the staged objects are
    // found at their deterministic paths.
    mockRecoverImageAtPath.mockImplementation(async (objectPath: string) =>
      staged.has(objectPath) ? { imageUrl: staged.get(objectPath)!, metadata: {} } : null
    );
    mockCopyImageToPath.mockImplementation(async (objectPath: string) => durableUrl(objectPath));
    mockGenerate.mockClear();
    mockCopyImageToPath.mockClear();

    const replayed = await startFromRecord(intakeRecord, shell);

    // v1–v3 were staged; only the interrupted v4 is bought and copied again.
    expect(mockGenerate).toHaveBeenCalledTimes(1);
    expect(mockCopyImageToPath).toHaveBeenCalledTimes(1);
    // Same inputs → the same object URLs, never a duplicate object.
    expect(replayed.variations.slice(0, 3).map(v => v.imageUrl)).toEqual(
      [...staged.values()]
    );
    for (const variation of replayed.variations) {
      expect(variation.imageUrl).not.toMatch(PROVIDER_HOST);
    }
  });

  it('bills nothing for a retry that buys nothing', async () => {
    mockRecoverImageAtPath.mockImplementation(async (objectPath: string) => ({
      imageUrl: durableUrl(objectPath),
      metadata: {},
    }));

    const session = await startSession(startRequest);

    expect(mockGenerate).not.toHaveBeenCalled();
    expect(mockCopyImageToPath).not.toHaveBeenCalled();
    expect(mockRecordSpend).not.toHaveBeenCalled();
    expect(session.variations).toHaveLength(4);
  });
});
