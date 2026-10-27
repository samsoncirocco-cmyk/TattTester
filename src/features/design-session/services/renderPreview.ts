// The first cut as it lands (spec 9). While a confirm or round POST is in
// flight, the page also re-reads the session and shows any cut the server
// has already recorded on the render's claim. The POST stays the source of
// truth for completion and credits; this read is only a preview.

import { useEffect, useRef, useState } from 'react';
import type { Variation } from '@/services/designSession/types';
import { fetchSessionForResume, type ResumeFetchResult } from './sessionResume';

/** The Studio path's cadence for the first minute… */
export const PREVIEW_POLL_MS = 2000;
/** …then a little slower, well inside the 60/min read limit. */
export const PREVIEW_POLL_SLOW_MS = 3000;
export const PREVIEW_SLOW_AFTER_MS = 60_000;

export function previewPollDelay(elapsedMs: number): number {
  return elapsedMs >= PREVIEW_SLOW_AFTER_MS ? PREVIEW_POLL_SLOW_MS : PREVIEW_POLL_MS;
}

/** The landed cuts a session read carries, or none. */
export function previewFrom(result: ResumeFetchResult): Variation[] {
  if (result.status !== 'found') return [];
  const rendering = result.resume?.rendering;
  if (!rendering || rendering.stale) return [];
  return rendering.preview ?? [];
}

function isHidden(): boolean {
  return typeof document !== 'undefined' && document.visibilityState === 'hidden';
}

/**
 * Re-read the session while `active`, one request at a time, and return the
 * cuts that have landed so far. Pauses on a hidden tab and reads again the
 * moment it is shown. Stops on a stale claim (the render is presumed dead;
 * the POST will report the failure). Demo mode renders stock images at
 * once, so it never polls.
 */
export function usePreviewPoll(sessionId: string | undefined, active: boolean): Variation[] {
  const [preview, setPreview] = useState<Variation[]>([]);
  const startedAt = useRef(0);

  useEffect(() => {
    if (!active || !sessionId || process.env.NEXT_PUBLIC_DEMO_MODE === 'true') return;
    startedAt.current = Date.now();
    let cancelled = false;
    let inFlight = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const schedule = () => {
      if (cancelled) return;
      timer = setTimeout(read, previewPollDelay(Date.now() - startedAt.current));
    };
    const read = () => {
      if (cancelled) return;
      if (isHidden() || inFlight) {
        schedule();
        return;
      }
      inFlight = true;
      fetchSessionForResume(sessionId)
        .then((result) => {
          if (cancelled) return;
          const landed = previewFrom(result);
          if (landed.length) setPreview(landed);
          if (result.status === 'found' && result.resume?.rendering?.stale) cancelled = true;
        })
        .finally(() => {
          inFlight = false;
          schedule();
        });
    };
    const onVisible = () => {
      if (isHidden() || cancelled) return;
      if (timer) clearTimeout(timer);
      read();
    };

    schedule();
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisible);
      // The next render starts with nothing landed.
      setPreview([]);
    };
  }, [sessionId, active]);

  return active ? preview : [];
}
