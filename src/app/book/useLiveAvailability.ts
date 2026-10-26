"use client";

/**
 * Keep /book's slot grid current (spec 6) from
 * `GET /api/v1/artists/{id}/availability`.
 *
 *  - refetch when the window regains focus (throttled), so a tab left open
 *    over lunch does not offer a time that went an hour ago;
 *  - `refetch({ force: true })` for the cheap slot check when the review step
 *    opens and after a lost race (replacing the full `router.refresh()`).
 *
 * The server-rendered offer stays the starting point; a failed fetch keeps
 * whatever we already show (the hold route is still the final arbiter).
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { BookOffer, OfferedSlot } from "./BookClient";

export const FOCUS_REFETCH_MIN_MS = 30_000;

type AvailabilityBody = {
  mode?: "reservation" | "request";
  label?: string;
  detail?: string;
  timezone?: string | null;
  nextOpeningAt?: string | null;
  days?: Array<{
    date: string;
    spots: Array<{ startTime: string; endTime: string; startsAt?: string; endsAt?: string }>;
  }>;
};

/** Response → the same BookOffer shape the server page renders. */
export function offerFromAvailability(body: AvailabilityBody, fallback: BookOffer): BookOffer | null {
  if (body.mode !== "reservation" && body.mode !== "request") return null;
  const slots: OfferedSlot[] =
    body.mode === "reservation"
      ? (body.days ?? []).flatMap((d) =>
          d.spots.map((s) => ({
            date: d.date,
            startTime: s.startTime,
            endTime: s.endTime,
            ...(s.startsAt ? { startsAt: s.startsAt } : {}),
            ...(s.endsAt ? { endsAt: s.endsAt } : {}),
          })),
        )
      : [];
  return {
    mode: body.mode,
    label: body.label ?? fallback.label,
    detail: body.detail ?? fallback.detail,
    slots,
    ...(body.timezone ? { timezone: body.timezone } : fallback.timezone ? { timezone: fallback.timezone } : {}),
    ...(body.nextOpeningAt ? { nextOpeningAt: body.nextOpeningAt } : {}),
  };
}

export function sameSlot(a: OfferedSlot, b: OfferedSlot): boolean {
  return a.date === b.date && a.startTime === b.startTime && a.endTime === b.endTime;
}

export function useLiveAvailability({
  artistId,
  initial,
  bookingId,
  enabled,
}: {
  artistId: string | null;
  initial: BookOffer;
  bookingId: string | null;
  /** Off for request-mode pages: there is no grid to keep fresh. */
  enabled: boolean;
}) {
  const [offer, setOffer] = useState<BookOffer>(initial);
  const lastFetchRef = useRef(0);
  const bookingIdRef = useRef(bookingId);
  useEffect(() => {
    bookingIdRef.current = bookingId;
  }, [bookingId]);

  const refetch = useCallback(
    async (opts: { force?: boolean } = {}): Promise<BookOffer | null> => {
      if (!artistId || !enabled) return null;
      const now = Date.now();
      if (!opts.force && now - lastFetchRef.current < FOCUS_REFETCH_MIN_MS) return null;
      lastFetchRef.current = now;
      const qs = new URLSearchParams();
      try {
        const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
        if (tz) qs.set("tz", tz);
      } catch {
        // No browser zone: the server still answers in the artist's zone.
      }
      if (bookingIdRef.current) qs.set("bookingId", bookingIdRef.current);
      try {
        const res = await fetch(
          `/api/v1/artists/${encodeURIComponent(artistId)}/availability?${qs.toString()}`,
          { method: "GET", cache: "no-store" },
        );
        if (!res.ok) return null;
        const next = offerFromAvailability((await res.json()) as AvailabilityBody, initial);
        if (next) setOffer(next);
        return next;
      } catch {
        return null;
      }
    },
    [artistId, enabled, initial],
  );

  useEffect(() => {
    if (!enabled) return;
    const onFocus = () => {
      if (!document.hidden) void refetch();
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onFocus);
    return () => {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onFocus);
    };
  }, [enabled, refetch]);

  return { offer, refetch };
}
