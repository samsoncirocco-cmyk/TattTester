import { afterEach, describe, expect, it } from "vitest";
import {
  artistDepositNotificationMoneyCopy,
  bookingMoneyCopy,
  bookingReviewMoneyCopy,
  bookingsListMoneyCopy,
  bookingSuccessMoneyCopy,
  checkoutFeeMoneyCopy,
} from "./money-copy";

describe("booking money copy", () => {
  const originalHoldDays = process.env.DEPOSIT_HOLD_DAYS;

  afterEach(() => {
    if (originalHoldDays === undefined) delete process.env.DEPOSIT_HOLD_DAYS;
    else process.env.DEPOSIT_HOLD_DAYS = originalHoldDays;
  });

  it("keeps every static surface on the same fee/deposit policy", () => {
    for (const sentence of Object.values(bookingMoneyCopy)) {
      expect(sentence).toMatch(/fee/i);
      expect(sentence).toMatch(/deposit/i);
      expect(sentence).toMatch(/artist|yours|your/i);
      expect(sentence).not.toMatch(/\bTatT\b/);
    }
  });

  it("gives the claimed-artist variants the full-strength sentence (ADR-0036 amendment)", () => {
    // Both clauses are load-bearing: 100% of the deposit to the artist, and
    // the booking fee as the only thing TattTester keeps.
    expect(checkoutFeeMoneyCopy(true)).toMatch(/keeps 100% of the deposit/i);
    expect(checkoutFeeMoneyCopy(true)).toMatch(/only part we keep/i);
    expect(bookingSuccessMoneyCopy(true)).toMatch(
      /whole deposit goes to your artist/i,
    );
    expect(bookingSuccessMoneyCopy(true)).toMatch(/only part we keep/i);
    // Claimed is the default, matching bookingReviewMoneyCopy.
    expect(checkoutFeeMoneyCopy()).toBe(checkoutFeeMoneyCopy(true));
    expect(bookingSuccessMoneyCopy()).toBe(bookingSuccessMoneyCopy(true));
  });

  it("keeps the held-deposit truth on the unclaimed variants (ADR-0006/0008)", () => {
    delete process.env.DEPOSIT_HOLD_DAYS;
    for (const sentence of [
      checkoutFeeMoneyCopy(false),
      bookingSuccessMoneyCopy(false),
      bookingReviewMoneyCopy("Nadia", 10, false),
    ]) {
      expect(sentence).toMatch(/has not joined TatT yet/i);
      expect(sentence).toMatch(/relay/i);
      expect(sentence).toMatch(/within 7 days/i);
      expect(sentence).toMatch(/automatically refunds/i);
    }
  });

  it("reads DEPOSIT_HOLD_DAYS for the unclaimed refund window", () => {
    process.env.DEPOSIT_HOLD_DAYS = "3";
    expect(checkoutFeeMoneyCopy(false)).toMatch(/within 3 days/i);
    expect(bookingSuccessMoneyCopy(false)).toMatch(/within 3 days/i);
    expect(bookingReviewMoneyCopy("Nadia", 10, false)).toMatch(
      /within 3 days/i,
    );
    expect(checkoutFeeMoneyCopy(false)).not.toMatch(/within 7 days/i);
  });

  it("uses the configured hold duration in the held-deposit success copy", () => {
    expect(bookingSuccessMoneyCopy(false, 3)).toMatch(/within 3 days/i);
    expect(bookingSuccessMoneyCopy(false, 3)).not.toMatch(/within 7 days/i);
  });

  it("states both the rule and the unclaimed exception on the bookings list", () => {
    delete process.env.DEPOSIT_HOLD_DAYS;
    expect(bookingsListMoneyCopy()).toMatch(
      /deposit goes to your artist in full/i,
    );
    expect(bookingsListMoneyCopy()).toMatch(/only part we keep/i);
    expect(bookingsListMoneyCopy()).toMatch(/unclaimed profile/i);
    expect(bookingsListMoneyCopy()).toMatch(/relay/i);
    expect(bookingsListMoneyCopy()).toMatch(/automatically refunded in full/i);
    expect(bookingsListMoneyCopy()).toMatch(/within 7 days/i);
    expect(bookingsListMoneyCopy(3)).toMatch(/within 3 days/i);
    expect(bookingsListMoneyCopy()).not.toMatch(/hold window/i);
    expect(bookingsListMoneyCopy()).not.toMatch(/held during verification/i);
    expect(bookingsListMoneyCopy()).not.toMatch(/claim window closes/i);
  });

  it("renders the live artist and fee percentage on booking review", () => {
    expect(bookingReviewMoneyCopy("Nadia", 10)).toBe(
      "Your deposit goes to Nadia. All of it. Our 10% booking fee is added on top — you’ll see both numbers at checkout.",
    );
  });

  it("describes relay custody and refund truth for an unclaimed profile", () => {
    delete process.env.DEPOSIT_HOLD_DAYS;
    expect(bookingReviewMoneyCopy("Nadia", 10, false)).toMatch(
      /relay your request to Nadia/i,
    );
    expect(bookingReviewMoneyCopy("Nadia", 10, false)).toMatch(
      /within 7 days/i,
    );
    expect(bookingReviewMoneyCopy("Nadia", 10, false)).toMatch(
      /10% booking fee/i,
    );
  });

  it("tells the notified artist who paid and what they keep", () => {
    expect(artistDepositNotificationMoneyCopy("$150.00")).toBe(
      "The client paid your $150.00 deposit plus TattTester’s booking fee. You keep the full $150.00 deposit; the fee is the only part TattTester keeps.",
    );
  });
});
