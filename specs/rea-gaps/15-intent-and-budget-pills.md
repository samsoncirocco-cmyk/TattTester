# Spec 15 — Intent and budget pills on /smart-match, sent as `budget`, `radius`, `has_portfolio`

Status: draft · Effort: **S** for intent + `has_portfolio` + budget; radius is **blocked on data** (see 4.2) · Depends on: [14](14-swipe-card-evidence-undo-and-broadened-deck.md) tier-2 distance for radius to mean anything · Gap T3 (listed in the Tinder report's gap table; the roll-up ranks T1, T2, T4, T5 under rank 11 and does not rank T3 separately)

## 1. Problem

The matcher cannot tell a first small tattoo from a sleeve commission, and the route already supports filters the client never sends. Wrong on day one: every customer gets the same kind of deck regardless of what they are trying to do or spend.

Current behaviour (generation/matching map §F2; the route, scoring and Cypher re-read at 1e301a1):

- `/smart-match` collects style pills over `CANONICAL_STYLES` and a free-text city (`src/app/smart-match/SmartMatchClient.tsx:276-296`). The request body is `{ query: [briefContext, ...styles, location].join(" ") || "tattoo artist", style_preferences, location, max_results: 20 }` (`:100-125`). With `?ds=` the brief (placement + meaning + mapped styles) prefills and auto-runs (`:188-223`).
- The route accepts `query, location, style_preferences, budget, radius = 25, max_results = 10, has_portfolio = false` (`src/app/api/v1/match/semantic/route.ts:14-22`) and builds `preferences = {location, styles, budget: budget || null, distance: radius, hasPortfolio: !!has_portfolio}` (`:24-30`). It does no validation of `budget` or `radius`.
- What each does downstream:
  - `has_portfolio` → Cypher `AND (NOT $hasPortfolio OR (a.portfolioImages IS NOT NULL AND size(a.portfolioImages) > 0) OR size(portfolio) > 0)` (`src/features/match-pulse/services/neo4jService.ts:394`, `buildHasPortfolioClause` `:286-288`). Live.
  - `budget` → compared with `a.hourlyRate`, an **hourly rate**, not a session budget: hard filter `a.hourlyRate IS NULL OR a.hourlyRate <= $budget * 1.5` (`neo4jService.ts:391`, comment: "Real scraped artists have no published rate ... never exclude them on budget"), score `0.1` if `<= $budget`, `0.05` if `<= 1.5x`, `0.05` neutral when null (`:424-426`); composite weight `budget: 0.10` (`src/utils/scoreAggregation.js:111`); reason chips "Within your budget" / "Close to your budget range" (`scoreAggregation.js:78-81`). How many production artists have a non-null `hourlyRate` is **unverified**; the filter is only as useful as that share.
  - `radius` → stored as `preferences.distance` (`hybridMatchService.ts:26`) and **not used** by any filter or score: `rg distance` over `hybridMatchService.ts` and `neo4jService.ts` finds only the type declaration (generation/matching map §F3 says the same: the cypher returns no distance). Location is a city `CONTAINS` / exact state match (`neo4jService.ts:~380-385`).
- The client never sends `budget`, `radius` or `has_portfolio` (map §F2). The route also has no rate limiter although `semantic-match` 100/h exists in `src/lib/rate-limit.ts:10,31` (map §F2). Each uncached search costs an embedding call and graph queries (`hybridMatchService.ts` has a 5-minute in-process cache keyed on query+preferences+max, `:105-106,340-346`).
- Money convention: ADR-0054 says money is integer cents on payment paths and out-of-range values are rejected. The matcher's `hourlyRate` is dollars (mock rows use 200–300, `neo4jService.ts:110-155`), a separate, existing convention; the new field must state its unit.

## 2. Competitor evidence

Tinder treats intent as a first-class required field ("Looking for" / "Add Relationship Intent") and requires 2 photos before any match is shown, stating what more photos buy (T1, T3; `~/reports/tatttester/2026-10-24-rea-tinder.html`, DOM read of the onboarding form, status "observed · DOM"). The report notes Tinder's matcher behaviour on the intent field was **not observed** (the swipe-deck request contract was not reached), so nothing here claims that intent changes Tinder's recommendations. The proposal is TattTester's own use of the same shape.

## 3. Scope and non-goals

In scope: an intent selector and a budget selector on `/smart-match`; sending `has_portfolio` from intent; sending `budget` from the budget selector; validating the three fields on the route; carrying selections in the URL; an honest statement of what each pill does.

Non-goals: a radius pill that does nothing (see 4.2); a free-text budget field; using intent to change style weights or the vector query; rate limiting the route as a general fix (flagged as adjacent, 8.4); the deposit ladder (that is booking money, ADR-0054, not matching budget); changing `scoreAggregation` weights.

## 4. Proposed change

### 4.1 User-visible behaviour

1. Under the style pills, a row "What are you after?" with single-select pills: **First small tattoo**, **Big piece or sleeve**, **Cover-up**, **Just exploring**. None selected by default. Choosing a big piece or a cover-up asks for artists with shown work (has_portfolio); the others do not.
2. A row "Hourly rate you're comfortable with" with single-select pills: **Up to $150/hr**, **Up to $250/hr**, **Up to $400/hr**, **No limit** (default). The wording says hourly because that is the unit the artist data has; the help text explains that artists who haven't published a rate are still shown.
3. A line under the pills tells the customer what was applied: "Showing artists with portfolios. Rate limit applies where artists list one." The line appears only when something is selected.
4. Selections persist in the URL (`?intent=big&rate=250`), so refresh and the back button keep them; with `?ds=` the brief prefill still runs and the pills are untouched.
5. No radius control is shown at launch (4.2).

### 4.2 Data and API

- **Client.** Add `intent` and `rate` state to `SmartMatchClient.tsx`. Request body gains `has_portfolio: boolean` and, when set, `budget: number` (dollars per hour; the field name stays `budget` because the route and engine already call it that, with a code comment stating the unit). `radius` is sent only when a radius control exists. `max_results` unchanged.
- **Intent mapping (pure, tested):** `intentToFilters(intent) → { hasPortfolio: boolean }`: first small tattoo → false; big piece → true; cover-up → true; just exploring → false. These are proposals; open question 8.1.
- **Rate mapping:** pills map to `budget` 150 / 250 / 400 / null. Note the engine's 1.5× tolerance means "Up to $150/hr" passes artists up to $225/hr in the hard filter (`neo4jService.ts:391`); copy must not promise a hard cap (4.3).
- **Route validation** (`src/app/api/v1/match/semantic/route.ts`): reject, do not clamp (ADR-0054's rule): `budget` must be a finite number in 1–2,000 or absent; `radius` a finite number in 1–500 or absent; `has_portfolio` boolean or absent. Invalid → 400 `{error, code:'INVALID_PREFERENCES'}`. Today `budget || null` silently swallows `0`/`NaN`.
- **Surface the real error.** The client currently discards the response body and shows "HTTP 400/500" (`SmartMatchClient.tsx:122`, map §H); read `error` so validation messages are shown.
- **Radius.** Because `distance` is unused, sending `radius` has no effect today. Two honest options (decide in 8.2): (a) leave radius out of the UI and out of the request until spec 14's tier-2 distance exists; (b) add a city-only fallback ("same city") that is just the existing location filter and does not pretend to be miles. Recommended: (a). When tier-2 lands, wire `radius` into the Cypher with the customer's coordinates and extend `intentToFilters` accordingly. The route keeps accepting `radius` so the contract stays stable.
- **Broadening interplay.** `hasRelaxableFilters` only counts styles and location (`hybridMatchService.ts:~405-410`); a thin result caused by `has_portfolio` or `budget` is not broadened. **Unverified** whether the relaxed query reuses `budget`/`hasPortfolio`; read `executeGraphQuery`'s relaxed call (`hybridMatchService.ts:~412-418`). Decision for spec 14's second deck: relax them too, and name which ones in the reason line.
- **Cache key** already includes preferences (`hybridMatchService.ts:105-106`); no change.
- **Analytics.** None added; the turn is derivable from the request.

### 4.3 Copy (ADR-0036)

The rate pills mention money, but as an artist's hourly rate in a search filter, not as booking money; the money sentence (who pays what and who keeps what) is for surfaces where the customer pays. Whether a search filter needs it is not stated by the ADR and is left to 8.3. "TattTester" for any brand string.

- Row labels: "What are you after?" / "Hourly rate you're comfortable with".
- Pills as in 4.1.
- Applied line: "Showing artists with portfolios. Rates are a guide — artists who haven't listed one are still shown."
- Help under rate: "Based on artists' listed hourly rates, with some give. Many artists haven't listed one."

## 5. Failure and edge cases

1. A selection removes everyone: the existing empty state, now with the spec 14 alternatives deck; the message names the filters in play ("with portfolios, up to $150/hr") so the customer knows what to loosen.
2. `has_portfolio` and an artist whose images are withheld by `SHOW_UNCLAIMED_PORTFOLIOS=false`: the Cypher counts stored `portfolioImages` (`buildHasPortfolioClause`), not displayable images, so an unclaimed artist can satisfy "has portfolio" and then show no hero image on the card (spec 14). **Unverified** whether to align the clause with the display gate; flagged as a correctness gap, not fixed here. Decide in 8.5.
3. `?intent=` or `?rate=` with an unknown value: ignore it (no pill selected), do not 400.
4. `budget` present but no artists have a `hourlyRate`: the filter and score are neutral; the engine behaves as if unset, as designed (`neo4jService.ts:391,424`). The applied line still appears; accept, or show it only when the result set contains at least one priced artist (more honest; costs one extra pass over the results).
5. Signed-out customers: unchanged (sign-in required before search, map §H).
6. Old bookmarks without params: unchanged behaviour.
7. Rapid pill toggling: debounce the auto-run on `?ds=` only; manual search remains button-driven.

## 6. Test plan

Extend:
- `src/app/smart-match/SmartMatchClient.test.tsx`: selecting intent/rate changes the request body (`has_portfolio`, `budget`); defaults send neither; URL params restore the selection; `?ds=` prefill unaffected; the 400 error message is displayed instead of "HTTP 400".
- `src/features/match-pulse/services/__tests__/hybridMatchService.rating.test.ts` (or the broadening test): `preferences.hasPortfolio` and `budget` reach the graph call; documents that `distance` is ignored (a test that fails the day radius starts working, forcing the doc to be updated).

Add:
- `src/app/api/v1/match/semantic/__tests__/route.test.ts` (new; none found for this route): rejects `budget` 0, negative, NaN, 5000; rejects `radius` out of range; accepts absent fields; passes validated values into `findMatchingArtists`.
- `src/app/smart-match/intentFilters.test.ts` (new): `intentToFilters` and the rate-pill map are total over their inputs.

## 7. Effort and dependencies

S: two pill rows, a pure mapping, route validation, URL state. Radius is intentionally not shipped. Independent of the other specs; its second-deck interplay is noted in spec 14.

## 8. Open questions for Samson

1. Intent set and mapping: are these four right, and should "Big piece or sleeve" and "Cover-up" really imply "must have shown work"? (Drives only `has_portfolio` today.)
2. Radius: leave it out until real distance exists (recommended), or ship a "same city" control now?
3. Do search filters that mention an artist's hourly rate need ADR-0036's money sentence, or does that law cover only payment surfaces?
4. Adjacent finding, not in scope: the `semantic-match` rate limiter (100/h) is defined but not applied to this route (map §F2), and each uncached search calls the embedding provider. Worth a separate small ticket before launch traffic.
5. `has_portfolio` counts stored images, not displayable ones (5.2). Should the clause use the same gate as the display (`filterPortfolioForDisplay`), so "has a portfolio" and "shows a portfolio" agree?
