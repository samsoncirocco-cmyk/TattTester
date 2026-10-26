import BookClient, {
  type BookArtist,
  type BookOffer,
  type BookResume,
  type OfferedSlot,
} from "./BookClient";
import { redirect, unstable_rethrow } from "next/navigation";
import { getRosterArtistById } from "@/lib/artists-graph";
import { getArtistAvailability } from "@/lib/availability";
import { availabilityLabel } from "@/lib/booking";
import { getBookingOffer } from "@/lib/booking-offer";
// Server component — safe to read the platform take rate from the shared
// Stripe config (never imported into client components). The money sentence
// on the review step renders from this so the copy can't drift from the rate.
import { PLATFORM_FEE_BPS } from "@/lib/stripe";
import { depositHoldDays } from "@/lib/deposit-hold";
import { readClaimedArtistExtras } from "@/lib/artist-profile-extras-store";
import { hasPolicies } from "@/lib/artist-profile-extras";

// The artist comes from the live graph and availability from Firestore
// on every request — never statically rendered.
export const dynamic = "force-dynamic";

export default async function BookPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const artistId = typeof sp.artistId === "string" ? sp.artistId : "";
  // Design-session id threaded from /design → /smart-match → /swipe → here;
  // travels on the booking POST so the artist Brief rides with the record.
  const designSessionId = typeof sp.ds === "string" ? sp.ds : "";

  // Resume state (REA gap #1). After the booking is captured the client writes
  // `bookingId` and, on the reservation path, the chosen `slot` into this URL;
  // Stripe's cancel_url carries the same plus `cancelled=1&holdId=`. A reload
  // or a return from checkout therefore re-uses the booking instead of minting
  // a new BK- id whose hold would collide with the customer's own live hold.
  const resumeBookingId =
    typeof sp.bookingId === "string" && /^BK-[A-Z0-9]{8}$/.test(sp.bookingId)
      ? sp.bookingId
      : "";
  const resumeSlot = parseSlotParam(typeof sp.slot === "string" ? sp.slot : "");
  const cancelledHoldId =
    sp.cancelled === "1" && typeof sp.holdId === "string" && /^hold_[\w-]+$/.test(sp.holdId)
      ? sp.holdId
      : null;
  const resume: BookResume | null = resumeBookingId
    ? { bookingId: resumeBookingId, slot: resumeSlot, cancelledHoldId }
    : null;

  let artist: BookArtist | null = null;
  let artistLoadFailed = false;
  /** Set when a claimed artist wrote policies (spec 16): /book points at them. */
  let policiesHref: string | null = null;

  /**
   * The honest default, and what every artist gets unless a live calendar read
   * says otherwise. If anything below throws we ship this — a booking page that
   * over-promises is worse than one that under-promises (ADR 0027).
   */
  let offer: BookOffer = {
    mode: "request",
    label: "Availability on request",
    detail:
      "Pick the dates that suit you — the artist confirms a time after your request lands.",
    slots: [],
  };

  if (artistId) {
    try {
      const found = await getRosterArtistById(artistId);
      if (found) {
        if (found.bookingTier !== "bookable") {
          const intro = new URLSearchParams({ artistId: found.id });
          if (designSessionId) intro.set("ds", designSessionId);
          redirect(`/intro?${intro.toString()}`);
        }
        const availability = await getArtistAvailability(found.id);
        artist = {
          id: found.id,
          slug: found.slug,
          name: found.name,
          location: found.location,
          shopName: found.shopName,
          styles: found.styles,
          availabilityStatus: availability.status,
          availabilityLabel: availabilityLabel(availability.status),
          availabilityNote: availability.note ?? null,
          claimed: found.claimed,
        };
        if (found.claimed && hasPolicies(await readClaimedArtistExtras(found))) {
          policiesHref = `/artists/${found.slug}#before-you-book`;
        }

        // Reservation or request, decided per artist from live signals. The
        // server guarantees `slots` is empty unless the mode is "reservation",
        // so the client cannot render a time we are unable to hold.
        // `excludeBookingId` keeps a resumed booking's OWN hold visible to it,
        // so the time the customer already holds is still on their grid.
        const resolved = await getBookingOffer({
          artistId: found.id,
          ...(resumeBookingId ? { excludeBookingId: resumeBookingId } : {}),
        });
        offer = {
          mode: resolved.decision.mode,
          label: resolved.decision.label,
          detail: resolved.decision.detail,
          slots: resolved.slots.map((s) => ({
            date: s.date,
            startTime: s.startTime,
            endTime: s.endTime,
            durationMinutes: s.durationMinutes,
            // Real instants with the artist's offset (spec 4), so the client
            // can name the zone and convert to the customer's own clock.
            startsAt: s.startsAt,
            endsAt: s.endsAt,
          })),
          ...(resolved.timezone ? { timezone: resolved.timezone } : {}),
          ...(resolved.nextOpening ? { nextOpeningAt: resolved.nextOpening.at } : {}),
        };
      }
    } catch (error) {
      // redirect() throws a special control-flow error; rethrow it so browse-only
      // artists reach /intro instead of the graph-failure empty state.
      unstable_rethrow(error);
      // Graph unreachable — be honest about it instead of faking an artist.
      artistLoadFailed = true;
    }
  }

  return (
    <BookClient
      artist={artist}
      requestedArtistId={artistId}
      artistLoadFailed={artistLoadFailed}
      designSessionId={designSessionId}
      offer={offer}
      feePercent={PLATFORM_FEE_BPS / 100}
      holdDays={depositHoldDays()}
      resume={resume}
      policiesHref={policiesHref}
    />
  );
}

/** "YYYY-MM-DD|HH:MM|HH:MM" → slot, or null when malformed. */
function parseSlotParam(raw: string): OfferedSlot | null {
  if (!raw) return null;
  const [date, startTime, endTime] = raw.split("|");
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(date ?? "") ||
    !/^\d{2}:\d{2}$/.test(startTime ?? "") ||
    !/^\d{2}:\d{2}$/.test(endTime ?? "")
  ) {
    return null;
  }
  return { date, startTime, endTime };
}
