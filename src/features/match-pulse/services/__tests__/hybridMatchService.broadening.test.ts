// @vitest-environment node
import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("@/services/vectorDbService", () => ({
  searchSimilar: vi.fn(async () => []),
}));

vi.mock("@/services/embeddingService", () => ({
  generateQueryEmbedding: vi.fn(async () => new Array(768).fill(0.1)),
}));

vi.mock("@/features/match-pulse/services/neo4jService", () => ({
  findMatchingArtists: vi.fn(async (preferences: { styles?: string[] }) => {
    const narrow = { id: "artist-narrow", name: "Narrow Match", city: "Brooklyn", styles: ["Traditional"] };
    const extras = [
      { id: "artist-extra-1", name: "Extra One", city: "Queens", styles: ["Blackwork"], heroImage: "https://img.example/extra-one.jpg" },
      { id: "artist-extra-2", name: "Extra Two", city: "Manhattan", styles: ["Fine Line"] },
    ];
    // Relaxed call (no style filter) surfaces the full roster; the
    // style-filtered call only returns the one narrow match.
    if (preferences.styles && preferences.styles.length > 0) {
      return [narrow];
    }
    return [narrow, ...extras];
  }),
  findArtistsByEmbeddingIds: vi.fn(async () => []),
  isNeo4jEnabled: vi.fn(() => true),
}));

describe("findMatchingArtists — thin-result broadening", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("keeps a thin, style-filtered primary set separate from the broadened set", async () => {
    const { findMatchingArtists } = await import("../hybridMatchService");

    const result = await findMatchingArtists(
      "traditional",
      { styles: ["Traditional"], location: null },
      10
    );

    expect(result.matches).toHaveLength(1);
    expect(result.matches[0].id).toBe("artist-narrow");

    // Broadened results are the relaxed-search extras, never mixed into `matches`.
    expect(result.broadened.length).toBeGreaterThan(0);
    expect(result.broadened.some((m) => m.id === "artist-narrow")).toBe(false);
    expect(result.broadenedReason).toBeTruthy();
  });
});

describe("findMatchingArtists — broadened items carry the primary fields (spec 14)", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("passes heroImage and the artist fields through to the broadened deck", async () => {
    const { findMatchingArtists } = await import("../hybridMatchService");
    const result = await findMatchingArtists(
      "traditional",
      { styles: ["Traditional"], location: null },
      10
    );
    const extra = result.broadened.find((m) => m.id === "artist-extra-1");
    expect(extra).toBeTruthy();
    expect(extra!.heroImage).toBe("https://img.example/extra-one.jpg");
    expect(extra!.name).toBe("Extra One");
    expect(extra!.city).toBe("Queens");
    expect(typeof extra!.score).toBe("number");
    expect(Array.isArray(extra!.reasons)).toBe(true);
  });
});

describe("findMatchingArtists — portfolio and rate filters are relaxable (spec 15)", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("broadens a thin result caused by has_portfolio or budget and names what was relaxed", async () => {
    const neo4j = await import("@/features/match-pulse/services/neo4jService");
    vi.mocked(neo4j.findMatchingArtists).mockImplementation(async (preferences) => {
      const narrow = { id: "artist-narrow", name: "Narrow Match", city: "Brooklyn", styles: ["Traditional"] };
      const extra = { id: "artist-extra-1", name: "Extra One", city: "Queens", styles: ["Blackwork"] };
      if (preferences.hasPortfolio || preferences.budget) return [narrow];
      return [narrow, extra];
    });
    const { findMatchingArtists } = await import("../hybridMatchService");

    const result = await findMatchingArtists(
      "tattoo artist",
      { styles: [], location: null, hasPortfolio: true, budget: 150 },
      10
    );
    expect(result.matches.map((m) => m.id)).toEqual(["artist-narrow"]);
    expect(result.broadened.map((m) => m.id)).toEqual(["artist-extra-1"]);
    expect(result.broadenedReason).toContain("relaxed: portfolio, rate");
  });
});
