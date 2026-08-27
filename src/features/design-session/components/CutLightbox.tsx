'use client';

import { useCallback, useEffect, useId, useRef } from 'react';

/**
 * One cut, full size, over the page (TAT-58).
 *
 * ## Why this exists next to the grid instead of reusing `punk/Lightbox`
 *
 * `src/components/punk/Lightbox.tsx` already draws this box — same hard
 * edges, same pink hairline, same ✕. It is a fine viewer and this file
 * deliberately keeps its visual language so the two never drift into
 * looking like different products. What it does not do is *keep the
 * keyboard*: nothing focuses the dialog on open, Tab walks straight out of
 * it into the page underneath, and closing leaves focus wherever the
 * document happened to leave it — usually `<body>`, which drops a keyboard
 * user back at the top of a long chat transcript with no way back to the
 * cut they were just reading. The reveal is the one screen in the session
 * a customer is *studying*, so that behavior is not acceptable here.
 *
 * Fixing it in `punk/Lightbox` would have been the better long-term move
 * and is worth doing later; that file is outside this change's blast
 * radius and has no current callers, so it stayed untouched.
 *
 * ## The contract
 *
 * - The artwork is never cropped. It is fit to the viewport at the largest
 *   size that still shows all of it (`object-contain` against explicit
 *   viewport-relative maxima), sitting on a near-black mat so the flash
 *   art's own near-white ground reads as a sheet of paper.
 * - The cut is named. `cutIdentity`'s designed name and caption come in as
 *   props — this component never sees, and so can never leak, the raw axis
 *   internals behind them (ADR-0012 / TAT-47 defect 8).
 * - The dialog owns the keyboard while it is open: focus lands on the close
 *   control, Tab cycles inside the card, Escape closes, and the caller puts
 *   focus back on the control that opened it.
 * - Motion is the design system's single `snap` cut-in via `.rise`, which
 *   `prefers-reduced-motion` already switches off in globals.css. No new
 *   keyframes, so no new reduced-motion exception to maintain.
 *
 * One deliberate departure from the dialog pattern in DESIGN_SYSTEM.md: the
 * backdrop is a flat `bg-black/95` instead of `bg-black/80 halftone`. The
 * halftone is a pink dot screen laid over everything behind it — over a
 * dialog whose entire job is showing artwork accurately, it would tint the
 * thing being judged. `punk/Lightbox` made the same call for the same
 * reason; image viewers get the flat scrim.
 */
export function CutLightbox({
  imageUrl,
  alt,
  name,
  caption,
  step,
  onClose,
  onPrev,
  onNext,
}: {
  imageUrl: string;
  /** Screen-reader name for the image itself — "Design 3", same as the grid. */
  alt: string;
  /** The cut's designed name, e.g. "the bold, blackwork one". */
  name: string;
  /** The cut's designed caption; may be empty on the generic fallback. */
  caption?: string;
  /** Where this cut sits in the expandable set, for the "01 / 02" counter. */
  step?: { position: number; total: number };
  onClose: () => void;
  /** Omitted at the ends of the set — the control renders disabled. */
  onPrev?: () => void;
  onNext?: () => void;
}) {
  const titleId = useId();
  const cardRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  // Open with focus on the close control rather than the card: the first
  // Tab then lands on a real control instead of announcing the whole dialog
  // again, and Escape-blind users have the way out already under the cursor.
  useEffect(() => {
    closeRef.current?.focus();
  }, []);

  const handleKey = useCallback(
    (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onClose();
        return;
      }
      if (event.key === 'ArrowLeft') {
        onPrev?.();
        return;
      }
      if (event.key === 'ArrowRight') {
        onNext?.();
        return;
      }
      if (event.key !== 'Tab') return;

      // The trap. Everything focusable lives inside the card, so the cycle
      // is just "wrap at whichever end you fell off". Computed per keypress
      // rather than cached because the prev/next controls flip between
      // enabled and disabled as the customer steps through the set.
      const focusables = cardRef.current?.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), textarea, input, select, [tabindex]:not([tabindex="-1"])'
      );
      if (!focusables || focusables.length === 0) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const active = document.activeElement;
      if (event.shiftKey && (active === first || !cardRef.current?.contains(active))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (active === last || !cardRef.current?.contains(active))) {
        event.preventDefault();
        first.focus();
      }
    },
    [onClose, onPrev, onNext]
  );

  useEffect(() => {
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [handleKey]);

  // Background scroll lock. The reveal sits in a long scrolling transcript;
  // without this, a trackpad flick behind the dialog scrolls the chat away
  // and the customer closes the lightbox somewhere they never were.
  useEffect(() => {
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previous;
    };
  }, []);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/95 p-3 sm:p-6"
      // Backdrop dismiss, guarded on the target so a click that starts on
      // the card and drifts onto the backdrop doesn't close the view.
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={cardRef}
        className="rise relative flex max-h-full w-full max-w-[min(94vw,1000px)] flex-col border-2 border-pink bg-black"
      >
        <div className="flex items-start justify-between gap-3 border-b-2 hairline px-3 py-2.5">
          <div className="min-w-0">
            <p className="font-body text-[10px] uppercase tracking-[0.28em] text-pink">
              Full view
            </p>
            <p id={titleId} className="font-body text-[11px] lowercase tracking-[0.1em] text-white">
              {name}
            </p>
          </div>
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            aria-label="Close full view"
            className="press shrink-0 font-display text-[16px] leading-none text-white hover:text-pink px-1"
          >
            ✕
          </button>
        </div>

        {/* The whole point of the feature: nothing cropped. The image is
            capped in both axes against the viewport and contained, so a
            9:16 back piece is bounded by height and a wide banner by width
            — either way the full sheet is on screen. */}
        <div className="flex min-h-0 flex-1 items-center justify-center p-2 sm:p-4">
          {/* eslint-disable-next-line @next/next/no-img-element -- generated images come from provider CDNs; next/image needs domain config */}
          <img
            src={imageUrl}
            alt={alt}
            className="block max-h-[72vh] w-auto max-w-full object-contain"
          />
        </div>

        <div className="flex items-center justify-between gap-3 border-t-2 hairline px-3 py-2.5">
          {caption ? (
            <p className="min-w-0 font-body text-[10px] lowercase tracking-[0.06em] text-white/50">
              {caption}
            </p>
          ) : (
            <span />
          )}
          {(onPrev || onNext) && (
            <div className="flex shrink-0 items-center gap-3 font-body text-[10px] uppercase tracking-[0.2em]">
              <button
                type="button"
                onClick={onPrev}
                disabled={!onPrev}
                aria-label="Previous design"
                className="press text-white/60 hover:text-pink disabled:opacity-30 disabled:hover:text-white/60"
              >
                ◂ Prev
              </button>
              {step && (
                <span className="tabular-nums text-white/30">
                  {String(step.position).padStart(2, '0')} / {String(step.total).padStart(2, '0')}
                </span>
              )}
              <button
                type="button"
                onClick={onNext}
                disabled={!onNext}
                aria-label="Next design"
                className="press text-white/60 hover:text-pink disabled:opacity-30 disabled:hover:text-white/60"
              >
                Next ▸
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
