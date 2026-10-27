'use client';

import type { Variation } from '@/services/designSession/types';
import { GeneratingBeat } from './GeneratingBeat';
import { RevealGrid } from './RevealGrid';

/** Every charged render is two cuts (ADR-0049). */
const CUTS_PER_ROUND = 2;

/**
 * The wait for a two-cut render (spec 9): the beat with its elapsed count,
 * and any cut that already landed, shown plainly beside a waiting tile.
 * Landed cuts can be opened full size but not picked: the pick is a choice
 * between two, so it opens only when the round is delivered.
 */
export function RenderProgress({
  lines,
  startedAt,
  preview,
  indexOffset = 0,
}: {
  lines: readonly string[];
  startedAt?: number;
  preview: Variation[];
  indexOffset?: number;
}) {
  return (
    <div className="space-y-4">
      <GeneratingBeat lines={lines} startedAt={startedAt} />
      {preview.length > 0 && (
        <RevealGrid
          variations={preview}
          mode="preview"
          indexOffset={indexOffset}
          pendingSlots={CUTS_PER_ROUND - preview.length}
        />
      )}
    </div>
  );
}
