/**
 * The first cut as it lands (spec 9). A two-cut render still delivers both
 * cuts in one final save; while it runs, each cut that has landed durably
 * is recorded on the render's claim so a polling client can show it early.
 *
 * Best-effort by design: the preview is an optimisation, never required.
 * A failed write is logged and the render carries on, and the final save
 * delivers both cuts whether or not any preview was written.
 */
import { logger } from '@/lib/logger';
import type { Variation } from '../types';
import type { SessionStore } from './store';

/**
 * Where a render's landed cuts go: the store, the session and the claim
 * that owns the render. Absent (the legacy scripted start, demo mode) means
 * nothing is previewed.
 */
export interface PreviewTarget {
  store: SessionStore;
  sessionId: string;
  claimId: string;
}

/** Record one landed cut on the claim. Never throws. */
export async function landPreviewCut(
  target: PreviewTarget | undefined,
  variation: Variation
): Promise<void> {
  if (!target) return;
  try {
    const recorded = await target.store.appendPreview(target.sessionId, target.claimId, variation);
    if (!recorded) {
      logger.info({
        event_type: 'design_session.preview_claim_gone',
        session_id: target.sessionId,
        variation_id: variation.id,
      });
    }
  } catch (error) {
    logger.warn({
      event_type: 'design_session.preview_write_failed',
      session_id: target.sessionId,
      variation_id: variation.id,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
