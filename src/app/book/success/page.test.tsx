// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, waitFor, act } from "@testing-library/react";
import BookingSuccessPage from "./page";

let searchParams = new URLSearchParams();
const getApiAuthHeadersMock = vi.hoisted(() => vi.fn());
const fetchMock = vi.hoisted(() => vi.fn());
const bookingFetchMock = vi.hoisted(() => vi.fn());

vi.mock("next/navigation", () => ({
  useSearchParams: () => searchParams,
}));

vi.mock("@/components/studio/StudioShell", () => ({
  default: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock("@/lib/client-api-auth", () => ({
  getApiAuthHeaders: getApiAuthHeadersMock,
}));

/**
 * Wire the page's two owner-scoped fetches. `booking` null ⇒ 404 from
 * /api/v1/bookings/[id]; `calendar` false ⇒ 404 from calendar.ics (the
 * request model), true ⇒ a served .ics (the reservation model).
 */
function stubServer({
  booking,
  calendar,
}: {
  booking: Record<string, unknown> | null;
  calendar: boolean;
}) {
  getApiAuthHeadersMock.mockResolvedValue({ Authorization: "Bearer t" });
  fetchMock.mockImplementation(async (url: string) => {
    if (String(url).endsWith("/calendar.ics")) {
      return calendar
        ? {
            ok: true,
            blob: async () => new Blob(["BEGIN:VCALENDAR"], { type: "text/calendar" }),
          }
        : { ok: false, status: 404, json: async () => ({ success: false }) };
    }
    return booking
      ? { ok: true, json: async () => ({ success: true, booking }) }
      : { ok: false, status: 404, json: async () => ({ success: false }) };
  });
}

function bookingResponse(status: string, overrides: Record<string, unknown> = {}) {
  return {
    ok: true,
    json: vi.fn().mockResolvedValue({
      success: true,
      booking: {
        status,
        depositAmount: 100,
        artistName: "Nadia",
        ...overrides,
      },
    }),
  };
}

async function flushInitialRead() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("BookingSuccessPage — no dead ends", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    searchParams = new URLSearchParams(
      "artist=Nadia&deposit=100&session_id=cs_test_123&bookingId=book_123"
    );
    getApiAuthHeadersMock.mockReset();
    getApiAuthHeadersMock.mockResolvedValue({ Authorization: "Bearer owner" });
    fetchMock.mockReset();
    bookingFetchMock.mockReset();
    bookingFetchMock.mockResolvedValue(bookingResponse("pending"));
    fetchMock.mockImplementation((url: string, init?: RequestInit) =>
      String(url).endsWith("/calendar.ics")
        ? Promise.resolve({ ok: false, status: 404 })
        : bookingFetchMock(url, init)
    );
    vi.stubGlobal("fetch", fetchMock);
  });

  it("offers the bookings door", async () => {
    render(<BookingSuccessPage />);
    await flushInitialRead();
    expect(
      screen.getByRole("link", { name: /your bookings/i }).getAttribute("href")
    ).toBe("/bookings");
  });

  it("offers a way back into the funnel — start another design", async () => {
    render(<BookingSuccessPage />);
    await flushInitialRead();
    expect(
      screen.getByRole("link", { name: /start another design/i }).getAttribute("href")
    ).toBe("/design");
  });

  it("keeps an unconfirmed payment return in a booking-request plan", async () => {
    render(<BookingSuccessPage />);
    await flushInitialRead();
    expect(
      screen.getByRole("heading", { name: /your booking-request plan/i })
    ).toBeTruthy();
    expect(screen.getByText(/shop address, remaining quote/i)).toBeTruthy();
    expect(screen.getByText(/do not make appointment plans yet/i)).toBeTruthy();
  });

  it("does not call an unreconciled return URL paid", async () => {
    render(<BookingSuccessPage />);
    await flushInitialRead();
    expect(screen.getAllByText(/confirming deposit/i).length).toBeGreaterThan(0);
    expect(screen.queryByText(/^deposit paid$/i)).toBeNull();
    expect(screen.getByText("book_123")).toBeTruthy();
  });

  it("polls the exact owner-scoped booking until the webhook marks the deposit paid", async () => {
    bookingFetchMock
      .mockResolvedValueOnce(bookingResponse("pending"))
      .mockResolvedValueOnce(
        bookingResponse("deposit_paid", { paidAt: "2026-07-29T23:00:00.000Z" })
      );

    render(<BookingSuccessPage />);
    await flushInitialRead();

    expect(bookingFetchMock).toHaveBeenCalledTimes(1);
    expect(bookingFetchMock).toHaveBeenLastCalledWith(
      "/api/v1/bookings/book_123",
      { headers: { Authorization: "Bearer owner" } }
    );
    expect(screen.getAllByText(/confirming deposit/i).length).toBeGreaterThan(0);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });

    expect(bookingFetchMock).toHaveBeenCalledTimes(2);
    expect(screen.getAllByText(/^deposit paid$/i).length).toBeGreaterThan(0);
    // Request model (no .ics): paid copy keeps the ADR-0027 distinction — the
    // artist still confirms a time, within the stated reply window (REA gap
    // #3), and no time is called booked.
    expect(screen.getByText(/your deposit cleared/i)).toBeTruthy();
    expect(screen.getAllByText(/Nadia replies within 48 hours/i).length).toBeGreaterThan(0);
    expect(screen.queryByText(/your time is booked/i)).toBeNull();

    await act(async () => {
      await vi.runAllTimersAsync();
    });
    expect(bookingFetchMock).toHaveBeenCalledTimes(2);
  });

  it("paid, claimed artist: the full-strength money sentence (ADR-0036 amendment)", async () => {
    bookingFetchMock.mockResolvedValueOnce(bookingResponse("deposit_paid"));

    render(<BookingSuccessPage />);
    await flushInitialRead();

    expect(screen.getByText(/whole deposit goes to your artist/i)).toBeTruthy();
    expect(screen.getByText(/only part we keep/i)).toBeTruthy();
    expect(screen.queryByText(/held during verification/i)).toBeNull();
  });

  it("paid, unclaimed artist (artistClaimed=0): the relay and auto-refund truth", async () => {
    searchParams = new URLSearchParams(
      "artist=Nadia&deposit=100&session_id=cs_test_123&bookingId=book_123&artistClaimed=0&holdDays=3"
    );
    bookingFetchMock.mockResolvedValueOnce(bookingResponse("deposit_paid"));

    render(<BookingSuccessPage />);
    await flushInitialRead();

    expect(screen.getAllByText(/has not joined TatT yet/i)).toHaveLength(2);
    expect(screen.getByText(/relay the request/i)).toBeTruthy();
    expect(screen.getAllByText(/within 3 days/i)).toHaveLength(2);
    expect(screen.getAllByText(/automatically refunds your deposit/i)).toHaveLength(2);
    // Unclaimed: the reply promise is TattTester's, never the absent artist's.
    expect(
      screen.getAllByText(/TattTester relays your request and you hear back within 48 hours/i).length
    ).toBeGreaterThan(0);
    expect(screen.queryByText(/Nadia replies within/i)).toBeNull();
    expect(screen.queryByText(/whole deposit goes to your artist/i)).toBeNull();
  });

  it("uses the checkout-pinned hold window in both unclaimed deposit promises", async () => {
    searchParams = new URLSearchParams(
      "artist=Nadia&deposit=100&session_id=cs_test_123&bookingId=book_123&artistClaimed=0&holdDays=3"
    );
    bookingFetchMock.mockResolvedValueOnce(bookingResponse("deposit_paid"));

    render(<BookingSuccessPage />);
    await flushInitialRead();

    expect(screen.getAllByText(/within 3 days/i)).toHaveLength(2);
    expect(screen.queryByText(/within 7 days/i)).toBeNull();
  });

  it("stops after a bounded reconciliation window without falling back to Deposit due", async () => {
    render(<BookingSuccessPage />);
    await flushInitialRead();

    await act(async () => {
      await vi.runAllTimersAsync();
    });

    expect(bookingFetchMock).toHaveBeenCalledTimes(6);
    expect(screen.getAllByText(/confirmation taking longer/i).length).toBeGreaterThan(0);
    expect(screen.getByText(/we haven't marked your deposit paid/i)).toBeTruthy();
    expect(screen.queryByText(/^deposit due$/i)).toBeNull();
  });

  it("does not borrow payment truth from a different booking on a legacy return URL", async () => {
    searchParams = new URLSearchParams(
      "artist=Nadia&deposit=100&session_id=cs_legacy_target",
    );
    bookingFetchMock.mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({
        success: true,
        bookings: [
          {
            status: "deposit_paid",
            stripeSessionId: "cs_some_other_booking",
            depositAmount: 100,
          },
        ],
      }),
    });

    render(<BookingSuccessPage />);
    await flushInitialRead();
    await act(async () => {
      await vi.runAllTimersAsync();
    });

    expect(bookingFetchMock).toHaveBeenCalledTimes(6);
    expect(screen.getAllByText(/confirmation taking longer/i).length).toBeGreaterThan(0);
    expect(screen.queryByText(/^deposit paid$/i)).toBeNull();
  });

  it("never chooses the first owner booking when a legacy URL has no exact identifier", async () => {
    searchParams = new URLSearchParams("artist=Nadia&deposit=100");
    fetchMock.mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({
        success: true,
        bookings: [
          {
            status: "deposit_paid",
            stripeSessionId: "cs_some_other_booking",
            depositAmount: 100,
          },
        ],
      }),
    });

    render(<BookingSuccessPage />);
    await flushInitialRead();

    expect(screen.queryByText(/^deposit paid$/i)).toBeNull();
    expect(screen.getByText(/deposit has not been confirmed/i)).toBeTruthy();
  });

  it("stops polling on a non-paid terminal status and does not imply a secured slot", async () => {
    bookingFetchMock
      .mockResolvedValueOnce(bookingResponse("pending"))
      .mockResolvedValueOnce(bookingResponse("cancelled"));

    render(<BookingSuccessPage />);
    await flushInitialRead();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
      await vi.runAllTimersAsync();
    });

    expect(bookingFetchMock).toHaveBeenCalledTimes(2);
    expect(screen.getAllByText(/^cancelled$/i).length).toBeGreaterThan(0);
    expect(screen.getByText(/no paid deposit is being claimed here/i)).toBeTruthy();
    expect(screen.queryByText(/secured|final slot/i)).toBeNull();
    expect(screen.queryByRole("heading", { name: /game plan|booking-request plan/i })).toBeNull();
  });

  it("only calls the appointment confirmed when server status proves it", async () => {
    bookingFetchMock.mockResolvedValueOnce(bookingResponse("confirmed"));

    render(<BookingSuccessPage />);
    await flushInitialRead();

    expect(screen.getByRole("heading", { name: /^booking confirmed$/i })).toBeTruthy();
    expect(screen.getByText(/your appointment is confirmed/i)).toBeTruthy();
    expect(screen.getByRole("heading", { name: /your appointment game plan/i })).toBeTruthy();
    expect(bookingFetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("BookingSuccessPage — what-happens-next timeline", () => {
  beforeEach(() => {
    searchParams = new URLSearchParams(
      "artist=Nadia&deposit=100&bookingId=BK-TEST1234"
    );
    // Default: signed out — param-based display, no server truth, no calendar.
    getApiAuthHeadersMock.mockReset();
    getApiAuthHeadersMock.mockRejectedValue(new Error("signed out"));
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });

  it("signed out: fails closed to the request-model timeline, no calendar button", () => {
    render(<BookingSuccessPage />);
    expect(screen.getByText("What happens next")).toBeTruthy();
    expect(screen.getByText("Request sent")).toBeTruthy();
    expect(screen.getByText("Artist review")).toBeTruthy();
    expect(screen.queryByText("Time reserved")).toBeNull();
    expect(screen.queryByRole("button", { name: /add to calendar/i })).toBeNull();
  });

  it("request model, deposit paid: the artist-review step is current", async () => {
    stubServer({
      booking: { status: "deposit_paid", artistName: "Nadia", depositAmount: 100 },
      calendar: false,
    });
    render(<BookingSuccessPage />);
    await waitFor(() => {
      const current = document.querySelector('[aria-current="step"]');
      expect(current?.textContent).toContain("Artist review");
    });
    // The reply-time promise (REA gap #3): a stated window the customer can
    // hold us to, the same sentence the in-page request card shows.
    expect(screen.queryByText(/there's no set window/i)).toBeNull();
    expect(screen.getAllByText(/Nadia replies within 48 hours/i).length).toBeGreaterThan(0);
    expect(screen.queryByRole("button", { name: /add to calendar/i })).toBeNull();
  });

  it("reservation model: renders the reservation timeline and the calendar button", async () => {
    stubServer({
      booking: { status: "deposit_paid", artistName: "Nadia", depositAmount: 100 },
      calendar: true,
    });
    render(<BookingSuccessPage />);
    await waitFor(() => {
      expect(screen.getByText("Time reserved")).toBeTruthy();
    });
    // Deposit-confirms-slot (ADR 0027): no artist-review step on this path.
    expect(screen.queryByText("Artist review")).toBeNull();
    expect(screen.getByText(/time is yours/i)).toBeTruthy();
    // Paid + reserved: the receipt copy says the time is booked — no
    // final-slot confirmation is pending on this path.
    expect(screen.getByText(/your time is booked/i)).toBeTruthy();
    expect(screen.queryByText(/they confirm the final slot/i)).toBeNull();
    expect(screen.getByRole("button", { name: /add to calendar/i })).toBeTruthy();
    // Paid ⇒ the session step is what's ahead.
    const current = document.querySelector('[aria-current="step"]');
    expect(current?.textContent).toContain("Your session");
  });

  it("request model, pending deposit: the deposit step is current", async () => {
    searchParams = new URLSearchParams("artist=Nadia&bookingId=BK-TEST1234");
    stubServer({
      booking: { status: "pending", artistName: "Nadia" },
      calendar: false,
    });
    render(<BookingSuccessPage />);
    await waitFor(() => {
      const current = document.querySelector('[aria-current="step"]');
      expect(current?.textContent).toContain("Deposit");
    });
    // The reply window is stated before the deposit clears, too.
    expect(screen.getByText(/Nadia replies within 48 hours/i)).toBeTruthy();
  });

  it("hides the timeline for an ended booking — there is no next", async () => {
    stubServer({
      booking: { status: "declined", artistName: "Nadia" },
      calendar: false,
    });
    render(<BookingSuccessPage />);
    await waitFor(() => {
      expect(screen.getAllByText(/declined/i).length).toBeGreaterThan(0);
    });
    expect(screen.queryByText("What happens next")).toBeNull();
  });
});
