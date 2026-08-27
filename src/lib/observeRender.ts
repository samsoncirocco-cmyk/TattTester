/**
 * The render-guard observation, in one place, for every lane that buys a
 * render.
 *
 * `@/lib/renderGuard` answers the question — are these pixels flash art on a
 * clean backdrop, or a photograph of somebody's skin? — over bytes, purely,
 * with no logger and no opinion about who asked. This module is the wrapper
 * that decides HOW an answer gets recorded, so that the several places which
 * pay for a render all record it the same way.
 *
 * ## Why it is not just a function on renderGuard
 *
 * #389 armed the guard at `designSession/internal/orchestrator.ts`, which is
 * genuinely every render in that file. It is not every render in the product:
 * `designSession/internal/stencil.ts` runs its own `durableRender` closure and
 * `app/api/v1/generate/route.ts` calls `generate` directly against a reserved
 * customer credit. Both bought renders nothing measured (#392). A private
 * helper in one orchestrator is how that happens — the second caller cannot
 * reach it, so the second caller does without.
 *
 * ## What it does, and what it refuses to do
 *
 * MEASURES AND LOGS. It never rejects and never throws. The bytes are already
 * billed; discarding them on this verdict trades a possible bad image for a
 * certain double charge, and a guard must not be the reason a paid render
 * fails to reach the customer. `border_backdrop_fraction` rides every measured
 * line so "how close to the line" is answerable without re-fetching.
 *
 * ONLY INLINE RENDERS ARE MEASURED, and the gap is logged rather than hidden.
 * Vertex returns `data:` URLs — the bytes are in memory, so the check costs a
 * decode and no network. Replicate returns a hosted URL, and measuring it
 * would mean fetching an image the caller is about to copy anyway, from inside
 * a paid render path. That lane logs `measured: false` WITH THE REASON rather
 * than a quiet green: a guard that cannot see something has to say so, which
 * is the whole lesson of the roster-only net that shipped the astronaut bug.
 */
import { logger } from '@/lib/logger';
import { guardRenderBytes } from '@/lib/renderGuard';

export interface RenderObservation {
  /**
   * Log event name for the lane, e.g. 'design_session.render_guard'. Named per
   * lane rather than shared, because "which renders are being measured at all"
   * is the question #392 was filed about and a single event name hides it.
   */
  eventType: string;
  /**
   * Identifying fields merged into every line — `{ session_id, cut_id }` for a
   * design session, whatever identifies the request elsewhere.
   */
  fields: Record<string, unknown>;
  /**
   * Whether a failing verdict deserves a `warn`. True for lanes that PIN the
   * flash-art presentation (ADR-0023), where a failure is a real defect.
   *
   * False for lanes that render an arbitrary caller-supplied prompt: there the
   * backdrop expectation was never asserted, so a low fraction is an
   * observation and not a verdict, and warning on it would train people to
   * ignore the event. The measurement is still recorded either way — this
   * governs the level, never whether the check runs.
   */
  warnOnFail?: boolean;
}

/**
 * Measure one render and log the verdict. Resolves even when everything about
 * the measurement fails.
 */
export async function observeRenderedImage(
  image: string | undefined,
  observation: RenderObservation
): Promise<void> {
  const { eventType, fields, warnOnFail = true } = observation;
  try {
    if (!image || !image.startsWith('data:')) {
      logger.info({
        event_type: eventType,
        ...fields,
        measured: false,
        reason: image
          ? 'render guard skipped: provider returned a hosted URL, not inline bytes'
          : 'render guard skipped: provider returned no image',
      });
      return;
    }
    const bytes = Buffer.from(image.slice(image.indexOf(',') + 1), 'base64');
    const verdict = await guardRenderBytes(new Uint8Array(bytes));
    logger[!verdict.passed && warnOnFail ? 'warn' : 'info']({
      event_type: eventType,
      ...fields,
      measured: true,
      passed: verdict.passed,
      kind: verdict.kind,
      border_backdrop_fraction: verdict.borderBackdropFraction,
      reason: verdict.reason,
    });
  } catch (err) {
    logger.warn({
      event_type: `${eventType}_errored`,
      ...fields,
      error: (err as Error)?.message ?? String(err),
    });
  }
}
