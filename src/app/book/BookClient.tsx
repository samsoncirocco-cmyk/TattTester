"use client";

/**
 * Punk booking flow — real capture, honest availability.
 *
 * Path: pick artist (from /artists or /swipe via ?artistId=) →
 * request time slots → design + details → review → POST /api/v1/book
 * (Firestore capture) → POST /api/checkout (Stripe deposit). When
 * payments aren't configured the request is still saved and the UI
 * says so plainly — no fake charges, no fake confirmations.
 *
 * Which of the two models the client gets is decided per artist, server-side,
 * by `resolveBookingMode` (ADR 0027):
 *
 *  - RESERVATION — the artist has a synced calendar and published hours, so we
 *    show concrete times. Picking one takes an exclusive hold before checkout,
 *    and the deposit pays for that specific slot.
 *  - REQUEST — everyone else, which is most of the roster and permanently so.
 *    Unchanged from before: pick preferred dates, the artist confirms after.
 *
 * The principle that produced the request model is intact, not abandoned: we
 * still never show a slot that is not real. The difference is that a synced
 * calendar makes some slots real. `offer.slots` is non-empty only in
 * reservation mode — the server guarantees it — so there is no path here that
 * renders a time we cannot hold.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import StudioShell from "@/components/studio/StudioShell";
import QuietHeadline from "@/components/quiet/QuietHeadline";
import QuietCTA from "@/components/quiet/QuietCTA";
import ReceiptCard from "@/components/quiet/ReceiptCard";
import { useBookings, useDesigns, type TattDesign } from "@/lib/tattStorage";
import { getApiAuthHeaders } from "@/lib/client-api-auth";
import { bookingReviewMoneyCopy } from "@/lib/money-copy";
import { requestReplyPromise } from "@/lib/request-reply-window";
import {
  BookingPathExplainer,
  CheckoutEstimate,
  TattooPrepPlan,
  bookingReviewLabels,
} from "./BookingConfidence";
import {
  depositDollarsForSize,
  MAX_REQUESTED_SLOTS,
  type RequestedSlot,
} from "@/lib/booking";

/** One concrete bookable time, as offered by the server. */
export type OfferedSlot = {
  date: string;
  startTime: string;
  endTime: string;
};

/**
 * What the server is willing to offer for this artist right now. `mode` is the
 * honest statement of which product the client is getting, and `slots` is
 * non-empty only when that mode is "reservation".
 */
export type BookOffer = {
  mode: "reservation" | "request";
  label: string;
  detail: string;
  slots: OfferedSlot[];
  timezone?: string;
};

/**
 * What a reload or a return from Stripe hands back to this page (REA gap #1).
 * The booking id is the load-bearing part: re-using it makes a second hold on
 * the same slot a refresh of the customer's own hold instead of a collision
 * with it. `cancelledHoldId` is set only by Stripe's cancel_url and names the
 * hold to release before anything else happens.
 */
export type BookResume = {
  bookingId: string;
  slot: OfferedSlot | null;
  cancelledHoldId: string | null;
};

export type BookArtist = {
  id: string;
  slug: string;
  name: string;
  location: string;
  shopName: string | null;
  styles: string[];
  availabilityStatus: string;
  availabilityLabel: string;
  availabilityNote: string | null;
  /** True only after this profile has a verified owner. */
  claimed: boolean;
};

const SIZES = [
  { id: "small", label: "Small", desc: 'Under 2"' },
  { id: "medium", label: "Medium", desc: '2"–4"' },
  { id: "large", label: "Large", desc: '4"–8"' },
  { id: "sleeve", label: "Sleeve", desc: "Full arm" },
];

const PLACEMENTS = [
  "Forearm", "Upper Arm", "Shoulder", "Back", "Chest",
  "Ribcage", "Thigh", "Calf", "Ankle", "Neck", "Hand", "Other",
];

const TIME_PREFS = ["Flexible", "Morning", "Afternoon", "Evening"] as const;

const BUDGETS = [
  { value: "under-300", label: "Under $300" },
  { value: "300-600", label: "$300 – $600" },
  { value: "600-1200", label: "$600 – $1,200" },
  { value: "1200-2500", label: "$1,200 – $2,500" },
  { value: "2500+", label: "$2,500+" },
  { value: "flexible", label: "Flexible — let the artist quote" },
];

/** Next `count` real calendar days starting tomorrow. No fake gaps. */
function upcomingDays(count: number): { iso: string; date: Date }[] {
  const out: { iso: string; date: Date }[] = [];
  const today = new Date();
  for (let i = 1; i <= count; i++) {
    const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() + i);
    const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
      d.getDate(),
    ).padStart(2, "0")}`;
    out.push({ iso, date: d });
  }
  return out;
}

function shortDate(d: Date): string {
  return d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
}

/** "2026-08-06" → "Thu, Aug 6", parsed as a wall-clock date, not an instant. */
function formatSlotDate(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  if (!y || !m || !d) return iso;
  return shortDate(new Date(y, m - 1, d));
}

/** Group offered slots by day, preserving the server's ordering. */
function groupSlotsByDate(slots: OfferedSlot[]): Array<[string, OfferedSlot[]]> {
  const byDate = new Map<string, OfferedSlot[]>();
  for (const slot of slots) {
    const bucket = byDate.get(slot.date);
    if (bucket) bucket.push(slot);
    else byDate.set(slot.date, [slot]);
  }
  return [...byDate.entries()];
}

type Phase = "form" | "submitting" | "captured";

export default function BookClient({
  artist,
  requestedArtistId,
  artistLoadFailed,
  designSessionId = "",
  offer,
  feePercent,
  holdDays,
  resume = null,
}: {
  artist: BookArtist | null;
  requestedArtistId: string;
  artistLoadFailed: boolean;
  /** Design-session id from the "ds" query param — rides on the booking POST. */
  designSessionId?: string;
  /** Which booking model this artist is on, and the times we can hold. */
  offer: BookOffer;
  /** Platform booking fee as a percentage (from PLATFORM_FEE_BPS, server-read). */
  feePercent: number;
  /** Held-deposit refund window (from DEPOSIT_HOLD_DAYS, server-read). */
  holdDays: number;
  /** Booking state carried in the URL from an earlier visit, if any. */
  resume?: BookResume | null;
}) {
  const { addBooking } = useBookings();
  const { designs } = useDesigns();
  const router = useRouter();

  // Was the slot the customer came back with still on offer? If our own hold
  // hid it the server already excluded it for us (page.tsx), so "not offered"
  // here means somebody else has it now.
  const resumedSlotOffered = Boolean(
    resume?.slot &&
      offer.slots.some(
        (s) =>
          s.date === resume.slot!.date &&
          s.startTime === resume.slot!.startTime &&
          s.endTime === resume.slot!.endTime,
      ),
  );

  const [step, setStep] = useState<0 | 1 | 2>(0);
  const [phase, setPhase] = useState<Phase>("form");
  const [error, setError] = useState<string | null>(null);

  // Step 01 — requested slots
  const [selectedDates, setSelectedDates] = useState<string[]>([]);
  const [timePref, setTimePref] = useState<(typeof TIME_PREFS)[number]>("Flexible");

  // Step 01, reservation model — one concrete slot, which we will hold.
  const [selectedSlot, setSelectedSlot] = useState<OfferedSlot | null>(
    resumedSlotOffered ? resume!.slot : null,
  );
  /**
   * Times this customer tried to hold and lost — the honest lost-race state
   * (REA gap #2). They stay on the grid, disabled and marked "Taken", instead
   * of vanishing or silently demoting the whole page to request mode.
   */
  const [takenSlots, setTakenSlots] = useState<OfferedSlot[]>(
    resume?.slot && offer.mode === "reservation" && !resumedSlotOffered
      ? [resume.slot]
      : [],
  );
  /**
   * The sentence that explains a lost slot or a resumed visit, shown on the
   * time step. Unlike `reservationLost` it does NOT drop the page to request
   * mode: the artist still has a live calendar, just not that time.
   */
  const [slotNotice, setSlotNotice] = useState<string | null>(() => {
    if (!resume) return null;
    if (resume.cancelledHoldId) {
      return "You left checkout, so we released your hold. Pick your time again to continue — your booking reference is kept.";
    }
    if (resume.slot && offer.mode === "reservation" && !resumedSlotOffered) {
      return "Your earlier time is no longer available. Your booking reference is kept — pick another time.";
    }
    return "Picking up where you left off. Your booking reference is kept; re-enter your details to continue.";
  });
  /** Set when checkout refused with HOLD_LOST — gets its own action, not the generic error box. */
  const [holdLost, setHoldLost] = useState<string | null>(null);
  /** The hold this tab currently owns, released if the customer walks away. */
  const holdIdRef = useRef<string | null>(null);
  /** True once we hand the browser to Stripe — then the hold must NOT be released on pagehide. */
  const redirectingRef = useRef(false);
  /**
   * Set when a reservation degrades mid-flow: the slot was taken between
   * loading the page and pressing book, or holds went unavailable. The UI drops
   * to the request model and says so, rather than retrying into a promise it
   * can no longer keep.
   */
  const [reservationLost, setReservationLost] = useState<string | null>(null);

  // Reservation mode only survives while the server is still offering slots AND
  // nothing has degraded underneath us.
  const reserving =
    offer.mode === "reservation" && offer.slots.length > 0 && !reservationLost;

  // Step 02 — design + details
  const [designId, setDesignId] = useState<string | null>(null);
  const [size, setSize] = useState("");
  const [placement, setPlacement] = useState("");
  const [description, setDescription] = useState("");
  const [budget, setBudget] = useState("");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");

  // The captured booking. Set after POST /api/v1/book, or restored from the
  // URL on a reload so a retry re-uses it instead of minting a second record.
  const [bookingId, setBookingId] = useState<string | null>(resume?.bookingId ?? null);
  const [paymentsUnavailable, setPaymentsUnavailable] = useState(false);

  const days = useMemo(() => upcomingDays(28), []);
  // Offered slots plus the ones this customer lost, so a lost time is shown
  // as "Taken" rather than quietly missing.
  const slotsByDate = useMemo(() => {
    const extra = takenSlots.filter(
      (t) => !offer.slots.some((s) => s.date === t.date && s.startTime === t.startTime),
    );
    const merged = [...offer.slots, ...extra].sort((a, b) =>
      a.date === b.date ? a.startTime.localeCompare(b.startTime) : a.date.localeCompare(b.date),
    );
    return groupSlotsByDate(merged);
  }, [offer.slots, takenSlots]);
  const isTaken = (slot: OfferedSlot) =>
    takenSlots.some((t) => t.date === slot.date && t.startTime === slot.startTime);

  /** Keep the URL in step with the booking so a reload lands back here. */
  const syncUrl = (patch: Record<string, string | null>) => {
    if (typeof window === "undefined") return;
    const url = new URL(window.location.href);
    for (const [k, v] of Object.entries(patch)) {
      if (v == null) url.searchParams.delete(k);
      else url.searchParams.set(k, v);
    }
    window.history.replaceState(window.history.state, "", url.toString());
  };

  /** Free a hold this tab owns. Best-effort; the TTL is the backstop. */
  const releaseHold = async (holdId: string | null, keepalive = false) => {
    if (!holdId) return;
    if (holdIdRef.current === holdId) holdIdRef.current = null;
    try {
      const authHeaders = await getApiAuthHeaders();
      await fetch(`/api/v1/book/hold?holdId=${encodeURIComponent(holdId)}`, {
        method: "DELETE",
        headers: authHeaders,
        keepalive,
      });
    } catch {
      // The hold lapses on its own; nothing else to do from here.
    }
  };

  // Returning from Stripe's cancel page: release the hold named in the URL
  // first, then scrub the cancel markers so a second reload is a plain resume.
  useEffect(() => {
    if (!resume?.cancelledHoldId) return;
    void releaseHold(resume.cancelledHoldId);
    syncUrl({ cancelled: null, holdId: null });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Closing the tab mid-review with a live hold: let the slot go now rather
  // than at the TTL. Skipped once we are handing off to Stripe — that hold
  // must survive the navigation.
  useEffect(() => {
    const onPageHide = () => {
      if (redirectingRef.current || !holdIdRef.current) return;
      void releaseHold(holdIdRef.current, true);
    };
    window.addEventListener("pagehide", onPageHide);
    return () => window.removeEventListener("pagehide", onPageHide);
  }, []);

  /** Step indicator navigation. Leaving the review step abandons any live hold. */
  const goToStep = (i: 0 | 1 | 2) => {
    if (step === 2 && i < 2 && holdIdRef.current) {
      void releaseHold(holdIdRef.current);
    }
    setStep(i);
  };

  /** A time this customer tried to hold is gone — say so and keep everything else. */
  const markSlotTaken = (slot: OfferedSlot, notice: string) => {
    setTakenSlots((prev) =>
      prev.some((t) => t.date === slot.date && t.startTime === slot.startTime) ? prev : [...prev, slot],
    );
    setSelectedSlot(null);
    setSlotNotice(notice);
    syncUrl({ slot: null });
    // Refetch the offer so the grid shows what is really free now.
    router.refresh();
  };
  const chosenDesign = designs.find((d) => d.id === designId);
  const deposit = depositDollarsForSize(size || undefined);
  const reviewLabels = bookingReviewLabels(reserving ? "reservation" : "request");
  const steps = [
    { n: "01", label: reserving ? "Pick a time" : "Request dates", hint: "When" },
    { n: "02", label: "Design + details", hint: "What" },
    { n: "03", label: "Review checkout", hint: "Deposit + fee" },
  ];

  const detailsValid =
    size && placement && description.trim().length > 10 && name.trim() && email.trim() && budget;

  const toggleDate = (iso: string) => {
    setSelectedDates((prev) =>
      prev.includes(iso)
        ? prev.filter((d) => d !== iso)
        : prev.length >= MAX_REQUESTED_SLOTS
          ? prev
          : [...prev, iso].sort(),
    );
  };

  // On the reservation path the booking record carries the exact time being
  // held, not a preference — the deposit is for that slot and nothing else.
  const requestedSlots: RequestedSlot[] = reserving
    ? selectedSlot
      ? [{ date: selectedSlot.date, time: selectedSlot.startTime }]
      : []
    : selectedDates.map((date) =>
        timePref === "Flexible" ? { date } : { date, time: timePref },
      );

  /** Has step 01 been answered, in whichever model applies? */
  const timeChosen = reserving ? Boolean(selectedSlot) : selectedDates.length > 0;

  const submit = async () => {
    if (!artist || !detailsValid || !timeChosen) return;
    setPhase("submitting");
    setError(null);

    try {
      const authHeaders = await getApiAuthHeaders();

      // 1. Capture the booking request — this is the real record. A resumed
      // visit already has one: re-using its id is what lets the hold below be
      // a refresh of the customer's own hold rather than a collision with it.
      let activeBookingId = bookingId;
      if (!activeBookingId) {
      const bookRes = await fetch("/api/v1/book", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders },
        body: JSON.stringify({
          artistId: artist.id,
          artistName: artist.name,
          clientName: name.trim(),
          clientEmail: email.trim(),
          clientPhone: phone.trim() || undefined,
          description: description.trim(),
          budget,
          designId: chosenDesign?.id,
          designImageUrl: chosenDesign?.image,
          designSessionId: designSessionId || undefined,
          requestedSlots,
        }),
      });
      const bookData = await bookRes.json().catch(() => null);
      // Tier flipped while the form was open — follow the same intro relay
      // path checkout uses rather than surfacing a generic booking error.
      if (
        bookData?.code === "ARTIST_INTRO_REQUIRED" &&
        typeof bookData?.introUrl === "string"
      ) {
        window.location.href = bookData.introUrl;
        return;
      }
      if (!bookRes.ok || !bookData?.success) {
        throw new Error(bookData?.error || "Couldn't save your booking request.");
      }
      activeBookingId = bookData.bookingId as string;
      setBookingId(activeBookingId);
      syncUrl({ bookingId: activeBookingId });

      // Mirror into local bookings so /bookings shows it immediately.
      // depositPaid stays false until Stripe actually confirms.
      addBooking({
        artistSlug: artist.slug,
        artistName: artist.name,
        designId: chosenDesign?.id,
        date: reserving && selectedSlot ? selectedSlot.date : selectedDates[0],
        depositPaid: false,
      });
      }

      // 1b. Reservation path — hold the slot BEFORE paying for it. If the hold
      // fails there is nothing to pay for, so we stop and say why rather than
      // taking money for a time we do not have.
      let holdId: string | undefined;
      if (reserving && selectedSlot) {
        const holdRes = await fetch("/api/v1/book/hold", {
          method: "POST",
          headers: { "Content-Type": "application/json", ...authHeaders },
          body: JSON.stringify({
            artistId: artist.id,
            bookingId: activeBookingId,
            ...selectedSlot,
          }),
        });
        const holdData = await holdRes.json().catch(() => null);

        if (holdRes.status === 409) {
          // Somebody else took it between the page loading and this click.
          // Stay on the reservation product: the artist's calendar is still
          // live, only this time is gone. Mark it, keep the form, ask again.
          markSlotTaken(
            selectedSlot,
            "That time was just taken by someone else. Your details are kept — pick another time.",
          );
          setStep(0);
          setPhase("form");
          return;
        }
        if (!holdRes.ok || !holdData?.holdId) {
          // Reservations are unavailable for this artist right now. The request
          // the client already sent is safe — degrade to it honestly instead of
          // failing the whole booking.
          setSelectedSlot(null);
          setReservationLost(
            "We couldn't hold that time. Your request is saved — the artist will confirm a slot with you.",
          );
          setPaymentsUnavailable(false);
          setPhase("captured");
          return;
        }
        holdId = holdData.holdId;
        holdIdRef.current = holdId ?? null;
        syncUrl({ slot: `${selectedSlot.date}|${selectedSlot.startTime}|${selectedSlot.endTime}` });
      }

      // 2. Deposit via Stripe Checkout. If payments aren't configured
      // the request above is still saved — degrade honestly.
      const payRes = await fetch("/api/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders },
        body: JSON.stringify({
          artistId: artist.id,
          artistName: artist.name,
          size,
          placement,
          date: reserving && selectedSlot ? selectedSlot.date : selectedDates[0],
          time: reserving && selectedSlot ? selectedSlot.startTime : timePref,
          budget,
          clientName: name.trim(),
          clientEmail: email.trim(),
          bookingId: activeBookingId,
          // Present only on the reservation path. It ties this payment to the
          // held slot and caps the Stripe session at the hold's expiry.
          holdId,
          // So a browse-only redirect from checkout can keep the Brief thread.
          designSessionId: designSessionId || undefined,
        }),
      });
      const payData = await payRes.json().catch(() => null);

      if (payRes.ok && typeof payData?.sessionUrl === "string") {
        redirectingRef.current = true;
        window.location.href = payData.sessionUrl;
        return;
      }

      // The hold lapsed or was lost before Stripe could open (REA gap #2).
      // This is not a generic failure: the booking is fine, the time is not.
      // Keep reservation mode and the filled form; offer another time.
      if (payData?.code === "HOLD_LOST") {
        holdIdRef.current = null;
        if (selectedSlot) {
          markSlotTaken(
            selectedSlot,
            "That time is no longer held. Your details are kept — pick another time.",
          );
        }
        setHoldLost("Your held time ran out before checkout opened. Nothing was charged.");
        setPhase("form");
        return;
      }

      // Tier flipped (or checkout raced) after capture — send the client to
      // /intro instead of claiming payments aren't configured. The checkout
      // route releases any hold before returning this code.
      if (
        payData?.code === "ARTIST_INTRO_REQUIRED" &&
        typeof payData?.introUrl === "string"
      ) {
        redirectingRef.current = true;
        window.location.href = payData.introUrl;
        return;
      }

      // Checkout refused and nothing will be paid for this hold. The route
      // releases it on every path it knows; this is the idempotent backstop.
      void releaseHold(holdIdRef.current);

      // Graph/bookability 503 and other hard checkout failures must not share
      // the "Payments aren't configured yet" captured copy — the booking may
      // already be saved, but the reason is not missing Stripe config.
      if (
        !payRes.ok &&
        typeof payData?.error === "string" &&
        payData.error !== "Payments are not configured."
      ) {
        setError(payData.error);
        setPhase("form");
        return;
      }

      setPaymentsUnavailable(true);
      setPhase("captured");
    } catch (err) {
      // A hold without a checkout behind it reserves nothing anyone can pay for.
      void releaseHold(holdIdRef.current);
      setError(err instanceof Error ? err.message : "Something broke. Try again.");
      setPhase("form");
    }
  };

  // ─── No artist picked / not found ────────────────────────────────────
  if (!artist) {
    return (
      <StudioShell quiet>
        <div className="px-6 md:px-12 pt-8 pb-6 border-b hairline-quiet-soft">
          <div className="max-w-5xl mx-auto flex items-center justify-between text-[12px] text-quiet-dim font-body">
            <span>Booking</span>
            <span>Step 0/3</span>
          </div>
        </div>
        <div className="px-6 md:px-12 py-24 md:py-32">
          <div className="max-w-5xl mx-auto">
            <QuietHeadline>Pick your artist</QuietHeadline>
            <div className="mt-16 border hairline-quiet p-12 md:p-20 text-center">
              <p className="font-display-quiet text-[22px] md:text-[26px] text-quiet">
                {artistLoadFailed ? (
                  <>Couldn&apos;t reach the artist graph.</>
                ) : requestedArtistId ? (
                  <>That artist isn&apos;t in the roster.</>
                ) : (
                  <>A booking starts with an artist.</>
                )}
              </p>
              <p className="mt-6 text-[13px] text-quiet-dim font-body leading-[1.9] max-w-md mx-auto">
                {artistLoadFailed
                  ? "The live roster is unreachable right now — try again in a minute."
                  : "Browse the roster or get matched, then hit Book the Chair on their profile."}
              </p>
              <div className="mt-12 flex flex-col sm:flex-row items-center justify-center gap-5">
                <QuietCTA href="/artists" size="md">Browse the roster</QuietCTA>
                <QuietCTA href="/smart-match" variant="ghost" size="sm">Get matched</QuietCTA>
              </div>
            </div>
          </div>
        </div>
      </StudioShell>
    );
  }

  // ─── Captured, payments unavailable ──────────────────────────────────
  if (phase === "captured") {
    return (
      <StudioShell quiet>
        <div className="px-6 md:px-12 pt-8 pb-6 border-b hairline-quiet-soft">
          <div className="max-w-5xl mx-auto flex items-center justify-between text-[12px] text-quiet-dim tabular-nums font-body">
            <span>Booking</span>
            <span>Request sent</span>
          </div>
        </div>
        <div className="px-6 md:px-12 py-24 md:py-32">
          <div className="max-w-5xl mx-auto">
            <QuietHeadline>Request sent</QuietHeadline>
            <div className="mt-16 border hairline-quiet p-8 md:p-14">
              <div className="inline-block border hairline-quiet px-5 py-3">
                <div className="font-display-quiet text-quiet text-[18px] leading-none tabular-nums">
                  {bookingId}
                </div>
                <div className="font-body text-[11px] text-quiet-dim leading-none mt-1.5">
                  Confirmation
                </div>
              </div>
              <p className="mt-10 font-display-quiet text-[20px] md:text-[24px] text-quiet leading-[1.3]">
                Your request is with {artist.name}.
              </p>
              <p className="mt-5 text-[13px] text-quiet-dim font-body leading-[1.9] max-w-xl">
                {/* The reply-time promise (REA gap #3): a stated window, not silence. */}
                {requestReplyPromise(artist.name, artist.claimed)}
                {paymentsUnavailable && (
                  <>
                    <br />
                    <span className="text-quiet">
                      Payments aren&apos;t configured yet — no deposit was charged.
                    </span>
                    &nbsp;You&apos;ll settle the deposit once the artist confirms.
                  </>
                )}
              </p>
              <TattooPrepPlan artistName={artist.name} showBookingsLink={false} />
              <div className="mt-12 flex flex-col sm:flex-row items-start gap-5">
                <QuietCTA href="/bookings" size="md">Your bookings</QuietCTA>
                <QuietCTA href={`/artists/${artist.slug}`} variant="ghost" size="sm">
                  Back to {artist.name}
                </QuietCTA>
              </div>
            </div>
          </div>
        </div>
      </StudioShell>
    );
  }

  // ─── The 3-step flow ─────────────────────────────────────────────────
  return (
    <StudioShell quiet>
      <div className="px-6 md:px-12 pt-8 pb-6 border-b hairline-quiet-soft">
        <div className="max-w-5xl mx-auto flex items-center justify-between text-[12px] text-quiet-dim tabular-nums font-body">
          <span>Booking</span>
          <span>{artist.name}</span>
        </div>
      </div>

      <div className="px-6 md:px-12 py-16 md:py-24">
        <div className="max-w-5xl mx-auto">
          <QuietHeadline>Book the chair</QuietHeadline>
          <p className="mt-5 text-[13px] text-quiet-dim font-body leading-[1.8] max-w-2xl">
            See exactly what you&apos;re requesting, what you&apos;ll pay at checkout, and
            what happens after you pay.
          </p>

          {/* ARTIST STRIP — who you're booking, with honest availability */}
          <div className="mt-12 border hairline-quiet p-6 flex flex-wrap items-center gap-x-6 gap-y-3">
            <div>
              <div className="font-display-quiet text-[20px] text-quiet leading-none">
                {artist.name}
              </div>
              <div className="mt-3 text-[12px] text-quiet-dim font-body">
                {[artist.shopName, artist.location].filter(Boolean).join(" · ")}
              </div>
            </div>
            <div className="ml-auto border hairline-quiet px-3 py-1.5">
              <span className="font-body text-[11px] text-quiet-dim">
                {artist.availabilityLabel}
              </span>
            </div>
          </div>

          <BookingPathExplainer
            mode={reserving ? "reservation" : "request"}
            artistName={artist.name}
          />

          {/* STEP INDICATOR */}
          <div className="mt-12 flex flex-col sm:flex-row sm:items-stretch gap-0 border hairline-quiet">
            {steps.map((s, i) => {
              const active = i === step;
              const done = i < step;
              const doneDetail =
                i === 0
                  ? reserving
                    ? selectedSlot
                      ? `${formatSlotDate(selectedSlot.date)} ${selectedSlot.startTime}`
                      : "No time picked"
                    : `${selectedDates.length} date${selectedDates.length === 1 ? "" : "s"}`
                  : i === 1
                    ? size
                      ? `${size} / ${placement}`
                      : "Details set"
                    : "";
              return (
                <button
                  key={s.n}
                  type="button"
                  onClick={() => { if (i <= step) goToStep(i as 0 | 1 | 2); }}
                  disabled={i > step}
                  className={`relative flex-1 px-6 py-5 border-b sm:border-b-0 sm:border-r hairline-quiet-soft last:border-r-0 last:border-b-0 flex items-center gap-4 press text-left ${
                    active ? "bg-white/[0.04]" : done ? "hover:bg-white/5" : ""
                  }`}
                >
                  {active && <span className="absolute top-0 left-0 right-0 h-px bg-quiet" />}
                  <span
                    className={`font-display-quiet text-[22px] leading-none tabular-nums ${
                      active ? "text-quiet" : "text-quiet-dim/70"
                    }`}
                  >
                    {s.n}
                  </span>
                  <span className="min-w-0">
                    <span
                      className={`block text-[12px] font-body ${
                        active ? "text-white" : done ? "text-quiet" : "text-quiet-dim"
                      }`}
                    >
                      {s.label}
                    </span>
                    <span
                      className={`block text-[11px] font-body mt-1 truncate ${
                        active ? "text-quiet-dim" : "text-quiet-dim/80"
                      }`}
                    >
                      {active ? "In progress" : done ? `✓ ${doneDetail}` : s.hint}
                    </span>
                  </span>
                </button>
              );
            })}
          </div>

          {/* STEP 01 — PICK A TIME (reservation) or REQUEST DATES (request) */}
          {step === 0 && (
            <div className="mt-12 border hairline-quiet p-8 md:p-12">
              <div className="flex items-baseline justify-between gap-4 flex-wrap mb-4">
                <h2 className="font-display-quiet text-[20px] text-quiet">
                  {reserving ? "Pick your time" : "Request your dates"}
                </h2>
                <span className="text-[12px] text-quiet-dim font-body tabular-nums">
                  {reserving ? offer.label : `Up to ${MAX_REQUESTED_SLOTS}`}
                </span>
              </div>

              {/* The client is told which product they are getting, always. */}
              <p className="text-[13px] text-quiet-dim font-body leading-[1.8] max-w-xl">
                {reserving
                  ? offer.detail
                  : (artist.availabilityNote ??
                    `${artist.name} confirms your slot after you send the request — these are asks, not reservations.`)}
              </p>

              {/* A reservation that stopped being available mid-flow says so. */}
              {reservationLost && (
                <p className="mt-5 text-[13px] text-pink font-body leading-[1.8] max-w-xl">
                  {reservationLost}
                </p>
              )}
              {/* A lost or resumed time says so without changing the product. */}
              {slotNotice && !reservationLost && (
                <p
                  role="status"
                  className="mt-5 text-[13px] text-pink font-body leading-[1.8] max-w-xl"
                >
                  {slotNotice}
                </p>
              )}

              {reserving ? (
                <div className="mt-8 space-y-8">
                  {slotsByDate.map(([date, daySlots]) => (
                    <div key={date}>
                      <div className="text-[12px] text-quiet-dim mb-4 font-body">
                        {formatSlotDate(date)}
                      </div>
                      <div className="flex flex-wrap gap-3">
                        {daySlots.map((slot) => {
                          const sel =
                            selectedSlot?.date === slot.date &&
                            selectedSlot?.startTime === slot.startTime;
                          const taken = isTaken(slot);
                          return (
                            <button
                              key={`${slot.date}-${slot.startTime}`}
                              type="button"
                              disabled={taken}
                              aria-disabled={taken || undefined}
                              onClick={() => setSelectedSlot(sel ? null : slot)}
                              className={`text-[13px] border hairline-quiet-soft px-5 py-3.5 press font-body tabular-nums ${
                                taken
                                  ? "text-white/25 line-through cursor-not-allowed"
                                  : sel
                                    ? "bg-quiet text-black border-quiet"
                                    : "text-quiet hover:text-black hover:bg-quiet"
                              }`}
                            >
                              {slot.startTime}
                              {taken && (
                                <span className="ml-2 no-underline text-[11px]">Taken</span>
                              )}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
              <>
              <div className="mt-8 grid grid-cols-2 sm:grid-cols-4 gap-3">
                {days.map(({ iso, date }) => {
                  const sel = selectedDates.includes(iso);
                  const full = !sel && selectedDates.length >= MAX_REQUESTED_SLOTS;
                  return (
                    <button
                      key={iso}
                      type="button"
                      onClick={() => toggleDate(iso)}
                      disabled={full}
                      className={`border hairline-quiet-soft px-4 py-4 text-left press font-body ${
                        sel
                          ? "bg-quiet text-black"
                          : full
                            ? "text-white/25 cursor-not-allowed"
                            : "text-quiet hover:bg-white/5 hover:text-white"
                      }`}
                    >
                      <span className="block font-display-quiet text-[16px] leading-none">
                        {shortDate(date)}
                      </span>
                      <span className="block text-[11px] mt-2 opacity-70">
                        {sel ? "✓ Requested" : "Tap to request"}
                      </span>
                    </button>
                  );
                })}
              </div>

              <div className="mt-10">
                <div className="text-[12px] text-quiet-dim mb-4 font-body">
                  Time of day
                </div>
                <div className="flex flex-wrap gap-3">
                  {TIME_PREFS.map((t) => (
                    <button
                      key={t}
                      type="button"
                      onClick={() => setTimePref(t)}
                      className={`text-[12px] border hairline-quiet-soft px-5 py-3 press font-body ${
                        timePref === t
                          ? "bg-quiet text-black border-quiet"
                          : "text-quiet hover:text-black hover:bg-quiet"
                      }`}
                    >
                      {t}
                    </button>
                  ))}
                </div>
              </div>
              </>
              )}
            </div>
          )}

          {/* STEP 02 — DESIGN + DETAILS */}
          {step === 1 && (
            <div className="mt-12 border hairline-quiet p-8 md:p-12 space-y-14">
              {/* Design */}
              <div>
                <div className="flex items-baseline justify-between mb-6">
                  <h2 className="font-display-quiet text-[20px] text-quiet">
                    Pick a design
                  </h2>
                  <span className="text-[12px] text-quiet-dim font-body tabular-nums">
                    {designs.length}&nbsp;saved
                  </span>
                </div>
                <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
                  <button
                    type="button"
                    onClick={() => setDesignId(null)}
                    className={`aspect-square border ${
                      designId === null ? "border-quiet" : "hairline-quiet-soft"
                    } press flex flex-col items-center justify-center gap-2 text-quiet hover:text-white`}
                  >
                    <span className="font-display-quiet text-[16px]">No design</span>
                    <span className="text-[11px] text-quiet-dim font-body">
                      Decide in chair
                    </span>
                  </button>
                  {designs.map((d: TattDesign) => (
                    <button
                      key={d.id}
                      type="button"
                      onClick={() => setDesignId(d.id)}
                      className={`group press text-left border ${
                        designId === d.id ? "border-quiet" : "hairline-quiet-soft"
                      }`}
                    >
                      <div className={`aspect-square ${d.image ? "bg-bone" : d.color} relative overflow-hidden`}>
                        {d.image ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img
                            src={d.image}
                            alt=""
                            className="absolute inset-0 w-full h-full object-cover"
                            loading="lazy"
                          />
                        ) : (
                          <div className="absolute inset-0 bg-gradient-to-b from-transparent to-black/50 mix-blend-multiply" />
                        )}
                      </div>
                      <div className="p-2.5">
                        <div className="font-body text-[12px] text-quiet line-clamp-1">
                          {d.prompt.split(/[\s,]+/).slice(0, 3).join(" ") || "Untitled"}
                        </div>
                      </div>
                    </button>
                  ))}
                </div>
              </div>

              {/* Size */}
              <div>
                <div className="text-[12px] text-quiet-dim mb-4 font-body">
                  Size
                </div>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                  {SIZES.map((s) => (
                    <button
                      key={s.id}
                      type="button"
                      onClick={() => setSize(s.id)}
                      className={`border px-4 py-4 text-left press ${
                        size === s.id ? "border-quiet bg-white/[0.04]" : "hairline-quiet-soft hover:bg-white/5"
                      }`}
                    >
                      <span className="block font-display-quiet text-[16px] text-quiet">
                        {s.label}
                      </span>
                      <span className="block text-[11px] text-quiet-dim font-body mt-1.5">
                        {s.desc} · ${depositDollarsForSize(s.id)} deposit
                      </span>
                    </button>
                  ))}
                </div>
              </div>

              {/* Placement */}
              <div>
                <div className="text-[12px] text-quiet-dim mb-4 font-body">
                  Placement
                </div>
                <div className="flex flex-wrap gap-3">
                  {PLACEMENTS.map((p) => (
                    <button
                      key={p}
                      type="button"
                      onClick={() => setPlacement(p)}
                      className={`text-[12px] border hairline-quiet-soft px-4 py-2.5 press font-body ${
                        placement === p
                          ? "bg-quiet text-black border-quiet"
                          : "text-quiet hover:text-black hover:bg-quiet"
                      }`}
                    >
                      {p}
                    </button>
                  ))}
                </div>
              </div>

              {/* Vision */}
              <div>
                <label
                  htmlFor="vision"
                  className="block text-[12px] text-quiet-dim mb-4 font-body"
                >
                  Describe your vision
                </label>
                <textarea
                  id="vision"
                  value={description}
                  onChange={(e) => setDescription(e.target.value.slice(0, 2000))}
                  rows={3}
                  placeholder="Style, mood, references — what matters to you…"
                  className="w-full bg-black text-quiet placeholder-white/30 focus:outline-none text-[16px] leading-[1.5] border hairline-quiet-soft focus:border-quiet p-4 transition-colors font-body resize-none"
                />
              </div>

              {/* Budget */}
              <div>
                <div className="text-[12px] text-quiet-dim mb-4 font-body">
                  Budget
                </div>
                <div className="flex flex-wrap gap-3">
                  {BUDGETS.map((b) => (
                    <button
                      key={b.value}
                      type="button"
                      onClick={() => setBudget(b.value)}
                      className={`text-[12px] border hairline-quiet-soft px-4 py-2.5 press font-body ${
                        budget === b.value
                          ? "bg-quiet text-black border-quiet"
                          : "text-quiet hover:text-black hover:bg-quiet"
                      }`}
                    >
                      {b.label}
                    </button>
                  ))}
                </div>
              </div>

              {/* Contact */}
              <div>
                <div className="text-[12px] text-quiet-dim mb-4 font-body">
                  Your info
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <input
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="Name"
                    aria-label="Name"
                    className="bg-black text-quiet placeholder-white/30 focus:outline-none text-[14px] border hairline-quiet-soft focus:border-quiet px-4 py-3 font-body"
                  />
                  <input
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="Email"
                    aria-label="Email"
                    type="email"
                    className="bg-black text-quiet placeholder-white/30 focus:outline-none text-[14px] border hairline-quiet-soft focus:border-quiet px-4 py-3 font-body"
                  />
                  <input
                    value={phone}
                    onChange={(e) => setPhone(e.target.value)}
                    placeholder="Phone (optional)"
                    aria-label="Phone"
                    type="tel"
                    className="bg-black text-quiet placeholder-white/30 focus:outline-none text-[14px] border hairline-quiet-soft focus:border-quiet px-4 py-3 font-body sm:col-span-2"
                  />
                </div>
              </div>
            </div>
          )}

          {/* STEP 03 — REVIEW + DEPOSIT */}
          {step === 2 && (
            <div className="mt-12 border hairline-quiet p-8 md:p-12">
              <h2 className="font-display-quiet text-[20px] text-quiet mb-8">
                    {reviewLabels.heading}
              </h2>
              <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-10 gap-y-7 text-[13px] font-body">
                <div>
                  <dt className="text-[11px] text-quiet-dim">Artist</dt>
                  <dd className="mt-1.5 text-quiet">{artist.name} · {artist.location}</dd>
                </div>
                <div>
                  <dt className="text-[11px] text-quiet-dim">
                    {reserving
                      ? reviewLabels.timing
                      : `${reviewLabels.timing} (${timePref.toLowerCase()})`}
                  </dt>
                  <dd className="mt-1.5 text-quiet">
                    {reserving && selectedSlot
                      ? `${formatSlotDate(selectedSlot.date)} · ${selectedSlot.startTime}`
                      : selectedDates
                          .map((iso) => shortDate(new Date(`${iso}T00:00:00`)))
                          .join(" · ")}
                  </dd>
                </div>
                <div>
                  <dt className="text-[11px] text-quiet-dim">Piece</dt>
                  <dd className="mt-1.5 text-quiet capitalize">{size} · {placement}</dd>
                </div>
                <div>
                  <dt className="text-[11px] text-quiet-dim">Design</dt>
                  <dd className="mt-1.5 text-quiet">
                    {chosenDesign
                      ? chosenDesign.prompt.split(/[\s,]+/).slice(0, 4).join(" ")
                      : "No design — decide in chair"}
                  </dd>
                </div>
                <div>
                  <dt className="text-[11px] text-quiet-dim">Budget</dt>
                  <dd className="mt-1.5 text-quiet">
                    {BUDGETS.find((b) => b.value === budget)?.label ?? budget}
                  </dd>
                </div>
                <div>
                  <dt className="text-[11px] text-quiet-dim">Contact</dt>
                  <dd className="mt-1.5 text-quiet">{name} · {email}</dd>
                </div>
                <div className="sm:col-span-2">
                  <dt className="text-[11px] text-quiet-dim">Vision</dt>
                  <dd className="mt-1.5 text-quiet/80 leading-[1.6] normal-case">
                    &ldquo;{description.trim()}&rdquo;
                  </dd>
                </div>
              </dl>

              <div className="mt-10 border-t hairline-quiet-soft pt-8">
                <ReceiptCard className="max-w-xl">
                  <div className="font-display-quiet text-[22px] leading-none">
                    Checkout breakdown
                  </div>
                  <CheckoutEstimate
                    deposit={deposit}
                    feePercent={feePercent}
                    artistClaimed={artist.claimed}
                  />
                  <p className="mt-5 pt-5 border-t border-black/15 text-[13px] font-body text-black/80 leading-[1.7]">
                    {/* The money sentence (ADR-0036): who pays what, who keeps what. */}
                    {bookingReviewMoneyCopy(artist.name, feePercent, artist.claimed, holdDays)}
                  </p>
                  <p className="mt-3 text-[12px] font-body text-black/60 leading-[1.7]">
                    {reserving
                      ? "We place a short hold before checkout; payment secures that held time."
                      : "Payment starts the booking process; it does not confirm one of your requested dates."}
                    <br />
                    {reserving
                      ? "If the hold expires before payment, the time returns to availability."
                      : "The artist confirms a date or offers another time."}
                  </p>
                </ReceiptCard>
              </div>
            </div>
          )}

          {holdLost && (
            <div className="mt-8 border border-pink/60 p-5 flex flex-col sm:flex-row sm:items-center gap-4">
              <p className="text-[13px] text-pink font-body leading-[1.7]">
                {holdLost}
                {step !== 0 && " Your details are kept."}
              </p>
              {step !== 0 && (
                <div className="sm:ml-auto">
                  <QuietCTA
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      setHoldLost(null);
                      goToStep(0);
                    }}
                  >
                    Pick another time
                  </QuietCTA>
                </div>
              )}
            </div>
          )}

          {error && (
            <div className="mt-8 border border-pink/60 p-5">
              <p className="text-[13px] text-pink font-body">
                {error}
              </p>
            </div>
          )}

          {/* ACTION ROW */}
          <div className="mt-14 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-6">
            {step === 0 && (reserving ? Boolean(selectedSlot) : selectedDates.length > 0) && (
              <div className="inline-block border hairline-quiet px-5 py-3 self-start">
                <div className="font-display-quiet text-quiet text-[14px] leading-none tabular-nums">
                  {reserving && selectedSlot
                    ? selectedSlot.startTime
                    : `${selectedDates.length}/${MAX_REQUESTED_SLOTS}`}
                </div>
                <div className="font-body text-[11px] text-quiet-dim leading-none mt-1.5">
                  {reserving ? "Time picked" : "Dates requested"}
                </div>
              </div>
            )}
            <div className="sm:ml-auto">
              {step === 0 && (
                <QuietCTA
                  size="md"
                  disabled={!timeChosen}
                  onClick={() => setStep(1)}
                >
                  Next
                </QuietCTA>
              )}
              {step === 1 && (
                <QuietCTA size="md" disabled={!detailsValid} onClick={() => setStep(2)}>
                  Review
                </QuietCTA>
              )}
              {step === 2 && (
                <QuietCTA size="md" disabled={phase === "submitting"} onClick={submit}>
                  {phase === "submitting"
                    ? "Preparing checkout…"
                    : reserving
                      ? "Hold time & continue"
                      : "Send request & continue"}
                </QuietCTA>
              )}
            </div>
          </div>
        </div>
      </div>
    </StudioShell>
  );
}
