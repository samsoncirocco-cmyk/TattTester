/**
 * The homepage featured grid must respect takedown suppression.
 *
 * Before this module the grid was a committed JSON file read straight into the
 * page, so a completed takedown left the person on the most prominent surface
 * of the site. These tests pin the two properties that fix depends on: the gate
 * only ever *removes*, and it removes on failure rather than on success.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  CURATED_FEATURED,
  PUBLISHABLE_FEATURED_CYPHER,
  candidateKeys,
  retainPublishable,
  attachHeroImages,
  heroImageFromRecord,
  getFeaturedArtists,
  type FeaturedArtist,
} from "@/lib/featured-artists";
import { PUBLIC_ARTIST_CLAUSE } from "@/lib/artist-visibility";

const execute = vi.hoisted(() => vi.fn());
vi.mock("@/features/match-pulse/services/neo4jService", () => ({
  executeServerCypherQuery: execute,
}));

function artist(over: Partial<FeaturedArtist> = {}): FeaturedArtist {
  return {
    id: "artist_ging",
    name: "Ging Tattoos",
    city: "Austin",
    state: "TX",
    styles: ["Traditional"],
    instagram: "@tattoosbyging",
    rating: 4.9,
    reviewCount: 500,
    ...over,
  };
}

beforeEach(() => execute.mockReset());
afterEach(() => {
  vi.restoreAllMocks();
  // The kill-switch tests stub SHOW_UNCLAIMED_PORTFOLIOS; restoreAllMocks does
  // not undo env stubs, and a leaked "false" would silently blank portfolio
  // assertions in every file that runs after this one.
  vi.unstubAllEnvs();
});

describe("candidateKeys", () => {
  it("asks about the instagram handle as well as the id", () => {
    // The crawler mints random ids, so an id-only check would miss a re-crawled
    // artist entirely — the same reason the tombstone leads on the handle.
    expect(candidateKeys(artist()).keys).toEqual([
      "instagram:tattoosbyging",
      "artist:artist_ging",
    ]);
  });

  it("normalizes the handle the same way the executor does", () => {
    expect(candidateKeys(artist({ instagram: "https://instagram.com/Foo/" })).keys).toContain(
      "instagram:foo",
    );
  });
});

describe("retainPublishable", () => {
  it("keeps only vouched-for artists, in curated order", () => {
    const a = artist({ id: "a" });
    const b = artist({ id: "b" });
    const c = artist({ id: "c" });
    expect(retainPublishable([a, b, c], ["c", "a"]).map((x) => x.id)).toEqual(["a", "c"]);
  });

  it("can never add an artist the graph did not vouch for", () => {
    const a = artist({ id: "a" });
    expect(retainPublishable([a], ["a", "someone_else"]).map((x) => x.id)).toEqual(["a"]);
  });

  it("returns nothing when nothing is allowed", () => {
    expect(retainPublishable([artist()], [])).toEqual([]);
  });
});

describe("PUBLISHABLE_FEATURED_CYPHER", () => {
  it("requires removedAt to be null", () => {
    expect(PUBLISHABLE_FEATURED_CYPHER).toContain(PUBLIC_ARTIST_CLAUSE);
  });

  it("suppresses artists marked stale by repeated confirmed dead refreshes", () => {
    expect(PUBLISHABLE_FEATURED_CYPHER).toContain("coalesce(a.stale, false) = false");
  });

  it("suppresses explicit negative account-quality verdicts", () => {
    expect(PUBLISHABLE_FEATURED_CYPHER).toContain(
      "coalesce(a.looksBookable, true) = true",
    );
  });

  it("excludes anyone carrying a tombstone", () => {
    expect(PUBLISHABLE_FEATURED_CYPHER).toContain("TakedownTombstone");
    expect(PUBLISHABLE_FEATURED_CYPHER).toContain("tombstones = 0");
  });

  it("asks both questions in one query so an error cannot fail open", () => {
    // A second, separate tombstone query would return [] on failure, which
    // reads as "nobody is tombstoned" — the exact fail-open trap ADR 0025 §4
    // exists to avoid. One query means an error can only shrink the result.
    expect(PUBLISHABLE_FEATURED_CYPHER.match(/RETURN/g)).toHaveLength(1);
  });
});

describe("getFeaturedArtists", () => {
  it("drops an artist whose node the graph does not return", async () => {
    const kept = artist({ id: "kept" });
    const removed = artist({ id: "removed" });
    execute.mockResolvedValue([{ id: "kept" }]);

    const result = await getFeaturedArtists([kept, removed]);

    expect(result.map((a) => a.id)).toEqual(["kept"]);
  });

  it("returns every artist the graph vouches for", async () => {
    const a = artist({ id: "a" });
    const b = artist({ id: "b" });
    execute.mockResolvedValue([{ id: "a" }, { id: "b" }]);

    expect((await getFeaturedArtists([a, b])).map((x) => x.id)).toEqual(["a", "b"]);
  });

  it("FAILS CLOSED: an unreachable graph empties the grid", async () => {
    // executeServerCypherQuery swallows driver errors and returns []. That must
    // read as "vouch for nobody", not "vouch for everybody".
    execute.mockResolvedValue([]);

    expect(await getFeaturedArtists([artist()])).toEqual([]);
  });

  it("FAILS CLOSED: a malformed row is not treated as an allowed id", async () => {
    execute.mockResolvedValue([{ id: null }, {}, { id: 42 }]);

    expect(await getFeaturedArtists([artist()])).toEqual([]);
  });

  it("passes the tombstone keys the executor writes", async () => {
    execute.mockResolvedValue([]);
    await getFeaturedArtists([artist()]);

    expect(execute).toHaveBeenCalledWith(PUBLISHABLE_FEATURED_CYPHER, {
      candidates: [{ id: "artist_ging", keys: ["instagram:tattoosbyging", "artist:artist_ging"] }],
    });
  });

  it("does not query at all for an empty candidate list", async () => {
    expect(await getFeaturedArtists([])).toEqual([]);
    expect(execute).not.toHaveBeenCalled();
  });
});

/**
 * The homepage rendered monogram tiles while /artists and the profile showed
 * the artist's real work, because the gate returned ids and nothing else. These
 * pin the fix: the photo is read live through the same seam the profile reads,
 * and it can only ever cost a card its photo — never its place in the grid.
 */
describe("heroImageFromRecord", () => {
  it("is the profile hero: filterPortfolioForDisplay then [0]", () => {
    expect(
      heroImageFromRecord({ portfolioImages: ["one.jpg", "two.jpg"] }),
    ).toBe("one.jpg");
  });

  it("is null when the artist has no hosted work", () => {
    expect(heroImageFromRecord({ portfolioImages: [] })).toBeNull();
    expect(heroImageFromRecord({})).toBeNull();
  });

  it("never lets graph junk reach an <img src>", () => {
    expect(heroImageFromRecord({ portfolioImages: "not-an-array" })).toBeNull();
    expect(heroImageFromRecord({ portfolioImages: [42, null] })).toBeNull();
  });

  it("HONOURS THE KILL SWITCH: withholds an unclaimed artist's scraped photos", () => {
    // TAT-31. The homepage is the most prominent surface on the site — if the
    // switch withholds these images on the profile it must withhold them here,
    // or the flag would leak the exact photographs it exists to suppress.
    vi.stubEnv("SHOW_UNCLAIMED_PORTFOLIOS", "false");

    expect(heroImageFromRecord({ portfolioImages: ["scraped.jpg"] })).toBeNull();
    expect(
      heroImageFromRecord({ portfolioImages: ["own.jpg"], claimedByUid: "uid_1" }),
    ).toBe("own.jpg");
  });
});

describe("attachHeroImages", () => {
  it("gives each artist the photo recorded against their id", () => {
    const a = artist({ id: "a" });
    const b = artist({ id: "b" });
    const result = attachHeroImages(
      [a, b],
      new Map([
        ["a", "a.jpg"],
        ["b", null],
      ]),
    );

    expect(result.map((x) => [x.id, x.heroImage])).toEqual([
      ["a", "a.jpg"],
      ["b", null],
    ]);
  });

  it("costs a photo, never a card, when the id is missing", () => {
    expect(attachHeroImages([artist({ id: "a" })], new Map())).toEqual([
      { ...artist({ id: "a" }), heroImage: null },
    ]);
  });

  it("leaves the curated copy untouched", () => {
    // Only the photo comes from the graph. A data refresh must not be able to
    // rename anyone on the homepage or move them to another city.
    const a = artist({ id: "a", name: "Ging Tattoos", city: "Austin" });
    const [out] = attachHeroImages([a], new Map([["a", "a.jpg"]]));

    expect(out.name).toBe("Ging Tattoos");
    expect(out.city).toBe("Austin");
    expect(out.styles).toEqual(a.styles);
  });
});

describe("getFeaturedArtists hero images", () => {
  it("asks the graph for the fields the display gate needs", () => {
    // Reading portfolioImages without claimedByUid would silently treat every
    // artist as unclaimed and blank the grid whenever the switch is off.
    expect(PUBLISHABLE_FEATURED_CYPHER).toContain("a.portfolioImages AS portfolioImages");
    expect(PUBLISHABLE_FEATURED_CYPHER).toContain("a.claimedByUid AS claimedByUid");
  });

  it("returns the artist's own hero alongside the curated copy", async () => {
    execute.mockResolvedValue([
      { id: "a", portfolioImages: ["hero.jpg", "second.jpg"], claimedByUid: null },
    ]);

    const [out] = await getFeaturedArtists([artist({ id: "a" })]);

    expect(out.heroImage).toBe("hero.jpg");
    expect(out.name).toBe("Ging Tattoos");
  });

  it("keeps the card when the artist has no displayable photo", async () => {
    // A vouched-for artist with no work is a monogram tile, not a missing card.
    execute.mockResolvedValue([{ id: "a", portfolioImages: [] }]);

    const result = await getFeaturedArtists([artist({ id: "a" })]);

    expect(result).toHaveLength(1);
    expect(result[0].heroImage).toBeNull();
  });

  it("never attributes one artist's photo to another", async () => {
    // A malformed row drops out of the allow-list and the photo map together,
    // so its image cannot land on the next card in the grid.
    execute.mockResolvedValue([
      { id: null, portfolioImages: ["orphan.jpg"] },
      { id: "b", portfolioImages: ["b.jpg"] },
    ]);

    const result = await getFeaturedArtists([artist({ id: "a" }), artist({ id: "b" })]);

    expect(result.map((x) => [x.id, x.heroImage])).toEqual([["b", "b.jpg"]]);
  });

  it("STILL FAILS CLOSED: rows carrying photos but no id vouch for nobody", async () => {
    execute.mockResolvedValue([{ portfolioImages: ["hero.jpg"] }]);

    expect(await getFeaturedArtists([artist()])).toEqual([]);
  });
});

describe("the committed snapshot", () => {
  it("is treated as candidates, not as output", async () => {
    // The regression this whole module exists for: the homepage used to render
    // src/data/featured-artists.json directly, with no filter of any kind.
    execute.mockResolvedValue([]);

    expect(CURATED_FEATURED.length).toBeGreaterThan(0);
    expect(await getFeaturedArtists()).toEqual([]);
  });
});
