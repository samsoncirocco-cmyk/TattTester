/**
 * The artist's stencil, derived from the design the customer approved.
 *
 * A finished session owes two artifacts to two different readers. The
 * customer approves a rendered design — in colour, if they asked for colour.
 * The artist needs black line art they can trace, resize and rearrange.
 * Those are not the same file, and the customer's is not usable as the
 * artist's.
 *
 * The stencil is derived from the approved IMAGE via image-to-image, never
 * re-prompted from the session's text. Re-prompting produces a different
 * pose and arrangement, and handing an artist a stencil of a design the
 * customer never approved is worse than handing them nothing.
 *
 * Deliberately NOT the browser stencil path (src/features/stencil): running
 * Sobel + threshold over a shaded colour render reads every shading boundary
 * as a line, which is where broken, noisy linework comes from — and it is
 * browser-only, so no server channel including SMS can reach it.
 */
import { generate, STENCIL_SHIELD_TOKENS } from '../../generation';
import { durableRender } from './durableImage';
import { logger } from '@/lib/logger';
import { observeRenderedImage } from '@/lib/observeRender';

/**
 * Only flux-dev accepts an image-to-image input (see the generation module's
 * model catalog), so the stencil pass pins it rather than inheriting the
 * session's provider. This does not violate ADR-0016: that pin exists so the
 * reveal variations stay comparable as a pick signal, and the stencil is
 * a derived deliverable, not a variation.
 */
const STENCIL_MODEL_ID = 'flux-dev';

/**
 * How far the prompt may pull away from the approved design. Lower keeps
 * more of the source composition; flux-dev's own default is 0.8, tuned for
 * reinterpreting an image rather than restyling one.
 *
 * Measured, not reasoned. The original 0.65 was a guess favouring composition
 * fidelity, and rendered output showed it is unusable: at 0.65 the pass returns
 * the approved design lightly desaturated, not a stencil — no closed contours,
 * no flat black on white, nothing an artist could trace. The usable band sits
 * between 0.85 (composition safest, linework still soft in places) and 0.95
 * (cleanest lines, occasional drift in small elements). 0.9 is the midpoint and
 * the default until a tattoo artist picks the end of that band they prefer.
 */
const DEFAULT_PROMPT_STRENGTH = 0.9;

export function stencilPromptStrength(): number {
  const raw = Number(process.env.STENCIL_PROMPT_STRENGTH);
  return Number.isFinite(raw) && raw > 0 && raw <= 1 ? raw : DEFAULT_PROMPT_STRENGTH;
}

/** Stencil derivation costs one render per session — off unless asked for. */
export function stencilDerivationEnabled(): boolean {
  return process.env.STENCIL_DERIVATION_ENABLED === 'true';
}

/**
 * The positive specification, which is the half the existing stencil shield
 * was missing. The shield lists what to avoid; a model still needs telling
 * what a stencil line IS — uniform weight, closed contours, flat black on
 * white — and that the source's layout must survive the restyle.
 */
const STENCIL_PROMPT =
  'Convert this design into a black and white tattoo stencil. ' +
  'Clean vector-style outlines only, uniform line weight, closed continuous contours, ' +
  'flat pure black lines on a pure white background. ' +
  'Preserve the exact composition, pose, proportions and placement of every element in the source image, ' +
  'with clear negative space between elements so the linework can be separated and rearranged.';

/**
 * Colour is the one thing a stencil must not inherit from the source.
 *
 * Built on call rather than at module load. A top-level template literal
 * would read STENCIL_SHIELD_TOKENS the moment anything imports the
 * orchestrator, which makes every unrelated suite that stubs the generation
 * module have to know about this constant. Derivation is off by default, so
 * lazily this is read almost nowhere.
 */
function stencilNegatives(): string {
  return `color, colour ink, saturated hues, ${STENCIL_SHIELD_TOKENS}`;
}

/**
 * Render the stencil for an approved design, returning a product-owned URL.
 *
 * Returns null when derivation is off or the render failed: a session that
 * reaches an artist with a colour design and no stencil is diminished, not
 * broken, so this never throws into the refinement flow that produced it.
 *
 * Durability is not optional here even though it is a soft failure. The
 * stencil is the file an artist opens at a consult days later, and provider
 * URLs expire within the hour — so it goes through durableRender, which
 * copies into our bucket and throws rather than handing back a dying link.
 */
export async function deriveStencil(
  sessionId: string,
  tag: string,
  sourceImageUrl: string
): Promise<string | null> {
  if (!stencilDerivationEnabled()) return null;

  try {
    const outcome = await durableRender(
      {
        sessionId,
        tag: `${tag}-stencil`,
        prompt: STENCIL_PROMPT,
        negativePrompt: stencilNegatives(),
        modelId: STENCIL_MODEL_ID,
      },
      async () => {
        const result = await generate({
          prompt: STENCIL_PROMPT,
          negativePrompt: stencilNegatives(),
          modelId: STENCIL_MODEL_ID,
          numImages: 1,
          sourceImage: sourceImageUrl,
          sourceStrength: stencilPromptStrength(),
          isStencilMode: true,
          // Only flux-dev can honor sourceImage; falling back to a model
          // that cannot would silently return a different design.
          allowProviderFallback: false,
        });
        // A stencil is line art on a clean field, so the backdrop question
        // applies here at least as strongly as it does to a re-cut: a stencil
        // that comes back as a photograph of skin is exactly as wrong. This
        // closure is its own render path and therefore missed #389's wiring
        // entirely — it bought renders nothing measured (#392).
        await observeRenderedImage(result.images[0], {
          eventType: 'design_session.render_guard',
          fields: { session_id: sessionId, cut_id: `${tag}-stencil` },
        });
        return { image: result.images[0] };
      }
    );
    return outcome.imageUrl;
  } catch (error) {
    logger.warn({
      event_type: 'design_session.stencil_failed',
      session_id: sessionId,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}
