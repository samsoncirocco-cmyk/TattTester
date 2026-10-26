// Money-path tests for the booking-deposit checkout.
//
// These assert the DIRECTION of the platform fee, which ADR-0007 fixes:
// the client pays the booking fee ON TOP of the deposit and the artist keeps
// 100% of the deposit. A regression that deducts the fee FROM the deposit
// costs real money on every booking and is invisible without a test that
// checks the arithmetic rather than the presence of the fields.
//
// Stripe, auth, firebase-admin and the artist lookup are mocked; the REAL
// platformFeeCents/CURRENCY are kept (via importActual) so the fee math under
// test is the shipping math.
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  createSessionMock,
  getArtistStripeMock,
  getRosterArtistByIdMock,
  releaseHoldByIdMock,
  getHoldMock,
  placeHoldMock,
} = vi.hoisted(() => ({
  createSessionMock: vi.fn(),
  getArtistStripeMock: vi.fn(),
  getRosterArtistByIdMock: vi.fn(),
  releaseHoldByIdMock: vi.fn(),
  getHoldMock: vi.fn(),
  placeHoldMock: vi.fn(),
}));

vi.mock("@/lib/api-auth", () => ({
  verifyApiAuth: vi.fn().mockResolvedValue(null),
}));

vi.mock("@/lib/auth-dal", () => ({
  verifyFirebaseToken: vi.fn().mockResolvedValue({ uid: "uid-client-1" }),
}));

// No admin credential → the bookingId ownership lookup short-circuits.
vi.mock("@/lib/firebase-admin", () => ({
  ensureAdminApp: () => null,
}));

vi.mock("@/lib/artist-stripe", () => ({
  getArtistStripe: getArtistStripeMock,
}));

vi.mock("@/lib/artists-graph", () => ({
  getRosterArtistById: getRosterArtistByIdMock,
}));

vi.mock("@/lib/booking-holds-persistence", () => ({
  releaseHoldById: releaseHoldByIdMock,
  getHold: getHoldMock,
  placeHold: placeHoldMock,
}));

vi.mock("@/lib/stripe", async () => {
  const actual =
    await vi.importActual<typeof import("@/lib/stripe")>("@/lib/stripe");
  return {
    ...actual,
    stripeConfigured: true,
    stripe: { checkout: { sessions: { create: createSessionMock } } },
  };
});

import { POST } from "./route";

// A medium tattoo → $150 deposit, 10% (1000 bps) booking fee → $15.
const DEPOSIT_CENTS = 15_000;
const FEE_CENTS = 1_500;

function makeRequest(overrides: Record<string, unknown> = {}) {
  const body = {
    artistId: "artist_1",
    artistName: "Nadia Ink",
    size: "medium",
    placement: "forearm",
    date: "2026-08-01",
    time: "14:00",
    budget: "500",
    clientName: "Sam Client",
    clientEmail: "client@example.com",
    ...overrides,
  };
  return new Request("http://localhost/api/checkout", {
    method: "POST",
    headers: { authorization: "Bearer fake", origin: "http://localhost:3000" },
    body: JSON.stringify(body),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as any;
}

/** The single Checkout Session params object the route handed to Stripe. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function sessionArgs(): any {
  expect(createSessionMock).toHaveBeenCalledTimes(1);
  return createSessionMock.mock.calls[0][0];
}

/** What the client is actually charged: the sum of the line items. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function chargedCents(args: any): number {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return args.line_items.reduce(
    (sum: number, li: any) => sum + li.price_data.unit_amount * li.quantity,
    0,
  );
}

describe("POST /api/checkout — claimed artist (destination charge)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    createSessionMock.mockResolvedValue({
      id: "cs_1",
      url: "https://checkout.stripe.com/c/cs_1",
    });
    getRosterArtistByIdMock.mockResolvedValue({
      id: "artist_1",
      bookingTier: "bookable",
    });
    getArtistStripeMock.mockResolvedValue({
      id: "artist_1",
      name: "Nadia Ink",
      email: "nadia@example.com",
      stripeAccountId: "acct_artist_1",
      chargesEnabled: true,
      claimVerified: true,
    });
  });

  it("charges the client deposit + fee as two line items", async () => {
    const res = await POST(makeRequest());
    expect(res.status).toBe(200);

    const args = sessionArgs();
    expect(args.line_items).toHaveLength(2);
    expect(args.line_items[0].price_data.unit_amount).toBe(DEPOSIT_CENTS);
    expect(args.line_items[1].price_data.unit_amount).toBe(FEE_CENTS);
    // The fee is ADDITIVE — the client pays more than the deposit, and the
    // deposit line item itself is never reduced.
    expect(chargedCents(args)).toBe(DEPOSIT_CENTS + FEE_CENTS);

    // The claimed-artist money sentence (ADR-0036 amendment): full strength,
    // both clauses. And no held-deposit flag on the success URL.
    expect(args.line_items[1].price_data.product_data.description).toMatch(
      /keeps 100% of the deposit/i,
    );
    expect(args.line_items[1].price_data.product_data.description).toMatch(
      /only part we keep/i,
    );
    expect(args.success_url).not.toContain("artistClaimed=0");
  });

  it("ADR-0007: application_fee_amount is the fee, so the artist nets 100% of the deposit", async () => {
    await POST(makeRequest());
    const args = sessionArgs();

    expect(args.payment_intent_data.application_fee_amount).toBe(FEE_CENTS);
    expect(args.payment_intent_data.transfer_data).toEqual({
      destination: "acct_artist_1",
    });

    // THE invariant. total − application_fee is what lands on the connected
    // account. It must equal the full deposit, not deposit − fee.
    const artistNet =
      chargedCents(args) - args.payment_intent_data.application_fee_amount;
    expect(artistNet).toBe(DEPOSIT_CENTS);
  });

  it("does NOT deduct the fee from the deposit (wrong-direction split guard)", async () => {
    await POST(makeRequest());
    const args = sessionArgs();

    const artistNet =
      chargedCents(args) - args.payment_intent_data.application_fee_amount;
    // The inverted model — artist receives deposit − fee — would land here.
    expect(artistNet).not.toBe(DEPOSIT_CENTS - FEE_CENTS);
    expect(artistNet).toBeGreaterThan(DEPOSIT_CENTS - FEE_CENTS);
  });

  it("tags the session 'routed' and records the artist's share as the deposit only", async () => {
    await POST(makeRequest());
    const args = sessionArgs();

    expect(args.metadata.depositState).toBe("routed");
    expect(args.metadata.depositCents).toBe(String(DEPOSIT_CENTS));
    expect(args.metadata.bookingFeeCents).toBe(String(FEE_CENTS));
    // Same metadata rides on the PaymentIntent so the webhook sees it either way.
    expect(args.payment_intent_data.metadata.depositState).toBe("routed");
  });

  it("scales the fee with the deposit (sleeve → $500 deposit, $50 fee)", async () => {
    await POST(makeRequest({ size: "sleeve" }));
    const args = sessionArgs();

    expect(args.line_items[0].price_data.unit_amount).toBe(50_000);
    expect(args.payment_intent_data.application_fee_amount).toBe(5_000);
    expect(
      chargedCents(args) - args.payment_intent_data.application_fee_amount,
    ).toBe(50_000);
  });
});

describe("POST /api/checkout — unclaimed artist (held deposit)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    createSessionMock.mockResolvedValue({
      id: "cs_2",
      url: "https://checkout.stripe.com/c/cs_2",
    });
    getRosterArtistByIdMock.mockResolvedValue({
      id: "artist_1",
      bookingTier: "bookable",
    });
  });

  it("holds on the platform — no transfer_data, no application_fee_amount", async () => {
    getArtistStripeMock.mockResolvedValue({
      id: "artist_1",
      name: "Nadia Ink",
      email: null,
      stripeAccountId: null,
      chargesEnabled: false,
    });

    const res = await POST(makeRequest());
    expect(res.status).toBe(200);

    const args = sessionArgs();
    expect(args.payment_intent_data.transfer_data).toBeUndefined();
    expect(args.payment_intent_data.application_fee_amount).toBeUndefined();
    expect(args.metadata.depositState).toBe("held");

    // The unclaimed-artist money sentence (ADR-0036 amendment): relay +
    // auto-refund truth on the Stripe summary, and the success URL carries
    // the variant plus the hold window stamped at checkout.
    expect(args.line_items[1].price_data.product_data.description).toMatch(
      /has not joined TatT yet/i,
    );
    expect(args.line_items[1].price_data.product_data.description).toMatch(
      /automatically refunds/i,
    );
    expect(args.success_url).toContain("artistClaimed=0");
    expect(args.success_url).toMatch(/holdDays=\d+/);
    // Lock the same window into Stripe metadata so the webhook does not
    // re-read a live DEPOSIT_HOLD_DAYS that may have changed since checkout.
    expect(args.metadata.holdDays).toMatch(/^\d+$/);
    expect(Number(args.metadata.holdDays)).toBeGreaterThan(0);
  });

  it("records the artist's share as the DEPOSIT ONLY, never the booking fee", async () => {
    getArtistStripeMock.mockResolvedValue({
      id: "artist_1",
      name: "Nadia Ink",
      email: null,
      stripeAccountId: null,
      chargesEnabled: false,
    });

    await POST(makeRequest());
    const args = sessionArgs();

    // depositCents is what transferHeldDeposits later pays the artist. The
    // client paid more than that; the surplus is TatT's fee and must not leak
    // into the relay amount.
    expect(args.metadata.depositCents).toBe(String(DEPOSIT_CENTS));
    expect(Number(args.metadata.depositCents)).toBeLessThan(chargedCents(args));
    expect(chargedCents(args) - Number(args.metadata.depositCents)).toBe(
      FEE_CENTS,
    );
  });

  it("holds when an account exists but charges are not enabled yet (mid-onboarding)", async () => {
    getArtistStripeMock.mockResolvedValue({
      id: "artist_1",
      name: "Nadia Ink",
      email: null,
      stripeAccountId: "acct_pending",
      chargesEnabled: false,
    });

    await POST(makeRequest());
    const args = sessionArgs();

    // Routing to a not-yet-enabled account would fail the charge outright.
    expect(args.payment_intent_data.transfer_data).toBeUndefined();
    expect(args.metadata.depositState).toBe("held");
  });

  it("holds when Stripe is ready but the ownership claim was never verified", async () => {
    getArtistStripeMock.mockResolvedValue({
      id: "artist_1",
      name: "Nadia Ink",
      email: null,
      stripeAccountId: "acct_attacker",
      chargesEnabled: true,
      claimedByUid: "uid_first_finder",
      claimVerified: false,
    });

    await POST(makeRequest());
    const args = sessionArgs();
    expect(args.payment_intent_data.transfer_data).toBeUndefined();
    expect(args.metadata.depositState).toBe("held");
  });
});

describe("POST /api/checkout — guards", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    createSessionMock.mockResolvedValue({ id: "cs_3", url: "https://x" });
    getRosterArtistByIdMock.mockResolvedValue({
      id: "artist_1",
      bookingTier: "bookable",
    });
  });

  it("400s without an artistId — a deposit with no payee must never be charged", async () => {
    const res = await POST(makeRequest({ artistId: undefined }));
    expect(res.status).toBe(400);
    expect(createSessionMock).not.toHaveBeenCalled();
  });

  it("404s for an unknown artist", async () => {
    getRosterArtistByIdMock.mockResolvedValue(null);
    const res = await POST(makeRequest());
    expect(res.status).toBe(404);
    expect(createSessionMock).not.toHaveBeenCalled();
  });

  it("404 releases any hold so a missing roster row cannot strand a slot", async () => {
    getRosterArtistByIdMock.mockResolvedValue(null);
    releaseHoldByIdMock.mockResolvedValue(true);

    const res = await POST(makeRequest({ holdId: "hold_missing" }));
    expect(res.status).toBe(404);
    expect(releaseHoldByIdMock).toHaveBeenCalledWith("hold_missing");
    expect(createSessionMock).not.toHaveBeenCalled();
  });

  it("503 on bookability outage releases any hold so the slot is not stranded", async () => {
    getRosterArtistByIdMock.mockRejectedValue(new Error("Neo4j down"));
    releaseHoldByIdMock.mockResolvedValue(true);

    const res = await POST(makeRequest({ holdId: "hold_outage" }));
    expect(res.status).toBe(503);
    expect(releaseHoldByIdMock).toHaveBeenCalledWith("hold_outage");
    expect(createSessionMock).not.toHaveBeenCalled();
  });

  it("409s browse-only artists with introUrl that preserves ds and releases any hold", async () => {
    getRosterArtistByIdMock.mockResolvedValue({
      id: "artist_intro_only",
      bookingTier: "browse-only",
    });
    releaseHoldByIdMock.mockResolvedValue(true);

    const res = await POST(
      makeRequest({
        artistId: "artist_intro_only",
        designSessionId: "sess-1",
        holdId: "hold_abc",
      }),
    );
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body).toMatchObject({
      code: "ARTIST_INTRO_REQUIRED",
      introUrl: "/intro?artistId=artist_intro_only&ds=sess-1",
    });
    expect(releaseHoldByIdMock).toHaveBeenCalledWith("hold_abc");
    expect(createSessionMock).not.toHaveBeenCalled();
  });
});

// ── Reservation path: the hold must never be stranded (REA gap #1) ──────────
// Every refusal after the hold has been refreshed must release it, or the slot
// stays blocked for the rest of the TTL while the customer sees an error. The
// cancel_url must carry the booking and hold so /book can pick them back up.
const LIVE_HOLD = {
  holdId: "hold_live",
  artistId: "artist_1",
  bookingId: "BK-RESUME01",
  date: "2026-08-01",
  startTime: "14:00",
  endTime: "16:00",
  timezone: "America/Phoenix",
  createdAt: "2026-07-31T00:00:00.000Z",
  expiresAt: "2099-01-01T00:00:00.000Z",
  status: "active",
};

describe("POST /api/checkout — reservation hold lifecycle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getRosterArtistByIdMock.mockResolvedValue({ id: "artist_1", bookingTier: "bookable" });
    getArtistStripeMock.mockResolvedValue({
      id: "artist_1",
      name: "Nadia Ink",
      claimVerified: true,
      stripeAccountId: "acct_1",
      chargesEnabled: true,
    });
    getHoldMock.mockResolvedValue(LIVE_HOLD);
    placeHoldMock.mockResolvedValue({
      ok: true,
      hold: { ...LIVE_HOLD, holdId: "hold_refreshed" },
    });
    releaseHoldByIdMock.mockResolvedValue(true);
    createSessionMock.mockResolvedValue({ id: "cs_r", url: "https://checkout.stripe.com/c/cs_r" });
  });

  it("refuses with HOLD_LOST (not a generic error) when the hold is gone", async () => {
    getHoldMock.mockResolvedValue({ ...LIVE_HOLD, status: "released" });
    const res = await POST(makeRequest({ holdId: "hold_live", bookingId: "BK-RESUME01" }));
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("HOLD_LOST");
    expect(createSessionMock).not.toHaveBeenCalled();
  });

  it("cancel_url carries bookingId, the refreshed holdId, cancelled=1 and the slot", async () => {
    const res = await POST(makeRequest({ holdId: "hold_live", bookingId: "BK-RESUME01" }));
    expect(res.status).toBe(200);
    const cancel = new URL(sessionArgs().cancel_url);
    expect(cancel.pathname).toBe("/book");
    expect(cancel.searchParams.get("artistId")).toBe("artist_1");
    expect(cancel.searchParams.get("bookingId")).toBe("BK-RESUME01");
    expect(cancel.searchParams.get("holdId")).toBe("hold_refreshed");
    expect(cancel.searchParams.get("cancelled")).toBe("1");
    expect(cancel.searchParams.get("slot")).toBe("2026-08-01|14:00|16:00");
  });

  it("request mode (no holdId) keeps a plain cancel_url with no hold markers", async () => {
    const res = await POST(makeRequest({ bookingId: "BK-REQ00001" }));
    expect(res.status).toBe(200);
    const cancel = new URL(sessionArgs().cancel_url);
    expect(cancel.searchParams.get("bookingId")).toBe("BK-REQ00001");
    expect(cancel.searchParams.get("holdId")).toBeNull();
    expect(cancel.searchParams.get("cancelled")).toBeNull();
  });

  it("releases the refreshed hold when the artist has no Stripe record (404)", async () => {
    getArtistStripeMock.mockResolvedValue(null);
    const res = await POST(makeRequest({ holdId: "hold_live", bookingId: "BK-RESUME01" }));
    expect(res.status).toBe(404);
    expect(releaseHoldByIdMock).toHaveBeenCalledWith("hold_refreshed");
  });

  it("releases the refreshed hold when Stripe session creation throws (502)", async () => {
    createSessionMock.mockRejectedValue(new Error("stripe exploded"));
    const res = await POST(makeRequest({ holdId: "hold_live", bookingId: "BK-RESUME01" }));
    expect(res.status).toBe(502);
    expect(releaseHoldByIdMock).toHaveBeenCalledWith("hold_refreshed");
  });

  it("releases the refreshed hold when Stripe returns a session with no url (502)", async () => {
    createSessionMock.mockResolvedValue({ id: "cs_nourl", url: null });
    const res = await POST(makeRequest({ holdId: "hold_live", bookingId: "BK-RESUME01" }));
    expect(res.status).toBe(502);
    expect(releaseHoldByIdMock).toHaveBeenCalledWith("hold_refreshed");
  });

  it("does not release anything on the happy path — the hold rides into Stripe", async () => {
    const res = await POST(makeRequest({ holdId: "hold_live", bookingId: "BK-RESUME01" }));
    expect(res.status).toBe(200);
    expect(releaseHoldByIdMock).not.toHaveBeenCalled();
    expect(sessionArgs().metadata.holdId).toBe("hold_refreshed");
  });
});
