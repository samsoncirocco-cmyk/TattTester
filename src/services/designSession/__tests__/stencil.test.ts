/**
 * Stencil derivation — the artist's half of a completed session.
 *
 * The generation module and the durable-image seam are mocked; what matters
 * here is the contract: derive from the approved IMAGE (never re-prompt from
 * text), pin the only model that can honor that, go through the durable path
 * so the link outlives the consult, and degrade to null rather than throwing
 * into the refinement that produced it.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../../generation', () => ({
  generate: vi.fn(),
  STENCIL_SHIELD_TOKENS: 'shading, gradients, grey, messy lines',
}));

// Stand in for the real durableRender: run the paid render, hand back a
// product-owned URL. Keeps this suite about the stencil's own decisions.
vi.mock('../internal/durableImage', () => ({
  durableRender: vi.fn(
    async (_identity: unknown, render: () => Promise<{ image: string; metadata?: Record<string, string> }>) => {
      const { image, metadata = {} } = await render();
      if (!image) throw new Error('Generation returned no image');
      return { imageUrl: 'https://storage.googleapis.com/tatt/stencil.png', metadata };
    }
  ),
}));

vi.mock('@/lib/observeRender', () => ({ observeRenderedImage: vi.fn() }));

import { deriveStencil, stencilPromptStrength } from '../internal/stencil';
import { observeRenderedImage } from '@/lib/observeRender';
import { generate } from '../../generation';
import { durableRender } from '../internal/durableImage';

const SOURCE = 'https://replicate.delivery/pbxt/approved.png';

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('STENCIL_DERIVATION_ENABLED', 'true');
  vi.mocked(generate).mockResolvedValue({
    images: ['https://replicate.delivery/pbxt/stencil.png'],
    metadata: {},
  } as unknown as Awaited<ReturnType<typeof generate>>);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('deriveStencil', () => {
  it('derives from the approved image, not from the session text', async () => {
    await deriveStencil('s1', 'v3-refined', SOURCE);

    const request = vi.mocked(generate).mock.calls[0][0];
    expect(request.sourceImage).toBe(SOURCE);
    expect(request.sourceStrength).toBe(stencilPromptStrength());
  });

  // Only flux-dev accepts an image-to-image input, and falling back to a
  // model that cannot would return a stencil of a different design.
  it('pins flux-dev and refuses provider fallback', async () => {
    await deriveStencil('s1', 'v3-refined', SOURCE);

    const request = vi.mocked(generate).mock.calls[0][0];
    expect(request.modelId).toBe('flux-dev');
    expect(request.allowProviderFallback).toBe(false);
    expect(request.numImages).toBe(1);
  });

  it('asks for line art positively and excludes colour', async () => {
    await deriveStencil('s1', 'v3-refined', SOURCE);

    const request = vi.mocked(generate).mock.calls[0][0];
    expect(request.prompt).toMatch(/uniform line weight/i);
    expect(request.prompt).toMatch(/preserve the exact composition/i);
    expect(request.negativePrompt).toMatch(/color/i);
    expect(request.isStencilMode).toBe(true);
  });

  // Provider URLs expire within the hour; this is the file an artist opens
  // at a consult days later, so it goes through the durable path like every
  // other session image.
  it('routes through the durable path under its own tag', async () => {
    const url = await deriveStencil('s1', 'v3-refined', SOURCE);

    const identity = vi.mocked(durableRender).mock.calls[0][0] as { tag: string; sessionId: string };
    expect(identity.sessionId).toBe('s1');
    expect(identity.tag).toBe('v3-refined-stencil');
    expect(url).toBe('https://storage.googleapis.com/tatt/stencil.png');
  });

  it('is off unless explicitly enabled — it costs a render per session', async () => {
    vi.stubEnv('STENCIL_DERIVATION_ENABLED', 'false');

    expect(await deriveStencil('s1', 'v3-refined', SOURCE)).toBeNull();
    expect(generate).not.toHaveBeenCalled();
    expect(durableRender).not.toHaveBeenCalled();
  });

  // A missing stencil costs the artist convenience; a thrown error would
  // cost the customer the refinement they already paid for.
  it('returns null instead of throwing when the render fails', async () => {
    vi.mocked(generate).mockRejectedValueOnce(new Error('provider blew up'));

    expect(await deriveStencil('s1', 'v3-refined', SOURCE)).toBeNull();
  });

  it('returns null instead of throwing when the durable copy fails', async () => {
    vi.mocked(durableRender).mockRejectedValueOnce(new Error('bucket unreachable'));

    expect(await deriveStencil('s1', 'v3-refined', SOURCE)).toBeNull();
  });

  it('returns null when the provider returned no image', async () => {
    vi.mocked(generate).mockResolvedValueOnce({
      images: [],
      metadata: {},
    } as unknown as Awaited<ReturnType<typeof generate>>);

    expect(await deriveStencil('s1', 'v3-refined', SOURCE)).toBeNull();
  });
});

describe('stencilPromptStrength', () => {
  // Pinned to the exact measured value rather than a range. 0.65 rendered an
  // unusable stencil, and a loose assertion is how that number quietly comes
  // back; this test fails if it does.
  it('defaults to the measured 0.9, not the unusable 0.65', () => {
    vi.stubEnv('STENCIL_PROMPT_STRENGTH', '');
    expect(stencilPromptStrength()).toBe(0.9);
  });

  it('is env-tunable within 0..1 and ignores nonsense', () => {
    vi.stubEnv('STENCIL_PROMPT_STRENGTH', '0.4');
    expect(stencilPromptStrength()).toBe(0.4);

    vi.stubEnv('STENCIL_PROMPT_STRENGTH', '7');
    expect(stencilPromptStrength()).toBe(0.9);

    vi.stubEnv('STENCIL_PROMPT_STRENGTH', 'banana');
    expect(stencilPromptStrength()).toBe(0.9);
  });
});

/**
 * #389 armed the pixel guard inside the orchestrator's render closure. This
 * function has its OWN durableRender closure, so it was never reached — a
 * paid render nothing measured (#392). A stencil is line art on a clean
 * field, so the backdrop question applies here at least as strongly: a
 * stencil that comes back as a photograph of skin is exactly as wrong as a
 * re-cut that does.
 */
describe('the pixel guard reaches this lane too', () => {
  it('observes the render it just bought, tagged as the stencil', async () => {
    await deriveStencil('s1', 'v3-refined', SOURCE);

    expect(observeRenderedImage).toHaveBeenCalledTimes(1);
    const [image, observation] = vi.mocked(observeRenderedImage).mock.calls[0];
    expect(image).toBe('https://replicate.delivery/pbxt/stencil.png');
    // Tagged distinctly from the cut it derives from, or the two renders are
    // indistinguishable in the log they both write to.
    expect(observation).toMatchObject({
      eventType: 'design_session.render_guard',
      fields: { session_id: 's1', cut_id: 'v3-refined-stencil' },
    });
  });

  it('is not consulted when derivation is switched off and nothing is bought', async () => {
    vi.stubEnv('STENCIL_DERIVATION_ENABLED', 'false');

    await deriveStencil('s1', 'v3-refined', SOURCE);

    expect(generate).not.toHaveBeenCalled();
    expect(observeRenderedImage).not.toHaveBeenCalled();
  });
});
