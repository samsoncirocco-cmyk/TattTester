// @vitest-environment node
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

vi.mock("@/services/vectorDbService", () => ({
  searchSimilar: vi.fn(async () => []),
}));

vi.mock("@/services/embeddingService", () => ({
  generateQueryEmbedding: vi.fn(async () => new Array(768).fill(0.1)),
}));

vi.mock("@/features/match-pulse/services/neo4jService", () => ({
  findMatchingArtists: vi.fn(async () => [
    { id: "artist-low-rated", name: "Low Rated", city: "Brooklyn", styles: ["Traditional"], rating: 2 },
    { id: "artist-high-rated", name: "High Rated", city: "Brooklyn", styles: ["Traditional"], rating: 5 },
    { id: "artist-unrated", name: "Unrated", city: "Brooklyn", styles: ["Traditional"] },
  ]),
  findArtistsByEmbeddingIds: vi.fn(async () => []),
  isNeo4jEnabled: vi.fn(() => true),
}));

describe("findMatchingArtists — rating signal", () => {
  beforeEach(() => {
    vi.resetModules();
    // Neutralize the randomVariety signal so ranking order is deterministic —
    // this test is about the rating weight, not the random-variety weight.
    vi.spyOn(Math, "random").mockReturnValue(0);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("ranks a higher-rated artist above an otherwise-identical lower-rated one", async () => {
    const { findMatchingArtists } = await import("../hybridMatchService");

    const result = await findMatchingArtists("traditional", { styles: ["Traditional"] }, 10);

    const highIndex = result.matches.findIndex((m) => m.id === "artist-high-rated");
    const lowIndex = result.matches.findIndex((m) => m.id === "artist-low-rated");
    const unratedIndex = result.matches.findIndex((m) => m.id === "artist-unrated");

    expect(highIndex).toBeGreaterThanOrEqual(0);
    expect(lowIndex).toBeGreaterThanOrEqual(0);
    expect(highIndex).toBeLessThan(lowIndex);

    // An unrated artist scores neutrally (0.5) — between low and high rated,
    // never penalized just for lacking a published rating.
    expect(unratedIndex).toBeGreaterThan(highIndex);
    expect(unratedIndex).toBeLessThan(lowIndex);
  });
});

// Spec 15: the pills send `hasPortfolio` and `budget`; both must reach the
// graph query. `distance` is accepted by the route but measured by nothing —
// this test documents that and fails the day radius starts working, so the
// docs and the UI get updated together.
describe("findMatchingArtists — preference passthrough (spec 15)", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.spyOn(Math, "random").mockReturnValue(0);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("hands hasPortfolio and budget to the graph call and ignores distance", async () => {
    const neo4j = await import("@/features/match-pulse/services/neo4jService");
    const { findMatchingArtists } = await import("../hybridMatchService");

    await findMatchingArtists(
      "traditional sleeve",
      { styles: ["Traditional"], hasPortfolio: true, budget: 250, distance: 10 },
      10
    );

    // The first call is the primary (unrelaxed) one; a thin mock result
    // triggers a relaxed follow-up with keywords only.
    const graphCall = vi.mocked(neo4j.findMatchingArtists).mock.calls[0][0];
    expect(graphCall.hasPortfolio).toBe(true);
    expect(graphCall.budget).toBe(250);
    // `distance` rides along in the preferences object but nothing reads it:
    // the Cypher has no distance or radius parameter. When it gains one,
    // this assertion fails and the radius pill (spec 15 §4.2) can ship.
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const cypherSource = readFileSync(
      resolve(process.cwd(), "src/features/match-pulse/services/neo4jService.ts"),
      "utf8"
    );
    expect(cypherSource).not.toMatch(/\$distance|\$radius|point\.distance/);
  });
});
