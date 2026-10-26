// @vitest-environment jsdom
//
// Spec 16: "Before you book" renders the artist's own words above the booking
// module on a claimed profile — and nothing at all on an unclaimed one, even
// when stale extras are sitting in the store.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";

const { mockedQuery, extrasGetMock } = vi.hoisted(() => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  mockedQuery: vi.fn(async () => [] as any[]),
  extrasGetMock: vi.fn(),
}));
vi.mock("@/features/match-pulse/services/neo4jService", () => ({
  executeServerCypherQuery: mockedQuery,
  executeServerCypherQueryOrThrow: mockedQuery,
}));
vi.mock("@/lib/firebase-admin", () => ({ ensureAdminApp: () => "sa-json" }));
vi.mock("firebase-admin/firestore", () => ({
  getFirestore: () => ({
    collection: (name: string) => ({
      doc: (id: string) => ({
        get: async () => {
          if (name !== "artist_profile_extras") return { exists: false, data: () => undefined };
          return extrasGetMock(id);
        },
      }),
    }),
    getAll: async () => [],
  }),
}));

import ArtistProfilePage from "../page";
import BeforeYouBook from "../BeforeYouBook";

const STORED = {
  policies: { deposit: "The deposit comes off your final price.", cancellation: "Give me 48 hours to move a session." },
  faqs: [
    { q: "Do you do cover-ups?", a: "Sometimes. Send a photo." },
    { q: "Hands?", a: "Yes." },
    { q: "Colour?", a: "Black and grey only." },
    { q: "Walk-ins?", a: "Fridays." },
  ],
  travelDates: [
    { city: "Old Town", startsOn: "2000-01-01", endsOn: "2000-01-03", kind: "travel" },
    { city: "Austin", region: "TX", startsOn: "2099-03-04", endsOn: "2099-03-09", kind: "guest_spot" },
  ],
};

function graphRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "artist_1",
    name: "Sam Ink",
    shopName: "Ink Shop",
    city: "Austin",
    state: "TX",
    styles: ["Blackwork"],
    instagram: "@sam.ink",
    rating: null,
    reviewCount: null,
    portfolioImages: [],
    portfolioPermalinks: [],
    claimedByUid: null,
    ...overrides,
  };
}

async function renderProfile(row: Record<string, unknown>) {
  mockedQuery.mockResolvedValue([row]);
  const jsx = await ArtistProfilePage({ params: Promise.resolve({ slug: "sam-ink-artist_1" }) });
  return render(jsx);
}

beforeEach(() => {
  extrasGetMock.mockResolvedValue({ exists: true, data: () => STORED });
});
afterEach(() => {
  mockedQuery.mockReset();
  extrasGetMock.mockReset();
});

describe("Before you book (spec 16)", () => {
  it("claimed + filled: renders above the booking module, attributed to the artist", async () => {
    const view = await renderProfile(graphRow({ claimedByUid: "uid_9" }));
    const block = view.getByTestId("before-you-book");
    expect(block.textContent).toMatch(/Before you book/);
    expect(block.textContent).toMatch(/deposit comes off your final price/);
    expect(block.textContent).toMatch(/TattTester's refund rules apply where they differ/);
    expect(block.textContent).toMatch(/Written by Sam Ink\./);
    // Directly before the booking module in document order.
    const cta = view.getByRole("link", { name: /Book the chair/ });
    expect(block.compareDocumentPosition(cta) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // Past travel hidden, future shown.
    expect(block.textContent).not.toMatch(/Old Town/);
    expect(block.textContent).toMatch(/Austin, TX · Mar 4 – Mar 9/);
    // Fourth FAQ is folded but still in the DOM.
    expect(block.querySelector("details")?.textContent).toMatch(/Walk-ins\?/);
  });

  it("claimed + empty: renders nothing", async () => {
    extrasGetMock.mockResolvedValue({ exists: false, data: () => undefined });
    const view = await renderProfile(graphRow({ claimedByUid: "uid_9" }));
    expect(view.queryByTestId("before-you-book")).toBeNull();
  });

  it("unclaimed: renders nothing and never reads the stored extras, even stale ones", async () => {
    const view = await renderProfile(graphRow());
    expect(view.queryByTestId("before-you-book")).toBeNull();
    expect(view.queryByText(/deposit comes off your final price/)).toBeNull();
    expect(extrasGetMock).not.toHaveBeenCalled();
  });

  it("an in-progress trip reads 'In {city} until {date}'", () => {
    const view = render(
      <BeforeYouBook
        artistName="Sam Ink"
        extras={{
          policies: {},
          faqs: [],
          travelDates: [{ city: "Denver", startsOn: "2099-01-08", endsOn: "2099-01-12", kind: "convention" }],
        }}
        nowMs={Date.parse("2099-01-10T12:00:00Z")}
      />,
    );
    expect(view.getByTestId("before-you-book").textContent).toMatch(/In Denver until Jan 12/);
  });
});
