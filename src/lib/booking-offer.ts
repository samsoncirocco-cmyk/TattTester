/**
 * What can we actually offer this client, for this artist, right now?
 *
 * The one server-side composition of every part of the reservation model:
 *
 *     artist's declared windows        (artist-availability)
 *   − time already booked on TatT      (existing bookings)
 *   − time held by another client      (booking-holds)
 *   − time busy on their own calendar  (artist-calendar freeBusy)
 *   = the slots we are willing to hold
 *
 * and, alongside it, the honest statement of which model the client is getting
 * (`booking-mode`).
 *
 * The invariant this file exists to guarantee: **`slots` is non-empty only when
 * `decision.mode === "reservation"`.** A slot on screen is a promise we can
 * keep, so if anything at all is uncertain the slots are dropped and the client
 * gets the request flow. Nothing downstream has to remember to check.
 */
import {
  generateAvailableSlots,
  addDaysToISODate,
  toISODate,
  toZonedISODate,
  zonedISOString,
  type SessionTypeConfig,
  type Slot,
} from "./scheduling-engine";
import { normalizeArtistSchedule, hasPublishedHours } from "./artist-availability";
import { filterSlotsByBusy } from "./artist-calendar";
import {
  getCalendarConnection,
  readArtistBusy,
} from "./artist-calendar-connection";
import { holdsWritable, listLiveHolds } from "./booking-holds-persistence";
import { holdsAsExistingBookings } from "./booking-holds";
import { isArtistClaimed } from "./artist-ownership";
import { resolveBookingMode, type BookingModeDecision } from "./booking-mode";
import { ensureAdminApp } from "./firebase-admin";
import {
  nextOpeningNeedsWrite,
  recordNextOpening,
  type NextOpening,
  type StoredNextOpening,
} from "./next-opening";

/** How far ahead the booking page offers times. */
export const OFFER_WINDOW_DAYS = 28;

/**
 * Fallback session shape until `:SessionType` is wired into the booking page.
 * Deliberately conservative: a two-hour sitting with 15 minutes either side and
 * a day's notice. Offering too little is a smaller mistake than offering a slot
 * the artist cannot honour.
 */
export const DEFAULT_SESSION: SessionTypeConfig = {
  durationMinutes: 120,
  beforeBufferMinutes: 15,
  afterBufferMinutes: 15,
  minimumBookingNoticeHours: 24,
};

/** A slot plus the real instants it names (spec 4): ISO-8601 with the artist's offset. */
export type OfferSlot = Slot & {
  startsAt: string;
  endsAt: string;
};

export interface BookingOffer {
  decision: BookingModeDecision;
  /** Concrete bookable times. Always empty unless the mode is "reservation". */
  slots: OfferSlot[];
  /**
   * The artist's zone: the one `slots` are expressed in, and the clock
   * request-mode "Morning" means. Present whenever the artist has published
   * hours, even with no slots; absent when we do not know it.
   */
  timezone?: string;
  /** First offered slot, or null. Only ever set in reservation mode. */
  nextOpening: NextOpening | null;
}

/** Read the artist's declared windows (and the cached next opening) from the availability document. */
async function readSchedule(artistId: string) {
  try {
    if (!ensureAdminApp()) return null;
    const { getFirestore } = await import("firebase-admin/firestore");
    const snap = await getFirestore()
      .collection("artist_availability")
      .doc(artistId)
      .get();
    const data = snap.exists ? snap.data() : null;
    const parsed = normalizeArtistSchedule(data);
    return parsed ? { ...parsed, cached: (data ?? {}) as StoredNextOpening } : null;
  } catch (err) {
    console.warn(
      `[offer] schedule read failed for ${artistId} — request model:`,
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}

/**
 * Compose the offer for one artist.
 *
 * `excludeBookingId` keeps a client's own hold visible to themselves, so
 * reloading the checkout page does not make their reserved slot vanish.
 */
export async function getBookingOffer(input: {
  artistId: string;
  nowMs?: number;
  excludeBookingId?: string;
  sessionType?: SessionTypeConfig;
}): Promise<BookingOffer> {
  const nowMs = input.nowMs ?? Date.now();

  // Everything independent, in parallel — this runs on a page render.
  const [claimed, connection, schedule, canHold] = await Promise.all([
    isArtistClaimed(input.artistId),
    getCalendarConnection(input.artistId),
    readSchedule(input.artistId),
    holdsWritable(),
  ]);

  // The window starts on the ARTIST's today (spec 4), not UTC's: for a US
  // evening the UTC date is already tomorrow, which shifted the whole
  // 28-day window a day ahead of the artist's calendar.
  const zone = schedule?.schedule.timezone;
  const startDate = zone ? toZonedISODate(nowMs, zone) : toISODate(new Date(nowMs));
  const endDate = addDaysToISODate(startDate, OFFER_WINDOW_DAYS);

  const publishedHours = Boolean(schedule && hasPublishedHours(schedule.schedule));

  // Only read the calendar when there is a live connection to read. Asking
  // otherwise would spend a network round trip to learn what we already know.
  const calendar =
    connection && !connection.revokedAt
      ? await readArtistBusy({
          artistId: input.artistId,
          timeMinMs: nowMs,
          timeMaxMs: Date.parse(`${endDate}T23:59:59.999Z`),
          nowMs,
        })
      : null;

  const decision = resolveBookingMode({
    artistId: input.artistId,
    claimed,
    connection,
    publishedHours,
    calendar,
    holdsWritable: canHold,
    nowMs,
  });

  // The invariant: no reservation, no slots. Every degradation path lands here.
  if (decision.mode !== "reservation" || !schedule || !calendar?.ok) {
    // A stale chip must not outlive the reservation it advertised.
    if (schedule && nextOpeningNeedsWrite(schedule.cached, null, nowMs)) {
      await recordNextOpening(input.artistId, null, nowMs);
    }
    return { decision, slots: [], ...(zone ? { timezone: zone } : {}), nextOpening: null };
  }

  const timezone = schedule.schedule.timezone;
  const holds = await listLiveHolds(input.artistId, nowMs);

  const slots = generateAvailableSlots({
    schedule: schedule.schedule,
    overrides: schedule.overrides,
    sessionType: input.sessionType ?? DEFAULT_SESSION,
    // Another client's live hold occupies the artist's time exactly as a booked
    // session does, so the engine filters it out without knowing holds exist.
    existingBookings: holdsAsExistingBookings(holds, nowMs, {
      excludeBookingId: input.excludeBookingId,
    }),
    nowEpochMs: nowMs,
    startDate,
    endDate,
  });

  // The calendar subtracts, last. It never adds a slot the artist did not
  // declare — it only removes ones they are already busy for. Each survivor
  // gains its real instants; one whose wall clock does not exist (a DST gap)
  // is dropped rather than shown as a time nobody can arrive at.
  const offered: OfferSlot[] = [];
  for (const slot of filterSlotsByBusy(slots, calendar.busy, timezone)) {
    const startsAt = zonedISOString(slot.date, slot.startTime, timezone);
    const endsAt = zonedISOString(slot.date, slot.endTime, timezone);
    if (startsAt && endsAt) offered.push({ ...slot, startsAt, endsAt });
  }

  const nextOpening: NextOpening | null = offered[0]
    ? { at: offered[0].startsAt, timezone }
    : null;
  // Feed the roster card's chip. Best-effort (never throws); written at most
  // hourly while unchanged, so the render rarely pays for it. Awaited because a
  // serverless function may be frozen once the response is sent.
  if (nextOpeningNeedsWrite(schedule.cached, nextOpening, nowMs)) {
    await recordNextOpening(input.artistId, nextOpening, nowMs);
  }

  return { decision, slots: offered, timezone, nextOpening };
}
