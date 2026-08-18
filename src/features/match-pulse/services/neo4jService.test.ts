// @vitest-environment node
// Node, not jsdom: the #362 regression below must exercise the server-side
// driver path (typeof window === "undefined"), not the browser fetch proxy.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildHasPortfolioClause, buildNotRemovedClause } from "./neo4jService";

// Matching is the widest artist read surface in the app, and unlike the roster
// it has no shared WHERE builder — each query site was written separately. A
// taken-down artist that still surfaces in match results has not been taken
// down. See docs/adr/0025.
describe("buildNotRemovedClause", () => {
  it("gates on removedAt", () => {
    expect(buildNotRemovedClause()).toBe("a.removedAt IS NULL");
  });

  it("is applied at every :Artist read site in the module", () => {
    const source = readFileSync(
      resolve(process.cwd(), "src/features/match-pulse/services/neo4jService.ts"),
      "utf8",
    );
    const lines = source.split("\n");

    // Every read binding an artist as `a` must interpolate the guard within the
    // query that follows. Checked per site rather than by counting, so a query
    // added later without the guard names itself here instead of silently
    // leaking a removed artist into match results.
    const siteLines: number[] = [];
    lines.forEach((line, i) => {
      if (/MATCH \(a:Artist[\s)]/.test(line)) siteLines.push(i);
    });

    const unguarded: string[] = [];
    siteLines.forEach((start, n) => {
      // Each site's query ends where the next one begins — otherwise the
      // embedding_id writer's SET leaks backwards and wrongly exempts the
      // query above it (which is exactly how this test first passed while
      // findArtistsByEmbeddingIds was unguarded).
      const end = siteLines[n + 1] ?? lines.length;
      const query = lines.slice(start, end).join("\n");

      // The one legitimate exception: a writer stamping embedding_id onto a
      // node by id. It returns nothing to a caller.
      if (/SET a\.embedding_id/.test(query)) return;
      if (!query.includes("${NOT_REMOVED}")) {
        unguarded.push(`line ${start + 1}: ${lines[start].trim()}`);
      }
    });

    expect(siteLines.length).toBeGreaterThan(3);
    expect(unguarded).toEqual([]);
  });

  it("uses the public predicate, so stale handles cannot reach match results", () => {
    const source = readFileSync(
      resolve(process.cwd(), "src/features/match-pulse/services/neo4jService.ts"),
      "utf8",
    );
    expect(source).toContain("const NOT_REMOVED = PUBLIC_ARTIST_CLAUSE");
  });
});

describe("buildHasPortfolioClause", () => {
  it("gates on the real hosted portfolioImages array, never the stale count", () => {
    const clause = buildHasPortfolioClause();
    expect(clause).toContain("a.portfolioImages IS NOT NULL");
    expect(clause).toContain("size(a.portfolioImages) > 0");
    expect(clause).not.toContain("portfolioImageCount");
  });

  it("still allows legacy demo-data Tattoo-node portfolios through", () => {
    expect(buildHasPortfolioClause()).toContain("size(portfolio) > 0");
  });
});

// Regression for #362: /api/v1/match/update (findArtistMatchesForPulse)
// compared style names literally — toLower(s) = toLower($style) — so the
// canonical "Japanese" pill scored zero against artists tagged with the alias
// spelling "Japanese (Irezumi)", while findMatchingArtists on identical input
// resolved correctly through styleMatchVariants. The live graph was migrated
// off the alias spellings, but scrapes can reintroduce them, so both matching
// paths must stay vocabulary-aware.
describe("findArtistMatchesForPulse style variants (#362)", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.resetModules();
    vi.doUnmock("@/lib/neo4j");
  });

  async function capturePulseQuery(style: string) {
    vi.resetModules();
    process.env.NEXT_PUBLIC_DEMO_MODE = "false";
    process.env.NEXT_PUBLIC_NEO4J_ENABLED = "true";

    const captured: { query: string; params: { styleVariants?: string[] } } = {
      query: "",
      params: {},
    };
    type FakeTx = {
      run: (query: string, params: Record<string, unknown>) => { records: [] };
    };
    vi.doMock("@/lib/neo4j", () => ({
      NEO4J_DATABASE: undefined,
      NEO4J_QUERY_TIMEOUT: 5000,
      getNeo4jDriver: () => ({
        session: () => ({
          executeRead: async (work: (tx: FakeTx) => unknown) =>
            work({
              run: (query, params) => {
                captured.query = query;
                captured.params = params as { styleVariants?: string[] };
                return { records: [] };
              },
            }),
          close: async () => {},
        }),
      }),
    }));

    const { findArtistMatchesForPulse } = await import("./neo4jService");
    const results = await findArtistMatchesForPulse({ style });
    return { captured, results };
  }

  it('canonical "Japanese" matches an artist tagged "Japanese (Irezumi)"', async () => {
    const { captured } = await capturePulseQuery("Japanese");

    // The query must filter and score through the variant groups, never a
    // literal comparison against the raw $style string.
    expect(captured.query).toContain("toLower(s) IN $styleVariants");
    expect(captured.query).not.toContain("toLower($style)");

    // The exact predicate the Cypher evaluates — membership of the artist's
    // lowercase style name in $styleVariants — must accept the alias spelling
    // a scrape could reintroduce.
    const artistStyles = ["Japanese (Irezumi)"];
    const matched = artistStyles.some((s) =>
      (captured.params.styleVariants ?? []).includes(s.toLowerCase()),
    );
    expect(matched).toBe(true);
  });

  it("a style outside the vocabulary matches nothing, not everything", async () => {
    const { captured, results } = await capturePulseQuery(
      "Definitely Not A Real Style",
    );

    // Same honesty rule findMatchingArtists enforces: unknown styles return
    // no matches without ever reaching the graph as an empty (= unfiltered)
    // variant list.
    expect(results).toEqual([]);
    expect(captured.query).toBe("");
  });
});

describe("findMatchingArtists (demo mode)", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.resetModules();
  });

  it("never pads a narrow filter back out to the full mock roster", async () => {
    vi.resetModules();
    process.env.NEXT_PUBLIC_DEMO_MODE = "true";
    process.env.NEXT_PUBLIC_NEO4J_ENABLED = "false";

    const { findMatchingArtists } = await import("./neo4jService");

    // A style/location combo no mock artist satisfies must come back thin
    // (or empty) — never silently swapped for the entire mock roster.
    const results = await findMatchingArtists({
      styles: ["Definitely Not A Real Style"],
    });

    expect(results.length).toBe(0);
  });
});
