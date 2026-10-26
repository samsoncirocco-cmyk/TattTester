/**
 * GET /api/v1/artists/{id}/availability?from&to&tz — live bookable times
 * (spec 6, REA gaps C1/K3).
 *
 * The same composition the /book page renders (`getBookingOffer`: declared
 * hours − bookings − other clients' holds − calendar busy), as JSON, so the
 * page can refresh its grid on window focus and re-check the chosen slot when
 * the review step opens, without a full page reload.
 *
 * Public, like the /book page that shows the same times to signed-out
 * visitors; flood-guarded per IP, and answers are cached per artist for a few
 * seconds because each miss may read the artist's Google calendar.
 * `bookingId` keeps that booking's own hold visible to it (as /book does).
 *
 * Request-mode artists answer with `mode: "request"` and no days: the offer's
 * invariant (no reservation, no slots) holds here too.
 */
import { NextRequest, NextResponse } from "next/server";
import { getBookingOffer, type BookingOffer } from "@/lib/booking-offer";
import { parseAvailabilityQuery, shapeAvailability } from "@/lib/availability-window";
import { rateLimit, rateLimitResponse } from "@/lib/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ARTIST_ID = /^[\w-]{1,128}$/;
const BOOKING_ID = /^BK-[A-Z0-9]{8}$/;
const CACHE_MS = 15_000;

const cache = new Map<string, { atMs: number; offer: BookingOffer }>();

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const limit = await rateLimit(req, "default");
  if (!limit.allowed) return rateLimitResponse(limit);

  const { id } = await params;
  if (!ARTIST_ID.test(id)) {
    return NextResponse.json({ error: "Unknown artist." }, { status: 400 });
  }

  const sp = new URL(req.url).searchParams;
  const parsed = parseAvailabilityQuery({
    from: sp.get("from") ?? undefined,
    to: sp.get("to") ?? undefined,
    tz: sp.get("tz") ?? undefined,
  });
  if (!parsed.ok) {
    return NextResponse.json({ error: parsed.error }, { status: 400 });
  }
  const bookingIdRaw = sp.get("bookingId");
  const bookingId = bookingIdRaw && BOOKING_ID.test(bookingIdRaw) ? bookingIdRaw : undefined;

  const nowMs = Date.now();
  const key = `${id}|${bookingId ?? ""}`;
  let offer = cache.get(key);
  if (!offer || nowMs - offer.atMs > CACHE_MS) {
    try {
      const fresh = await getBookingOffer({
        artistId: id,
        nowMs,
        ...(bookingId ? { excludeBookingId: bookingId } : {}),
      });
      offer = { atMs: nowMs, offer: fresh };
      cache.set(key, offer);
      if (cache.size > 500) cache.delete(cache.keys().next().value as string);
    } catch (err) {
      console.warn(
        `[availability] offer failed for ${id}:`,
        err instanceof Error ? err.message : err,
      );
      return NextResponse.json(
        { error: "Availability is unavailable right now. Try again shortly." },
        { status: 503 },
      );
    }
  }

  return NextResponse.json(shapeAvailability(id, offer.offer, parsed), {
    headers: { "Cache-Control": "no-store" },
  });
}
