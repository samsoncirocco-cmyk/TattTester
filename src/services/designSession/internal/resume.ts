/**
 * Reload resume for /design (#394).
 *
 * Samson ruled auto-resume of the most recent unfinished session, with an
 * explicit start-over. The page used to keep the session id in React state
 * only, so a reload always opened a new conversation even when the
 * half-finished design was still in the store.
 *
 * Two ways back in, newest updatedAt wins:
 * - a hinted session id (sessionStorage). This is the only path for a
 *   session that has not been charged yet, because those stay unowned.
 * - the account pointer written when ownership is stamped, so a picked
 *   cut survives a reload on another browser once the visitor is signed in.
 *
 * The transcript is the visitor's own chat. TurnLogs, confidence, and the
 * raw intake record stay on the server. An id that belongs to someone else
 * resolves to nothing — same existence-hiding posture as the ownership gate.
 */
import type { SessionNotes } from '../../designConversation/types';
import { buildSessionNotes, withReferenceNotes } from '../../designConversation/internal/notes';
import type { DesignSessionResume } from '../types';
import {
  isResumableSession,
  resolveSessionStore,
  toDesignSession,
  type StoredSession,
} from './store';

function canRead(session: StoredSession, uid: string | null, viaHint: boolean): boolean {
  if (session.ownerUid) return uid !== null && session.ownerUid === uid;
  return viaHint;
}

function projectResume(session: StoredSession): DesignSessionResume {
  const conversation = session.conversation;
  const record = conversation?.record ?? {};
  let notes: SessionNotes | undefined = conversation ? buildSessionNotes(record, []) : undefined;
  const summaries = (conversation?.references ?? []).map((reference) => reference.summary).filter(Boolean);
  if (notes && summaries.length > 0) {
    notes = withReferenceNotes(notes, record, summaries);
  }
  return {
    sessionId: session.id,
    phase: session.phase,
    updatedAt: session.updatedAt,
    transcript: conversation?.transcript ?? [],
    ...(conversation ? { stage: conversation.stage } : {}),
    ...(conversation?.playback ? { playback: conversation.playback } : {}),
    ...(notes ? { notes } : {}),
    session: toDesignSession(session),
  };
}

export async function resolveDesignResume(args: {
  uid: string | null;
  hintedSessionId: string | null;
}): Promise<DesignSessionResume | null> {
  const store = resolveSessionStore();
  const candidates: StoredSession[] = [];
  const hinted = args.hintedSessionId?.trim() || null;

  if (hinted) {
    const session = await store.get(hinted);
    if (session && canRead(session, args.uid, true) && isResumableSession(session)) {
      candidates.push(session);
    }
  }

  if (args.uid) {
    const pointerId = await store.getOwnerPointer(args.uid);
    if (pointerId && pointerId !== hinted) {
      const session = await store.get(pointerId);
      if (session && session.ownerUid === args.uid && isResumableSession(session)) {
        candidates.push(session);
      }
    }
  }

  candidates.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
  const winner = candidates[0];
  return winner ? projectResume(winner) : null;
}

/**
 * Start over. The session is kept (a charged reveal is not thrown away)
 * and marked so the next load will not pick it up. A caller who cannot
 * read the session gets the same silence as a missing id.
 */
export async function dismissDesignResume(args: {
  uid: string | null;
  sessionId: string;
}): Promise<void> {
  const store = resolveSessionStore();
  const session = await store.get(args.sessionId);
  if (!session || !canRead(session, args.uid, true)) return;
  if (session.resumeDismissed) return;
  session.resumeDismissed = true;
  session.updatedAt = new Date().toISOString();
  await store.save(session);
}
