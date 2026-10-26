// @vitest-environment jsdom
//
// Spec 6 on /book: refetch on window focus, and a slot check when the review
// step opens that catches a time taken while the customer filled the form.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, act, within } from "@testing-library/react";
import BookClient, { type BookArtist, type BookOffer } from "./BookClient";
import { offerFromAvailability } from "./useLiveAvailability";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/book",
}));
vi.mock("@/components/studio/StudioShell", () => ({
  default: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock("@/lib/client-api-auth", () => ({
  getApiAuthHeaders: vi.fn(async () => ({})),
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
const A = { date: "2099-01-10", startTime: "14:00", endTime: "16:00", startsAt: "2099-01-10T14:00:00-07:00", endsAt: "2099-01-10T16:00:00-07:00" };
const B = { date: "2099-01-10", startTime: "17:00", endTime: "19:00", startsAt: "2099-01-10T17:00:00-07:00", endsAt: "2099-01-10T19:00:00-07:00" };
const OFFER: BookOffer = {
  mode: "reservation",
  label: "Live calendar",
  detail: "From the artist's calendar.",
  slots: [A, B],
  timezone: "America/Phoenix",
};

function availability(slots: typeof A[], mode: "reservation" | "request" = "reservation") {
  const days = new Map<string, Array<Record<string, string>>>();
  for (const s of slots) {
    const spot = { startTime: s.startTime, endTime: s.endTime, startsAt: s.startsAt, endsAt: s.endsAt };
    days.set(s.date, [...(days.get(s.date) ?? []), spot]);
  }
  return {
    mode,
    label: "Live calendar",
    detail: "From the artist's calendar.",
    timezone: "America/Phoenix",
    days: [...days.entries()].map(([date, spots]) => ({ date, spots })),
    nextOpeningAt: slots[0]?.startsAt ?? null,
  };
}

let current: ReturnType<typeof availability>;
let urls: string[];

beforeEach(() => {
  urls = [];
  current = availability([A, B]);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      urls.push(url);
      if (url.startsWith("/api/v1/artists/artist_1/availability")) {
        return new Response(JSON.stringify(current), { status: 200, headers: { "content-type": "application/json" } });
      }
      throw new Error(`unexpected ${url}`);
    }),
  );
  window.history.replaceState(null, "", "/book?artistId=artist_1");
});

function renderBook(offer: BookOffer = OFFER) {
  return render(
    <BookClient artist={ARTIST} requestedArtistId="artist_1" artistLoadFailed={false} offer={offer} feePercent={10} holdDays={7} />,
  );
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

describe("BookClient live availability (spec 6)", () => {
  it("review step checks the slot: still free → stays on review", async () => {
    renderBook();
    walkToReview();
    await waitFor(() => expect(urls.some((u) => u.includes("/availability"))).toBe(true));
    expect(urls[0]).toMatch(/tz=/);
    expect(screen.getByRole("button", { name: "Pay $75 deposit to hold" })).toBeTruthy();
  });

  it("review step checks the slot: gone → back to times, marked Taken, details kept", async () => {
    current = availability([B]);
    renderBook();
    walkToReview();
    await screen.findByText(/That time is no longer available/);
    const taken = screen.getByRole("button", { name: /14:00/ });
    expect((taken as HTMLButtonElement).disabled).toBe(true);
    expect(within(taken).getByText("Taken")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "17:00" }));
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe("Sam");
  });

  it("refetches on window focus and drops a time that went", async () => {
    renderBook();
    current = availability([A]);
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    await waitFor(() => expect(urls.length).toBe(1));
    await waitFor(() => expect(screen.queryByRole("button", { name: "17:00" })).toBeNull());
    expect(screen.getByRole("button", { name: "14:00" })).toBeTruthy();
  });

  it("calendar no longer live → says so and drops to requests", async () => {
    current = availability([], "request");
    renderBook();
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    await screen.findByText(/Live times for this artist aren't available right now/);
    expect(screen.getByText("Request your dates")).toBeTruthy();
  });

  it("request-mode pages never poll", async () => {
    renderBook({ mode: "request", label: "On request", detail: "d", slots: [] });
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    expect(urls).toHaveLength(0);
  });
});

describe("offerFromAvailability", () => {
  it("maps the response to the page's offer shape", () => {
    expect(offerFromAvailability(availability([A]) as Parameters<typeof offerFromAvailability>[0], OFFER)).toMatchObject({
      mode: "reservation",
      slots: [A],
      timezone: "America/Phoenix",
      nextOpeningAt: A.startsAt,
    });
    expect(offerFromAvailability({ mode: undefined } as never, OFFER)).toBeNull();
  });
});
