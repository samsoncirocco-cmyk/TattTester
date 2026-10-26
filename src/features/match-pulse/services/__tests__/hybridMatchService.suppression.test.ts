// @vitest-environment node
/**
 * #398: vector search does not know about takedown or staleness. A hit that
 * findArtistsByEmbeddingIds does not return must not survive the merge,
 * including as a vector-only card and including in the broadened set.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { searchSimilar, findGraphArtists, findArtistsByEmbeddingIds } = vi.hoisted(() => ({
  searchSimilar: vi.fn(),
  findGraphArtists: vi.fn(),
  findArtistsByEmbeddingIds: vi.fn(),
}));

vi.mock("@/services/vectorDbService", () => ({
  searchSimilar,
}));

vi.mock("@/services/embeddingService", () => ({
  generateQueryEmbedding: vi.fn(async () => new Array(768).fill(0.1)),
}));

vi.mock("@/features/match-pulse/services/neo4jService", () => ({
  findMatchingArtists: findGraphArtists,
  findArtistsByEmbeddingIds,
  isNeo4jEnabled: vi.fn(() => true),
}));

const PUBLIC = {
  id: "artist-public",
  embedding_id: "artist_public",
  name: "Public Artist",
  city: "Austin",
  styles: ["Traditional"],
};

describe("findMatchingArtists — vector hits pass the public-artist gate (#398)", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.spyOn(Math, "random").mockReturnValue(0);
    searchSimilar.mockResolvedValue([
      { id: "artist_public", score: 0.91 },
      { id: "artist_removed", score: 0.99 },
    ]);
    findArtistsByEmbeddingIds.mockImplementation(async (ids: string[]) => {
      return ids.includes("artist_public") ? [PUBLIC] : [];
    });
    findGraphArtists.mockResolvedValue([]);
  });

  it("drops a vector-only hit the gate does not return and hydrates the one it does", async () => {
    const { findMatchingArtists } = await import("../hybridMatchService");

    const result = await findMatchingArtists("traditional dagger", {}, 10);

    expect(result.matches.map((match) => match.id)).toEqual(["artist-public"]);
    expect(result.matches[0]).toMatchObject({
      name: "Public Artist",
      city: "Austin",
      visualSimilarity: 0.91,
    });
    expect(JSON.stringify(result)).not.toContain("artist_removed");
    expect(findArtistsByEmbeddingIds).toHaveBeenCalledWith(
      expect.arrayContaining(["artist_public", "artist_removed"])
    );
  });

  it("does not let a suppressed vector hit back in through broadening", async () => {
    findGraphArtists.mockImplementation(async (preferences: { styles?: string[] }) => {
      if (preferences.styles && preferences.styles.length > 0) {
        return [{ id: "artist-narrow", name: "Narrow", city: "Austin", styles: ["Traditional"] }];
      }
      return [
        { id: "artist-narrow", name: "Narrow", city: "Austin", styles: ["Traditional"] },
        { id: "artist-extra", name: "Extra", city: "Dallas", styles: ["Blackwork"] },
      ];
    });

    const { findMatchingArtists } = await import("../hybridMatchService");
    const result = await findMatchingArtists(
      "traditional",
      { styles: ["Traditional"], location: "Austin" },
      10
    );

    const broadenedIds = result.broadened.map((match) => String(match.id));
    expect(broadenedIds).not.toContain("artist_removed");
    expect(broadenedIds).not.toContain("artist_public");
    expect(result.matches.map((match) => match.id)).not.toContain("artist_removed");
  });

  it("fails closed when the gate throws, instead of publishing the raw vector rows", async () => {
    findArtistsByEmbeddingIds.mockRejectedValue(new Error("neo4j down"));
    const { findMatchingArtists } = await import("../hybridMatchService");

    const result = await findMatchingArtists("traditional dagger", {}, 10);

    expect(result.matches).toEqual([]);
    expect(result.queryInfo.degraded).toBe(true);
    expect(result.queryInfo.vectorResultCount).toBe(0);
  });
});
