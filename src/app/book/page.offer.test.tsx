// Spec 4: /book passes the slot instants, the artist zone and the next
// opening through to the client.
import { describe, expect, it, vi } from "vitest";

const { offerMock } = vi.hoisted(() => ({ offerMock: vi.fn() }));

vi.mock("@/lib/artists-graph", () => ({
  getRosterArtistById: vi.fn(async () => ({
    id: "artist_1",
    slug: "nadia-ink",
    name: "Nadia Ink",
    location: "Phoenix, AZ",
    shopName: null,
    styles: [],
    claimed: true,
    bookingTier: "bookable",
  })),
}));
vi.mock("@/lib/availability", () => ({
  getArtistAvailability: vi.fn(async () => ({ status: "open" })),
}));
vi.mock("@/lib/booking-offer", () => ({ getBookingOffer: offerMock }));
vi.mock("@/lib/stripe", () => ({ PLATFORM_FEE_BPS: 1000 }));
vi.mock("./BookClient", () => ({ default: () => null }));

// The profile now reads cached Firestore hints (next opening, artist extras);
// with only a project id configured that would try a real network call.
vi.mock("@/lib/firebase-admin", () => ({ ensureAdminApp: () => false }));

import BookPage from "./page";

describe("BookPage offer props (spec 4)", () => {
  it("includes startsAt, endsAt, durationMinutes, timezone and nextOpeningAt", async () => {
    offerMock.mockResolvedValue({
      decision: { mode: "reservation", label: "Live", detail: "d" },
      slots: [
        {
          date: "2099-01-10",
          startTime: "14:00",
          endTime: "16:00",
          durationMinutes: 120,
          startsAt: "2099-01-10T14:00:00-07:00",
          endsAt: "2099-01-10T16:00:00-07:00",
        },
      ],
      timezone: "America/Phoenix",
      nextOpening: { at: "2099-01-10T14:00:00-07:00", timezone: "America/Phoenix" },
    });
    const el = (await BookPage({ searchParams: Promise.resolve({ artistId: "artist_1" }) })) as {
      props: { offer: Record<string, unknown> };
    };
    expect(el.props.offer).toMatchObject({
      timezone: "America/Phoenix",
      nextOpeningAt: "2099-01-10T14:00:00-07:00",
      slots: [
        {
          startsAt: "2099-01-10T14:00:00-07:00",
          endsAt: "2099-01-10T16:00:00-07:00",
          durationMinutes: 120,
        },
      ],
    });
  });
});
