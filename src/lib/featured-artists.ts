/**
 * The homepage "Featured artists" grid, gated on takedown suppression.
 *
 * ## Why this module exists
 *
 * `src/data/featured-artists.json` is a committed snapshot produced by
 * `scripts/pick-featured-artists.mjs`. It was read straight into the homepage,
 * and **no database filter reached it** — so a completed takedown left the
 * removed artist on the most prominent surface of the site until somebody
 * remembered to re-run a script and redeploy. ADR 0025 flagged this as a known
 * gap and the executor prints a warning about it; a warning is not a mechanism.
 *
 * ## Why the curated file is kept rather than replaced with a live query
 *
 * The four cards are an *editorial* choice — one artist per state, ordered by
 * review volume, hand-checkable before it ships. Deriving them live would make
 * the homepage's most visible section depend on Neo4j being up at request time,
 * and would let a data refresh silently swap who TatT promotes. Curation stays.
 *
 * What changes is that the curated list is now a **candidate** list. Every
 * render asks the graph which of those candidates may still be published, and
 * anyone the graph does not vouch for is dropped.
 *
 * ## Fail closed
 *
 * The gate returns *permission to publish*, never *permission to suppress*. A
 * Neo4j outage yields an empty allow-list, so the grid empties rather than
 * republishing someone who asked to be removed. This mirrors the ingest gate in
 * `scripts/lib/takedown-tombstone.mjs` and ADR 0025 §4 — losing four cards is
 * far cheaper than breaking a removal promise, and the section degrades to the
 * "Browse artists" link that already sits beside it.
 *
 * This is why the check is a single query. Two queries (visible-artists, then
 * tombstones) would fail *open* on the second: `executeServerCypherQuery`
 * swallows errors and returns `[]`, and an empty tombstone list reads as
 * "nobody is tombstoned". Everything the gate needs is asked for at once, so an
 * error can only ever shrink the result.
 *
 * ## What disqualifies an artist
 *
 * - `a.removedAt` is set — a scope=all takedown was executed.
 * - Any `:TakedownTombstone` matches their id or Instagram handle, **including
 *   a scope=images one**. The grid is promotion, not a listing: someone who
 *   asked us to stop using their photographs should not be TatT's shop window,
 *   even if they were content to remain in the roster.
 * - They are no longer in the graph at all.
 *
 * A *pending* takedown request deliberately does **not** disqualify anyone. The
 * request route is public and unauthenticated by design (ADR 0025 §6), so
 * honouring unactioned requests here would let any stranger knock any artist
 * off the homepage. Only removals a human has actually executed count.
 *
 * ## Why the photo comes from the graph and the rest does not
 *
 * The gate used to return ids only, so the homepage had no photo to render and
 * fell back to the monogram tile — while `/artists` and the profile page showed
 * the artist's real work. The same featured artist looked like two different
 * people depending on which page you landed on.
 *
 * Carrying an image URL in the curated JSON would have fixed the symptom and
 * created the drift: a snapshot photo goes stale the moment the artist claims
 * their profile, swaps their work, or the kill switch below turns off. So the
 * hero image is read live, from the same query, and put through
 * `filterPortfolioForDisplay` — the one seam `/artists` and the profile already
 * read through. Same artist, same seam, same `[0]`, so the homepage photo *is*
 * the profile photo by construction rather than by a copy someone must
 * remember to refresh.
 *
 * This narrowly widens the graph's power over the homepage: it can take a card
 * away, and it can say which photo that card wears. It still cannot add a card,
 * rename anyone, or change who TatT promotes — that stays the reviewed
 * snapshot. And because the image travels through the TAT-31 gate,
 * `SHOW_UNCLAIMED_PORTFOLIOS=false` empties the homepage tile exactly when it
 * empties the profile hero, rather than leaking withheld photographs onto the
 * most prominent surface of the site.
 */
import featuredData from "@/data/featured-artists.json";
import { PUBLIC_ARTIST_CLAUSE } from "@/lib/artist-visibility";
import { filterPortfolioForDisplay } from "@/lib/portfolio-display";
import { tombstoneKeysFor } from "@/lib/takedown";

export type FeaturedArtist = {
  id: string;
  name: string;
  city: string;
  state: string;
  styles: string[];
  instagram: string;
  rating: number;
  reviewCount: number;
};

/**
 * A candidate the graph vouched for, carrying the photo it vouched for.
 *
 * `heroImage` is `null` for an artist with no displayable portfolio — no work
 * hosted, or the kill switch withholding it. That is a real state, not a
 * failure: the card renders its monogram tile, exactly as the profile renders
 * its no-work hero.
 */
export type PublishedFeaturedArtist = FeaturedArtist & {
  heroImage: string | null;
};

/** The editorial snapshot. Candidates only — never rendered unfiltered. */
export const CURATED_FEATURED: FeaturedArtist[] = featuredData.artists as FeaturedArtist[];

/**
 * The identifiers the graph must be asked about for one candidate.
 *
 * Reuses `tombstoneKeysFor` so the keys checked here are exactly the keys the
 * executor writes — if the two ever drift, the gate silently stops matching,
 * which is the failure this shares a function to prevent.
 */
export function candidateKeys(artist: FeaturedArtist): { id: string; keys: string[] } {
  return {
    id: artist.id,
    keys: tombstoneKeysFor({ artistId: artist.id, instagram: artist.instagram }).map((k) => k.key),
  };
}

/**
 * Keep only the candidates the graph explicitly vouched for, in curated order.
 *
 * Pure, so the fail-closed behaviour is testable without a driver: an empty or
 * partial `allowedIds` can only ever remove cards.
 */
export function retainPublishable(
  candidates: readonly FeaturedArtist[],
  allowedIds: Iterable<string>,
): FeaturedArtist[] {
  const allowed = new Set(allowedIds);
  return candidates.filter((a) => allowed.has(a.id));
}

/**
 * Ask the graph which candidates are still publishable, and with which photo.
 *
 * Returns ids and raw portfolio fields — never names, cities or styles. The
 * words on the card stay the reviewed snapshot; the graph decides only whether
 * a card survives and which of the artist's own images it wears.
 *
 * `claimedByUid` rides along because `filterPortfolioForDisplay` needs it to
 * answer the TAT-31 question. Reading the images without it would silently
 * treat every artist as unclaimed.
 */
export const PUBLISHABLE_FEATURED_CYPHER = `
  UNWIND $candidates AS c
  MATCH (a:Artist {id: c.id})
  WHERE ${PUBLIC_ARTIST_CLAUSE}
  OPTIONAL MATCH (t:TakedownTombstone)
  WHERE t.key IN c.keys
  WITH a, count(t) AS tombstones
  WHERE tombstones = 0
  RETURN
    a.id AS id,
    a.portfolioImages AS portfolioImages,
    a.claimedByUid AS claimedByUid
`;

/**
 * The hero the profile page would show for this row, or `null`.
 *
 * Pure, and deliberately the *only* place the homepage turns graph fields into
 * an image URL — `filterPortfolioForDisplay` then `[0]` is precisely what
 * `/artists` and `src/app/artists/[slug]/page.tsx` do, so the three surfaces
 * cannot disagree about which photograph belongs to an artist.
 */
export function heroImageFromRecord(record: {
  portfolioImages?: unknown;
  claimedByUid?: unknown;
}): string | null {
  return filterPortfolioForDisplay(record)[0] ?? null;
}

/**
 * Give each retained candidate the photo the graph vouched for.
 *
 * Pure and additive-only: an id missing from `heroById` yields `heroImage:
 * null`, so a partial or malformed response costs a photo, never a card.
 */
export function attachHeroImages(
  artists: readonly FeaturedArtist[],
  heroById: ReadonlyMap<string, string | null>,
): PublishedFeaturedArtist[] {
  return artists.map((a) => ({ ...a, heroImage: heroById.get(a.id) ?? null }));
}

async function runServerQuery(query: string, params: Record<string, unknown>) {
  const { executeServerCypherQuery } = await import(
    "@/features/match-pulse/services/neo4jService"
  );
  return executeServerCypherQuery(query, params);
}

/**
 * The homepage grid: curated candidates minus anyone the graph suppresses.
 *
 * May legitimately return fewer than four artists, or none. Callers must render
 * that honestly rather than backfilling — a short grid is the correct output
 * when someone has been removed.
 */
export async function getFeaturedArtists(
  candidates: readonly FeaturedArtist[] = CURATED_FEATURED,
): Promise<PublishedFeaturedArtist[]> {
  if (!candidates.length) return [];

  const records = await runServerQuery(PUBLISHABLE_FEATURED_CYPHER, {
    candidates: candidates.map(candidateKeys),
  });

  // One pass: a row only counts as a vouch if it carries a usable id, and the
  // photo it carries is recorded against that same id. A malformed row drops
  // out of both, so it can never contribute an image to somebody else's card.
  const heroById = new Map<string, string | null>();
  for (const record of records) {
    const id = typeof record?.id === "string" ? record.id : null;
    if (!id) continue;
    heroById.set(id, heroImageFromRecord(record));
  }

  return attachHeroImages(retainPublishable(candidates, heroById.keys()), heroById);
}
