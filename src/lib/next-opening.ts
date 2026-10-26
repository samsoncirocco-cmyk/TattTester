/**
 * The cached "next opening" hint for roster cards and profiles (spec 4 §4.2).
 *
 * Computing an artist's next free slot needs a Google free/busy read, which is
 * too expensive per card on a roster page. So whenever `getBookingOffer`
 * computes real slots for an artist (the /book page, the hold route, the
 * availability endpoint) it writes the first one onto that artist's
 * `artist_availability/{artistId}` document, and cards read it back.
 *
 * It is a hint, never a promise: the grid on /book is the truth. A value older
 * than a day, or already in the past, is not shown; neither is a missing one.
 * Request-mode artists never get one, because they have no concrete slots.
 * Server only (firebase-admin).
 */
import { ensureAdminApp } from "./firebase-admin";

export const NEXT_OPENING_MAX_AGE_MS = 24 * 60 * 60 * 1000;
/** Skip rewriting an unchanged value more often than this. */
const REWRITE_AFTER_MS = 60 * 60 * 1000;

export type NextOpening = {
  /** ISO instant with offset, e.g. "2026-11-03T14:00:00-07:00". */
  at: string;
  /** IANA zone the artist works in, for formatting the day. */
  timezone: string;
};

export type StoredNextOpening = {
  nextOpeningAt?: string | null;
  nextOpeningTimezone?: string | null;
  nextOpeningComputedAtMs?: number | null;
};

/** Is a stored value fresh enough to show right now? */
export function usableNextOpening(
  doc: StoredNextOpening | null | undefined,
  nowMs: number,
): NextOpening | null {
  if (!doc?.nextOpeningAt || !doc.nextOpeningTimezone) return null;
  const computed = Number(doc.nextOpeningComputedAtMs);
  if (!Number.isFinite(computed) || nowMs - computed > NEXT_OPENING_MAX_AGE_MS) return null;
  const at = Date.parse(doc.nextOpeningAt);
  if (!Number.isFinite(at) || at <= nowMs) return null;
  return { at: doc.nextOpeningAt, timezone: doc.nextOpeningTimezone };
}

/** Should `getBookingOffer` rewrite the cached value? */
export function nextOpeningNeedsWrite(
  stored: StoredNextOpening | null | undefined,
  next: NextOpening | null,
  nowMs: number,
): boolean {
  const storedAt = stored?.nextOpeningAt ?? null;
  const nextAt = next?.at ?? null;
  if (storedAt !== nextAt) return true;
  if (nextAt === null) return false;
  const computed = Number(stored?.nextOpeningComputedAtMs);
  return !Number.isFinite(computed) || nowMs - computed > REWRITE_AFTER_MS;
}

/** "Nov 3" in the artist's zone. */
export function formatNextOpening(opening: NextOpening): string {
  try {
    return new Date(opening.at).toLocaleDateString("en-US", {
      timeZone: opening.timezone,
      month: "short",
      day: "numeric",
    });
  } catch {
    return new Date(opening.at).toLocaleDateString("en-US", { month: "short", day: "numeric" });
  }
}

/** Best-effort write-through from `getBookingOffer`. Never throws. */
export async function recordNextOpening(
  artistId: string,
  next: NextOpening | null,
  nowMs: number,
): Promise<void> {
  try {
    if (!ensureAdminApp()) return;
    const { getFirestore } = await import("firebase-admin/firestore");
    await getFirestore()
      .collection("artist_availability")
      .doc(artistId)
      .set(
        {
          nextOpeningAt: next?.at ?? null,
          nextOpeningTimezone: next?.timezone ?? null,
          nextOpeningComputedAtMs: nowMs,
        },
        { merge: true },
      );
  } catch (err) {
    console.warn(
      `[next-opening] write failed for ${artistId}:`,
      err instanceof Error ? err.message : err,
    );
  }
}

/**
 * Read the cached next openings for a page of artists in one round trip.
 * Any failure resolves to an empty map — cards then show no chip.
 */
export async function readNextOpenings(
  artistIds: string[],
  nowMs = Date.now(),
): Promise<Map<string, NextOpening>> {
  const out = new Map<string, NextOpening>();
  const ids = [...new Set(artistIds.filter(Boolean))];
  if (ids.length === 0) return out;
  try {
    if (!ensureAdminApp()) return out;
    const { getFirestore } = await import("firebase-admin/firestore");
    const db = getFirestore();
    const col = db.collection("artist_availability");
    const snaps = await db.getAll(...ids.map((id) => col.doc(id)));
    for (const snap of snaps) {
      if (!snap.exists) continue;
      const usable = usableNextOpening(snap.data() as StoredNextOpening, nowMs);
      if (usable) out.set(snap.id, usable);
    }
  } catch (err) {
    console.warn(
      "[next-opening] read failed — no chips:",
      err instanceof Error ? err.message : err,
    );
  }
  return out;
}
