/**
 * Take an exclusive hold on one slot, before checkout.
 *
 * This is the step that makes a booking a reservation. The client picks a time,
 * this route reserves it for HOLD_TTL_MINUTES, and only then may they pay for
 * it. A
 * second client asking for the same time gets 409 and sees it gone from their
 * grid. A booking re-holding its own slot (reload, retry, return from a
 * cancelled checkout) refreshes the window instead of colliding with itself.
 *
 * DELETE releases a hold early — the client abandoned the review step or came
 * back from Stripe's cancel page — so the slot goes back on sale now rather
 * than when the TTL lapses. Owner-checked through the booking the hold belongs
 * to, because releasing someone else's hold is a way to steal their slot.
 *
 * The route refuses to hold a slot the offer would not currently show. That
 * matters: a client could otherwise post any time at all — 3am, a day the
 * artist blocked, a slot already busy on their calendar — and reserve it. The
 * slot must be one `getBookingOffer` is offering *right now*, in reservation
 * mode, to this artist.
 *
 * A 503 here is not a failure the client should retry into: it means this
 * artist is not on the reservation model, and the caller falls back to the
 * request flow.
 */
import { NextRequest, NextResponse } from 'next/server';
import { verifyApiAuth } from '@/lib/api-auth';
import { verifyFirebaseToken } from '@/lib/auth-dal';
import { ensureAdminApp } from '@/lib/firebase-admin';
import { getBookingOffer } from '@/lib/booking-offer';
import {
  getHold,
  placeHold,
  releaseHoldById,
} from '@/lib/booking-holds-persistence';
import { canTransition, type BookingStatus } from '@/lib/booking';

export const runtime = 'nodejs';

interface HoldPayload {
  artistId?: string;
  bookingId?: string;
  date?: string;
  startTime?: string;
  endTime?: string;
}

export async function POST(req: NextRequest) {
  const authError = await verifyApiAuth(req);
  if (authError) return authError;

  const caller = await verifyFirebaseToken(req);
  let body: HoldPayload;
  try {
    body = (await req.json()) as HoldPayload;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 });
  }

  const { artistId, bookingId, date, startTime, endTime } = body;
  if (!artistId || !bookingId || !date || !startTime || !endTime) {
    return NextResponse.json(
      { error: 'artistId, bookingId, date, startTime and endTime are required.' },
      { status: 400 }
    );
  }

  // Ownership: a hold moves someone's booking record, so it must be theirs.
  // A missing document is allowed through for the same reason /api/checkout
  // allows it — the capture may have hit the file fallback.
  const cred = ensureAdminApp();
  if (cred) {
    try {
      const { getFirestore } = await import('firebase-admin/firestore');
      const snap = await getFirestore()
        .collection('booking_requests')
        .doc(bookingId)
        .get();
      if (snap.exists) {
        const doc = snap.data() as Record<string, unknown>;
        const ownerUid = (doc.uid as string | null) ?? null;
        if (ownerUid && ownerUid !== (caller?.uid ?? null)) {
          return NextResponse.json({ error: 'Booking does not belong to you.' }, { status: 403 });
        }
        // Only a booking that may legally move to `held` may take one. A paid
        // or cancelled booking reserving more of an artist's day is a bug.
        const status = (doc.status as BookingStatus | undefined) ?? 'pending';
        if (status !== 'held' && !canTransition(status, 'held')) {
          return NextResponse.json(
            { error: `A ${status} booking cannot hold a slot.` },
            { status: 409 }
          );
        }
      }
    } catch (err) {
      // Fail CLOSED, unlike the checkout ownership check. That one guards a
      // payment the caller is making for themselves; this one hands out an
      // exclusive claim on an artist's time to whoever asks.
      console.error('[hold] ownership check failed — refusing:', err);
      return NextResponse.json({ error: 'Could not verify your booking.' }, { status: 503 });
    }
  }

  const nowMs = Date.now();
  const offer = await getBookingOffer({ artistId, nowMs, excludeBookingId: bookingId });
  if (offer.decision.mode !== 'reservation') {
    return NextResponse.json(
      {
        error: 'This artist takes booking requests, not reservations.',
        mode: offer.decision.mode,
        reason: offer.decision.reason,
      },
      { status: 503 }
    );
  }

  // The slot must be one we are offering right now — not any time the caller
  // cares to name.
  const offered = offer.slots.some(
    (s) => s.date === date && s.startTime === startTime && s.endTime === endTime
  );
  if (!offered) {
    return NextResponse.json(
      { error: 'That time is no longer available.', code: 'SLOT_GONE' },
      { status: 409 }
    );
  }

  const result = await placeHold({
    artistId,
    bookingId,
    slot: { date, startTime, endTime, timezone: offer.timezone! },
    nowMs,
  });

  if (!result.ok) {
    if (result.reason === 'slot_held') {
      return NextResponse.json(
        { error: 'Someone just took that time.', code: 'SLOT_GONE' },
        { status: 409 }
      );
    }
    if (result.reason === 'unavailable') {
      return NextResponse.json(
        { error: 'Reservations are temporarily unavailable.', mode: 'request' },
        { status: 503 }
      );
    }
    return NextResponse.json({ error: 'That slot is not bookable.' }, { status: 400 });
  }

  // Persist the hold onto the booking so checkout and the webhook can find it.
  if (cred) {
    try {
      const { getFirestore } = await import('firebase-admin/firestore');
      await getFirestore()
        .collection('booking_requests')
        .doc(bookingId)
        .set(
          {
            status: 'held',
            holdId: result.hold.holdId,
            holdExpiresAt: result.hold.expiresAt,
            heldSlot: {
              date: result.hold.date,
              startTime: result.hold.startTime,
              endTime: result.hold.endTime,
              timezone: result.hold.timezone,
            },
          },
          { merge: true }
        );
    } catch (err) {
      // The hold itself is taken and will lapse on its own at its TTL, so
      // nothing is over-booked. Log loudly: the booking record is now behind.
      console.error(`[hold] booking ${bookingId} not stamped with hold:`, err);
    }
  }

  return NextResponse.json({
    holdId: result.hold.holdId,
    expiresAt: result.hold.expiresAt,
    slot: {
      date: result.hold.date,
      startTime: result.hold.startTime,
      endTime: result.hold.endTime,
      timezone: result.hold.timezone,
    },
  });
}

interface ReleasePayload {
  holdId?: string;
}

/**
 * Release a hold before it lapses.
 *
 * `holdId` comes from the query string (`?holdId=`) or the JSON body. Unknown
 * ids are 404. A hold that has already been paid for is never released here —
 * that would put a sold slot back on sale under a client who paid for it.
 * Ownership is the booking's: the hold names the booking it belongs to, and
 * that booking's `uid` must be the caller (an ownerless record from the
 * anonymous path is allowed through, matching POST).
 */
export async function DELETE(req: NextRequest) {
  const authError = await verifyApiAuth(req);
  if (authError) return authError;

  const caller = await verifyFirebaseToken(req);

  let holdId = new URL(req.url).searchParams.get('holdId') ?? undefined;
  if (!holdId) {
    try {
      const body = (await req.json()) as ReleasePayload;
      holdId = body?.holdId;
    } catch {
      // No body is fine when the query string carried the id.
    }
  }
  if (!holdId || typeof holdId !== 'string') {
    return NextResponse.json({ error: 'holdId is required.' }, { status: 400 });
  }

  const hold = await getHold(holdId);
  if (!hold) {
    return NextResponse.json(
      { error: 'No such hold.', code: 'HOLD_NOT_FOUND' },
      { status: 404 }
    );
  }

  const cred = ensureAdminApp();
  if (cred) {
    try {
      const { getFirestore } = await import('firebase-admin/firestore');
      const snap = await getFirestore()
        .collection('booking_requests')
        .doc(hold.bookingId)
        .get();
      if (snap.exists) {
        const ownerUid = ((snap.data() as Record<string, unknown>).uid as string | null) ?? null;
        if (ownerUid && ownerUid !== (caller?.uid ?? null)) {
          return NextResponse.json({ error: 'Hold does not belong to you.' }, { status: 403 });
        }
      }
    } catch (err) {
      // Fail CLOSED for the same reason POST does: this hands out control over
      // an exclusive claim on an artist's time.
      console.error('[hold] release ownership check failed — refusing:', err);
      return NextResponse.json({ error: 'Could not verify your booking.' }, { status: 503 });
    }
  }

  if (hold.status === 'converted') {
    return NextResponse.json(
      { error: 'That time has been paid for and cannot be released.' },
      { status: 409 }
    );
  }
  if (hold.status === 'released') {
    // Idempotent: a retry of a release that already happened is a success.
    return NextResponse.json({ released: true, holdId, alreadyReleased: true });
  }

  const released = await releaseHoldById(holdId);
  if (!released) {
    return NextResponse.json(
      { error: 'Could not release the hold right now.' },
      { status: 503 }
    );
  }

  // Walk the booking record back to `pending` so /bookings stops saying the
  // time is held. Best-effort, and only when the record still points at this
  // hold — a newer hold on the same booking must not be clobbered.
  if (cred) {
    try {
      const { getFirestore, FieldValue } = await import('firebase-admin/firestore');
      const ref = getFirestore().collection('booking_requests').doc(hold.bookingId);
      const snap = await ref.get();
      if (snap.exists) {
        const doc = snap.data() as Record<string, unknown>;
        if (doc.status === 'held' && doc.holdId === holdId && canTransition('held', 'pending')) {
          await ref.set(
            {
              status: 'pending',
              holdId: FieldValue.delete(),
              holdExpiresAt: FieldValue.delete(),
              heldSlot: FieldValue.delete(),
              holdReleasedAt: new Date().toISOString(),
            },
            { merge: true }
          );
        }
      }
    } catch (err) {
      console.error(`[hold] booking ${hold.bookingId} not walked back after release:`, err);
    }
  }

  return NextResponse.json({ released: true, holdId });
}
