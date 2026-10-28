/**
 * Design-library search, server side.
 *
 * `filterDesignsByQuery` is the candidate generator (the same keyword
 * filter the client library uses). This function reranks that shortlist
 * by fit to the brief when TYPESAFE_RERANK is on. The client `searchDesigns`
 * helper stays synchronous and does not call TypeSafe — the API key is
 * server-only.
 */

import {
  filterDesignsByQuery,
  type Design,
} from '@/services/designLibraryService';
import { rerankByBrief, type Ranked } from './typesafeRerank';

export function designCandidateProfile(design: Design): Record<string, unknown> {
  return compact({
    style: clip(design.userInput?.style, 120),
    subject: clip(design.userInput?.subject, 200),
    placement: clip(design.userInput?.bodyPart, 120),
    size: clip(design.userInput?.size, 40),
    notes: clip(design.notes, 400),
    tags: (design.tags || []).filter((tag) => typeof tag === 'string' && tag.trim()).slice(0, 12),
    description: clip(design.metadata?.prompt || design.notes, 600),
  });
}

export async function searchDesignCandidates(brief: string, designs: Design[]): Promise<Array<Ranked<Design>>> {
  const candidates = filterDesignsByQuery(designs, brief);
  return rerankByBrief({
    brief: { text: brief },
    candidates,
    profile: designCandidateProfile,
  });
}

function clip(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed.length > max ? trimmed.slice(0, max) : trimmed;
}

function compact(record: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (value === undefined || value === null) continue;
    if (typeof value === 'string' && value.length === 0) continue;
    if (Array.isArray(value) && value.length === 0) continue;
    out[key] = value;
  }
  return out;
}
