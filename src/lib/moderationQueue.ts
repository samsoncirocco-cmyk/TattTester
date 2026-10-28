/**
 * Minimal queue for moderation decisions a person has to see.
 *
 * There is no admin moderation inbox in this repo. Takedown and reinstatement
 * already email ops and stay `pending` until a human runs the executor. This
 * record is the extra durable flag for those, and the only queue for a design
 * prompt that was not generated.
 *
 * The record is append-only. Nothing here deletes user data, closes a
 * takedown, or sets status to anything but `open`.
 */
import { randomUUID } from 'crypto';
import { ensureAdminApp } from '@/lib/firebase-admin';
import { logger } from '@/lib/logger';
import type { ModerationAction, ModerationSurface } from '@/lib/contentModeration';

const COLLECTION = 'content_moderation_flags';
const EXCERPT_CHARS = 1000;

export interface ModerationFlag {
  id: string;
  surface: ModerationSurface;
  action: Extract<ModerationAction, 'review' | 'block'>;
  /** Always open. A person closes it; this module never does. */
  status: 'open';
  severity: number;
  confidence: number;
  nouls: Record<string, number>;
  excerpt: string;
  subjectId: string | null;
  createdAt: string;
}

const globalKey = '__tattModerationFlags';
type FlagGlobal = typeof globalThis & { [globalKey]?: Map<string, ModerationFlag> };
const flags: Map<string, ModerationFlag> =
  (globalThis as FlagGlobal)[globalKey] ??
  ((globalThis as FlagGlobal)[globalKey] = new Map<string, ModerationFlag>());

/** In-memory flags, newest first. Tests and a process without Firestore read this. */
export function listModerationFlags(): ModerationFlag[] {
  return [...flags.values()].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

/** Test isolation. Does not talk to Firestore and does not delete product data. */
export function clearModerationFlags(): void {
  flags.clear();
}

export async function recordModerationFlag(input: {
  surface: ModerationSurface;
  action: Extract<ModerationAction, 'review' | 'block'>;
  severity: number;
  confidence: number;
  nouls: Record<string, number>;
  text: string;
  subjectId?: string | null;
}): Promise<{ flag: ModerationFlag; durable: boolean }> {
  const flag: ModerationFlag = {
    id: randomUUID(),
    surface: input.surface,
    action: input.action,
    status: 'open',
    severity: input.severity,
    confidence: input.confidence,
    nouls: input.nouls,
    excerpt: input.text.trim().slice(0, EXCERPT_CHARS),
    subjectId: input.subjectId ?? null,
    createdAt: new Date().toISOString(),
  };
  flags.set(flag.id, flag);

  try {
    if (!ensureAdminApp()) return { flag, durable: false };
    const { getFirestore } = await import('firebase-admin/firestore');
    await getFirestore().collection(COLLECTION).doc(flag.id).set(flag);
    return { flag, durable: true };
  } catch (error) {
    // Losing the durable copy must not delete anything or resolve a takedown.
    logger.warn({
      event_type: 'moderation.flag_unpersisted',
      surface: flag.surface,
      action: flag.action,
      flag_id: flag.id,
      excerpt: flag.excerpt,
      error: error instanceof Error ? error.message.slice(0, 200) : String(error).slice(0, 200),
    });
    return { flag, durable: false };
  }
}
