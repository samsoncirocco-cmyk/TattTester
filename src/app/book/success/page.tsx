"use client";

/**
 * Stripe Checkout return page (success_url) — quiet-dark StudioShell look
 * (ADR-0032): this is a money surface, so the volume stays down.
 *
 * The Stripe redirect params tell us what the client *asked* for, but a
 * redirect alone doesn't prove the deposit cleared. So after mount we
 * reconcile against server truth via the owner-scoped read API and prefer
 * the persisted status/depositAmount/paidAt over the URL params. If that
 * fetch can't run (signed out, offline, backend unconfigured) we fall back
 * to the param-based display — never blank, never invent a paid deposit.
 */

import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import StudioShell from "@/components/studio/StudioShell";
import QuietHeadline from "@/components/quiet/QuietHeadline";
import QuietCTA from "@/components/quiet/QuietCTA";
import ReceiptCard from "@/components/quiet/ReceiptCard";
import { getApiAuthHeaders } from "@/lib/client-api-auth";
import type { BookingStatus } from "@/lib/booking";
import { depositHoldDays } from "@/lib/deposit-hold";
import { bookingSuccessMoneyCopy } from "@/lib/money-copy";
import { requestReplyPromise } from "@/lib/request-reply-window";
import { TattooPrepPlan } from "../BookingConfidence";

/** Statuses at or past a paid deposit — safe to say "Deposit paid". */
const PAID_STATUSES: ReadonlySet<BookingStatus> = new Set<BookingStatus>([
  "deposit_paid",
  "confirmed",
  "completed",
]);

/**
 * Terminal states where "what happens next" would be a lie — the booking is
 * over, and the status line above already says so.
 */
const ENDED_STATUSES: ReadonlySet<BookingStatus> = new Set<BookingStatus>([
  "declined",
  "cancelled",
  "refunded",
  "expired",
]);

const STATUS_LABELS: Record<BookingStatus, string> = {
  pending: "Awaiting deposit",
  held: "Slot held — finish payment",
  deposit_paid: "Deposit paid",
  confirmed: "Confirmed",
  declined: "Declined",
  completed: "Completed",
  cancelled: "Cancelled",
  refunded: "Refunded",
  expired: "Expired",
};

type ServerBooking = {
  status?: BookingStatus;
  depositAmount?: number | string;
  paidAt?: string;
  artistName?: string;
  stripeSessionId?: string;
};

type TimelineStep = { title: string; detail: string };

/**
 * The vertical what-happens-next timeline — quiet register: hairline
 * connector, warm-gray dots, no pink. The current step carries
 * aria-current="step" and the brightest text.
 */
function QuietTimeline({
  steps,
  currentIndex,
  allDone,
}: {
  steps: TimelineStep[];
  /** Index of the step in progress; steps before it are done. */
  currentIndex: number;
  /** Every step is behind us (booking completed). */
  allDone: boolean;
}) {
  return (
    <ol className="mt-7">
      {steps.map((step, i) => {
        const done = allDone || i < currentIndex;
        const current = !allDone && i === currentIndex;
        const last = i === steps.length - 1;
        return (
          <li
            key={step.title}
            aria-current={current ? "step" : undefined}
            className={`relative pl-8 ${last ? "" : "pb-8"}`}
          >
            {!last && (
              <span
                aria-hidden
                className="absolute left-[4px] top-[14px] bottom-0 w-px bg-white/15"
              />
            )}
            <span
              aria-hidden
              className={`absolute left-0 top-[5px] h-[9px] w-[9px] rounded-full ${
                current
                  ? "bg-white"
                  : done
                    ? "bg-quiet"
                    : "border hairline-quiet bg-transparent"
              }`}
            />
            <p
              className={`text-[13px] font-body ${
                current ? "text-white" : done ? "text-quiet" : "text-quiet-dim"
              }`}
            >
              {step.title}
            </p>
            <p className="mt-1 text-[12px] text-quiet-dim font-body leading-[1.7]">
              {step.detail}
            </p>
          </li>
        );
      })}
    </ol>
  );
}

type ReconciliationPhase = "idle" | "reconciling" | "settled" | "timed_out" | "unavailable";

const RECONCILIATION_INTERVAL_MS = 1_000;
const RECONCILIATION_MAX_ATTEMPTS = 6;
const NON_PAID_TERMINAL_STATUSES: ReadonlySet<BookingStatus> = new Set<BookingStatus>([
  "declined",
  "cancelled",
  "refunded",
  "expired",
]);

function prettyDate(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(iso) ? `${iso}T00:00:00` : iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" });
}

function SuccessContent() {
  const sp = useSearchParams();
  const artist = sp.get("artist");
  const size = sp.get("size");
  const placement = sp.get("placement");
  const date = prettyDate(sp.get("date"));
  const time = sp.get("time");
  const deposit = sp.get("deposit");
  const sessionId = sp.get("session_id");
  const bookingId = sp.get("bookingId");
  // Which money-sentence variant applies (ADR-0036 amendment). Checkout sets
  // artistClaimed=0 on the held-deposit path; absent means claimed. Display
  // copy only — never used to infer payment.
  const artistClaimed = sp.get("artistClaimed") !== "0";
  // Hold window stamped at checkout (ADR-0006); fall back to live config.
  const holdDaysParam = Number(sp.get("holdDays"));
  const holdDays =
    Number.isFinite(holdDaysParam) && holdDaysParam > 0
      ? Math.trunc(holdDaysParam)
      : depositHoldDays();
  // A display-only amount is not a payment identifier. Reconcile only when
  // the return URL can name an exact booking or Stripe session.
  const hasPaymentReturnContext = Boolean(bookingId || sessionId);

  // Server truth, once reconciled. `null` = not yet loaded / unavailable.
  const [server, setServer] = useState<ServerBooking | null>(null);
  const [reconciliationPhase, setReconciliationPhase] = useState<ReconciliationPhase>(
    hasPaymentReturnContext ? "reconciling" : "idle"
  );

  // The booking's .ics, when it has a CONCRETE slot (reservation model —
  // ADR 0027). The calendar route answers 404 for request-model bookings,
  // so a fetched file doubles as the honest discriminator between the two
  // timeline variants. `null` = request model, or truth unavailable —
  // either way we fail closed to the request framing, mirroring
  // resolveBookingMode.
  const [calendarIcs, setCalendarIcs] = useState<Blob | null>(null);

  useEffect(() => {
    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;

    (async () => {
      let headers: Record<string, string>;
      try {
        headers = await getApiAuthHeaders();
      } catch {
        if (!cancelled && hasPaymentReturnContext) setReconciliationPhase("unavailable");
        return;
      }

      let attempts = 0;
      const reconcile = async (): Promise<void> => {
        attempts += 1;
        let booking: ServerBooking | undefined;

        try {
          // Both reads are owner-scoped, but ownership alone is not enough to
          // prove which payment this page belongs to. We only accept an exact
          // booking id or an exact Stripe session match.
          const url = bookingId
            ? `/api/v1/bookings/${encodeURIComponent(bookingId)}`
            : `/api/v1/bookings`;
          const res = await fetch(url, { headers });
          if (res.ok) {
            const data = await res.json().catch(() => null);
            if (data?.success) {
              booking = bookingId
                ? data.booking
                : Array.isArray(data.bookings)
                  ? sessionId
                    ? data.bookings.find(
                        (candidate: ServerBooking) =>
                          candidate.stripeSessionId === sessionId,
                      )
                    : undefined
                  : undefined;
            }
          }
        } catch {
          // A transient read failure is allowed to use the rest of the bounded
          // reconciliation window. We still never infer payment from the URL.
        }

        if (cancelled) return;
        if (booking) setServer(booking);

        const status = booking?.status;
        const isSettled =
          status !== undefined &&
          (PAID_STATUSES.has(status) || NON_PAID_TERMINAL_STATUSES.has(status));
        if (isSettled || !hasPaymentReturnContext) {
          setReconciliationPhase("settled");
          return;
        }

        if (attempts >= RECONCILIATION_MAX_ATTEMPTS) {
          setReconciliationPhase("timed_out");
          return;
        }

        retryTimer = setTimeout(() => {
          void reconcile();
        }, RECONCILIATION_INTERVAL_MS);
      };

      await reconcile();
    })();
    return () => {
      cancelled = true;
      if (retryTimer) clearTimeout(retryTimer);
    };
  }, [bookingId, hasPaymentReturnContext, sessionId]);

  useEffect(() => {
    if (!bookingId) return;
    let cancelled = false;
    (async () => {
      let headers: Record<string, string>;
      try {
        headers = await getApiAuthHeaders();
      } catch {
        return; // signed out — request framing, no calendar file
      }
      try {
        const res = await fetch(
          `/api/v1/bookings/${encodeURIComponent(bookingId)}/calendar.ics`,
          { headers },
        );
        if (!res.ok || cancelled) return;
        const blob = await res.blob();
        if (!cancelled) setCalendarIcs(blob);
      } catch {
        // No calendar — the request-model timeline still stands.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [bookingId]);

  const downloadCalendar = () => {
    if (!calendarIcs || !bookingId) return;
    const url = URL.createObjectURL(calendarIcs);
    const a = document.createElement("a");
    a.href = url;
    a.download = `tatttester-booking-${bookingId.replace(/[^A-Za-z0-9_-]/g, "")}.ics`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  const serverStatus = server?.status;
  // Only server truth can prove payment. A Stripe return URL is useful context,
  // but it can be reloaded or copied, so it earns "confirming" rather than a
  // fabricated "paid" state while reconciliation is unavailable.
  const isPaid = serverStatus ? PAID_STATUSES.has(serverStatus) : false;
  const isNonPaidTerminal = serverStatus
    ? NON_PAID_TERMINAL_STATUSES.has(serverStatus)
    : false;
  const isReconciling =
    hasPaymentReturnContext &&
    reconciliationPhase === "reconciling" &&
    !isPaid &&
    !isNonPaidTerminal;
  const reconciliationTimedOut =
    hasPaymentReturnContext &&
    (reconciliationPhase === "timed_out" || reconciliationPhase === "unavailable") &&
    !isPaid &&
    !isNonPaidTerminal;
  const statusText = isReconciling
    ? "Confirming deposit"
    : reconciliationTimedOut
      ? "Confirmation taking longer"
      : serverStatus
        ? STATUS_LABELS[serverStatus]
        : null;
  const depositValue = server?.depositAmount != null ? String(server.depositAmount) : deposit;
  const appointmentConfirmed = serverStatus === "confirmed" || serverStatus === "completed";
  // Reservation vs request (ADR 0027) — the same honest discriminator that
  // drives the timeline below: a fetched .ics proves a concrete slot.
  const reserved = calendarIcs !== null;
  const artistLabel = server?.artistName ?? artist ?? "the artist";

  const paymentStatusCopy = isPaid ? (
    <>
      {bookingSuccessMoneyCopy(artistClaimed, holdDays)}
      <br />
      {appointmentConfirmed
        ? "Your appointment is confirmed. Check Your bookings for the latest details."
        : reserved
          ? "Your deposit cleared and your time is booked. Check Your bookings for the latest details."
          : `Your deposit cleared. Your requested time is with the artist. ${requestReplyPromise(artistLabel, artistClaimed)} Check Your bookings for the latest status.`}
      <br />
      Balance settles at the shop.
    </>
  ) : isNonPaidTerminal ? (
    <>
      This booking is {STATUS_LABELS[serverStatus as BookingStatus].toLowerCase()}.
      No paid deposit is being claimed here. Open Your bookings for the latest details.
    </>
  ) : isReconciling ? (
    <>
      We&apos;re confirming your deposit with Stripe. This page updates once it
      clears — you can also check Your bookings.
    </>
  ) : reconciliationTimedOut ? (
    <>
      Confirmation is taking longer than usual. We haven&apos;t marked your deposit
      paid; open Your bookings for the latest status.
    </>
  ) : (
    <>
      Your deposit has not been confirmed. Open Your bookings to continue or check
      the latest status.
    </>
  );

  const rows: { label: string; value: string }[] = [
    ...(bookingId ? [{ label: "Booking reference", value: bookingId }] : []),
    { label: "Artist", value: server?.artistName ?? artist ?? "To be confirmed" },
    { label: "Requested date", value: date ?? "To be confirmed" },
    { label: "Time", value: time ?? "To be confirmed" },
    {
      label: "Piece",
      value: size || placement ? [size, placement].filter(Boolean).join(" · ") : "To be confirmed",
    },
  ];

  // ── What happens next ─────────────────────────────────────────────
  // Two honest variants (ADR 0027), keyed on `reserved` above. Reservation:
  // the deposit confirmed a concrete, exclusively-held slot — nothing further
  // to wait on before the session. Request: the deposit accompanies an ask,
  // and the artist still confirms or counters — within the stated reply window
  // (REA gap #3), the same sentence the request card shows.
  const whenLabel = date ? (time ? `${date} at ${time}` : date) : null;

  const timelineSteps: TimelineStep[] = reserved
    ? [
        {
          title: "Time reserved",
          detail: whenLabel
            ? `${whenLabel} — held exclusively for you while you paid.`
            : "Your chosen time was held exclusively for you while you paid.",
        },
        {
          title: "Deposit",
          detail: isPaid
            ? "Paid — and that's what confirms the slot. The time is yours."
            : "Confirming with Stripe. Once it clears, the time is yours.",
        },
        {
          title: "Your session",
          detail:
            "Balance settles at the shop. Add the time to your calendar below.",
        },
      ]
    : [
        {
          title: "Request sent",
          detail: artistClaimed
            ? `Your design, dates and details are with ${artistLabel}.`
            : `TatT is relaying your design, dates and details to ${artistLabel}, who has not joined TatT yet.`,
        },
        {
          title: "Deposit",
          detail: isPaid
            ? artistClaimed
              ? "Paid — and held against your session. If the booking doesn't go ahead, your deposit comes back in full."
              : `Paid — TatT holds the deposit while it relays your request. If the artist has not claimed and completed setup within ${holdDays} days, TatT automatically refunds your deposit in full.`
            : "Confirming with Stripe. This page updates once it clears.",
        },
        {
          title: "Artist review",
          detail: requestReplyPromise(artistLabel, artistClaimed),
        },
        {
          title: "Your session",
          detail: "Time settled with the artist. Balance settles at the shop.",
        },
      ];

  const timelineDone = serverStatus === "completed";
  const timelineCurrent = reserved
    ? serverStatus === "deposit_paid" || serverStatus === "confirmed"
      ? 2
      : isPaid
        ? 2
        : 1
    : serverStatus === "confirmed"
      ? 3
      : serverStatus === "deposit_paid" || (!serverStatus && isPaid)
        ? 2
        : 1;
  const showTimeline = !serverStatus || !ENDED_STATUSES.has(serverStatus);

  return (
    <StudioShell quiet>
      <div className="px-6 md:px-12 pt-8 pb-6 border-b hairline-quiet-soft">
        <div className="max-w-5xl mx-auto flex items-center justify-between text-[12px] text-quiet-dim tabular-nums font-body">
          <span>Booking</span>
          <span>{isPaid ? "Deposit paid" : `Status — ${statusText ?? "pending"}`}</span>
        </div>
      </div>

      <div className="px-6 md:px-12 py-24 md:py-32">
        <div className="max-w-5xl mx-auto">
          <QuietHeadline>
            {appointmentConfirmed ? "Booking confirmed" : isPaid ? "Deposit paid" : "Booking received"}
          </QuietHeadline>

          <div className="mt-16 border hairline-quiet p-8 md:p-14">
            {statusText && (
              <p className="text-[13px] text-quiet font-body">
                {statusText}
              </p>
            )}

            <dl className="mt-8 grid grid-cols-1 sm:grid-cols-2 gap-x-10 gap-y-7 text-[13px] font-body max-w-2xl">
              {rows.map((r) => (
                <div key={r.label}>
                  <dt className="text-[11px] text-quiet-dim">
                    {r.label}
                  </dt>
                  <dd className="mt-1.5 text-quiet capitalize">{r.value}</dd>
                </div>
              ))}
            </dl>

            {/* The final money summary — the one light receipt card the quiet
                register allows (ADR-0032). */}
            <div className="mt-10">
              {depositValue ? (
                <ReceiptCard className="max-w-xl">
                  <div className="flex items-baseline justify-between gap-6">
                    <div className="font-display-quiet text-[28px] leading-none tabular-nums">
                      ${depositValue}
                    </div>
                    <div className="font-body text-[12px] text-black/60">
                      {isPaid
                        ? "Deposit paid"
                        : isNonPaidTerminal
                          ? STATUS_LABELS[serverStatus as BookingStatus]
                          : isReconciling
                            ? "Confirming deposit"
                            : reconciliationTimedOut
                              ? "Check payment status"
                              : "Deposit due"}
                    </div>
                  </div>
                  <p className="mt-5 pt-5 border-t border-black/15 text-[13px] font-body text-black/80 leading-[1.7]">
                    {paymentStatusCopy}
                  </p>
                </ReceiptCard>
              ) : (
                <p className="text-[13px] text-quiet-dim font-body leading-[1.9] max-w-xl">
                  {paymentStatusCopy}
                </p>
              )}
            </div>

            {showTimeline && (
              <div className="mt-14 max-w-xl">
                <h2 className="text-[11px] text-quiet-dim font-body">
                  What happens next
                </h2>
                <QuietTimeline
                  steps={timelineSteps}
                  currentIndex={timelineCurrent}
                  allDone={timelineDone}
                />
                {calendarIcs && (
                  <div className="mt-7 pl-8">
                    <QuietCTA onClick={downloadCalendar} variant="ghost" size="sm">
                      Add to calendar (.ics)
                    </QuietCTA>
                  </div>
                )}
              </div>
            )}

            {sessionId && (
              <p className="mt-8 text-[11px] text-quiet-dim/80 font-body break-all">
                Stripe session: {sessionId}
              </p>
            )}

            <div className="mt-12 flex flex-col sm:flex-row items-start gap-5">
              <QuietCTA href="/bookings" size="md">Your bookings</QuietCTA>
              <QuietCTA href="/artists" variant="ghost" size="sm">Back to the roster</QuietCTA>
              <QuietCTA href="/design" variant="ghost" size="sm">Start another design</QuietCTA>
            </div>
          </div>
          {!isNonPaidTerminal && (
            <TattooPrepPlan
              artistName={server?.artistName ?? artist}
              showBookingsLink={false}
              stage={appointmentConfirmed ? "appointment" : "request"}
            />
          )}
        </div>
      </div>
    </StudioShell>
  );
}

export default function BookingSuccessPage() {
  return (
    <Suspense fallback={<div className="min-h-screen bg-black" />}>
      <SuccessContent />
    </Suspense>
  );
}
