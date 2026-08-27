// Seam tests for the /api/v1/generate route adapter: the generation module is
// mocked at its public entry point; these tests pin the route's policy
// (spend recording, error mapping) and its response shapes.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const {
  generateMock,
  observeRenderedImageMock,
  recordSpendMock,
  checkBudgetMock,
  rateLimitMock,
  verifyApiAuthMock,
  verifyFirebaseTokenMock,
  reserveGenerationCreditMock,
  releaseGenerationCreditMock,
} = vi.hoisted(() => ({
  generateMock: vi.fn(),
  observeRenderedImageMock: vi.fn(),
  recordSpendMock: vi.fn(),
  checkBudgetMock: vi.fn(),
  rateLimitMock: vi.fn(),
  verifyApiAuthMock: vi.fn(),
  verifyFirebaseTokenMock: vi.fn(),
  reserveGenerationCreditMock: vi.fn(),
  releaseGenerationCreditMock: vi.fn(),
}));

// routeGeneration is real, not mocked: the route calls it to label a failure
// with the model that was actually attempted, and a stubbed router would let
// that label drift from the routing table it is supposed to report.
vi.mock('@/services/generation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/generation')>()),
  generate: generateMock
}));

vi.mock('@/lib/api-auth', () => ({
  verifyApiAuth: verifyApiAuthMock
}));

vi.mock('@/lib/auth-dal', () => ({ verifyFirebaseToken: verifyFirebaseTokenMock }));

vi.mock('@/lib/generation-credits', () => ({
  reserveGenerationCredit: reserveGenerationCreditMock,
  releaseGenerationCredit: releaseGenerationCreditMock,
  GenerationCreditsExhaustedError: class GenerationCreditsExhaustedError extends Error {},
}));

vi.mock('@/lib/rate-limit', () => ({
  rateLimit: rateLimitMock,
  rateLimitResponse: vi.fn()
}));

vi.mock('@/lib/budget-tracker', () => ({
  checkBudget: checkBudgetMock,
  recordSpend: recordSpendMock,
  VERTEX_IMAGEN_COST_CENTS: 4
}));

vi.mock('@/lib/logger', () => ({
  createRequestLogger: () => ({
    start: vi.fn(),
    complete: vi.fn(),
    error: vi.fn()
  })
}));

vi.mock('@/lib/observeRender', () => ({ observeRenderedImage: observeRenderedImageMock }));

import { POST } from '../route';

function makeRequest(body: Record<string, unknown>) {
  return new NextRequest('http://localhost/api/v1/generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
}

function vertexResult(imageCount = 2) {
  return {
    images: Array.from({ length: imageCount }, (_, i) => `data:image/png;base64,img${i}`),
    metadata: {
      model: 'imagen-3.0-generate-001',
      provider: 'vertex-ai',
      generatedAt: '2026-07-20T00:00:00.000Z',
      durationMs: 1234,
      attempts: 1,
      safetyFilterLevel: 'block_only_high',
      personGeneration: 'allow_adult',
      seed: 42,
      fallbackUsed: false
    }
  };
}

describe('/api/v1/generate route adapter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    verifyApiAuthMock.mockResolvedValue(null);
    verifyFirebaseTokenMock.mockResolvedValue({ uid: 'uid_customer' });
    reserveGenerationCreditMock.mockResolvedValue({ source: 'free', freeRemaining: 24, paidRemaining: 0 });
    releaseGenerationCreditMock.mockResolvedValue(undefined);
    rateLimitMock.mockResolvedValue({ allowed: true });
    checkBudgetMock.mockResolvedValue({ allowed: true });
    recordSpendMock.mockResolvedValue(undefined);
  });

  it('returns the vertex success shape and records vertex spend per image', async () => {
    generateMock.mockResolvedValueOnce(vertexResult(2));

    const res = await POST(makeRequest({
      prompt: 'dragon tattoo',
      sampleCount: 2,
      style: 'realism',
      bodyPart: 'forearm'
    }));

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.images).toHaveLength(2);
    expect(json.metadata).toMatchObject({
      prompt: 'dragon tattoo',
      model: 'imagen-3.0-generate-001',
      provider: 'vertex-ai',
      style: 'realism',
      bodyPart: 'forearm',
      aspectRatio: '1:1',
      outputFormat: 'png',
      durationMs: 1234,
      attempts: 1,
      safetyFilterLevel: 'block_only_high',
      personGeneration: 'allow_adult',
      seed: 42,
      fallbackUsed: false
    });

    // Vertex spend: cents-per-image * images generated.
    expect(recordSpendMock).toHaveBeenCalledWith(4 * 2);

    // The route is a thin adapter: it forwards the style and owns only the
    // retry/safety policy. It must NOT pin a model — pinning 'imagen3' here
    // is what kept this endpoint on Google after the routing table moved
    // realism off it.
    expect(generateMock).toHaveBeenCalledWith(expect.objectContaining({
      prompt: 'dragon tattoo',
      numImages: 2,
      style: 'realism',
      bodyPart: 'forearm',
      retry: { maxRetries: 2, baseDelayMs: 400 },
      fallback: { safetyFilterLevel: 'block_only_high' }
    }));
    expect(generateMock.mock.calls[0][0]).not.toHaveProperty('modelId');
  });

  it('reports outputFormat from the image data-URL mime type', async () => {
    generateMock.mockResolvedValueOnce({
      ...vertexResult(1),
      images: ['data:image/jpeg;base64,jpg0']
    });

    const res = await POST(makeRequest({ prompt: 'dragon tattoo' }));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.metadata.outputFormat).toBe('jpeg');
  });

  it('stops before generation when the lifetime and paid credits are exhausted', async () => {
    const exhausted = Object.assign(new Error('No cuts left'), { code: 'GENERATION_CREDITS_EXHAUSTED' });
    reserveGenerationCreditMock.mockRejectedValueOnce(exhausted);

    const res = await POST(makeRequest({ prompt: 'dragon tattoo' }));

    expect(res.status).toBe(402);
    expect(generateMock).not.toHaveBeenCalled();
  });

  it('returns the replicate fallback shape and records flat fallback spend', async () => {
    generateMock.mockResolvedValueOnce({
      images: ['https://replicate.delivery/out.png'],
      metadata: {
        model: 'sdxl',
        provider: 'replicate',
        generatedAt: '2026-07-20T00:00:00.000Z',
        durationMs: 2000,
        attempts: 1,
        fallbackUsed: true,
        fallbackReason: 'VERTEX_QUOTA_EXCEEDED'
      }
    });

    const res = await POST(makeRequest({ prompt: 'koi fish tattoo' }));

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.images).toEqual(['https://replicate.delivery/out.png']);
    expect(json.metadata).toMatchObject({
      prompt: 'koi fish tattoo',
      model: 'sdxl',
      provider: 'replicate',
      fallback: true,
      fallbackReason: 'VERTEX_QUOTA_EXCEEDED'
    });

    // Flat ~1 cent for a replicate fallback result.
    expect(recordSpendMock).toHaveBeenCalledWith(1);
  });

  // #287 took this route off the retiring Imagen endpoint by deleting the
  // hardcoded modelId and letting the routing table decide. A caller-supplied
  // modelId must not reopen that door: forwarding it would let a client pin
  // Vertex for a style #281 deliberately moved to Flux, which is the
  // text-in-tattoo defect arriving by a different road.
  it('ignores a caller-supplied modelId — the routing table decides', async () => {
    generateMock.mockResolvedValueOnce(vertexResult(1));

    const res = await POST(makeRequest({
      prompt: 'dragon tattoo',
      modelId: 'imagen3',
      style: 'anime'
    }));

    expect(res.status).toBe(200);
    expect(generateMock).toHaveBeenCalledWith(
      expect.not.objectContaining({ modelId: expect.anything() })
    );
    expect(generateMock).toHaveBeenCalledWith(
      expect.objectContaining({ prompt: 'dragon tattoo', style: 'anime' })
    );
  });

  it('treats primary Replicate success as full success, not a fallback', async () => {
    generateMock.mockResolvedValueOnce({
      images: [
        'https://replicate.delivery/a.png',
        'https://replicate.delivery/b.png'
      ],
      metadata: {
        model: 'flux-dev',
        provider: 'replicate',
        generatedAt: '2026-07-20T00:00:00.000Z',
        durationMs: 1800,
        attempts: 1,
        safetyFilterLevel: 'block_only_high',
        personGeneration: 'allow_adult',
        seed: null,
        fallbackUsed: false
      }
    });

    const res = await POST(makeRequest({
      prompt: 'koi fish tattoo',
      style: 'traditional',
      sampleCount: 2
    }));

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.metadata).toMatchObject({
      prompt: 'koi fish tattoo',
      model: 'flux-dev',
      provider: 'replicate',
      style: 'traditional',
      fallbackUsed: false,
      durationMs: 1800,
      attempts: 1
    });
    expect(json.metadata.fallback).toBeUndefined();
    // Per-image Replicate spend on the primary path (not the flat fallback 1¢).
    expect(recordSpendMock).toHaveBeenCalledWith(2);
  });

  it('maps VERTEX_QUOTA_EXCEEDED module errors to a 429', async () => {
    const quotaError = Object.assign(new Error('Vertex AI daily request quota exceeded'), {
      code: 'VERTEX_QUOTA_EXCEEDED',
      status: 429,
      details: { limit: 100 }
    });
    generateMock.mockRejectedValueOnce(quotaError);

    const res = await POST(makeRequest({ prompt: 'rose tattoo' }));

    expect(res.status).toBe(429);
    const json = await res.json();
    expect(json).toMatchObject({
      error: 'Vertex AI quota exceeded',
      code: 'VERTEX_QUOTA_EXCEEDED',
      details: { limit: 100 }
    });
    expect(recordSpendMock).not.toHaveBeenCalled();
  });

  it('rejects a missing/short prompt with 400 before calling the module', async () => {
    const res = await POST(makeRequest({ prompt: 'ab' }));

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.code).toBe('INVALID_PROMPT');
    expect(generateMock).not.toHaveBeenCalled();
    expect(recordSpendMock).not.toHaveBeenCalled();
  });
});

/**
 * #389 armed the pixel guard inside the design-session orchestrator. This
 * endpoint reserves a customer credit and calls `generate` directly, so it
 * never went through that wiring — a paid render nothing measured (#392).
 */
describe('the pixel guard reaches this lane too', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    verifyApiAuthMock.mockResolvedValue(null);
    verifyFirebaseTokenMock.mockResolvedValue({ uid: 'uid_customer' });
    reserveGenerationCreditMock.mockResolvedValue({ source: 'free', freeRemaining: 24, paidRemaining: 0 });
    rateLimitMock.mockResolvedValue({ allowed: true });
    checkBudgetMock.mockResolvedValue({ allowed: true });
    recordSpendMock.mockResolvedValue(undefined);
  });

  it('observes every image it charged for, not just the first', async () => {
    generateMock.mockResolvedValueOnce(vertexResult(2));

    await POST(makeRequest({ prompt: 'dragon tattoo', sampleCount: 2 }));

    // Two images were billed; two were measured. A per-request check would
    // report clean over a second image nobody looked at.
    expect(observeRenderedImageMock).toHaveBeenCalledTimes(2);
    expect(observeRenderedImageMock.mock.calls[0][0]).toBe('data:image/png;base64,img0');
    expect(observeRenderedImageMock.mock.calls[1][0]).toBe('data:image/png;base64,img1');
  });

  it('records a failing verdict here as an observation, not a warning', async () => {
    generateMock.mockResolvedValueOnce(vertexResult(1));

    await POST(makeRequest({ prompt: 'a photo of a forearm', sampleCount: 1 }));

    // This endpoint renders whatever prompt the caller sends, so it never
    // asserted the ADR-0023 flash-art presentation the design-session lanes
    // pin. A low backdrop fraction is therefore an observation, not a defect,
    // and warning on it would train people to ignore the event.
    expect(observeRenderedImageMock.mock.calls[0][1]).toMatchObject({
      eventType: 'generate_api.render_guard',
      warnOnFail: false,
      fields: { uid: 'uid_customer', image_index: 0 },
    });
  });

  it('does not measure a render that was never bought', async () => {
    generateMock.mockRejectedValueOnce(new Error('provider exploded'));

    await POST(makeRequest({ prompt: 'dragon tattoo', sampleCount: 1 }));

    expect(observeRenderedImageMock).not.toHaveBeenCalled();
  });
});
