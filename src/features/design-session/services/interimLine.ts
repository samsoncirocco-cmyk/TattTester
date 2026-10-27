// The one line said the moment a reveal is confirmed, before any cut exists
// (spec 10): "drawing your Deku, forearm, fine line." It echoes only what
// the notepad already shows the customer (SessionNotes, the whitelisted
// projection), so it never reports Council output the client does not have
// and never quotes the freeform meaning.

import type { SessionNotes } from '@/services/designConversation/types';
import { trimAtWord } from './revealNarration';

function castPhrase(cast: readonly string[]): string | undefined {
  const names = cast.map((name) => name.trim()).filter(Boolean);
  if (names.length === 0) return undefined;
  if (names.length === 1) return trimAtWord(names[0]);
  if (names.length === 2) return trimAtWord(`${names[0]} and ${names[1]}`);
  return `cast of ${names.length}`;
}

export function interimLine(notes: SessionNotes | undefined): string | null {
  if (!notes) return null;
  const cast = castPhrase(notes.cast ?? []);
  const parts = [
    notes.placement?.trim() ? trimAtWord(notes.placement) : undefined,
    notes.style?.trim() ? trimAtWord(notes.style) : undefined,
  ].filter((part): part is string => Boolean(part));
  if (!cast && parts.length === 0) return null;
  return `drawing your ${cast ?? 'design'}${parts.length ? `, ${parts.join(', ')}` : ''}.`;
}
