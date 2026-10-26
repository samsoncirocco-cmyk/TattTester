"use client";

/**
 * Spec 4 on /book: say which clock the times are on, and what the booking
 * costs before the customer is halfway through the form.
 *
 *  - <ArtistZoneLine>: "Times are in Phoenix time (MST). It's 5:47 pm there now."
 *  - yourTimeLabel(): "8:00 pm your time" — only when the customer's clock differs.
 *  - <BookingHeaderFacts>: the deposit ladder, the next opening and the
 *    one-sentence fee model, under the artist strip.
 *
 * Everything formats with Intl in the artist's IANA zone; nothing here
 * guesses a zone it was not given.
 */
import { useEffect, useState } from "react";

/** "Phoenix, AZ" → "Phoenix". Null when there is nothing usable. */
export function cityFromLocation(location: string | null | undefined): string | null {
  const city = location?.split(",")[0]?.trim();
  return city ? city : null;
}

/** Short zone name ("MST", "GMT+13") at a given instant, or null for a bad zone. */
export function zoneAbbreviation(timeZone: string, atMs: number): string | null {
  try {
    const part = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "short" })
      .formatToParts(new Date(atMs))
      .find((p) => p.type === "timeZoneName");
    return part?.value ?? null;
  } catch {
    return null;
  }
}

/** "5:47 pm" on the given zone's clock (the browser's when omitted). */
export function formatClock(atMs: number, timeZone?: string): string {
  return new Date(atMs)
    .toLocaleTimeString("en-US", {
      hour: "numeric",
      minute: "2-digit",
      ...(timeZone ? { timeZone } : {}),
    })
    .replace("AM", "am")
    .replace("PM", "pm");
}

/**
 * "8:00 pm your time" when the customer's browser clock shows a different
 * wall time (or day) for this slot than the artist's; null when it is the
 * same, or when the instant or the browser zone is unknown.
 */
export function yourTimeLabel(
  slot: { date: string; startTime: string; startsAt?: string },
  customerZone?: string,
): string | null {
  if (!slot.startsAt) return null;
  const at = Date.parse(slot.startsAt);
  if (!Number.isFinite(at)) return null;
  try {
    const parts = Object.fromEntries(
      new Intl.DateTimeFormat("en-US", {
        ...(customerZone ? { timeZone: customerZone } : {}),
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
      })
        .formatToParts(new Date(at))
        .filter((p) => p.type !== "literal")
        .map((p) => [p.type, p.value]),
    ) as Record<string, string>;
    const sameDay = `${parts.year}-${parts.month}-${parts.day}` === slot.date;
    const sameTime = `${parts.hour}:${parts.minute}` === slot.startTime;
    if (sameDay && sameTime) return null;
    const clock = formatClock(at, customerZone);
    if (sameDay) return `${clock} your time`;
    const day = new Date(at).toLocaleDateString("en-US", {
      ...(customerZone ? { timeZone: customerZone } : {}),
      weekday: "short",
      month: "short",
      day: "numeric",
    });
    return `${day}, ${clock} your time`;
  } catch {
    return null;
  }
}

/** Re-renders every minute, paused while the tab is hidden. */
function useMinuteClock(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | null = null;
    const start = () => {
      if (timer) return;
      setNow(Date.now());
      timer = setInterval(() => setNow(Date.now()), 60_000);
    };
    const stop = () => {
      if (timer) clearInterval(timer);
      timer = null;
    };
    const onVisibility = () => (document.hidden ? stop() : start());
    if (!document.hidden) start();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);
  return now;
}

export function artistZoneSentence(
  timezone: string | undefined,
  location: string | null | undefined,
  nowMs: number,
): string {
  if (!timezone) return "Times are in the artist's local time.";
  const abbr = zoneAbbreviation(timezone, nowMs);
  if (!abbr) return "Times are in the artist's local time.";
  const city = cityFromLocation(location);
  const where = city ? `${city} time` : "the artist's time";
  return `Times are in ${where} (${abbr}). It's ${formatClock(nowMs, timezone)} there now.`;
}

export function ArtistZoneLine({
  timezone,
  location,
}: {
  timezone?: string;
  location?: string | null;
}) {
  const now = useMinuteClock();
  return (
    <p
      data-testid="artist-zone-line"
      className="mt-4 text-[12px] text-quiet-dim font-body leading-[1.7]"
    >
      {artistZoneSentence(timezone, location, now)}
    </p>
  );
}

/** "Mon, Nov 3" for an ISO instant, on the artist's calendar. */
export function formatOpeningDay(iso: string, timezone?: string): string | null {
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return null;
  try {
    return new Date(at).toLocaleDateString("en-US", {
      ...(timezone ? { timeZone: timezone } : {}),
      weekday: "short",
      month: "short",
      day: "numeric",
    });
  } catch {
    return null;
  }
}

export function BookingHeaderFacts({
  ladderLabel,
  nextOpeningAt,
  timezone,
  feeSentence,
}: {
  ladderLabel: string;
  nextOpeningAt?: string;
  timezone?: string;
  feeSentence: string;
}) {
  const opening = nextOpeningAt ? formatOpeningDay(nextOpeningAt, timezone) : null;
  return (
    <div
      data-testid="booking-header-facts"
      className="mt-4 border hairline-quiet-soft p-5 text-[12px] text-quiet-dim font-body leading-[1.8]"
    >
      <div className="flex flex-wrap gap-x-6 gap-y-1">
        <span>
          <span className="text-quiet">Deposits</span> {ladderLabel}
        </span>
        {opening && (
          <span>
            <span className="text-quiet">Next opening</span> {opening}
          </span>
        )}
      </div>
      {/* The money sentence (ADR-0036): who pays what, who keeps what. */}
      <p className="mt-2">{feeSentence}</p>
    </div>
  );
}
