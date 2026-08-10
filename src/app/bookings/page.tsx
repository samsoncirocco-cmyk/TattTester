"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import StudioShell from "@/components/studio/StudioShell";
import QuietHeadline from "@/components/quiet/QuietHeadline";
import QuietCTA from "@/components/quiet/QuietCTA";
import {
  useBookings,
  useDesigns,
  type TattBooking,
  type TattDesign,
} from "@/lib/tattStorage";
import { getApiAuthHeaders } from "@/lib/client-api-auth";
import type { BookingStatus } from "@/lib/booking";
import { bookingsListMoneyCopy } from "@/lib/money-copy";
import { bookingStatusCopy } from "./bookingStatus";

function formatBookingDate(iso: string): string {
  const [y, m, d] = iso.split("-");
  const months = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun",
    "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
  ];
  const month = months[parseInt(m, 10) - 1] ?? m;
  return `${month} ${parseInt(d, 10)}, ${y}`;
}

type RequestedSlot = { date: string; time?: string };
type ServerBooking = {
  id: string;
  bookingId?: string;
  artistId?: string;
  artistName?: string;
  designId?: string;
  status?: BookingStatus;
  depositAmount?: number | string;
  requestedSlots?: RequestedSlot[];
};

type DesignSummary = {
  id: string;
  label: string;
};

function designSummary(designs: TattDesign[], id?: string): DesignSummary | null {
  if (!id) return null;
  const design = designs.find((candidate) => candidate.id === id);
  if (!design) return null;
  return {
    id,
    label:
      design.title?.trim() ||
      design.prompt.split(/[\s,]+/).slice(0, 4).join(" ") ||
      "Untitled design",
  };
}

function requestedDate(slots?: RequestedSlot[]): string | null {
  const slot = slots?.find((candidate) =>
    /^\d{4}-\d{2}-\d{2}$/.test(candidate.date),
  );
  return slot ? formatBookingDate(slot.date) : null;
}

function SavedDesignLink({ design }: { design: DesignSummary }) {
  return (
    <Link
      href={`/designs/${design.id}`}
      className="text-quiet underline underline-offset-4 hover:text-white"
    >
      {design.label}
    </Link>
  );
}

function CardAction({
  status,
  design,
}: {
  status?: BookingStatus;
  design: DesignSummary | null;
}) {
  const copy = bookingStatusCopy(status);
  if (design && copy.preferDesignAction) {
    return (
      <QuietCTA href={`/designs/${design.id}`} size="sm" variant="ghost">
        View saved design
      </QuietCTA>
    );
  }
  return (
    <QuietCTA href={copy.actionHref} size="sm" variant="ghost">
      {copy.actionLabel}
    </QuietCTA>
  );
}

function ServerBookingCard({
  booking,
  design,
}: {
  booking: ServerBooking;
  design: DesignSummary | null;
}) {
  const copy = bookingStatusCopy(booking.status);
  const date = requestedDate(booking.requestedSlots);

  return (
    <article className="border hairline-quiet p-8 md:p-10">
      <div className="flex items-start justify-between gap-6 flex-wrap">
        <div>
          <div className="font-body text-[10px] uppercase tracking-[0.16em] text-quiet-dim">
            Requested date
          </div>
          <div className="mt-2 font-display-quiet text-quiet text-[24px] sm:text-[28px] leading-none">
            {date ?? "No date requested"}
          </div>
          <div className="mt-4 flex flex-wrap items-center gap-3 text-[12px] text-quiet-dim font-body">
            <span>
              Artist:&nbsp;
              <span className="text-quiet">
                {booking.artistName ?? "Not assigned"}
              </span>
            </span>
            <span aria-hidden="true">·</span>
            <span>
              Ref:&nbsp;
              <span className="text-quiet">
                {booking.bookingId ?? booking.id}
              </span>
            </span>
            {booking.depositAmount != null && (
              <>
                <span aria-hidden="true">·</span>
                <span>
                  Deposit amount:&nbsp;
                  <span className="text-quiet">
                    ${String(booking.depositAmount)}
                  </span>
                </span>
              </>
            )}
            {design && (
              <>
                <span aria-hidden="true">·</span>
                <span>
                  Design:&nbsp;<SavedDesignLink design={design} />
                </span>
              </>
            )}
          </div>
        </div>

        <div className="inline-block border hairline-quiet px-3 py-2">
          <div className="font-display-quiet text-quiet text-[13px] leading-none">
            {copy.label}
          </div>
          <div className="font-body text-[10px] text-quiet-dim leading-none mt-1">
            {copy.qualifier}
          </div>
        </div>
      </div>

      <div className="mt-8 pt-6 border-t hairline-quiet-soft flex items-center justify-between gap-5 flex-wrap">
        <p className="font-body text-[12px] leading-[1.6] text-quiet-dim max-w-2xl">
          {copy.nextStep}
        </p>
        <CardAction status={booking.status} design={design} />
      </div>
    </article>
  );
}

function LocalBookingCard({
  booking,
  design,
  onRemove,
}: {
  booking: TattBooking;
  design: DesignSummary | null;
  onRemove: () => void;
}) {
  const paymentLabel = booking.depositPaid
    ? "Payment saved on this device"
    : "Deposit not recorded";
  const nextStep = booking.depositPaid
    ? "Next: refresh for server verification. A date is not confirmed until the artist confirms it."
    : "This device copy cannot resume checkout. Start a fresh request if you did not pay; this requested date is not booked.";

  return (
    <article className="border hairline-quiet p-8 md:p-10">
      <div className="flex items-start justify-between gap-6 flex-wrap">
        <div>
          <div className="font-body text-[10px] uppercase tracking-[0.16em] text-quiet-dim">
            Requested date
          </div>
          <div className="mt-2 font-display-quiet text-quiet text-[24px] sm:text-[28px] leading-none">
            {formatBookingDate(booking.date)}
          </div>
          <div className="mt-4 flex flex-wrap items-center gap-3 text-[12px] text-quiet-dim font-body">
            <span>
              Artist:&nbsp;
              <span className="text-quiet">
                {booking.artistName ?? "Not assigned"}
              </span>
            </span>
            {design && (
              <>
                <span aria-hidden="true">·</span>
                <span>
                  Design:&nbsp;<SavedDesignLink design={design} />
                </span>
              </>
            )}
          </div>
        </div>

        <div className="inline-block border hairline-quiet px-3 py-2">
          <div className="font-display-quiet text-quiet text-[13px] leading-none">
            Request saved on this device
          </div>
          <div className="font-body text-[10px] text-quiet-dim leading-none mt-1">
            {paymentLabel}
          </div>
        </div>
      </div>

      <div className="mt-8 pt-6 border-t hairline-quiet-soft flex items-center justify-between gap-5 flex-wrap">
        <p className="font-body text-[12px] leading-[1.6] text-quiet-dim max-w-2xl">
          {nextStep}
        </p>
        <div className="flex items-center gap-3 flex-wrap">
          {design ? (
            <QuietCTA href={`/designs/${design.id}`} size="sm" variant="ghost">
              View saved design
            </QuietCTA>
          ) : (
            <QuietCTA href="/book" size="sm" variant="ghost">
              Start a fresh request
            </QuietCTA>
          )}
          <button
            onClick={() => {
              if (
                confirm(
                  "Hide this device copy? This does not cancel the request with the artist.",
                )
              ) {
                onRemove();
              }
            }}
            className="px-3 py-2 text-[11px] text-quiet-dim hover:text-white font-body"
          >
            Hide from this device
          </button>
        </div>
      </div>
    </article>
  );
}

export default function BookingsPage() {
  const { bookings, hydrated, removeBooking } = useBookings();
  const { designs } = useDesigns();

  // Server truth. `null` means unresolved or unavailable, in which case the
  // device copy remains visible but is explicitly labelled as such.
  const [server, setServer] = useState<ServerBooking[] | null>(null);
  const [serverResolved, setServerResolved] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      let headers: Record<string, string>;
      try {
        headers = await getApiAuthHeaders();
      } catch {
        if (!cancelled) setServerResolved(true);
        return;
      }
      try {
        const response = await fetch("/api/v1/bookings", { headers });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json().catch(() => null);
        if (!cancelled && data?.success && Array.isArray(data.bookings)) {
          setServer(data.bookings as ServerBooking[]);
        }
      } catch {
        // Keep the labelled device copy instead of presenting a false server state.
      } finally {
        if (!cancelled) setServerResolved(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // A just-created request can take a moment to appear in the owner query.
  // Keep its device copy visible until the server returns at least one row.
  const useServer = server !== null && (server.length > 0 || bookings.length === 0);
  const count = useServer ? server.length : bookings.length;
  const ready = useServer ? true : hydrated && serverResolved;
  const showEmpty = ready && count === 0;

  return (
    <StudioShell quiet>
      <div className="px-6 md:px-12 pt-8 pb-6 border-b hairline-quiet-soft">
        <div className="max-w-5xl mx-auto flex items-center justify-between text-[12px] text-quiet-dim tabular-nums font-body">
          <span>Booking status</span>
          <span>Requests: {ready ? count : "—"}</span>
        </div>
      </div>

      <div className="px-6 md:px-12 py-24 md:py-32">
        <div className="max-w-5xl mx-auto">
          <div className="flex items-end justify-between gap-6 flex-wrap">
            <div>
              <QuietHeadline>Your bookings</QuietHeadline>
              <p className="mt-4 font-body text-[13px] text-quiet-dim leading-[1.7] max-w-2xl">
                Requested dates are not appointments until the booking status
                says confirmed and the artist sends the exact details.
              </p>
            </div>
            <QuietCTA href="/book" size="md">New booking</QuietCTA>
          </div>

          <p className="mt-6 font-body text-[14px] text-quiet leading-[1.7] max-w-xl">
            {bookingsListMoneyCopy()}
          </p>

          {showEmpty ? (
            <div className="mt-24 border hairline-quiet py-28 px-6 text-center">
              <div className="font-display-quiet text-[26px] sm:text-[32px] leading-[1.1] text-quiet">
                No booking requests yet.
              </div>
              <p className="mt-5 text-[13px] text-quiet-dim font-body">
                Start with an artist, a design, and dates that work for you.
              </p>
              <div className="mt-12 flex justify-center gap-3 flex-wrap">
                <QuietCTA href="/book" size="lg">Start a booking</QuietCTA>
                <QuietCTA href="/designs" size="lg" variant="ghost">
                  Choose a saved design
                </QuietCTA>
              </div>
            </div>
          ) : useServer ? (
            <div className="mt-16 space-y-6">
              {server.map((booking) => (
                <ServerBookingCard
                  key={booking.id}
                  booking={booking}
                  design={designSummary(designs, booking.designId)}
                />
              ))}
            </div>
          ) : (
            <div className="mt-16 space-y-6">
              <div className="border hairline-quiet-soft px-5 py-4 font-body text-[12px] leading-[1.6] text-quiet-dim">
                Showing the copy saved on this device. Refresh later for payment
                and artist-confirmation updates.
              </div>
              {bookings.map((booking) => (
                <LocalBookingCard
                  key={booking.id}
                  booking={booking}
                  design={designSummary(designs, booking.designId)}
                  onRemove={() => removeBooking(booking.id)}
                />
              ))}
            </div>
          )}
        </div>
      </div>
    </StudioShell>
  );
}
