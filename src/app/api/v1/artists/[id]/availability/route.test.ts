// Spec 6: GET /api/v1/artists/{id}/availability?from&to&tz
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const { offerMock, rateLimitMock } = vi.hoisted(() => ({
  offerMock: vi.fn(),
  rateLimitMock: vi.fn(),
}));

vi.mock("@/lib/booking-offer", () => ({ getBookingOffer: offerMock }));
vi.mock("@/lib/rate-limit", () => ({
  rateLimit: rateLimitMock,
  rateLimitResponse: () => new Response(JSON.stringify({ error: "Too Many Requests" }), { status: 429 }),
}));

import { GET } from "./route";

const RESERVATION = {
  decision: { mode: "reservation", label: "Live calendar", detail: "From the calendar." },
  timezone: "America/Phoenix",
  nextOpening: { at: "2099-01-10T14:00:00-07:00", timezone: "America/Phoenix" },
  slots: [
    { date: "2099-01-10", startTime: "14:00", endTime: "16:00", durationMinutes: 120, startsAt: "2099-01-10T14:00:00-07:00", endsAt: "2099-01-10T16:00:00-07:00" },
    { date: "2099-01-10", startTime: "17:00", endTime: "19:00", durationMinutes: 120, startsAt: "2099-01-10T17:00:00-07:00", endsAt: "2099-01-10T19:00:00-07:00" },
    { date: "2099-01-12", startTime: "10:00", endTime: "12:00", durationMinutes: 120, startsAt: "2099-01-12T10:00:00-07:00", endsAt: "2099-01-12T12:00:00-07:00" },
  ],
};

let n = 0;
async function get(query: string, id?: string) {
  // A fresh artist id per call keeps the route's short per-artist cache out of the way.
  const artistId = id ?? `artist_${++n}`;
  const res = await GET(new NextRequest(`http://localhost/api/v1/artists/${artistId}/availability${query}`), {
    params: Promise.resolve({ id: artistId }),
  });
  return { res, body: await res.json() };
}

beforeEach(() => {
  vi.clearAllMocks();
  rateLimitMock.mockResolvedValue({ allowed: true, limit: 60, remaining: 59, reset: 0 });
  offerMock.mockResolvedValue(RESERVATION);
});

describe("GET availability (spec 6)", () => {
  it("returns days, spots and timezone grouped by the artist's date", async () => {
    const { res, body } = await get("");
    expect(res.status).toBe(200);
    expect(body).toMatchObject({
      mode: "reservation",
      timezone: "America/Phoenix",
      nextOpeningAt: "2099-01-10T14:00:00-07:00",
      from: "2099-01-10",
      to: "2099-01-12",
    });
    expect(body.days.map((d: { date: string }) => d.date)).toEqual(["2099-01-10", "2099-01-12"]);
    expect(body.days[0].spots[0]).toEqual({
      startTime: "14:00",
      endTime: "16:00",
      startsAt: "2099-01-10T14:00:00-07:00",
      endsAt: "2099-01-10T16:00:00-07:00",
    });
  });

  it("from/to narrow the window; tz adds the viewer's wall clock", async () => {
    const { body } = await get("?from=2099-01-11&to=2099-01-31&tz=America/New_York");
    expect(body.days).toHaveLength(1);
    expect(body.viewerTimezone).toBe("America/New_York");
    expect(body.days[0].spots[0].local).toEqual({ date: "2099-01-12", time: "12:00" });
    // Next opening is the artist's first overall, not the first in range.
    expect(body.nextOpeningAt).toBe("2099-01-10T14:00:00-07:00");
  });

  it("request mode answers with no days", async () => {
    offerMock.mockResolvedValue({
      decision: { mode: "request", label: "On request", detail: "d" },
      slots: [],
      timezone: "America/Phoenix",
      nextOpening: null,
    });
    const { body } = await get("");
    expect(body.mode).toBe("request");
    expect(body.days).toEqual([]);
    expect(body.nextOpeningAt).toBeNull();
  });

  it("rejects bad input with 400 instead of widening", async () => {
    expect((await get("?from=2099-13-01")).res.status).toBe(400);
    expect((await get("?from=2099-01-10&to=2099-01-01")).res.status).toBe(400);
    expect((await get("?tz=Mars/Olympus")).res.status).toBe(400);
    expect((await get("", "bad id!")).res.status).toBe(400);
    expect(offerMock).not.toHaveBeenCalled();
  });

  it("passes a well-formed bookingId through so a customer's own hold stays visible", async () => {
    await get("?bookingId=BK-ABCD1234");
    expect(offerMock.mock.calls[0][0]).toMatchObject({ excludeBookingId: "BK-ABCD1234" });
    await get("?bookingId=not-a-booking");
    expect(offerMock.mock.calls[1][0].excludeBookingId).toBeUndefined();
  });

  it("caches per artist briefly, so a burst reads the calendar once", async () => {
    await get("", "artist_cached");
    await get("?tz=UTC", "artist_cached");
    expect(offerMock).toHaveBeenCalledTimes(1);
  });

  it("is flood-guarded and fails soft on an offer error", async () => {
    rateLimitMock.mockResolvedValueOnce({ allowed: false, limit: 60, remaining: 0, reset: 0 });
    expect((await get("")).res.status).toBe(429);
    offerMock.mockRejectedValueOnce(new Error("calendar down"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect((await get("")).res.status).toBe(503);
    warn.mockRestore();
  });
});
