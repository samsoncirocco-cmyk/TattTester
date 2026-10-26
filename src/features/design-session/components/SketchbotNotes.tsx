'use client';

import { useState } from 'react';
import type { SessionNotes } from '@/services/designConversation/types';

/**
 * SketchBot's live notepad (TAT-48): the session's intake record rendered
 * as a designed brief beside the conversation — placement, cast (every
 * member enumerated), style, scene, vibe, and the IP heads-up when the
 * rule fired.
 *
 * HARD RULE (TAT-47 defect 8, revealNarration precedent): this component
 * receives ONLY the whitelisted SessionNotes projection — internal
 * rationale, confidence scores, and axis telemetry never reach it, and it
 * renders nothing beyond the fields the user would recognize as their own
 * words.
 *
 * Tap-to-fix: every entry prefills a correction into the chat input — the
 * correction is just another converse message (ADR-0020), no new API.
 */

export const NOTES_TITLE = "sketchbot's notes";
export const NOTES_HINT = 'tap to fix';
export const NOTES_EMPTY_LINE = 'nothing yet — talk to me.';
export const IP_HEADS_UP_LINE =
  'heads-up: inspired-by take — your artist dials in the exact likeness.';
export const DRAW_CTA_LABEL = 'ready when you are — draw 2 cuts ▸';

/** Persistent stall signal (#376). The chat question can scroll away. */
export const PLACEMENT_GAP_LINE =
  'still need where on your body this goes before I can draw.';

interface NoteRow {
  key: string;
  label: string;
  value: string;
  /** Prefilled correction opener for the chat input. */
  fix: string;
}

function rowsFrom(notes: SessionNotes): NoteRow[] {
  const rows: NoteRow[] = [];
  if (notes.placement) {
    rows.push({
      key: 'placement',
      label: 'placement',
      value: notes.placement,
      fix: 'actually, the placement is ',
    });
  }
  notes.cast.forEach((member, index) => {
    rows.push({
      key: `cast-${index}`,
      label:
        index === 0 ? (notes.cast.length > 1 ? `cast (${notes.cast.length})` : 'subject') : '',
      value: member,
      fix: 'actually, about the cast — ',
    });
  });
  if (notes.style) {
    rows.push({ key: 'style', label: 'style', value: notes.style, fix: 'actually, the style is ' });
  }
  if (notes.scene) {
    rows.push({ key: 'scene', label: 'scene', value: notes.scene, fix: 'actually, the scene is ' });
  }
  if (notes.vibe) {
    rows.push({ key: 'vibe', label: 'vibe', value: notes.vibe, fix: 'actually, what it means is ' });
  }
  (notes.references ?? []).forEach((summary, index) => {
    // Reference images (TAT-50): one designed summary line per photo —
    // never the raw analysis structure (same whitelist as everything here).
    rows.push({
      key: `reference-${index}`,
      label:
        index === 0
          ? (notes.references!.length > 1 ? `references (${notes.references!.length})` : 'reference')
          : '',
      value: summary,
      fix: 'about that reference photo — ',
    });
  });
  return rows;
}

export interface SketchbotNotesProps {
  notes?: SessionNotes;
  /**
   * The reveal fired: the notepad becomes a static brief — no chat input
   * exists to fix into, and the CTA's job is done.
   */
  locked?: boolean;
  /** Tap-to-fix: receives the correction prefix for the chat input. */
  onFix?: (prefill: string) => void;
  /** Proposal reached — anchor the draw CTA at the notepad's bottom. */
  drawReady?: boolean;
  onDraw?: () => void;
  /** The user has spoken and placement is still empty (#376). */
  placementNeeded?: boolean;
}

/** The rows + heads-up + CTA, shared by the desktop card and mobile sheet. */
function NotesBody({
  notes,
  locked = false,
  onFix,
  drawReady = false,
  onDraw,
  placementNeeded = false,
}: SketchbotNotesProps) {
  const rows = notes ? rowsFrom(notes) : [];
  const gap = placementNeeded ? (
    <p role="status" className="px-2 pb-2 font-body text-[12px] leading-[1.5] text-pink">
      {PLACEMENT_GAP_LINE}
    </p>
  ) : null;

  if (rows.length === 0) {
    return (
      <div className="space-y-2">
        <p className="font-body text-[13px] text-white/40">{NOTES_EMPTY_LINE}</p>
        {gap}
      </div>
    );
  }

  return (
    <div className="space-y-1">
      {gap}
      {rows.map((row) =>
        locked || !onFix ? (
          <div key={row.key} className="flex gap-3 px-2 py-1.5">
            <span className="w-20 shrink-0 font-body text-[10px] uppercase tracking-[0.2em] text-white/40 pt-0.5">
              {row.label}
            </span>
            <span className="font-body text-[13px] leading-[1.5] text-white/85">{row.value}</span>
          </div>
        ) : (
          <button
            key={row.key}
            type="button"
            aria-label={`fix ${row.label || 'cast'}: ${row.value}`}
            onClick={() => onFix(row.fix)}
            className="press w-full text-left flex gap-3 px-2 py-1.5 hover:bg-pink/10 hover:outline hover:outline-1 hover:outline-pink/40"
          >
            <span className="w-20 shrink-0 font-body text-[10px] uppercase tracking-[0.2em] text-white/40 pt-0.5">
              {row.label}
            </span>
            <span className="font-body text-[13px] leading-[1.5] text-white/85">{row.value}</span>
          </button>
        )
      )}

      {notes?.ipHeadsUp && (
        <p className="px-2 pt-2 font-body text-[11px] leading-[1.5] text-white/50">
          <span className="text-pink">!</span>&nbsp;&nbsp;{IP_HEADS_UP_LINE}
        </p>
      )}

      {drawReady && !locked && onDraw && (
        <div className="pt-3">
          <button
            type="button"
            onClick={onDraw}
            className="press w-full bg-pink text-black font-display text-[15px] leading-none tracking-[0.02em] uppercase px-4 py-3.5"
          >
            {DRAW_CTA_LABEL}
          </button>
        </div>
      )}
    </div>
  );
}

/** Desktop: the persistent panel beside the conversation. */
export function SketchbotNotesCard(props: SketchbotNotesProps) {
  const hasRows = props.notes ? rowsFrom(props.notes).length > 0 : false;
  return (
    <section aria-label={NOTES_TITLE} className="border hairline bg-white/[0.02] p-4">
      <header className="flex items-baseline justify-between gap-4 pb-3 border-b hairline mb-3">
        <h2 className="font-body text-[11px] uppercase tracking-[0.25em] text-white/70">
          <span className="text-pink">●</span>&nbsp;&nbsp;{NOTES_TITLE}
        </h2>
        {hasRows && !props.locked && (
          <span className="font-body text-[10px] uppercase tracking-[0.2em] text-pink/80">
            {NOTES_HINT}
          </span>
        )}
      </header>
      <NotesBody {...props} />
    </section>
  );
}

/**
 * Mobile: a collapsible pull-up sheet pinned to the bottom edge. Default
 * peeking (the header bar), tap to expand. Same body, same hard rule.
 */
export function MobileNotesSheet(props: SketchbotNotesProps) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="md:hidden fixed inset-x-0 bottom-0 z-40 border-t hairline bg-black/95 backdrop-blur-sm">
      <button
        type="button"
        aria-expanded={expanded}
        aria-label={`${NOTES_TITLE} — ${expanded ? 'collapse' : 'expand'}`}
        onClick={() => setExpanded((v) => !v)}
        className="press w-full flex items-center justify-between px-5 py-3"
      >
        <span className="font-body text-[11px] uppercase tracking-[0.25em] text-white/70">
          <span className="text-pink">●</span>&nbsp;&nbsp;{NOTES_TITLE}
        </span>
        <span className="font-body text-[12px] text-pink">{expanded ? '▾' : '▴'}</span>
      </button>
      {expanded && (
        <div className="max-h-[55vh] overflow-y-auto px-4 pb-5">
          <NotesBody {...props} />
        </div>
      )}
    </div>
  );
}
