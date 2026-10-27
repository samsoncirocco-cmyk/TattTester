'use client';

import { useEffect, useState } from 'react';

/**
 * The while-generating state for the reveal (TAT-52) — an in-voice progress
 * beat instead of a spinner. Rotates through a few designed lines while the
 * machines run. No fake percentages, no fake specifics: every line is
 * generic enough to be true of every generation.
 *
 * Screen readers get one stable "Working" status; the rotating line is
 * visual flavor and stays out of the live region so it doesn't narrate
 * every beat.
 */

/** The reveal generation — two cuts a round (ADR-0049), so every line holds. */
export const REVEAL_BEAT_LINES = [
  'warming up the machines…',
  'mixing ink…',
  'pulling two directions apart…',
  'two cuts, almost dry…',
] as const;

/** The one refinement regen (ADR-0013). */
export const REFINE_BEAT_LINES = [
  'one more pass on the machine…',
  'holding your pick, shifting the rest…',
  'reworking the lines…',
] as const;

const BEAT_MS = 2600;

/** After this long the wait says so, in the same quiet voice (spec 9). */
export const SLOW_AFTER_MS = 90_000;
export const SLOW_LINE = 'this one’s taking a while — still on it.';

/** "14s", then "2m 05s": a plain count, never an estimate. */
export function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${String(seconds % 60).padStart(2, '0')}s`;
}

/**
 * `startedAt` (epoch ms) is when the wait began: the confirm tap, or the
 * render claim's `since` after a reload (spec 7), so the count runs on
 * through a silent retry wait and survives a refresh. Without it the count
 * starts at mount.
 */
export function GeneratingBeat({
  lines,
  startedAt,
}: {
  lines: readonly string[];
  startedAt?: number;
}) {
  const [beat, setBeat] = useState(0);
  const [mountedAt] = useState(() => Date.now());
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = setInterval(() => setBeat((b) => b + 1), BEAT_MS);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  const elapsed = now - (startedAt ?? mountedAt);

  return (
    <div
      role="status"
      aria-label="Working"
      className="flex flex-wrap items-center gap-3 font-body text-[11px] lowercase tracking-[0.14em] text-white/60"
    >
      <span className="text-pink motion-safe:animate-pulse" aria-hidden="true">
        ●
      </span>
      <span aria-hidden="true">{lines[beat % lines.length]}</span>
      <span aria-hidden="true" data-testid="elapsed" className="tabular-nums text-white/40">
        {formatElapsed(elapsed)}
      </span>
      {elapsed >= SLOW_AFTER_MS && <span aria-hidden="true">{SLOW_LINE}</span>}
    </div>
  );
}
