# Spec 14 — Swipe card with evidence, undo, and a second deck for broadened results

Status: draft · Effort: **M** (L if distance requires new geo data, see 4.2) · Depends on: [13](13-persist-swipe-decisions.md) for server-side undo (a local-only undo can ship first); [15](15-intent-and-budget-pills.md) supplies the `radius` that distance needs · Rollup rank 11, parts T1, T4, T5

## 1. Problem

The card that asks the customer to decide carries less evidence than any other surface: initials on a pink tile, a match percentage and up to three chips. And when the search is thin, the server builds a list of near-matches that the client throws away. Wrong on day one: the customer is asked to pin an artist they have never seen the work of, with no way to take back a mistaken swipe, and a thin search ends in "No artists match" while good alternatives sit unused.

Current behaviour (generation/matching map §F2-§H; `SwipeClient.tsx`, `SmartMatchClient.tsx`, `ArtistCard.tsx` unchanged at 1e301a1):

- The swipe card is inline in `src/app/swipe/SwipeClient.tsx:160-247` (react-tinder-card, drag left/right, up/down prevented `:162-164`). It renders a monogram tile of initials on pink — no photo (`:172-181`, comment `:168-171`), up to 3 reason chips (`:189-200`), name (`:202-204`), `"{matchPercent}% match"` as `clamp(round(score),1,99)` (`:57,205-207`), location or "-" (`:209-211`), and style tags only as a fallback when there are no chips (`:214-225`).
- Not rendered: rating, review count, price, availability, distance, bio, instagram handle (carried in `card.instagram`, unused, `:36,61`), profile link (`card.slug` computed at `:56`, unused), portfolio images.
- Actions: Pass and Pin buttons (`:229-242`) plus drag; no profile, book, or undo ("[not found] undo", map §H). Booking appears only on the "Deck complete" screen, as `Book` links for pinned artists (`:46-49,265-284`), plus "Browse the roster" or "Try again" (`:285-291`). Header counter "Pinned: n" (`:135-137`).
- The match percentage includes a 5% per-call random variety term (`Math.random()`, `hybridMatchService.ts` `scoreArtists`; weights in `src/utils/scoreAggregation.js:106-113`; map §G "honesty caveat"). Out of scope here, but the card should not present it as more precise than it is.
- The payload: per artist `id, name, city, state, location, rating, reviewCount, styles[], hourlyRate, portfolio[], instagram, embedding_id, tags[], score, matchScore, reasons[], visualSimilarity?, source` (`neo4jService.ts:26-49,438-483`). `portfolio[]` comes from `Tattoo.imageUrl` nodes (cypher `collect(DISTINCT t.imageUrl) AS portfolio`, `neo4jService.ts:~357`), which is empty for scraped artists, and is not passed through `filterPortfolioForDisplay` (map §F3; the gate is applied in the pulse query at `neo4jService.ts:598`). The artist node's own `portfolioImages` property (what the roster uses) is not returned by the match query. There is no distance in the payload: the route accepts `radius` (default 25) and passes it as `preferences.distance`, but the Cypher never uses it — location is a city `CONTAINS` / exact state match only (`neo4jService.ts:~380-385`); the `distance?` field on the store type is never populated (`useMatchStore.ts:15-16`).
- The client keeps `artistId, artistName, matchScore, tags, styles, location, instagramUrl, bio, reasoning, reasonChips` (`SmartMatchClient.tsx:134-162`) and ignores the response's `broadened[]` and `broadened_reason` (map §F2: "rg broadened in app/features/components finds only the service and route"). On an empty primary result the page shows "No artists match that combination yet…" (`SmartMatchClient.tsx:164-168`) and drops the alternatives. The server builds `broadened[]` (up to 8, relaxed style/location filters, scored against the original preferences) when fewer than 4 primary matches exist and style or location filters are set (`hybridMatchService.ts` `THIN_RESULT_THRESHOLD = 4`, `MAX_BROADENED_RESULTS = 8`, `:~320-324,407-424`); a test exists (`__tests__/hybridMatchService.broadening.test.ts`).

## 2. Competitor evidence

Tinder (passes and one rewind, 2026-10-26; `~/reports/tatttester/2026-10-24-rea-tinder.html`):
- The card carries first name, age, a "Recently Active" badge, distance ("24 miles away") on the open card, a one-line bio, 4–9 photos with Previous/Next, and an "Open Profile" action (DOM read; T5, T1).
- Keyboard shortcuts are printed on screen: Left = Nope, Right = Like, Up = Open Profile, Enter = Super Like, Space = Next Photo.
- Rewind exists but on a free account sends nothing and opens a Tinder Plus paywall modal; the card is not restored (observed; T4). So Tinder's undo is a paid feature, not a free one; "one-step free undo" is TattTester's own design, not an observed behaviour.
- A pass is optimistic; four passes did not trigger a new recommendation batch; deck size and refill threshold were not observable (T4).
- Tinder requires two photos before matching starts and states what more photos buy (T1, DOM). That is an onboarding rule and is not part of this spec.

## 3. Scope and non-goals

In scope: the hero portfolio image on the card; distance when it can be known; a link to the artist profile; a one-step undo; rendering the server's `broadened[]` as a second deck; printed keyboard shortcuts.

Non-goals: photo carousel (one hero image for now); showing rating/price/availability on the card (spec 4 treats roster cards; keep the swipe card lean); changing the scoring or removing the random term; geocoding new data sources beyond what exists; paywalling anything.

## 4. Proposed change

### 4.1 User-visible behaviour

1. The card leads with the artist's best work image, full-bleed; the monogram tile remains the fallback when no displayable image exists.
2. Under the name: city, and "12 mi away" when the customer gave a place and the artist has a location the product can measure; otherwise just the city.
3. A "View profile" link opens the artist's page in a new tab without losing the deck. Keyboard: Left passes, Right pins, Up opens the profile, Z (or Backspace) undoes; the shortcuts are printed under the deck.
4. "Undo" appears for a few seconds after a swipe and, always, as a small button; it brings back the last card and reverses its pin or pass. One step only.
5. When the main deck ends, or a search finds few matches, a second deck appears: "Close to what you asked for" with the server's reason line. The two decks are visibly separate; the main deck's "Deck complete" screen offers to continue into it. If the primary result is empty but alternatives exist, `/smart-match` goes straight to the alternatives deck with the reason line instead of the dead-end message.

### 4.2 Data and API

- **Hero image.**
  - Server: add `a.portfolioImages AS portfolioImages` and `a.claimedByUid AS claimedByUid` to the Cypher RETURN in `neo4jService.ts` (near `:438-483`). In the mapper, compute `heroImage = pickHeroImage(filterPortfolioForDisplay({portfolioImages, claimedByUid}))` using the same helpers the roster uses (`src/lib/portfolio-display.ts`, `src/lib/hero-image.ts:300`). Return `heroImage` (string | null) and keep `portfolio[]` as is. This applies the `SHOW_UNCLAIMED_PORTFOLIOS` gate: with the switch set to "false" an unclaimed artist's images are withheld and the card falls back to the monogram. **Do not render any portfolio image outside this gate.** The flag's production value is not assumed here.
  - Honest expectation: per `CLAUDE.md`, 7,511 of 18,002 production artists have images, and only 26 of the 68,532 URLs are GCS-hosted; the rest are external source URLs. Whether external Instagram CDN URLs keep loading in a swipe card (expiry, hotlink blocking) is **unverified**; check how the roster page renders them before committing. Plan for the monogram fallback to be common at launch.
  - The store type and `SmartMatchClient.tsx:134-162` mapping gain `heroImage`, `slug`, `distanceMiles?`.
- **Profile link.** `card.slug` already exists in the card model (`SwipeClient.tsx:56`); link to `/artists/{slug}` with `target="_blank" rel="noopener"`.
- **Distance.** The engine does not compute it today and location is free text. Two tiers:
  1. Ship now: nothing (omit the distance line); the card shows city only.
  2. With data: requires (a) artist coordinates on `:Artist` (**unverified** whether `lat/lng` exist; the roster type `RosterArtist` has none, `artists-graph.ts:43-76`) and (b) geocoding the customer's city string, which `/smart-match` collects as free text (`SmartMatchClient.tsx:276-296`). Then compute great-circle miles in the mapper and honour `radius` as a filter. This is the L-sized part and is what makes spec 15's radius pill real; schedule it separately if data is missing. Until then the response must not claim a distance.
- **Undo.** `SwipeClient` keeps a one-element history `{artistId, decision, cardIndex}`. Undo: re-insert the card at the top (react-tinder-card exposes `restoreCard()` on its ref — **unverified** for the pinned version; check `package.json` and the library API before relying on it), revert local state, and call spec 13's `DELETE /api/v1/match/decision?artistId=`. Without spec 13, undo is local-only and the legacy `localStorage` write is reverted too.
- **Second deck.**
  - `SmartMatchClient` reads `broadened` and `broadened_reason` from the response (route already returns them: `src/app/api/v1/match/semantic/route.ts:43-44`) and maps them with the same mapper as primary matches, tagged `deck: 'broadened'`.
  - `useMatchStore` (`src/store/useMatchStore.ts:42-103`) stores `{matches, broadened, broadenedReason}`; include the new fields in the persisted slice (bump the persist `version` so old shapes migrate to `broadened: []`).
  - `SwipeClient` renders deck 1, then the "Close to what you asked for" interstitial, then deck 2. Decisions on deck 2 are recorded with the same endpoint (spec 13) plus `deck: 'broadened'` if analytics wants it (optional field).
  - Empty primary and non-empty broadened: set the store and navigate to `/swipe` directly with the reason line; otherwise keep the existing empty-state copy.
  - Unverified: whether the relaxed query keeps `budget` and `has_portfolio` filters (spec 15 makes them live); read `findMatchingArtists` `hybridMatchService.ts:~407-424` and decide whether broadening should also relax them, since `hasRelaxableFilters` only considers styles and location.

### 4.3 Copy (ADR-0036)

No money mentioned on the swipe card (rate/price is deliberately not shown). "TattTester" for any brand string.

- Profile link: "View profile".
- Undo: "Undo".
- Shortcuts line: "← pass · → pin · ↑ profile · Z undo".
- Second deck heading: the server reason, normalised for display: "Close to what you asked for — fewer than a handful of exact matches for your filters." Replace the server's "Also nearby / similar" text with copy owned by the client so wording stays under ADR-0036 control (open question 8.3).
- Hero image alt text: "Work by {Artist}". Credit line for unclaimed artists follows the existing provenance label rule (ADR-0036 law 3: the profile page carries the label; the swipe card links to it with "View profile"); open question 8.2 on whether a one-word "Instagram" credit belongs on the card.

## 5. Failure and edge cases

1. No displayable image: monogram tile as today, no broken-image box. Image load error: swap to the monogram on `onError`.
2. `SHOW_UNCLAIMED_PORTFOLIOS=false`: unclaimed artists have no hero; claimed artists still do. Tested explicitly.
3. Undo after the last card of the main deck: returns to the last card, not the interstitial.
4. Undo then a new swipe: history is overwritten (one step).
5. Undo with a failed server delete: revert locally and queue the delete; the server decision lingers until the queue flushes; a reload in between would re-hide that card (acceptable, tell no one).
6. Empty broadened list and empty primary: existing empty state.
7. Duplicates across decks: the server already filters `primaryIds` out of `broadened` (`hybridMatchService.ts:~412`); the client also de-dupes by id.
8. Reduced motion and keyboard users: shortcuts work without drag; the card is a labelled region; Undo is a button.
9. Image weight: the hero is one image per card, lazy-loaded for cards beyond the first two.
10. Profile link opens an artist who was removed meanwhile: the profile route's own takedown handling applies.

## 6. Test plan

Extend:
- `src/app/swipe/page.test.tsx`: card shows hero image when provided, monogram when not, and on image error; "View profile" href; keyboard shortcuts; undo restores the previous card and calls DELETE; second deck appears after the main deck with the reason line; Deck complete offers the continue action.
- `src/features/match-pulse/services/neo4jService.test.ts`: the mapped artist includes a gated `heroImage`; with `SHOW_UNCLAIMED_PORTFOLIOS=false` an unclaimed artist's `heroImage` is null and a claimed one's is kept (reuse the env-injection pattern in `portfolio-display.test.ts`).
- `src/features/match-pulse/services/__tests__/hybridMatchService.broadening.test.ts`: `broadened` items carry the same fields as primary matches, including `heroImage`.
- `src/app/smart-match/SmartMatchClient.test.tsx`: empty primary + non-empty broadened goes to the alternatives deck; both empty shows the existing message; `broadened` mapped and stored.
- `src/store/useMatchStore.test.ts`: persist migration to a store with `broadened`; old persisted shape loads.

Add:
- `src/app/swipe/SwipeCard.test.tsx` (new, if the card is extracted into its own component as part of this change): the pure render states.

## 7. Effort and dependencies

M for image, link, undo, second deck, shortcuts. Distance is the L-sized part and depends on data that may not exist; it can be a follow-up without blocking the rest. Server-side undo needs spec 13's DELETE.

## 8. Open questions for Samson

1. Should distance wait for real coordinates, or should the card ship city-only at launch (recommended)?
2. Showing a scraped artist's Instagram photo on a swipe card is the most exposed use of third-party images in the product (`CLAUDE.md`, Status: third-party data; the gate is `SHOW_UNCLAIMED_PORTFOLIOS`). Do you want a visible credit ("from @handle's Instagram") on the card itself, or is the profile page's provenance label enough?
3. Who owns the wording of the second-deck heading and reason line? The server string today is "Also nearby / similar — fewer than a handful of exact matches for your filters".
4. Is a free one-step undo what you want, given Tinder charges for Rewind (observed)? Cheap to build; not a gated feature here.
