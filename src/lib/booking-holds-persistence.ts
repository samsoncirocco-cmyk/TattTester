/**
 * Firestore persistence for slot holds (firebase-admin only).
 *
 * The pure logic lives in `booking-holds.ts`. This file exists for one reason:
 * a hold is only exclusive if the *check* and the *write* are atomic. Two
 * clients hitting "book this slot" in the same second must not both read "no
 * conflicting holds" and both write one — which is exactly the bug the hold was
 * introduced to fix, reproduced one layer down.
 *
 * So `placeHold` runs inside a Firestore transaction: it reads this artist's
 * active holds, calls `requestHold` on the result, and writes only if that
 * says yes. Firestore aborts and retries the transaction if the read set
 * changed underneath, so the loser sees the winner's hold and is refused.
 *
 * Collection: `booking_holds/{holdId}`, denied to every client in
 * firestore.rules — a hold is server state and a client that could write one
 * could reserve an artist's entire month.
 *
 * `holdsWritable()` is what `resolveBookingMode` consults: if this store is
 * unavailable, no artist gets the reservation model, because a "reservation"
 * we cannot make exclusive is just the old double-booking with better copy.
 */
import { randomUUID } from "crypto";
import { ensureAdminApp } from "./firebase-admin";
import {
  requestHold,
  releaseHold,
  convertHold,
  liveHolds,
  type Hold,
  type HeldSlot,
  type HoldRefusal,
} from "./booking-holds";

const COLLECTION = "booking_holds";

export type PlaceHoldOutcome =
  | { ok: true; hold: Hold }
  | { ok: false; reason: HoldRefusal | "unavailable" };

async function firestore() {
  if (!ensureAdminApp()) return null;
  const { getFirestore } = await import("firebase-admin/firestore");
  return getFirestore();
}

/**
 * Can we take exclusive holds right now? False degrades every artist to the
 * request model rather than offering slots nothing can reserve.
 */
export async function holdsWritable(): Promise<boolean> {
  return Boolean(ensureAdminApp());
}

/** Every hold for this artist that is still reserving its slot. */
export async function listLiveHolds(
  artistId: string,
  nowMs: number,
): Promise<Hold[]> {
  const db = await firestore();
  if (!db) return [];
  try {
    const snap = await db
      .collection(COLLECTION)
      .where("artistId", "==", artistId)
      .where("status", "==", "active")
      .get();
    return liveHolds(
      snap.docs.map((d) => d.data() as Hold),
      nowMs,
    );
  } catch (err) {
    console.warn(
      '[holds] live-hold read failed:',
      { artistId },
      err instanceof Error ? err.message : err,
    );
    return [];
  }
}

/**
 * Take an exclusive hold on one slot, atomically.
 *
 * The conflict check runs inside the transaction against the same read set the
 * write commits on. On a read-write race Firestore retries, so the second
 * caller re-reads, sees the first caller's hold, and is refused with
 * `slot_held` — which is the whole point of this file.
 */
export async function placeHold(input: {
  artistId: string;
  bookingId: string;
  slot: HeldSlot;
  nowMs?: number;
}): Promise<PlaceHoldOutcome> {
  const db = await firestore();
  if (!db) return { ok: false, reason: "unavailable" };
  const nowMs = input.nowMs ?? Date.now();
  const holdId = `hold_${randomUUID()}`;

  try {
    return await db.runTransaction(async (tx) => {
      // Read inside the transaction: this read set is what Firestore watches,
      // and a concurrent write to it aborts and retries us.
      const snap = await tx.get(
        db
          .collection(COLLECTION)
          .where("artistId", "==", input.artistId)
          .where("status", "==", "active"),
      );
      const existing = snap.docs.map((d) => d.data() as Hold);

      const result = requestHold({
        existing,
        artistId: input.artistId,
        bookingId: input.bookingId,
        slot: input.slot,
        nowMs,
        holdId,
      });
      if (!result.ok) return { ok: false as const, reason: result.reason };

      // A booking refreshing its own hold gets a new document; the old one is
      // released in the same transaction so it cannot block anyone later.
      for (const doc of snap.docs) {
        if ((doc.data() as Hold).bookingId === input.bookingId) {
          tx.update(doc.ref, { status: "released" });
        }
      }
      tx.set(db.collection(COLLECTION).doc(holdId), result.hold);
      return { ok: true as const, hold: result.hold };
    });
  } catch (err) {
    console.error(
      '[holds] placeHold failed:',
      { artistId: input.artistId },
      err instanceof Error ? err.message : err,
    );
    return { ok: false, reason: "unavailable" };
  }
}

/** Read one hold back, or null. */
export async function getHold(holdId: string): Promise<Hold | null> {
  const db = await firestore();
  if (!db) return null;
  try {
    const snap = await db.collection(COLLECTION).doc(holdId).get();
    return snap.exists ? (snap.data() as Hold) : null;
  } catch {
    return null;
  }
}

/** Release a hold — the client abandoned checkout, or payment failed. */
export async function releaseHoldById(holdId: string): Promise<boolean> {
  const db = await firestore();
  if (!db) return false;
  try {
    const ref = db.collection(COLLECTION).doc(holdId);
    const snap = await ref.get();
    if (!snap.exists) return false;
    await ref.set(releaseHold(snap.data() as Hold));
    return true;
  } catch (err) {
    console.warn(
      '[holds] release failed:',
      { holdId },
      err instanceof Error ? err.message : err,
    );
    return false;
  }
}

/** Mark a hold as having become a paid booking. */
export async function convertHoldById(holdId: string): Promise<boolean> {
  const db = await firestore();
  if (!db) return false;
  try {
    const ref = db.collection(COLLECTION).doc(holdId);
    const snap = await ref.get();
    if (!snap.exists) return false;
    await ref.set(convertHold(snap.data() as Hold));
    return true;
  } catch (err) {
    console.warn(
      '[holds] convert failed:',
      { holdId },
      err instanceof Error ? err.message : err,
    );
    return false;
  }
}
