'use client';

import { useCallback, useRef, useState } from 'react';
import type { Variation } from '@/services/designSession/types';
import { cutIdentity } from '@/services/designSession/cutIdentity';
import { CutLightbox } from './CutLightbox';

export type RevealMode = 'pick' | 'not-you' | 'locked';

/**
 * How wide or tall a measured cut is allowed to make the grid's frame.
 * The renders come back at whatever ratio the session pinned, and nothing
 * validates that on the way in — a stray 1:3 would otherwise hand the
 * transcript a pair of skyscrapers that push the round's controls off the
 * fold. Anything outside the clamp still shows in full inside the frame
 * (`object-contain`), just letterboxed.
 */
const MIN_FRAME_RATIO = 0.55; // ~9:16, the tall end we actually generate
const MAX_FRAME_RATIO = 1.9; // ~16:9

/**
 * The round reveal (ADR-0012, ADR-0049): two named cuts side by side, tap
 * the one that's closer. The same grid can still host the most-not-you tap
 * ('not-you' mode) where a flow needs the one clean negative signal.
 *
 * The theater (TAT-52): cuts land one at a time on the design system's
 * `snap` hard cut-in — `.reveal-cut-1..4` spaces them a full beat apart
 * (260ms; `prefers-reduced-motion` renders everything at once). Each cut
 * carries a human name derived from its variation axes (`cutIdentity` —
 * designed strings only, never raw axis internals). The pick lands as a
 * tape-corner tag on a tilted card; the most-not-you round flips the
 * remaining cuts to a dashed "not you?" affordance.
 *
 * ## The frame, and why it is measured instead of square (TAT-58)
 *
 * This grid used to render every cut as `aspect-square object-cover`. The
 * session pins an aspect ratio per design (`session.pinnedAspectRatio`),
 * and a back piece comes back tall — so `object-cover` inside a forced
 * square was quietly slicing the top and bottom off the artwork. A
 * customer choosing between two designs was choosing between two crops.
 *
 * The fix has to hold two things at once: show every pixel, and keep the
 * pair reading as a matched set. A tile-by-tile natural-size layout gives
 * up the second one — two cuts of different heights sitting side by side
 * stop looking like one round. So the grid measures the *first* image that
 * loads and applies that ratio as the frame for every tile, with
 * `object-contain` inside as the guarantee that nothing is ever cut. Both
 * cuts of a round share a pinned ratio by construction, so in practice the
 * frame fits the art exactly and there is no letterbox at all; when it
 * doesn't, the tiles stay aligned and the odd one out is matted rather
 * than cropped.
 *
 * The mat is `bg-bone` (#f5f5f0) on purpose. The renders are flash art on
 * a near-white ground (`PRESENTATION_LEAD` in the council's structured
 * mode), so bone letterboxing disappears into the artwork's own paper
 * instead of punching black bars through it — which is what a dark mat
 * would do on this UI.
 *
 * The grid cannot read `pinnedAspectRatio` itself: it is handed
 * `Variation[]`, not the session, and both call sites in
 * `DesignSessionFlow` pass slices of one. Measuring keeps the fix inside
 * this component instead of threading a new prop through the flow.
 */
export function RevealGrid({
  variations,
  mode,
  pickId,
  onSelect,
  indexOffset = 0,
}: {
  variations: Variation[];
  mode: RevealMode;
  pickId?: string;
  onSelect?: (variationId: string) => void;
  /**
   * Where this grid's cuts start counting. The critique lane (ADR-0039)
   * renders its re-cuts in a second grid below the reveal — without an offset
   * both grids would announce a "Design 1", leaving two identically-labelled
   * pick targets for anyone on a screen reader.
   */
  indexOffset?: number;
}) {
  const [frameRatio, setFrameRatio] = useState<number | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  /**
   * The expand controls, by variation id, so closing the lightbox can put
   * focus back where it came from. Focus returns to the cut the customer
   * was *looking at* when they closed, not the one they opened — after
   * arrowing across the round, the first is where they think they are.
   */
  const expandTriggers = useRef(new Map<string, HTMLButtonElement | null>());

  const measureFrame = useCallback((image: HTMLImageElement | null) => {
    if (!image) return;
    const { naturalWidth, naturalHeight } = image;
    // Zero on a broken or not-yet-decoded image, and in jsdom, where no
    // image ever decodes — the square default carries those cases.
    if (!naturalWidth || !naturalHeight) return;
    const ratio = Math.min(MAX_FRAME_RATIO, Math.max(MIN_FRAME_RATIO, naturalWidth / naturalHeight));
    setFrameRatio((current) => current ?? ratio);
  }, []);

  // Only cuts that actually rendered an image can be expanded, and they are
  // what the arrow keys step through — a failed cut is not a stop on the way.
  const expandable = variations.filter((variation) => variation.imageUrl);
  const expandedPosition = expandable.findIndex((variation) => variation.id === expandedId);
  const expanded = expandedPosition >= 0 ? expandable[expandedPosition] : null;
  const expandedIndex = expanded ? variations.indexOf(expanded) + indexOffset : 0;
  const expandedIdentity = expanded
    ? cutIdentity(expanded, expandedIndex)
    : { name: '', caption: '' };

  const closeLightbox = useCallback(() => {
    setExpandedId((current) => {
      // Restore focus synchronously against the id being closed: the
      // trigger is already in the document, so this lands before the
      // dialog unmounts and takes the focused node with it.
      if (current) expandTriggers.current.get(current)?.focus();
      return null;
    });
  }, []);

  const frameStyle = { aspectRatio: String(frameRatio ?? 1) };

  return (
    <div className="grid grid-cols-2 gap-3">
      {variations.map((variation, position) => {
        const i = position + indexOffset;
        const { name, caption } = cutIdentity(variation, i);
        const isPick = variation.id === pickId;
        const notYouCandidate = mode === 'not-you' && !isPick;
        const disabled = mode === 'locked' || (mode === 'not-you' && isPick);
        const label = notYouCandidate
          ? `Design ${i + 1} feels most not me — ${name}`
          : `Pick design ${i + 1} — ${name}`;
        return (
          <div key={variation.id} className={`reveal-cut reveal-cut-${position + 1}`}>
            {/* The expand control is a SIBLING of the pick target, not a
                child of it. Two reasons, both load-bearing: a button inside
                a button is invalid HTML that browsers reflow unpredictably,
                and as a sibling there is no bubbling path from "see it big"
                into "this is my pick" — the round's signal cannot be fired
                by a customer who only wanted a closer look. It also stays
                reachable in 'locked' mode, where the pick target is
                disabled: the critique lane's re-cuts render locked, and
                those are exactly the ones people want to inspect. */}
            {/* The tilt of a confirmed pick lives on this wrapper, not on
                the pick target itself, so the expand control tilts with the
                card instead of sitting square on a crooked one (and so
                `.press`'s active transform stops cancelling the rotation). */}
            <div className={`relative ${isPick ? '-rotate-1' : ''}`}>
              <button
                type="button"
                disabled={disabled}
                onClick={() => onSelect?.(variation.id)}
                aria-label={label}
                className={`press relative block w-full border-2 ${
                  isPick
                    ? 'border-pink'
                    : notYouCandidate
                      ? 'border-dashed hairline-white hover:border-pink'
                      : 'hairline-white hover:border-pink'
                } ${disabled && !isPick ? 'opacity-40' : ''}`}
              >
                {variation.imageUrl ? (
                  <div className="block w-full overflow-hidden bg-bone" style={frameStyle}>
                    {/* eslint-disable-next-line @next/next/no-img-element -- generated images come from provider CDNs; next/image needs domain config */}
                    <img
                      src={variation.imageUrl}
                      alt={`Design ${i + 1}`}
                      // A cached image can already be complete before React
                      // attaches onLoad, so measure from both doors.
                      ref={measureFrame}
                      onLoad={(event) => measureFrame(event.currentTarget)}
                      className="block h-full w-full object-contain"
                    />
                  </div>
                ) : (
                  <div
                    className="flex w-full items-center justify-center font-display text-white/30 text-[24px]"
                    style={frameStyle}
                  >
                    ✕
                  </div>
                )}
                {isPick && (
                  // Tape-corner confirm — pink tape, hard white shadow, crooked
                  // on purpose. Mounts with the pick, so it snaps in on cue.
                  <span
                    className="reveal-cut absolute -top-2 -left-2 -rotate-3 bg-pink text-black font-body text-[10px] uppercase tracking-[0.2em] px-2 py-1 shadow-[3px_3px_0_0_#f5f5f0]"
                  >
                    Your pick
                  </span>
                )}
                {notYouCandidate && (
                  <span className="absolute bottom-2 right-2 border hairline-white bg-black/70 font-body text-[10px] lowercase tracking-[0.14em] text-white/70 px-2 py-1">
                    not you?
                  </span>
                )}
              </button>
              {variation.imageUrl && (
                // Top-right is the one free corner: the pick tape owns the
                // top-left and the "not you?" chip the bottom-right.
                <button
                  type="button"
                  ref={(node) => {
                    expandTriggers.current.set(variation.id, node);
                  }}
                  onClick={() => setExpandedId(variation.id)}
                  aria-label={`See design ${i + 1} full size — ${name}`}
                  aria-haspopup="dialog"
                  className="press absolute top-2 right-2 z-10 border hairline-white bg-black/70 font-body text-[10px] uppercase tracking-[0.18em] text-white/70 px-2 py-1 hover:border-pink hover:bg-pink hover:text-black"
                >
                  Full
                </button>
              )}
            </div>
            <div className="mt-2 space-y-0.5">
              <p className="font-body text-[11px] lowercase tracking-[0.1em] text-white">
                {name}
              </p>
              {caption && (
                <p className="font-body text-[10px] lowercase tracking-[0.06em] text-white/50">
                  {caption}
                </p>
              )}
            </div>
          </div>
        );
      })}
      {expanded?.imageUrl && (
        <CutLightbox
          imageUrl={expanded.imageUrl}
          // Same numbering the grid announces, `indexOffset` included, so
          // the dialog and the tile behind it name the same design.
          alt={`Design ${expandedIndex + 1}`}
          name={expandedIdentity.name}
          caption={expandedIdentity.caption}
          step={{ position: expandedPosition + 1, total: expandable.length }}
          onClose={closeLightbox}
          onPrev={
            expandedPosition > 0
              ? () => setExpandedId(expandable[expandedPosition - 1].id)
              : undefined
          }
          onNext={
            expandedPosition < expandable.length - 1
              ? () => setExpandedId(expandable[expandedPosition + 1].id)
              : undefined
          }
        />
      )}
    </div>
  );
}
