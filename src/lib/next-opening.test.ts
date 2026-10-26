// Spec 4: the cached next-opening hint is shown only while fresh and future.
import { describe, expect, it } from "vitest";
import {
  NEXT_OPENING_MAX_AGE_MS,
  formatNextOpening,
  nextOpeningNeedsWrite,
  usableNextOpening,
} from "./next-opening";

const NOW = Date.parse("2026-11-01T12:00:00Z");
const AT = "2026-11-03T14:00:00-07:00";

describe("usableNextOpening", () => {
  it("returns a fresh, future value", () => {
    expect(
      usableNextOpening(
        { nextOpeningAt: AT, nextOpeningTimezone: "America/Phoenix", nextOpeningComputedAtMs: NOW - 1000 },
        NOW,
      ),
    ).toEqual({ at: AT, timezone: "America/Phoenix" });
  });

  it("hides a value older than a day", () => {
    expect(
      usableNextOpening(
        { nextOpeningAt: AT, nextOpeningTimezone: "America/Phoenix", nextOpeningComputedAtMs: NOW - NEXT_OPENING_MAX_AGE_MS - 1 },
        NOW,
      ),
    ).toBeNull();
  });

  it("hides a value already in the past, and a missing one", () => {
    expect(
      usableNextOpening(
        { nextOpeningAt: "2026-10-01T10:00:00-07:00", nextOpeningTimezone: "America/Phoenix", nextOpeningComputedAtMs: NOW },
        NOW,
      ),
    ).toBeNull();
    expect(usableNextOpening(null, NOW)).toBeNull();
    expect(usableNextOpening({ nextOpeningAt: null }, NOW)).toBeNull();
  });
});

describe("nextOpeningNeedsWrite", () => {
  const next = { at: AT, timezone: "America/Phoenix" };
  it("writes a changed value, and clears a stale one", () => {
    expect(nextOpeningNeedsWrite({ nextOpeningAt: null }, next, NOW)).toBe(true);
    expect(nextOpeningNeedsWrite({ nextOpeningAt: AT, nextOpeningComputedAtMs: NOW }, null, NOW)).toBe(true);
  });
  it("skips an unchanged value written within the hour, and a null that stays null", () => {
    expect(nextOpeningNeedsWrite({ nextOpeningAt: AT, nextOpeningComputedAtMs: NOW - 60_000 }, next, NOW)).toBe(false);
    expect(nextOpeningNeedsWrite({ nextOpeningAt: AT, nextOpeningComputedAtMs: NOW - 2 * 3_600_000 }, next, NOW)).toBe(true);
    expect(nextOpeningNeedsWrite({}, null, NOW)).toBe(false);
  });
});

describe("formatNextOpening", () => {
  it("formats on the artist's calendar, not the server's", () => {
    // 23:30 in Auckland on Nov 3 is still Nov 3 there, Nov 3 10:30 UTC.
    expect(formatNextOpening({ at: "2026-11-03T23:30:00+13:00", timezone: "Pacific/Auckland" })).toBe("Nov 3");
  });
});
