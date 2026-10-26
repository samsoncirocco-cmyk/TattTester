/**
 * Firestore persistence for swipe decisions (firebase-admin only).
 *
 * One document per (uid, artistId) in `match_decisions`, id `${uid}__${artistId}`.
 * A re-pin or a pass on the same artist overwrites, so writes are idempotent
 * without a key (contrast the booking paths, spec 5). The uid always comes
 * from a verified token — the old localStorage path keyed everything under a
 * hardcoded 'user-123', which is exactly what this replaces.
 *
 * Denied to every client in firestore.rules: decisions are personal data
 * about the customer's taste and are read and written through
 * /api/v1/match/decision(s) only. Firestore, not Neo4j: matching reads the
 * graph and a customer's pins must never mutate it.
 */
import { ensureAdminApp } from "@/lib/firebase-admin";

export const COLLECTION = "match_decisions";
export type Decision = "pin" | "pass";

export interface MatchDecision {
  uid: string;
  artistId: string;
  decision: Decision;
  dsId: string | null;
  source: "swipe";
  decidedAt: number;
  updatedAt: number;
}

/** Newest-first read cap. */
export const MAX_DECISIONS_READ = 500;
/** Per-uid document cap; oldest decisions are evicted beyond it. */
export const MAX_DECISIONS_PER_UID = 2000;
/** A decision older than this no longer hides a card (spec 13 §8.2). */
export const DECISION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export function decisionDocId(uid: string, artistId: string): string {
  return `${uid}__${artistId}`;
}

async function firestore() {
  if (!ensureAdminApp()) return null;
  const { getFirestore } = await import("firebase-admin/firestore");
  return getFirestore();
}

/** Can decisions be stored right now? False means the client keeps retrying. */
export async function decisionsWritable(): Promise<boolean> {
  return Boolean(ensureAdminApp());
}

/**
 * Upsert one decision. `decidedAt` is kept from the first write; `updatedAt`
 * moves on every write. Both are server clocks — the client's is never trusted.
 */
export async function recordDecision(input: {
  uid: string;
  artistId: string;
  decision: Decision;
  dsId?: string | null;
  nowMs?: number;
}): Promise<boolean> {
  const db = await firestore();
  if (!db) return false;
  const now = input.nowMs ?? Date.now();
  const ref = db.collection(COLLECTION).doc(decisionDocId(input.uid, input.artistId));
  const existing = await ref.get();
  const prior = existing.exists ? (existing.data() as Partial<MatchDecision>) : null;
  const doc: MatchDecision = {
    uid: input.uid,
    artistId: input.artistId,
    decision: input.decision,
    dsId: input.dsId ?? prior?.dsId ?? null,
    source: "swipe",
    decidedAt: typeof prior?.decidedAt === "number" ? prior.decidedAt : now,
    updatedAt: now,
  };
  await ref.set(doc);
  await evictBeyondCap(db, input.uid);
  return true;
}

/** Keep a hand-crafted flood of ids from growing one uid's set without bound. */
async function evictBeyondCap(
  db: Awaited<ReturnType<typeof firestore>>,
  uid: string,
): Promise<void> {
  if (!db) return;
  try {
    const agg = await db.collection(COLLECTION).where("uid", "==", uid).count().get();
    const total = agg.data().count;
    const excess = total - MAX_DECISIONS_PER_UID;
    if (excess <= 0) return;
    const oldest = await db
      .collection(COLLECTION)
      .where("uid", "==", uid)
      .orderBy("updatedAt", "asc")
      .limit(excess)
      .get();
    const batch = db.batch();
    oldest.docs.forEach((d) => batch.delete(d.ref));
    await batch.commit();
  } catch (err) {
    console.warn(
      `[decisions] cap eviction failed for ${uid}:`,
      err instanceof Error ? err.message : err,
    );
  }
}

export async function removeDecision(uid: string, artistId: string): Promise<boolean> {
  const db = await firestore();
  if (!db) return false;
  await db.collection(COLLECTION).doc(decisionDocId(uid, artistId)).delete();
  return true;
}

/**
 * The caller's decisions, newest first, capped. With `dsId` only the deck that
 * produced them; otherwise everything still inside the 30-day window.
 */
export async function listDecisions(
  uid: string,
  opts: { dsId?: string | null; nowMs?: number } = {},
): Promise<Array<Pick<MatchDecision, "artistId" | "decision" | "dsId" | "updatedAt">>> {
  const db = await firestore();
  if (!db) return [];
  const now = opts.nowMs ?? Date.now();
  let q = db.collection(COLLECTION).where("uid", "==", uid);
  if (opts.dsId) {
    q = q.where("dsId", "==", opts.dsId);
  } else {
    q = q.where("updatedAt", ">=", now - DECISION_TTL_MS);
  }
  const snap = await q.orderBy("updatedAt", "desc").limit(MAX_DECISIONS_READ).get();
  return snap.docs.map((d) => {
    const data = d.data() as MatchDecision;
    return {
      artistId: data.artistId,
      decision: data.decision,
      dsId: data.dsId ?? null,
      updatedAt: data.updatedAt,
    };
  });
}
