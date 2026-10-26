/**
 * #396: /api/v1/council/generate buys a Flux render and never called the pixel
 * guard the other paid lanes use. These tests pin that the observation
 * happens for a render that was paid for, and not for one that was not.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const {
  observeRenderedImageMock,
  recordSpendMock,
  checkBudgetMock,
  rateLimitMock,
  verifyApiAuthMock,
  llmMock,
  fetchMock,
} = vi.hoisted(() => ({
  observeRenderedImageMock: vi.fn(),
  recordSpendMock: vi.fn(),
  checkBudgetMock: vi.fn(),
  rateLimitMock: vi.fn(),
  verifyApiAuthMock: vi.fn(),
  llmMock: vi.fn(),
  fetchMock: vi.fn(),
}));

vi.mock('openai', () => ({
  default: class OpenAI {
    chat = { completions: { create: (...args: unknown[]) => llmMock(...args) } };
  },
}));

vi.mock('@/lib/observeRender', () => ({ observeRenderedImage: observeRenderedImageMock }));
vi.mock('@/lib/api-auth', () => ({ verifyApiAuth: verifyApiAuthMock }));
vi.mock('@/lib/rate-limit', () => ({
  rateLimit: rateLimitMock,
  rateLimitResponse: vi.fn(
    () => new Response(JSON.stringify({ error: 'Too Many Requests' }), { status: 429 })
  ),
}));
vi.mock('@/lib/budget-tracker', () => ({
  checkBudget: checkBudgetMock,
  recordSpend: recordSpendMock,
}));

import { POST } from '../route';

const IMAGE_URL = 'https://replicate.delivery/pbxt/council-out.png';

function makeRequest(body: Record<string, unknown>) {
  return new NextRequest('http://localhost/api/v1/council/generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function systemOf(args: unknown): string {
  const messages = (args as { messages?: Array<{ content?: unknown }> }).messages ?? [];
  const content = messages[0]?.content;
  return typeof content === 'string' ? content : '';
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('OPENROUTER_API_KEY', 'test-openrouter');
  vi.stubEnv('REPLICATE_API_TOKEN', 'test-replicate');
  vi.stubGlobal('fetch', fetchMock);
  verifyApiAuthMock.mockResolvedValue(null);
  rateLimitMock.mockResolvedValue({ allowed: true });
  checkBudgetMock.mockResolvedValue({ allowed: true, spentCents: 0 });
  recordSpendMock.mockResolvedValue(undefined);
  observeRenderedImageMock.mockResolvedValue(undefined);
  llmMock.mockImplementation(async (args: unknown) => {
    const system = systemOf(args);
    if (system.includes('tattoo intake')) {
      return {
        choices: [{
          message: {
            content: JSON.stringify({
              placement: 'forearm',
              style: 'traditional',
              subject_type: 'objects',
              subjects: ['dagger'],
              relationships: '',
              vibes: ['bold'],
              needs_reference: false,
            }),
          },
        }],
      };
    }
    if (system.includes('tattoo design critic')) {
      return {
        choices: [{
          message: { content: JSON.stringify({ verdict: 'ok', issues: [], suggestion: '' }) },
        }],
      };
    }
    return { choices: [{ message: { content: 'tattoo flash, black background' } }] };
  });
  fetchMock.mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({ output: [IMAGE_URL] }),
    text: async () => '',
  });
});

describe('POST /api/v1/council/generate — pixel guard (#396)', () => {
  it('observes the render it bought, as a pinned-backdrop lane', async () => {
    const res = await POST(makeRequest({ customerText: 'a dagger on my forearm' }));

    expect(res.status).toBe(200);
    expect(observeRenderedImageMock).toHaveBeenCalledTimes(1);
    expect(observeRenderedImageMock).toHaveBeenCalledWith(IMAGE_URL, {
      eventType: 'council_generate.render_guard',
      fields: { model: 'black-forest-labs/flux-1.1-pro', provider: 'replicate' },
      warnOnFail: true,
    });
    expect(recordSpendMock).toHaveBeenCalled();
  });

  it('does not measure a render the provider never returned', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({}),
      text: async () => 'upstream down',
    });

    const res = await POST(makeRequest({ customerText: 'a dagger on my forearm' }));

    expect(res.status).toBe(500);
    expect(observeRenderedImageMock).not.toHaveBeenCalled();
    expect(recordSpendMock).not.toHaveBeenCalled();
  });
});
