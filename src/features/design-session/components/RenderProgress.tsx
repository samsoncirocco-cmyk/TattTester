'use client';

import type { Variation } from '@/services/designSession/types';
import { ChatBubble } from './ChatBubble';
import { GeneratingBeat } from './GeneratingBeat';
import { RevealGrid } from './RevealGrid';

/** Every charged render is two cuts (ADR-0049). */
const CUTS_PER_ROUND = 2;

/**
 * The wait for a two-cut render (spec 9): the beat with its elapsed count,
 * and any cut that already landed, shown plainly beside a waiting tile.
 * Landed cuts can be opened full size but not picked: the pick is a choice
 * between two, so it opens only when the round is delivered.
 *
 * `interim` (spec 10) is the one line said before anything exists — what
 * is being drawn, echoed from the brief the customer already sees.
 */
export function RenderProgress({
  lines,
  startedAt,
  preview,
  indexOffset = 0,
  interim,
}: {
  lines: readonly string[];
  startedAt?: number;
  preview: Variation[];
  indexOffset?: number;
  interim?: string | null;
}) {
  return (
    <div className="space-y-4">
      {interim && <ChatBubble role="bot">{interim}</ChatBubble>}
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
