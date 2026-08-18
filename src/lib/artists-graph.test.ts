import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ROSTER_PAGE_SIZE,
  buildRosterFilter,
  getRosterArtistById,
  instagramUrl,
  rosterPageWindow,
  toRosterArtist,
} from "./artists-graph";
import { IG_PERMALINK_CYPHER } from "./portfolio-display";

const mockedQuery = vi.hoisted(() => vi.fn(async () => [] as unknown[]));
vi.mock("@/features/match-pulse/services/neo4jService", () => ({
  executeServerCypherQuery: mockedQuery,
  executeServerCypherQueryOrThrow: mockedQuery,
}));

describe("buildRosterFilter", () => {
  it("nulls out empty filters so the WHERE clause passes everything", () => {
    expect(buildRosterFilter({}).params).toEqual({
      q: null,
      styleVariants: [],
      hasPortfolio: false,
      igPermalinkPattern: IG_PERMALINK_CYPHER,
    });
    expect(buildRosterFilter({ q: "  ", style: "" }).params).toEqual({
      q: null,
      styleVariants: [],
      hasPortfolio: false,
      igPermalinkPattern: IG_PERMALINK_CYPHER,
    });
  });

  it("trims and forwards active filters as parameters, never inline", () => {
    const { where, params } = buildRosterFilter({
      q: " austin ",
      style: "Blackwork",
    });
    expect(params.q).toBe("austin");
    expect(params.hasPortfolio).toBe(false);
    // The style reaches Cypher as its spelling group, not as a bare name.
    expect(params.styleVariants).toContain("blackwork");
    // Values must reach Cypher only via $params (no string interpolation).
    expect(where).not.toContain("austin");
    expect(where).not.toContain("Blackwork");
    expect(where).toContain("$q");
    expect(where).toContain("$styleVariants");
  });

  // A takedown that the roster ignores is cosmetic. Every roster read must be
  // gated on removedAt — see docs/adr/0025.
  it("suppresses taken-down artists unconditionally, whatever the filters", () => {
    for (const filter of [
      {},
      { q: "austin" },
      { style: "Blackwork" },
      { hasPortfolio: true },
    ]) {
      expect(buildRosterFilter(filter).where).toContain("a.removedAt IS NULL");
    }
  });

  it("suppresses artists after repeated confirmed dead/private refreshes", () => {
    for (const filter of [{}, { q: "austin" }, { style: "Blackwork" }]) {
      const where = buildRosterFilter(filter).where;
      expect(where).toContain("coalesce(a.stale, false) = false");
    }
  });

  it("suppresses only explicit negative bookability verdicts", () => {
    expect(buildRosterFilter({}).where).toContain(
      "coalesce(a.looksBookable, true) = true",
    );
  });

  // The count and the grid share this WHERE, so the headline "Artists: N"
  // stays honest: junk-stamped unclaimed discovery accounts (RESEARCH bet 2)
  // are excluded from both, whatever the filters.
  it("excludes junk-stamped unclaimed discovery accounts from every roster read", () => {
    for (const filter of [
      {},
      { q: "austin" },
      { style: "Blackwork" },
      { hasPortfolio: true },
    ]) {
      const where = buildRosterFilter(filter).where;
      expect(where).toContain("coalesce(a.discoverySignal, '') = 'junk'");
      // Unstamped / uncertain / tattoo nodes and claimed profiles must pass:
      // the clause only bites on the explicit junk stamp of an unclaimed node.
      expect(where).toContain(
        "NOT (coalesce(a.discoverySignal, '') = 'junk' AND (a.claimedByUid IS NULL OR a.claimedByUid = ''))",
      );
    }
  });

  it("gates the roster on real stored portfolioImages, not the stale count", () => {
    const { where, params } = buildRosterFilter({ hasPortfolio: true });
    expect(params.hasPortfolio).toBe(true);
    // Keys off the real self-hosted array, never portfolioImageCount.
    expect(where).toContain("$hasPortfolio");
    expect(where).toContain("a.portfolioImages IS NOT NULL");
    expect(where).toContain("size(a.portfolioImages) > 0");
    expect(where).not.toContain("portfolioImageCount");
  });

  // hasPortfolio must mean "would actually display something", not "has
  // scraped rows in the graph" — otherwise /artists?hasPortfolio=1 fills with
  // image-less cards the moment the kill switch is off (flagged in PR #218).
  describe("hasPortfolio tracks the display policy (TAT-31/TAT-40)", () => {
    const KILL_SWITCH_OFF = { SHOW_UNCLAIMED_PORTFOLIOS: "false" };
    const KILL_SWITCH_OFF_EMBEDS_ON = {
      SHOW_UNCLAIMED_PORTFOLIOS: "false",
      ENABLE_IG_EMBEDS: "true",
    };

    it("switch on (default): stored images or authorized IG posts count", () => {
      const { where } = buildRosterFilter({ hasPortfolio: true }, {});
      expect(where).toContain("size(a.portfolioImages) > 0");
      expect(where).toContain("SHOWCASES");
      expect(where).toContain("PortfolioPost");
      // No claim gate, no legacy permalink tier. (The discovery-junk clause
      // reads claimedByUid too, so target the gate's IS NOT NULL shape.)
      expect(where).not.toContain("a.claimedByUid IS NOT NULL");
      expect(where).not.toContain("portfolioPermalinks");
    });

    it("switch off, embeds off: claimed artists' images or authorized IG posts count", () => {
      const { where } = buildRosterFilter(
        { hasPortfolio: true },
        KILL_SWITCH_OFF,
      );
      expect(where).toContain(
        "(a.claimedByUid IS NOT NULL AND a.claimedByUid <> '')",
      );
      expect(where).toContain("size(a.portfolioImages) > 0");
      expect(where).toContain("SHOWCASES");
      // No embed tier ⇒ an unclaimed artist displays nothing ⇒ never matches.
      expect(where).not.toContain("portfolioPermalinks");
    });

    it("switch off, embeds on: unclaimed artists count only via a displayable permalink", () => {
      const { where, params } = buildRosterFilter(
        { hasPortfolio: true },
        KILL_SWITCH_OFF_EMBEDS_ON,
      );
      // Claimed lane: licensed hosted images or artist-authorized IG posts.
      expect(where).toContain(
        "(a.claimedByUid IS NOT NULL AND a.claimedByUid <> '')",
      );
      expect(where).toContain("size(a.portfolioImages) > 0");
      expect(where).toContain("SHOWCASES");
      // Unclaimed lane: at least one permalink filterPermalinksForDisplay
      // would keep — matched via the shared pattern, passed as a $param.
      expect(where).toContain(
        "NOT (a.claimedByUid IS NOT NULL AND a.claimedByUid <> '')",
      );
      expect(where).toContain("coalesce(a.portfolioPermalinks, [])");
      expect(where).toContain("$igPermalinkPattern");
      expect(params.igPermalinkPattern).toBe(IG_PERMALINK_CYPHER);
      expect(where).not.toContain("instagram.com"); // pattern rides the param, never inline
    });

    it("the display policy never gates the roster when hasPortfolio is off", () => {
      // $hasPortfolio=false short-circuits the clause; unfiltered browsing
      // must list every artist (cards fall back to their no-image state).
      for (const env of [{}, KILL_SWITCH_OFF, KILL_SWITCH_OFF_EMBEDS_ON]) {
        const { where, params } = buildRosterFilter({}, env);
        expect(params.hasPortfolio).toBe(false);
        expect(where).toContain("NOT $hasPortfolio OR");
      }
    });
  });

  it("searches name, city, and shop; matches style case-insensitively", () => {
    const { where } = buildRosterFilter({ q: "x", style: "Blackwork" });
    expect(where).toContain("a.name");
    expect(where).toContain("a.city");
    expect(where).toContain("a.shopName");
    expect(where).toContain("toLower(s) IN $styleVariants");
  });
});

describe("rosterPageWindow", () => {
  it("defaults to page 1", () => {
    expect(rosterPageWindow(undefined)).toEqual({
      page: 1,
      skip: 0,
      limit: ROSTER_PAGE_SIZE,
    });
  });

  it("computes the skip window from the 1-based page", () => {
    expect(rosterPageWindow("3")).toEqual({
      page: 3,
      skip: 2 * ROSTER_PAGE_SIZE,
      limit: ROSTER_PAGE_SIZE,
    });
  });

  it("clamps junk to page 1 and truncates floats", () => {
    expect(rosterPageWindow("-2").page).toBe(1);
    expect(rosterPageWindow("banana").page).toBe(1);
    expect(rosterPageWindow(["2", "9"]).page).toBe(1);
    expect(rosterPageWindow("2.9").page).toBe(2);
  });
});

describe("instagramUrl", () => {
  it("normalizes handles, urls, and trailing paths", () => {
    expect(instagramUrl("@ink.by.sam")).toBe(
      "https://instagram.com/ink.by.sam",
    );
    expect(instagramUrl("https://www.instagram.com/ink.by.sam/reels")).toBe(
      "https://instagram.com/ink.by.sam",
    );
    expect(instagramUrl("")).toBeNull();
    expect(instagramUrl(null)).toBeNull();
  });
});

// The SHOW_UNCLAIMED_PORTFOLIOS kill switch (TAT-31): every roster surface —
// /artists cards and the /artists/[slug] profile — reads through
// toRosterArtist, so this seam is where withholding scraped images for
// unclaimed artists must actually happen.
describe("roster portfolio kill switch", () => {
  const GCS_IMAGES = [
    "https://storage.googleapis.com/tatt-pro-assets/artists/artist_1/0.jpg",
  ];

  afterEach(() => {
    mockedQuery.mockReset();
    mockedQuery.mockResolvedValue([]);
    vi.unstubAllEnvs();
  });

  it("selects claimedByUid in the roster page and profile queries", () => {
    // Source-level check: the mapper can only gate on a claim binding the
    // Cypher actually returns. Both RETURN blocks must select it.
    const source = readFileSync(
      resolve(process.cwd(), "src/lib/artists-graph.ts"),
      "utf8",
    );
    const hits = source.match(/a\.claimedByUid AS claimedByUid/g) ?? [];
    expect(hits.length).toBeGreaterThanOrEqual(2);
  });

  it("default (flag unset): unclaimed artists keep their images — current behavior", () => {
    const row = toRosterArtist({
      id: "artist_1",
      name: "A",
      portfolioImages: GCS_IMAGES,
      claimedByUid: null,
    });
    expect(row.portfolioImages).toEqual(GCS_IMAGES);
  });

  it("flag off: an unclaimed artist's roster card carries no images", () => {
    vi.stubEnv("SHOW_UNCLAIMED_PORTFOLIOS", "false");
    const row = toRosterArtist({
      id: "artist_1",
      name: "A",
      portfolioImages: GCS_IMAGES,
      claimedByUid: null,
    });
    expect(row.portfolioImages).toEqual([]);
  });

  it("flag off: a claimed artist's images still show — claiming grants the license", () => {
    vi.stubEnv("SHOW_UNCLAIMED_PORTFOLIOS", "false");
    const row = toRosterArtist({
      id: "artist_1",
      name: "A",
      portfolioImages: GCS_IMAGES,
      claimedByUid: "uid_9",
    });
    expect(row.portfolioImages).toEqual(GCS_IMAGES);
  });

  it("flag off: the /artists/[slug] profile read comes back image-less end to end", async () => {
    vi.stubEnv("SHOW_UNCLAIMED_PORTFOLIOS", "false");
    mockedQuery.mockResolvedValue([
      {
        id: "artist_1",
        name: "A",
        portfolioImages: GCS_IMAGES,
        claimedByUid: null,
      },
    ]);
    const artist = await getRosterArtistById("artist_1");
    expect(artist?.portfolioImages).toEqual([]);
    // And the profile query itself asked for the claim binding.
    expect(mockedQuery.mock.calls[0][0]).toContain(
      "a.claimedByUid AS claimedByUid",
    );
  });
});

// The Instagram embed tier (TAT-40): permalinks ride the same toRosterArtist
// seam as the kill switch, and are inert ([]) until ENABLE_IG_EMBEDS=true.
describe("roster Instagram permalinks (TAT-40)", () => {
  const PERMALINKS = ["https://www.instagram.com/p/Abc123/"];

  afterEach(() => {
    mockedQuery.mockReset();
    mockedQuery.mockResolvedValue([]);
    vi.unstubAllEnvs();
  });

  it("selects portfolioPermalinks in the roster page and profile queries", () => {
    const source = readFileSync(
      resolve(process.cwd(), "src/lib/artists-graph.ts"),
      "utf8",
    );
    const hits =
      source.match(/a\.portfolioPermalinks AS portfolioPermalinks/g) ?? [];
    expect(hits.length).toBeGreaterThanOrEqual(2);
  });

  it("default (ENABLE_IG_EMBEDS unset): permalinks stay behind the flag — []", () => {
    const row = toRosterArtist({
      id: "artist_1",
      name: "A",
      portfolioPermalinks: PERMALINKS,
      claimedByUid: null,
    });
    expect(row.portfolioPermalinks).toEqual([]);
  });

  it("flag on: an unclaimed artist's permalinks pass through", () => {
    vi.stubEnv("ENABLE_IG_EMBEDS", "true");
    const row = toRosterArtist({
      id: "artist_1",
      name: "A",
      portfolioPermalinks: PERMALINKS,
      claimedByUid: null,
    });
    expect(row.portfolioPermalinks).toEqual(PERMALINKS);
  });

  it("flag on: a claimed artist gets [] — hosted licensed images are their display", () => {
    vi.stubEnv("ENABLE_IG_EMBEDS", "true");
    const row = toRosterArtist({
      id: "artist_1",
      name: "A",
      portfolioPermalinks: PERMALINKS,
      claimedByUid: "uid_9",
    });
    expect(row.portfolioPermalinks).toEqual([]);
  });

  it("graph rows without the property (backfill not run) degrade to []", () => {
    vi.stubEnv("ENABLE_IG_EMBEDS", "true");
    const row = toRosterArtist({
      id: "artist_1",
      name: "A",
      claimedByUid: null,
    });
    expect(row.portfolioPermalinks).toEqual([]);
  });

  it("kill switch off + embeds on: profile read is image-less but carries permalinks", async () => {
    vi.stubEnv("SHOW_UNCLAIMED_PORTFOLIOS", "false");
    vi.stubEnv("ENABLE_IG_EMBEDS", "true");
    mockedQuery.mockResolvedValue([
      {
        id: "artist_1",
        name: "A",
        portfolioImages: [
          "https://storage.googleapis.com/tatt-pro-assets/a/0.jpg",
        ],
        portfolioPermalinks: PERMALINKS,
        claimedByUid: null,
      },
    ]);
    const artist = await getRosterArtistById("artist_1");
    expect(artist?.portfolioImages).toEqual([]);
    expect(artist?.portfolioPermalinks).toEqual(PERMALINKS);
    expect(mockedQuery.mock.calls[0][0]).toContain(
      "a.portfolioPermalinks AS portfolioPermalinks",
    );
  });
});

// The claim entry point (TAT-16): public surfaces decide whether to offer
// "Claim this profile" off this boolean — the owning uid itself never leaves
// the server.
describe("toRosterArtist claimed flag (TAT-16)", () => {
  it("unclaimed (claimedByUid null): claimed is false", () => {
    const row = toRosterArtist({
      id: "artist_1",
      name: "A",
      claimedByUid: null,
    });
    expect(row.claimed).toBe(false);
  });

  it("graph rows without the property (backfill not run) read as unclaimed", () => {
    const row = toRosterArtist({ id: "artist_1", name: "A" });
    expect(row.claimed).toBe(false);
  });

  it("claimed: the flag is true and the uid is NOT exposed on the row", () => {
    const row = toRosterArtist({
      id: "artist_1",
      name: "A",
      claimedByUid: "uid_9",
    });
    expect(row.claimed).toBe(true);
    expect("claimedByUid" in row).toBe(false);
  });
});

describe("getRosterArtistById outage vs absence", () => {
  afterEach(() => {
    mockedQuery.mockReset();
    mockedQuery.mockResolvedValue([]);
  });

  it("returns null when the graph answers with no rows", async () => {
    mockedQuery.mockResolvedValueOnce([]);
    await expect(getRosterArtistById("artist_missing")).resolves.toBeNull();
  });

  it("throws when the graph read fails so callers can return 503", async () => {
    mockedQuery.mockRejectedValueOnce(new Error("Neo4j down"));
    await expect(getRosterArtistById("artist_1")).rejects.toThrow(/Neo4j down/);
  });
});

describe("toRosterArtist booking tier (ADR-0043)", () => {
  it("permits deposits only with tattoo evidence and a positively live shop website", () => {
    expect(
      toRosterArtist({
        id: "artist_1",
        name: "A",
        portfolioImages: ["https://example.com/work.jpg"],
        shopWebsiteLive: true,
      }).bookingTier,
    ).toBe("bookable");

    expect(
      toRosterArtist({
        id: "artist_2",
        name: "B",
        portfolioImages: ["https://example.com/work.jpg"],
      }).bookingTier,
    ).toBe("browse-only");
  });

  it("treats a claimed profile as bookable without scrape-tier evidence", () => {
    expect(
      toRosterArtist({
        id: "artist_claimed",
        name: "C",
        claimedByUid: "uid_9",
      }).bookingTier,
    ).toBe("bookable");
  });

  it("requires a non-empty URL as well as a live-probe flag in the artist lookup", async () => {
    mockedQuery.mockClear();
    mockedQuery.mockResolvedValueOnce([]);
    await getRosterArtistById("artist_1");
    expect(mockedQuery.mock.calls[0][0]).toContain(
      "sh.websiteLive = true AND trim(coalesce(sh.website,'')) <> ''",
    );
  });
});
