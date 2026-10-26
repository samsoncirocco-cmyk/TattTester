// @vitest-environment jsdom
//
// Spec 4 on /book: the zone line, the "your time" conversion, the header
// facts and the CTA that names the amount.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import BookClient, { type BookArtist, type BookOffer } from "./BookClient";
import { artistZoneSentence, yourTimeLabel } from "./BookTimezone";

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
const SLOT = {
  date: "2099-01-10",
  startTime: "14:00",
  endTime: "16:00",
  startsAt: "2099-01-10T14:00:00-07:00",
  endsAt: "2099-01-10T16:00:00-07:00",
};
const OFFER: BookOffer = {
  mode: "reservation",
  label: "Live calendar",
  detail: "From the artist's calendar.",
  slots: [SLOT],
  timezone: "America/Phoenix",
  nextOpeningAt: SLOT.startsAt,
};

function renderBook(offer: BookOffer) {
  return render(
    <BookClient
      artist={ARTIST}
      requestedArtistId="artist_1"
      artistLoadFailed={false}
      offer={offer}
      feePercent={10}
      holdDays={7}
    />,
  );
}

beforeEach(() => {
  window.history.replaceState(null, "", "/book?artistId=artist_1");
});

describe("artistZoneSentence", () => {
  const now = Date.parse("2099-01-10T00:47:00Z"); // 5:47 pm in Phoenix
  it("names the city, the zone and the artist's current time", () => {
    expect(artistZoneSentence("America/Phoenix", "Phoenix, AZ", now)).toBe(
      "Times are in Phoenix time (MST). It's 5:47 pm there now.",
    );
  });
  it("does not guess when the zone is missing", () => {
    expect(artistZoneSentence(undefined, "Phoenix, AZ", now)).toBe("Times are in the artist's local time.");
  });
});

describe("yourTimeLabel", () => {
  it("converts only when the customer's clock differs", () => {
    expect(yourTimeLabel(SLOT, "America/Phoenix")).toBeNull();
    expect(yourTimeLabel(SLOT, "America/New_York")).toBe("4:00 pm your time");
    expect(yourTimeLabel(SLOT, "Pacific/Auckland")).toMatch(/^\w{3}, Jan 11, 10:00 am your time$/);
  });
  it("says nothing without an instant", () => {
    expect(yourTimeLabel({ date: SLOT.date, startTime: SLOT.startTime }, "America/New_York")).toBeNull();
  });
});

describe("/book header and CTA (spec 4)", () => {
  it("shows the zone line, ladder, next opening and the fee sentence", () => {
    renderBook(OFFER);
    expect(screen.getByTestId("artist-zone-line").textContent).toMatch(/^Times are in Phoenix time \(MST\)\. It's .+ there now\.$/);
    const facts = screen.getByTestId("booking-header-facts").textContent ?? "";
    expect(facts).toMatch(/\$75 small · \$150 medium · \$300 large · \$500 sleeve/);
    expect(facts).toMatch(/Next opening \w{3}, Jan 10/);
    expect(facts).toMatch(/You pay the deposit plus a 10% booking fee\. The artist keeps 100% of the deposit; the booking fee is the only part TattTester keeps\./);
    // Slot buttons keep their plain wall-clock text.
    expect(screen.getByRole("button", { name: "14:00" })).toBeTruthy();
  });

  it("the review CTA names the deposit for the chosen size", () => {
    renderBook(OFFER);
    fireEvent.click(screen.getByRole("button", { name: "14:00" }));
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    fireEvent.click(screen.getByRole("button", { name: /^Medium/ }));
    fireEvent.click(screen.getByRole("button", { name: "Forearm" }));
    fireEvent.change(screen.getByLabelText("Describe your vision"), {
      target: { value: "A fine-line fox curled around my forearm." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Under $300" }));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Sam" } });
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "sam@example.com" } });
    fireEvent.click(screen.getByRole("button", { name: "Review" }));
    expect(screen.getByRole("button", { name: "Pay $150 deposit to hold" })).toBeTruthy();
    expect(screen.getByText(/14:00 MST/)).toBeTruthy();
  });

  it("request mode: no next opening, CTA says request", () => {
    renderBook({ mode: "request", label: "On request", detail: "Pick dates.", slots: [], timezone: "America/Phoenix" });
    expect(screen.getByTestId("booking-header-facts").textContent).not.toMatch(/Next opening/);
    expect(screen.queryByTestId("artist-zone-line")).toBeNull();
    expect(screen.getByText(/in Phoenix time \(MST\)/)).toBeTruthy();
  });
});
