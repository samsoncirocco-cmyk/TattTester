// @vitest-environment jsdom
//
// Spec 4: the profile's booking module names the deposit floor and carries
// the money sentence for bookable artists; intro-only artists get neither.
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";

const { mockedQuery } = vi.hoisted(() => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  mockedQuery: vi.fn(async () => [] as any[]),
}));
vi.mock("@/features/match-pulse/services/neo4jService", () => ({
  executeServerCypherQuery: mockedQuery,
  executeServerCypherQueryOrThrow: mockedQuery,
}));

// The profile now reads cached Firestore hints (next opening, artist extras);
// with only a project id configured that would try a real network call.
vi.mock("@/lib/firebase-admin", () => ({ ensureAdminApp: () => false }));

import ArtistProfilePage from "./page";

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

afterEach(() => mockedQuery.mockReset());

describe("profile booking CTA (spec 4)", () => {
  it("bookable: CTA names the deposit floor and the claimed money sentence sits beside it", async () => {
    const view = await renderProfile(graphRow({ claimedByUid: "uid_9" }));
    expect(view.getByRole("link", { name: "Book the chair — deposit from $75" })).toBeTruthy();
    const sentence = view.getByTestId("profile-money-sentence").textContent ?? "";
    expect(sentence).toMatch(/plus a 10% booking fee/);
    expect(sentence).toMatch(/keeps 100% of the deposit/);
    expect(sentence).toMatch(/only part TattTester keeps/);
  });

  it("intro-only: no deposit line, no money sentence, and 'No deposit is taken'", async () => {
    const view = await renderProfile(graphRow());
    expect(view.queryByText(/deposit from/)).toBeNull();
    expect(view.queryByTestId("profile-money-sentence")).toBeNull();
    expect(view.getByText(/No deposit is taken/)).toBeTruthy();
    expect(view.queryByTestId("profile-next-opening")).toBeNull();
  });
});
