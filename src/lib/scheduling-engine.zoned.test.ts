// Spec 4: the offer window starts on the artist's date, and slots carry real
// instants with the artist's offset.
import { describe, expect, it } from "vitest";
import { toISODate, toZonedISODate, zonedISOString } from "./scheduling-engine";
import {
  DEPOSIT_CENTS_BY_SIZE,
  depositDollarsForSize,
  depositLadder,
  depositLadderLabel,
  minimumDepositCents,
} from "./booking";

describe("toZonedISODate", () => {
  // 2026-08-06 03:30 UTC = Aug 5, 20:30 in Los Angeles, Aug 6 15:30 in Auckland.
  const eveningInLA = Date.parse("2026-08-06T03:30:00Z");

  it("is the artist's date, not UTC's, on a US evening", () => {
    expect(toISODate(new Date(eveningInLA))).toBe("2026-08-06");
    expect(toZonedISODate(eveningInLA, "America/Los_Angeles")).toBe("2026-08-05");
  });

  it("runs ahead of UTC east of Greenwich", () => {
    const lateUtc = Date.parse("2026-08-06T13:00:00Z"); // Aug 7, 01:00 NZST
    expect(toZonedISODate(lateUtc, "Pacific/Auckland")).toBe("2026-08-07");
  });

  it("falls back to the UTC date for an unknown zone", () => {
    expect(toZonedISODate(eveningInLA, "Not/AZone")).toBe("2026-08-06");
  });
});

describe("zonedISOString", () => {
  it("names the offset in force on that date", () => {
    expect(zonedISOString("2026-08-06", "14:00", "America/Los_Angeles")).toBe("2026-08-06T14:00:00-07:00");
    expect(zonedISOString("2026-12-06", "14:00", "America/Los_Angeles")).toBe("2026-12-06T14:00:00-08:00");
    expect(zonedISOString("2026-08-06", "09:30", "Pacific/Auckland")).toBe("2026-08-06T09:30:00+12:00");
    expect(zonedISOString("2026-08-06", "14:00", "America/Phoenix")).toBe("2026-08-06T14:00:00-07:00");
  });

  it("round-trips to the same instant", () => {
    const iso = zonedISOString("2026-11-03", "10:00", "America/Denver")!;
    expect(new Date(iso).toISOString()).toBe("2026-11-03T17:00:00.000Z");
  });

  it("spring-forward: a skipped wall clock has no instant", () => {
    // 2026-03-08 02:30 does not exist in America/Denver.
    expect(zonedISOString("2026-03-08", "02:30", "America/Denver")).toBeNull();
    expect(zonedISOString("2026-03-08", "03:30", "America/Denver")).toBe("2026-03-08T03:30:00-06:00");
  });

  it("fall-back: a repeated wall clock resolves to one real instant", () => {
    const iso = zonedISOString("2026-11-01", "01:30", "America/Denver");
    expect(iso === "2026-11-01T01:30:00-06:00" || iso === "2026-11-01T01:30:00-07:00").toBe(true);
  });
});

describe("depositLadder", () => {
  it("matches DEPOSIT_CENTS_BY_SIZE and depositDollarsForSize for every size", () => {
    for (const { size, cents } of depositLadder()) {
      expect(cents).toBe(DEPOSIT_CENTS_BY_SIZE[size]);
      expect(cents / 100).toBe(depositDollarsForSize(size));
      expect(Number.isInteger(cents)).toBe(true);
    }
    expect(depositLadder().map((r) => r.size)).toEqual(["small", "medium", "large", "sleeve"]);
    expect(minimumDepositCents()).toBe(7_500);
    expect(depositLadderLabel()).toBe("$75 small · $150 medium · $300 large · $500 sleeve");
  });
});
