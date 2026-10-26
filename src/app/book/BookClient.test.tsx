// @vitest-environment jsdom
//
// The three top-ranked booking gaps from the REA competitor study
// (~/reports/tatttester/2026-10-23-rea-competitor-rollup.html), as seen from
// the customer's side of /book:
//
//  1. a resumed visit re-uses the booking id instead of minting a new one, and
//     a return from Stripe's cancel page releases the hold it names;
//  2. a lost slot stays in reservation mode, is marked "Taken", and the form
//     keeps its answers; checkout's HOLD_LOST gets its own "pick another time";
//  3. the request-sent card states when the customer hears back.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import BookClient, { type BookArtist, type BookOffer, type BookResume } from "./BookClient";

const refresh = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh, push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/book",
}));

vi.mock("@/components/studio/StudioShell", () => ({
  default: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock("@/lib/client-api-auth", () => ({
  getApiAuthHeaders: vi.fn(async () => ({ Authorization: "Bearer test-token" })),
}));

const addBooking = vi.fn();
vi.mock("@/lib/tattStorage", () => ({
  useBookings: () => ({ addBooking }),
  useDesigns: () => ({ designs: [] }),
}));

const ARTIST: BookArtist = {
  id: "artist_1",
  slug: "nadia-ink",
  name: "Nadia Ink",
  location: "Phoenix, AZ",
  shopName: "Ink House",
  styles: ["fine-line"],
  availabilityStatus: "open",
  availabilityLabel: "Taking bookings",
  availabilityNote: null,
  claimed: true,
};

const SLOT_A = { date: "2099-01-10", startTime: "14:00", endTime: "16:00" };
const SLOT_B = { date: "2099-01-10", startTime: "17:00", endTime: "19:00" };

const RESERVATION_OFFER: BookOffer = {
  mode: "reservation",
  label: "Live calendar",
  detail: "These times come from the artist's own calendar.",
  slots: [SLOT_A, SLOT_B],
  timezone: "America/Phoenix",
};

const REQUEST_OFFER: BookOffer = {
  mode: "request",
  label: "Availability on request",
  detail: "Pick the dates that suit you.",
  slots: [],
};

type Call = { url: string; init: RequestInit | undefined };
let calls: Call[] = [];
let responders: Array<(url: string, init?: RequestInit) => Response | undefined> = [];

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function installFetch() {
  calls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      calls.push({ url, init });
      for (const r of responders) {
        const res = r(url, init);
        if (res) return res;
      }
      throw new Error(`unexpected fetch ${init?.method ?? "GET"} ${url}`);
    }),
  );
}

function renderBook(offer: BookOffer, resume: BookResume | null = null) {
  return render(
    <BookClient
      artist={ARTIST}
      requestedArtistId="artist_1"
      artistLoadFailed={false}
      offer={offer}
      feePercent={10}
      holdDays={7}
      resume={resume}
    />,
  );
}

/** Step 02: every required answer. */
function fillDetails() {
  fireEvent.click(screen.getByRole("button", { name: /^Small/ }));
  fireEvent.click(screen.getByRole("button", { name: "Forearm" }));
  fireEvent.change(screen.getByLabelText("Describe your vision"), {
    target: { value: "A fine-line fox curled around my forearm, soft shading." },
  });
  fireEvent.click(screen.getByRole("button", { name: "Under $300" }));
  fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Sam Client" } });
  fireEvent.change(screen.getByLabelText("Email"), { target: { value: "sam@example.com" } });
}

function pickSlot(startTime: string) {
  fireEvent.click(screen.getByRole("button", { name: startTime }));
}

const bookOk = (url: string, init?: RequestInit) =>
  url === "/api/v1/book" && init?.method === "POST"
    ? json({ success: true, bookingId: "BK-NEW00001" })
    : undefined;

beforeEach(() => {
  vi.clearAllMocks();
  responders = [];
  installFetch();
  window.history.replaceState(null, "", "/book?artistId=artist_1");
});

describe("BookClient — lost race stays honest (REA gap #2)", () => {
  it("hold 409 keeps reservation mode, marks the slot Taken, keeps the form, refetches", async () => {
    responders = [
      bookOk,
      (url, init) =>
        url === "/api/v1/book/hold" && init?.method === "POST"
          ? json({ error: "Someone just took that time.", code: "SLOT_GONE" }, 409)
          : undefined,
    ];
    renderBook(RESERVATION_OFFER);

    pickSlot("14:00");
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    fillDetails();
    fireEvent.click(screen.getByRole("button", { name: "Review" }));
    fireEvent.click(screen.getByRole("button", { name: "Pay $75 deposit to hold" }));

    // Back on the time step, STILL the reservation product.
    await waitFor(() => expect(screen.getByText("Pick your time")).toBeTruthy());
    expect(screen.queryByText("Request your dates")).toBeNull();

    // The lost time is shown, disabled, and labelled.
    const taken = screen.getByRole("button", { name: /14:00/ });
    expect((taken as HTMLButtonElement).disabled).toBe(true);
    expect(within(taken).getByText("Taken")).toBeTruthy();
    // The other time is still live.
    expect((screen.getByRole("button", { name: "17:00" }) as HTMLButtonElement).disabled).toBe(false);

    expect(screen.getByRole("status").textContent).toMatch(/just taken by someone else/);
    expect(screen.getByRole("status").textContent).toMatch(/pick another time/i);
    // Spec 6: the grid refetches from the availability endpoint, not a full page refresh.
    expect(calls.some((c) => c.url.startsWith("/api/v1/artists/artist_1/availability"))).toBe(true);
    expect(refresh).not.toHaveBeenCalled();

    // The form kept its answers: pick the other time and walk forward.
    pickSlot("17:00");
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect((screen.getByLabelText("Describe your vision") as HTMLTextAreaElement).value).toMatch(/fine-line fox/);
    expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe("Sam Client");
  });

  it("checkout HOLD_LOST gets its own branch with a 'Pick another time' action", async () => {
    responders = [
      bookOk,
      (url, init) =>
        url === "/api/v1/book/hold" && init?.method === "POST"
          ? json({ holdId: "hold_1", expiresAt: "2099-01-01T00:35:00.000Z", slot: SLOT_A })
          : undefined,
      (url, init) =>
        url === "/api/checkout" && init?.method === "POST"
          ? json({ error: "That time is no longer held. Pick another.", code: "HOLD_LOST" }, 409)
          : undefined,
    ];
    renderBook(RESERVATION_OFFER);

    pickSlot("14:00");
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    fillDetails();
    fireEvent.click(screen.getByRole("button", { name: "Review" }));
    fireEvent.click(screen.getByRole("button", { name: "Pay $75 deposit to hold" }));

    const action = await screen.findByRole("button", { name: "Pick another time" });
    expect(screen.getByText(/held time ran out before checkout opened/)).toBeTruthy();
    // Not the generic inline error path.
    expect(screen.queryByText("That time is no longer held. Pick another.")).toBeNull();

    fireEvent.click(action);
    expect(screen.getByText("Pick your time")).toBeTruthy();
    const taken = screen.getByRole("button", { name: /14:00/ });
    expect((taken as HTMLButtonElement).disabled).toBe(true);
    expect(within(taken).getByText("Taken")).toBeTruthy();
  });
});

describe("BookClient — resumable, releasable hold (REA gap #1)", () => {
  it("writes bookingId and the held slot into the URL after capture and hold", async () => {
    responders = [
      bookOk,
      (url, init) =>
        url === "/api/v1/book/hold" && init?.method === "POST"
          ? json({ holdId: "hold_1", expiresAt: "2099-01-01T00:35:00.000Z", slot: SLOT_A })
          : undefined,
      (url, init) =>
        url === "/api/checkout" && init?.method === "POST"
          ? json({ error: "Payments are not configured." }, 503)
          : undefined,
    ];
    renderBook(RESERVATION_OFFER);
    pickSlot("14:00");
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    fillDetails();
    fireEvent.click(screen.getByRole("button", { name: "Review" }));
    fireEvent.click(screen.getByRole("button", { name: "Pay $75 deposit to hold" }));

    await waitFor(() => expect(screen.getByRole("heading", { name: "Request sent" })).toBeTruthy());
    const url = new URL(window.location.href);
    expect(url.searchParams.get("bookingId")).toBe("BK-NEW00001");
    expect(url.searchParams.get("slot")).toBe("2099-01-10|14:00|16:00");
  });

  it("a resumed visit re-uses the booking id: no new capture, same-booking re-hold", async () => {
    responders = [
      (url, init) =>
        url === "/api/v1/book/hold" && init?.method === "POST"
          ? json({ holdId: "hold_2", expiresAt: "2099-01-01T00:35:00.000Z", slot: SLOT_A })
          : undefined,
      (url, init) =>
        url === "/api/checkout" && init?.method === "POST"
          ? json({ error: "Payments are not configured." }, 503)
          : undefined,
    ];
    renderBook(RESERVATION_OFFER, {
      bookingId: "BK-RESUME01",
      slot: SLOT_A,
      cancelledHoldId: null,
    });

    expect(screen.getByRole("status").textContent).toMatch(/Picking up where you left off/);
    // The slot came back pre-selected, so Next is already enabled.
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    fillDetails();
    fireEvent.click(screen.getByRole("button", { name: "Review" }));
    fireEvent.click(screen.getByRole("button", { name: "Pay $75 deposit to hold" }));

    await waitFor(() => expect(screen.getByRole("heading", { name: "Request sent" })).toBeTruthy());

    expect(calls.some((c) => c.url === "/api/v1/book" && c.init?.method === "POST")).toBe(false);
    const hold = calls.find((c) => c.url === "/api/v1/book/hold" && c.init?.method === "POST")!;
    expect(JSON.parse(String(hold.init?.body))).toMatchObject({
      bookingId: "BK-RESUME01",
      ...SLOT_A,
    });
    const checkout = calls.find((c) => c.url === "/api/checkout")!;
    expect(JSON.parse(String(checkout.init?.body))).toMatchObject({
      bookingId: "BK-RESUME01",
      holdId: "hold_2",
    });
    expect(screen.getByText("BK-RESUME01")).toBeTruthy();
  });

  it("a resumed slot that is no longer offered is shown as Taken, not dropped", () => {
    renderBook({ ...RESERVATION_OFFER, slots: [SLOT_B] }, {
      bookingId: "BK-RESUME01",
      slot: SLOT_A,
      cancelledHoldId: null,
    });
    expect(screen.getByText("Pick your time")).toBeTruthy();
    const taken = screen.getByRole("button", { name: /14:00/ });
    expect((taken as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByRole("status").textContent).toMatch(/no longer available/);
  });

  it("returning from Stripe's cancel page releases the named hold and scrubs the URL", async () => {
    window.history.replaceState(
      null,
      "",
      "/book?artistId=artist_1&bookingId=BK-RESUME01&cancelled=1&holdId=hold_9&slot=2099-01-10%7C14%3A00%7C16%3A00",
    );
    responders = [
      (url, init) =>
        url.startsWith("/api/v1/book/hold?holdId=hold_9") && init?.method === "DELETE"
          ? json({ released: true, holdId: "hold_9" })
          : undefined,
    ];
    renderBook(RESERVATION_OFFER, {
      bookingId: "BK-RESUME01",
      slot: SLOT_A,
      cancelledHoldId: "hold_9",
    });

    await waitFor(() =>
      expect(
        calls.some((c) => c.url === "/api/v1/book/hold?holdId=hold_9" && c.init?.method === "DELETE"),
      ).toBe(true),
    );
    expect(screen.getByRole("status").textContent).toMatch(/released your hold/);
    const url = new URL(window.location.href);
    expect(url.searchParams.get("cancelled")).toBeNull();
    expect(url.searchParams.get("holdId")).toBeNull();
    expect(url.searchParams.get("bookingId")).toBe("BK-RESUME01");
  });

  it("stepping back off the review step releases a hold this tab owns", async () => {
    responders = [
      bookOk,
      (url, init) =>
        url === "/api/v1/book/hold" && init?.method === "POST"
          ? json({ holdId: "hold_7", expiresAt: "2099-01-01T00:35:00.000Z", slot: SLOT_A })
          : undefined,
      (url, init) =>
        url.startsWith("/api/v1/book/hold?holdId=hold_7") && init?.method === "DELETE"
          ? json({ released: true, holdId: "hold_7" })
          : undefined,
      // Checkout refuses for a reason the client shows inline (stays on review).
      (url, init) =>
        url === "/api/checkout" && init?.method === "POST"
          ? json({ error: "That hold is not for this booking." }, 403)
          : undefined,
    ];
    renderBook(RESERVATION_OFFER);
    pickSlot("14:00");
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    fillDetails();
    fireEvent.click(screen.getByRole("button", { name: "Review" }));
    fireEvent.click(screen.getByRole("button", { name: "Pay $75 deposit to hold" }));

    await screen.findByText("That hold is not for this booking.");
    await waitFor(() =>
      expect(
        calls.filter((c) => c.url === "/api/v1/book/hold?holdId=hold_7" && c.init?.method === "DELETE"),
      ).toHaveLength(1),
    );
  });
});

describe("BookClient — reply-time promise (REA gap #3)", () => {
  it("the Request sent card says when the customer hears back", async () => {
    responders = [
      bookOk,
      (url, init) =>
        url === "/api/checkout" && init?.method === "POST"
          ? json({ error: "Payments are not configured." }, 503)
          : undefined,
    ];
    renderBook(REQUEST_OFFER);

    // Request mode: pick a date, then details.
    fireEvent.click(screen.getAllByRole("button", { name: /Tap to request/ })[0]);
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    fillDetails();
    fireEvent.click(screen.getByRole("button", { name: "Review" }));
    fireEvent.click(screen.getByRole("button", { name: "Pay $75 deposit to request" }));

    await waitFor(() => expect(screen.getByRole("heading", { name: "Request sent" })).toBeTruthy());
    expect(screen.getByText(/Nadia Ink replies within 48 hours/)).toBeTruthy();
  });
});
