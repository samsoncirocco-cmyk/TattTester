/**
 * Resume rules for /design?ds= (spec 7).
 *
 * Who may resume:
 *  - an OWNED session (a charged action stamped `ownerUid`): only that uid;
 *  - an UNOWNED session (still in intake, nothing charged): only the browser
 *    that created it, proven by the resume key the opening converse call
 *    returned once. Only the key's SHA-256 is stored.
 *
 * Everyone else gets the session's public projection exactly as before (or
 * nothing, if they could not read it before) and no resume view.
 */
import { createHash, randomBytes, timingSafeEqual } from 'crypto';
import { HANDOFF_URL } from '../../designConversation';
import type { SessionResumeView, SessionRendering } from '../resumeContract';
import { ROUND_CLAIM_STALE_MS, type StoredSession } from './store';

export function hashResumeKey(key: string): string {
  return createHash('sha256').update(key, 'utf8').digest('hex');
}

/** A fresh resume key and the hash to persist. The key leaves exactly once. */
export function mintResumeKey(): { key: string; hash: string } {
  const key = randomBytes(24).toString('base64url');
  return { key, hash: hashResumeKey(key) };
}

function sameHash(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  return left.length === right.length && timingSafeEqual(left, right);
}

export interface ResumeCaller {
  /** Verified Firebase uid, or null when signed out. */
  uid: string | null;
  /** The raw resume key the browser sent, if any. */
  resumeKey?: string | null;
}

export function mayResume(session: StoredSession, caller: ResumeCaller): boolean {
  if (session.ownerUid) return caller.uid !== null && caller.uid === session.ownerUid;
  if (!session.resumeKeyHash || !caller.resumeKey) return false;
  return sameHash(session.resumeKeyHash, hashResumeKey(caller.resumeKey));
}

/** Derive the render state from the claim, never exposing its ids. */
export function renderingFromClaim(
  session: StoredSession,
  now: number = Date.now()
): SessionRendering | undefined {
  const claim = session.roundInFlight;
  if (!claim) return undefined;
  const at = Date.parse(claim.at);
  const since = Number.isFinite(at) ? new Date(at).toISOString() : new Date(0).toISOString();
  return {
    // The first reveal claims the slot while the session is still in
    // intake; every later claim is a refine round or re-roll.
    kind: session.phase === 'intake' ? 'reveal' : 'round',
    since,
    stale: !Number.isFinite(at) || now - at >= ROUND_CLAIM_STALE_MS,
  };
}

export function toResumeView(session: StoredSession, now: number = Date.now()): SessionResumeView {
  const conversation = session.conversation;
  const rendering = renderingFromClaim(session, now);
  const view: SessionResumeView = {
    transcript: (conversation?.transcript ?? []).map(({ role, text }) => ({ role, text })),
  };
  if (conversation?.stage) view.stage = conversation.stage;
  if (conversation?.stage === 'proposal' && conversation.playback) {
    view.playback = conversation.playback;
  }
  if (conversation?.stage === 'handoff') view.handoffUrl = HANDOFF_URL;
  if (conversation?.notes) view.notes = conversation.notes;
  if (rendering) view.rendering = rendering;
  return view;
}
