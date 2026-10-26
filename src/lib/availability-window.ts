/**
 * Shape a booking offer into the public availability response (spec 6):
 * `GET /api/v1/artists/{id}/availability?from&to&tz`.
 *
 * Pure: the route does the I/O (`getBookingOffer`) and hands the result here.
 *
 *   {
 *     artistId, mode, label, detail,
 *     timezone,                 // the artist's IANA zone, when known
 *     viewerTimezone,           // echo of a valid `tz`, else null
 *     from, to,                 // the artist-local date range actually covered
 *     days: [{ date, spots: [{ startTime, endTime, startsAt, endsAt, local? }] }],
 *     nextOpeningAt,            // first spot's instant, or null
 *   }
 *
 * `from`/`to` are artist-local "YYYY-MM-DD" and only ever narrow the offer's
 * own window — this endpoint never offers a day `getBookingOffer` would not.
 * `tz` is display only: each spot gains `local: { date, time }` on that clock.
 * Spots exist only in reservation mode, the same invariant as the offer.
 */
import type { BookingOffer, OfferSlot } from "./booking-offer";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export type AvailabilitySpot = {
  startTime: string;
  endTime: string;
  startsAt: string;
  endsAt: string;
  local?: { date: string; time: string };
};

export type AvailabilityResponse = {
  artistId: string;
  mode: "reservation" | "request";
  label: string;
  detail: string;
  timezone: string | null;
  viewerTimezone: string | null;
  from: string | null;
  to: string | null;
  days: Array<{ date: string; spots: AvailabilitySpot[] }>;
  nextOpeningAt: string | null;
};

export type AvailabilityQuery = { from?: string; to?: string; tz?: string };

export type ParsedQuery =
  | { ok: true; from: string | null; to: string | null; tz: string | null }
  | { ok: false; error: string };

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

function isRealDate(s: string): boolean {
  if (!ISO_DATE.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/** Validate the query. Bad input is a 400, never silently widened. */
export function parseAvailabilityQuery(q: AvailabilityQuery): ParsedQuery {
  const from = q.from?.trim() || null;
  const to = q.to?.trim() || null;
  const tz = q.tz?.trim() || null;
  if (from && !isRealDate(from)) return { ok: false, error: "from must be YYYY-MM-DD." };
  if (to && !isRealDate(to)) return { ok: false, error: "to must be YYYY-MM-DD." };
  if (from && to && to < from) return { ok: false, error: "to must not be before from." };
  if (tz && (tz.length > 64 || !isValidTimeZone(tz))) {
    return { ok: false, error: "tz must be an IANA time zone, e.g. America/Phoenix." };
  }
  return { ok: true, from, to, tz };
}

function localParts(iso: string, tz: string): { date: string; time: string } | undefined {
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return undefined;
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(new Date(at))
      .filter((x) => x.type !== "literal")
      .map((x) => [x.type, x.value]),
  ) as Record<string, string>;
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}` };
}

export function shapeAvailability(
  artistId: string,
  offer: BookingOffer,
  query: { from: string | null; to: string | null; tz: string | null },
): AvailabilityResponse {
  const inRange = (s: OfferSlot) =>
    (!query.from || s.date >= query.from) && (!query.to || s.date <= query.to);
  const slots = offer.decision.mode === "reservation" ? offer.slots.filter(inRange) : [];

  const byDate = new Map<string, AvailabilitySpot[]>();
  for (const s of slots) {
    const spot: AvailabilitySpot = {
      startTime: s.startTime,
      endTime: s.endTime,
      startsAt: s.startsAt,
      endsAt: s.endsAt,
      ...(query.tz ? { local: localParts(s.startsAt, query.tz) } : {}),
    };
    const bucket = byDate.get(s.date);
    if (bucket) bucket.push(spot);
    else byDate.set(s.date, [spot]);
  }

  return {
    artistId,
    mode: offer.decision.mode,
    label: offer.decision.label,
    detail: offer.decision.detail,
    timezone: offer.timezone ?? null,
    viewerTimezone: query.tz,
    from: query.from ?? slots[0]?.date ?? null,
    to: query.to ?? slots[slots.length - 1]?.date ?? null,
    days: [...byDate.entries()].map(([date, spots]) => ({ date, spots })),
    // The artist's first opening overall, not just inside the asked range.
    nextOpeningAt: offer.nextOpening?.at ?? null,
  };
}
