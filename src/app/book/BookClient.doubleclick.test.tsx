// @vitest-environment jsdom
//
// Spec 5 (specs/rea-gaps/05-idempotency-keys-and-in-flight-guard.md): a
// double-click on the review CTA makes one booking, and every call in one
// submit attempt carries the same Idempotency-Key.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import BookClient, { type BookArtist, type BookOffer } from "./BookClient";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/book",
}));
vi.mock("@/components/studio/StudioShell", () => ({
  default: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock("@/lib/client-api-auth", () => ({
  getApiAuthHeaders: vi.fn(async () => ({ Authorization: "Bearer test-token" })),
}));
vi.mock("@/lib/tattStorage", () => ({
  useBookings: () => ({ addBooking: vi.fn() }),
  useDesigns: () => ({ designs: [] }),
}));

const ARTIST: BookArtist = {
  id: "artist_1",
  slug: "nadia-ink",
  name: "Nadia Ink",
  location: "Phoenix, AZ",
  shopName: null,
  styles: [],
  availabilityStatus: "open",
  availabilityLabel: "Taking bookings",
  availabilityNote: null,
  claimed: true,
};
const SLOT = { date: "2099-01-10", startTime: "14:00", endTime: "16:00" };
const OFFER: BookOffer = {
  mode: "reservation",
  label: "Live calendar",
  detail: "From the artist's calendar.",
  slots: [SLOT],
  timezone: "America/Phoenix",
};

type Call = { url: string; init?: RequestInit };
let calls: Call[];
let releaseBook: (() => void) | null;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function header(init: RequestInit | undefined, name: string): string | undefined {
  const h = (init?.headers ?? {}) as Record<string, string>;
  return h[name];
}

function walkToReview() {
  fireEvent.click(screen.getByRole("button", { name: "14:00" }));
  fireEvent.click(screen.getByRole("button", { name: "Next" }));
  fireEvent.click(screen.getByRole("button", { name: /^Small/ }));
  fireEvent.click(screen.getByRole("button", { name: "Forearm" }));
  fireEvent.change(screen.getByLabelText("Describe your vision"), {
    target: { value: "A fine-line fox curled around my forearm." },
  });
  fireEvent.click(screen.getByRole("button", { name: "Under $300" }));
  fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Sam" } });
  fireEvent.change(screen.getByLabelText("Email"), { target: { value: "sam@example.com" } });
  fireEvent.click(screen.getByRole("button", { name: "Review" }));
}

beforeEach(() => {
  calls = [];
  releaseBook = null;
  window.history.replaceState(null, "", "/book?artistId=artist_1");
});

describe("BookClient — in-flight guard and idempotency key (spec 5)", () => {
  it("two synchronous clicks produce one /api/v1/book call", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        calls.push({ url, init });
        if (url === "/api/v1/book") {
          // Hold the capture open so the second click lands mid-flight.
          await new Promise<void>((resolve) => {
            releaseBook = resolve;
          });
          return json({ success: true, bookingId: "BK-ONE00001" });
        }
        if (url === "/api/v1/book/hold") {
          return json({ holdId: "hold_1", expiresAt: "2099-01-01T00:35:00.000Z", slot: SLOT });
        }
        if (url === "/api/checkout") return json({ error: "Payments are not configured." }, 503);
        throw new Error(`unexpected ${url}`);
      }),
    );
    render(
      <BookClient
        artist={ARTIST}
        requestedArtistId="artist_1"
        artistLoadFailed={false}
        offer={OFFER}
        feePercent={10}
        holdDays={7}
      />,
    );
    walkToReview();
    const cta = screen.getByRole("button", { name: "Hold time & continue" });
    // Same tick: React has not re-rendered the disabled state between these.
    fireEvent.click(cta);
    fireEvent.click(cta);

    await waitFor(() => expect(releaseBook).not.toBeNull());
    releaseBook!();
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: "Request sent" })).toBeTruthy(),
    );

    expect(calls.filter((c) => c.url === "/api/v1/book")).toHaveLength(1);
    expect(calls.filter((c) => c.url === "/api/v1/book/hold")).toHaveLength(1);
    expect(calls.filter((c) => c.url === "/api/checkout")).toHaveLength(1);

    // One attempt, one key, on all three calls.
    const keys = calls
      .filter((c) => c.init?.method === "POST")
      .map((c) => header(c.init, "Idempotency-Key"));
    expect(keys[0]).toBeTruthy();
    expect(new Set(keys).size).toBe(1);
  });

  it("REQUEST_IN_FLIGHT shows the quiet busy copy and does not mark the slot taken", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        calls.push({ url, init });
        if (url === "/api/v1/book") return json({ success: true, bookingId: "BK-ONE00001" });
        if (url === "/api/v1/book/hold") {
          return json({ error: "Still working on that one. Give it a moment.", code: "REQUEST_IN_FLIGHT" }, 409);
        }
        throw new Error(`unexpected ${url}`);
      }),
    );
    render(
      <BookClient
        artist={ARTIST}
        requestedArtistId="artist_1"
        artistLoadFailed={false}
        offer={OFFER}
        feePercent={10}
        holdDays={7}
      />,
    );
    walkToReview();
    fireEvent.click(screen.getByRole("button", { name: "Hold time & continue" }));
    await screen.findByText("Still working on that one. Give it a moment.");
    // Still on review, not bounced to the time step with a "Taken" slot.
    expect(screen.queryByText("Taken")).toBeNull();
    expect(screen.getByRole("button", { name: "Hold time & continue" })).toBeTruthy();
  });
});
