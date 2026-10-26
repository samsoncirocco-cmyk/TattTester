/**
 * Scheduling engine — generates bookable time slots from artist availability.
 *
 * This is the Cal.com-style core primitive: caller-supplied recurring hours
 * and date overrides become concrete slots after existing bookings, session
 * duration and buffers, minimum notice, and the requested date range are
 * applied.
 *
 * This module is deliberately pure. It does not read Firestore, Neo4j, Google
 * Calendar, or the hold store, and it does not filter holds or calendar
 * conflicts. `booking-offer.ts` owns that composition and passes trusted
 * domain values into the functions below.
 */

// ─── Types ─────────────────────────────────────────────────────────────

export interface TimeRange {
  /** "10:00" (24h, "HH:MM") */
  start: string;
  /** "18:00" (24h, "HH:MM") */
  end: string;
}

export interface WeeklySchedule {
  monday: TimeRange[];
  tuesday: TimeRange[];
  wednesday: TimeRange[];
  thursday: TimeRange[];
  friday: TimeRange[];
  saturday: TimeRange[];
  sunday: TimeRange[];
  /** IANA timezone, e.g. "America/Phoenix" */
  timezone: string;
}

export type DayOfWeek =
  | "monday"
  | "tuesday"
  | "wednesday"
  | "thursday"
  | "friday"
  | "saturday"
  | "sunday";

export interface AvailabilityOverride {
  date: string; // "YYYY-MM-DD"
  type: "block" | "open";
  /** "14:00" — timed window for 'open', or partial-day 'block' */
  startTime?: string;
  /** "18:00" — timed window for 'open', or partial-day 'block' */
  endTime?: string;
}

export interface Slot {
  date: string; // "YYYY-MM-DD"
  startTime: string; // "14:00"
  endTime: string; // "16:00"
  durationMinutes: number;
}

export interface SessionTypeConfig {
  durationMinutes: number;
  beforeBufferMinutes: number;
  afterBufferMinutes: number;
  minimumBookingNoticeHours: number;
}

export interface ExistingBooking {
  /** Wall-clock date the session *starts* on. */
  date: string;
  startTime: string;
  /** Wall-clock end. If it is at or before `startTime`, the session runs past midnight. */
  endTime: string;
  /** IANA timezone the wall-clock times are in. Defaults to the schedule's. */
  timezone?: string;
}

/** A half-open wall-clock range expressed in minutes since midnight. */
export interface MinuteRange {
  start: number;
  end: number;
}

/** A half-open interval on the absolute (UTC epoch ms) timeline. */
interface EpochInterval {
  startMs: number;
  endMs: number;
}

const MINUTES_PER_DAY = 24 * 60;
const MS_PER_MINUTE = 60 * 1000;

/**
 * Default spacing of the wall-clock grid that slot start times are rounded up
 * to. 15 is the finest quantum the product uses anywhere: `durationMinutes` is
 * validated as 15–720 in ./session-types, so no session can be shorter than one
 * step. It only ever moves a start later, never adds a candidate, so a finer
 * grid costs nothing in slot count — see `slotGranularityMinutes`.
 */
export const DEFAULT_SLOT_GRANULARITY_MINUTES = 15;

// ─── Time helpers (pure) ──────────────────────────────────────────────

/** True when `time` is a wall-clock "H:MM" / "HH:MM" with hour 0–23 and minute 0–59. */
export function isValidTimeString(time: string): boolean {
  const m = /^(\d{1,2}):(\d{2})$/.exec(time);
  if (!m) return false;
  const hours = parseInt(m[1], 10);
  const minutes = parseInt(m[2], 10);
  return hours <= 23 && minutes <= 59;
}

/** Parse "HH:MM" to minutes since midnight. Returns 0 on invalid input. */
export function parseTimeToMinutes(time: string): number {
  if (!isValidTimeString(time)) return 0;
  const m = /^(\d{1,2}):(\d{2})$/.exec(time)!;
  return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
}

/** Convert minutes since midnight to "HH:MM". */
export function minutesToTime(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/**
 * Check if two half-open intervals overlap. Unit-agnostic: both operands must
 * simply be on the same scale (minutes since midnight, or epoch ms).
 */
export function timeOverlap(
  startA: number,
  endA: number,
  startB: number,
  endB: number,
): boolean {
  return startA < endB && startB < endA;
}

/** Get the day-of-week key for a date (UTC to match date iteration). */
export function dayOfWeekKey(date: Date): DayOfWeek {
  const days: DayOfWeek[] = [
    "sunday",
    "monday",
    "tuesday",
    "wednesday",
    "thursday",
    "friday",
    "saturday",
  ];
  return days[date.getUTCDay()];
}

/** Format a Date to "YYYY-MM-DD" (UTC). */
export function toISODate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * Convert a wall-clock date+time in an IANA timezone to UTC epoch ms.
 * "2026-07-27" + "10:30" in America/Phoenix → the corresponding UTC instant.
 */
export function zonedDateTimeToEpochMs(
  dateStr: string,
  timeStr: string,
  timeZone: string,
): number {
  if (!isValidTimeString(timeStr)) return NaN;
  const [Y, M, D] = dateStr.split("-").map(Number);
  const minutesSinceMidnight = parseTimeToMinutes(timeStr);
  const hour = Math.floor(minutesSinceMidnight / 60);
  const minute = minutesSinceMidnight % 60;

  const desiredAsUtc = Date.UTC(Y, M - 1, D, hour, minute, 0);

  // Guess: treat wall clock as UTC, then correct by the zone's offset at that instant.
  let utcMs = desiredAsUtc;
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });

  for (let i = 0; i < 8; i++) {
    const parts = Object.fromEntries(
      dtf
        .formatToParts(new Date(utcMs))
        .filter((p) => p.type !== "literal")
        .map((p) => [p.type, p.value]),
    ) as Record<string, string>;
    const shownHour = parts.hour === "24" ? 0 : Number(parts.hour);
    const shownAsUtc = Date.UTC(
      Number(parts.year),
      Number(parts.month) - 1,
      Number(parts.day),
      shownHour,
      Number(parts.minute),
      Number(parts.second),
    );
    const diff = desiredAsUtc - shownAsUtc;
    if (diff === 0) return utcMs;
    utcMs += diff;
  }
  // Did not converge (e.g. nonexistent local time in a DST gap).
  return NaN;
}

/**
 * The calendar date ("YYYY-MM-DD") it is right now in an IANA zone — the
 * artist's today, not UTC's (spec 4). Falls back to the UTC date for an
 * unknown zone rather than throwing on a page render.
 */
export function toZonedISODate(nowMs: number, timeZone: string): string {
  try {
    const parts = Object.fromEntries(
      new Intl.DateTimeFormat("en-US", {
        timeZone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      })
        .formatToParts(new Date(nowMs))
        .filter((p) => p.type !== "literal")
        .map((p) => [p.type, p.value]),
    ) as Record<string, string>;
    return `${parts.year}-${parts.month}-${parts.day}`;
  } catch {
    return toISODate(new Date(nowMs));
  }
}

/**
 * A wall-clock date+time in a zone as an ISO-8601 instant WITH that zone's
 * offset — "2026-08-06T14:00:00-07:00" — so a slot names one real moment
 * whatever clock the reader is on. Null for a time that does not exist there
 * (inside a spring-forward gap) or a bad zone.
 */
export function zonedISOString(
  dateStr: string,
  timeStr: string,
  timeZone: string,
): string | null {
  let epochMs: number;
  try {
    epochMs = zonedDateTimeToEpochMs(dateStr, timeStr, timeZone);
  } catch {
    return null;
  }
  if (!Number.isFinite(epochMs)) return null;
  const [Y, M, D] = dateStr.split("-").map(Number);
  const minutes = parseTimeToMinutes(timeStr);
  const wallAsUtc = Date.UTC(Y, M - 1, D, Math.floor(minutes / 60), minutes % 60);
  const offsetMin = Math.round((wallAsUtc - epochMs) / 60_000);
  const sign = offsetMin >= 0 ? "+" : "-";
  const abs = Math.abs(offsetMin);
  const hh = String(Math.floor(abs / 60)).padStart(2, "0");
  const mm = String(abs % 60).padStart(2, "0");
  return `${dateStr}T${timeStr}:00${sign}${hh}:${mm}`;
}

/** Add whole days to a "YYYY-MM-DD" string. */
export function addDaysToISODate(dateStr: string, days: number): string {
  const d = new Date(dateStr + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return toISODate(d);
}

/**
 * Convert "minutes since midnight" on a wall-clock date to a UTC instant,
 * rolling into an adjacent day when the value falls outside [0, 1440) — which
 * is how a session running past midnight is expressed.
 * Returns NaN when the wall clock does not exist in the zone (DST gap).
 */
export function zonedMinutesToEpochMs(
  dateStr: string,
  minutes: number,
  timeZone: string,
): number {
  const dayOffset = Math.floor(minutes / MINUTES_PER_DAY);
  const minuteOfDay = minutes - dayOffset * MINUTES_PER_DAY;
  return zonedDateTimeToEpochMs(
    addDaysToISODate(dateStr, dayOffset),
    minutesToTime(minuteOfDay),
    timeZone,
  );
}

/** Render a UTC instant as the wall-clock date + time seen in an IANA timezone. */
export function epochMsToZonedDateTime(
  epochMs: number,
  timeZone: string,
): { date: string; time: string } {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(new Date(epochMs))
      .filter((p) => p.type !== "literal")
      .map((p) => [p.type, p.value]),
  ) as Record<string, string>;
  const hour = parts.hour === "24" ? "00" : parts.hour;
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    time: `${hour}:${parts.minute}`,
  };
}

/**
 * Merge overlapping or touching ranges into a sorted, disjoint set.
 * Empty and inverted ranges are dropped.
 */
export function mergeMinuteRanges(ranges: MinuteRange[]): MinuteRange[] {
  const merged: MinuteRange[] = [];
  const sorted = ranges
    .filter((r) => r.end > r.start)
    .sort((a, b) => a.start - b.start);
  for (const range of sorted) {
    const last = merged[merged.length - 1];
    if (last && range.start <= last.end) {
      last.end = Math.max(last.end, range.end);
    } else {
      merged.push({ ...range });
    }
  }
  return merged;
}

/**
 * Resolve a `block` override to the absolute window it takes out, or null when
 * it is not a usable timed window — which covers both a deliberate full-day
 * block (no bounds) and a malformed one (missing, unparseable, inverted, or
 * nonexistent-in-zone bounds). Callers must treat null as blocking the day:
 * a malformed block must never be more permissive than a well-formed one.
 */
function toBlockWindow(
  override: AvailabilityOverride,
  dateStr: string,
  timeZone: string,
): EpochInterval | null {
  const { startTime, endTime } = override;
  if (!startTime || !endTime) return null;
  if (!isValidTimeString(startTime) || !isValidTimeString(endTime)) return null;

  const startMinutes = parseTimeToMinutes(startTime);
  const endMinutes = parseTimeToMinutes(endTime);
  if (endMinutes <= startMinutes) return null;

  const startMs = zonedMinutesToEpochMs(dateStr, startMinutes, timeZone);
  const endMs = zonedMinutesToEpochMs(dateStr, endMinutes, timeZone);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return null;

  return { startMs, endMs };
}

/**
 * Convert existing bookings into absolute, buffered intervals.
 *
 * Bookings are absolute occupancy, not per-date wall-clock strings: a session
 * running 22:00–02:00 occupies part of the following day too. Buffers are real
 * elapsed time, so they are applied to the instant rather than the wall clock.
 *
 * Malformed times are ignored rather than treated as a midnight-anchored
 * exclusion zone (`parseTimeToMinutes` maps junk to 0).
 */
function toBookedIntervals(
  bookings: ExistingBooking[],
  defaultTimeZone: string,
  beforeBufferMs: number,
  afterBufferMs: number,
): EpochInterval[] {
  const intervals: EpochInterval[] = [];
  for (const booking of bookings) {
    if (
      !isValidTimeString(booking.startTime) ||
      !isValidTimeString(booking.endTime)
    ) {
      continue;
    }
    const timeZone = booking.timezone ?? defaultTimeZone;
    const startMinutes = parseTimeToMinutes(booking.startTime);
    let endMinutes = parseTimeToMinutes(booking.endTime);
    // An end at or before the start means the session runs past midnight.
    if (endMinutes <= startMinutes) endMinutes += MINUTES_PER_DAY;

    const startMs = zonedMinutesToEpochMs(booking.date, startMinutes, timeZone);
    const endMs = zonedMinutesToEpochMs(booking.date, endMinutes, timeZone);
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) continue;

    intervals.push({
      startMs: startMs - beforeBufferMs,
      endMs: endMs + afterBufferMs,
    });
  }
  return intervals;
}

/**
 * Subtract a set of occupied intervals from one open interval, returning the
 * free sub-intervals in chronological order. `occupied` may overlap itself and
 * need not be sorted; intervals outside `open` are ignored.
 */
function freeIntervals(
  open: EpochInterval,
  occupied: EpochInterval[],
): EpochInterval[] {
  const relevant = occupied
    .filter((o) => o.endMs > open.startMs && o.startMs < open.endMs)
    .sort((a, b) => a.startMs - b.startMs);

  const free: EpochInterval[] = [];
  let cursor = open.startMs;
  for (const busy of relevant) {
    if (busy.startMs > cursor) {
      free.push({ startMs: cursor, endMs: busy.startMs });
    }
    if (busy.endMs > cursor) cursor = busy.endMs;
    if (cursor >= open.endMs) return free;
  }
  if (cursor < open.endMs) free.push({ startMs: cursor, endMs: open.endMs });
  return free;
}

/** Round `valueMs` up to the next `stepMs` boundary measured from `originMs`. */
function alignUp(valueMs: number, originMs: number, stepMs: number): number {
  return originMs + Math.ceil((valueMs - originMs) / stepMs) * stepMs;
}

// ─── Slot generation (pure, no I/O) ───────────────────────────────────

export interface GenerateSlotsParams {
  schedule: WeeklySchedule;
  overrides: AvailabilityOverride[];
  sessionType: SessionTypeConfig;
  existingBookings: ExistingBooking[];
  /** Unix epoch ms for "now" — used for minimum booking notice. */
  nowEpochMs: number;
  /** Start of the date range (inclusive). */
  startDate: string; // "YYYY-MM-DD"
  /** End of the date range (inclusive). */
  endDate: string; // "YYYY-MM-DD"
  /**
   * Spacing of the grid that slot start times are rounded up to, measured from
   * each open range's own start — so an artist who opens at 10:00 is offered
   * 10:00 / 10:15 / 10:30 …, and a session freed up at 12:37 surfaces as 13:15
   * rather than 13:07.
   *
   * This is ALIGNMENT, not stride: it can only push a start later, never add a
   * candidate. Two offered slots are still spaced a full footprint apart, which
   * is what keeps them independently bookable. Defaults to
   * `DEFAULT_SLOT_GRANULARITY_MINUTES`; anything that is not a positive finite
   * number falls back to that default.
   *
   * Cost: up to `slotGranularityMinutes - 1` minutes of each free interval go
   * unused, which can drop a slot when an interval is within a grid step of
   * fitting one more. Pass 1 to disable alignment and take every minute.
   */
  slotGranularityMinutes?: number;
}

/**
 * Generate available slots from a recurring schedule.
 *
 * A session's *footprint* is the time it actually costs the artist:
 * `[start - beforeBuffer, end + afterBuffer]`. Every rule below is expressed in
 * terms of footprints on the absolute (epoch ms) timeline, which is what keeps
 * the offered grid self-consistent and DST-correct:
 *  - a slot is offered only if its whole footprint fits in free time;
 *  - consecutive slots are spaced at least a footprint apart, so booking one
 *    offered slot can never invalidate another;
 *  - occupied time (block overrides, existing bookings' footprints) and the
 *    minimum-notice cutoff are subtracted from the open hours *before* slots
 *    are laid out, so the grid re-anchors after each of them instead of being
 *    pinned to the range start. Pinning it was #162: a mid-day booking off the
 *    grid stranded the entire rest of the day.
 *
 * Algorithm — for each date in [startDate, endDate]:
 *  a. Resolve `block` overrides; any that is not a usable timed window —
 *     deliberate full-day or malformed — takes out the whole day
 *  b. Keep the resolved block windows as absolute intervals
 *  c. Merge the recurring day's hours with any 'open' overrides into a
 *     disjoint set of open ranges (overlapping windows must not be sliced twice)
 *  d. For each open range, trim the head to the minimum-notice cutoff, subtract
 *     occupied intervals, and pack footprints into what is left — one slot per
 *     footprint, each start rounded up to the granularity grid
 *
 * Slot count is bounded exactly as it was before #162: the free intervals of an
 * open range are disjoint sub-ranges of it, and each yields at most
 * `floor(length / footprint)` slots, so a range still yields at most
 * `floor(rangeLength / footprint)` in total. Splitting a day into more free
 * intervals cannot inflate the output.
 */
export function generateAvailableSlots(params: GenerateSlotsParams): Slot[] {
  const slots: Slot[] = [];
  const {
    schedule,
    overrides,
    sessionType,
    existingBookings,
    nowEpochMs,
    startDate,
    endDate,
    slotGranularityMinutes,
  } = params;

  // Zero/negative duration would never advance the cursor → infinite loop.
  if (sessionType.durationMinutes <= 0) return [];

  const timeZone = schedule.timezone;
  const durationMs = sessionType.durationMinutes * MS_PER_MINUTE;
  const beforeBufferMs =
    Math.max(0, sessionType.beforeBufferMinutes) * MS_PER_MINUTE;
  const afterBufferMs =
    Math.max(0, sessionType.afterBufferMinutes) * MS_PER_MINUTE;
  // One footprint per step, so two offered slots never contend for the same time.
  const footprintMs = beforeBufferMs + durationMs + afterBufferMs;

  // A non-positive or non-finite grid would stall or NaN the cursor.
  const granularityMs =
    (Number.isFinite(slotGranularityMinutes) &&
    (slotGranularityMinutes as number) > 0
      ? (slotGranularityMinutes as number)
      : DEFAULT_SLOT_GRANULARITY_MINUTES) * MS_PER_MINUTE;

  const noticeHours = Math.max(0, sessionType.minimumBookingNoticeHours);
  const minNoticeMs = noticeHours * 60 * 60 * 1000;
  const earliestBookable = nowEpochMs + minNoticeMs;

  const start = new Date(startDate + "T00:00:00Z");
  const end = new Date(endDate + "T00:00:00Z");
  const maxDays = 90; // safety cap — reject oversized ranges instead of truncating
  const rangeDays =
    Math.floor((end.getTime() - start.getTime()) / (24 * 60 * 60 * 1000)) + 1;
  if (rangeDays > maxDays) {
    throw new Error(
      `Date range exceeds maximum of ${maxDays} days (got ${rangeDays})`,
    );
  }

  // Existing bookings are absolute occupancy — resolved once, not per date, so
  // that a session running past midnight also blocks the following morning.
  const bookedIntervals = toBookedIntervals(
    existingBookings,
    timeZone,
    beforeBufferMs,
    afterBufferMs,
  );

  for (let d = new Date(start); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
    const dateStr = toISODate(d);
    const dayKey = dayOfWeekKey(d);

    const dayBlocks = overrides.filter(
      (o) => o.date === dateStr && o.type === "block",
    );

    // a/b. Resolve block overrides to timed windows. Any block that does not
    //      resolve — a deliberate full-day block, or a malformed one — takes
    //      out the whole day. A block is the artist's "do not book me" signal,
    //      so it must never fail in the permissive direction.
    const blockedIntervals: EpochInterval[] = [];
    let fullDayBlocked = false;
    for (const o of dayBlocks) {
      const blockWindow = toBlockWindow(o, dateStr, timeZone);
      if (!blockWindow) {
        fullDayBlocked = true;
        break;
      }
      blockedIntervals.push(blockWindow);
    }
    if (fullDayBlocked) continue;

    // c. Merge the recurring day's hours with any 'open' overrides. Merging
    //    (rather than concatenating) is what stops an overlapping window from
    //    being sliced twice into overlapping slots.
    const rawRanges: MinuteRange[] = [];
    for (const range of schedule[dayKey] ?? []) {
      // Reject out-of-range clocks (parseTimeToMinutes maps them to 0, which
      // would incorrectly look like midnight).
      if (!isValidTimeString(range.start) || !isValidTimeString(range.end))
        continue;
      rawRanges.push({
        start: parseTimeToMinutes(range.start),
        end: parseTimeToMinutes(range.end),
      });
    }
    for (const o of overrides) {
      if (o.date !== dateStr || o.type !== "open") continue;
      if (!o.startTime || !o.endTime) continue;
      if (!isValidTimeString(o.startTime) || !isValidTimeString(o.endTime))
        continue;
      rawRanges.push({
        start: parseTimeToMinutes(o.startTime),
        end: parseTimeToMinutes(o.endTime),
      });
    }

    const openRanges = mergeMinuteRanges(rawRanges);
    if (!openRanges.length) continue;

    // d. Walk each open range on the absolute timeline.
    for (const range of openRanges) {
      const rangeStartMs = zonedMinutesToEpochMs(
        dateStr,
        range.start,
        timeZone,
      );
      const rangeEndMs = zonedMinutesToEpochMs(dateStr, range.end, timeZone);
      // A boundary that does not exist in this zone (DST gap) makes the range
      // unusable; dropping it is the conservative direction.
      if (!Number.isFinite(rangeStartMs) || !Number.isFinite(rangeEndMs))
        continue;

      // Minimum notice trims the head of the range rather than filtering
      // candidates off a fixed grid — same reason as #162, so that a cutoff
      // landing mid-range does not strand the time just after it. A slot must
      // START at or after the cutoff; its before-buffer may precede it.
      const openStartMs = Math.max(
        rangeStartMs,
        earliestBookable - beforeBufferMs,
      );
      if (openStartMs >= rangeEndMs) continue;

      const free = freeIntervals({ startMs: openStartMs, endMs: rangeEndMs }, [
        ...blockedIntervals,
        ...bookedIntervals,
      ]);

      for (const interval of free) {
        // Pack footprints back to back, each start rounded up to the grid the
        // artist's own opening time defines. Alignment only ever moves a start
        // later, so the spacing stays >= one footprint and no two offered slots
        // can contend for the same time.
        let cursorMs = interval.startMs;
        while (true) {
          const slotStartMs = alignUp(
            cursorMs + beforeBufferMs,
            rangeStartMs,
            granularityMs,
          );
          const footprintStartMs = slotStartMs - beforeBufferMs;
          const footprintEndMs = footprintStartMs + footprintMs;
          if (footprintEndMs > interval.endMs) break;

          const slotEndMs = slotStartMs + durationMs;
          const slotStart = epochMsToZonedDateTime(slotStartMs, timeZone);
          const slotEnd = epochMsToZonedDateTime(slotEndMs, timeZone);
          slots.push({
            date: slotStart.date,
            startTime: slotStart.time,
            endTime: slotEnd.time,
            durationMinutes: sessionType.durationMinutes,
          });

          cursorMs = footprintEndMs;
        }
      }
    }
  }

  return slots;
}
