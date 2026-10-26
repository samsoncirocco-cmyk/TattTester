# Spec 13 — Persist swipe decisions per user, and hydrate pins

Status: draft · Effort: **M** · Depends on: none; [14](14-swipe-card-evidence-undo-and-broadened-deck.md) (undo, second deck) builds on this · Rollup rank 11, part T2 (gaps T2, T4)

## 1. Problem

Pins and passes live in the browser only, under a hardcoded user, and the pin list is lost on refresh. Wrong on day one: a customer who pins three artists, reloads or switches phones, sees the swiped cards come back and the pins gone, and nothing the customer decided is available to the product.

Current behaviour (generation/matching map §F1, §E2, §G; `src/app/swipe/SwipeClient.tsx`, `src/utils/matching.js`, `src/store/useMatchStore.ts` unchanged at 1e301a1):

- `/swipe` makes no fetch. A swipe, pass or pin calls `trackSwipe(card.id, direction)` (`SwipeClient.tsx:76-80`), which writes `localStorage.tattester_swipes` under the hardcoded user `'user-123'` (`src/utils/matching.js:290-316`; code comment "MVP: Store swipes in localStorage"). No route receives a swipe (map §F1: "[not found] any route that receives it").
- `liked` is React state only (`SwipeClient.tsx:74-77`) and resets on refresh. `getLikedArtists` (`matching.js:323-326`) has no caller in `src`.
- The deck itself persists: `/smart-match` puts matches in the zustand store persisted as `tatt-match-storage` (`src/store/useMatchStore.ts:42-103`, persist `:81-88`), so a refresh keeps the deck but `swipedIds`/`liked` reset and already-swiped cards return (`SwipeClient.tsx:73`, index by id Set; hydration gate `:85-101`).
- Pinned artists reach the booking flow only on the "Deck complete" screen, as `Book` links `/book?artistId=…&ds=…` (`SwipeClient.tsx:46-49,265-284`).
- A separate local favourites concept exists: `localStorage "tatt:favorites"` (`src/lib/tattStorage.ts:19`) and a `favorite` prop on `ArtistCard` rendering a "Pinned" badge (`src/components/punk/ArtistCard.tsx` `:144`; booking map §E). Whether the swipe pins and these favourites are meant to be one list is **unverified**; they do not share storage today.
- `/smart-match` requires sign-in (client `getApiAuthHeaders` throws `SignInRequiredError`, map §H), so anyone who reaches a deck has a verified uid.
- Server-side swipe learning: none ("nothing learns from them", rollup).

## 2. Competitor evidence

Tinder (signed-up account, passes only, 2026-10-26; `~/reports/tatttester/2026-10-24-rea-tinder.html`):
- Every decision on the profile form is persisted server-side under the account before the deck exists (T2, DOM).
- A pass is one `POST /pass/{userId}` call of about 195–246 ms and the next card is on screen before the reply arrives (optimistic UI); the request method is inferred, the URL and timing observed from the page's own resource timeline (REA saw no traffic on this service-worker page).
- Two rapid NOPE presses produced two distinct `/pass/{id}` calls for two different ids; no duplicate for the same id.
- Likes were not exercised, so what a like writes, and any pagination or refill behaviour, is unknown. Failure of a pass call was not seen ("inferred: a failure would have to be reconciled silently").

## 3. Scope and non-goals

In scope: store each pin/pass per verified uid on the server; the swipe UI stays instant (optimistic); on load, hydrate pins and passes so a refresh resumes where the customer left off; a read for pins that other pages can use.

Non-goals: learning from decisions (re-ranking, "more like this") — data is kept so that can come later; undo and the second deck (spec 14); merging with `tatt:favorites` (open question 8.1); cross-device sync of the deck itself (the deck lives in the zustand store; hydrating decisions is enough to make a regenerated deck coherent); any use of decisions in artist-facing surfaces; analytics dashboards.

## 4. Proposed change

### 4.1 User-visible behaviour

1. Swiping works exactly as now: the card leaves at once; nothing waits on the network.
2. Refresh, or open the deck on another device after signing in: swiped cards do not come back, the "Pinned: n" counter is right, and "Deck complete" shows the same pins.
3. A fresh search from `/smart-match` makes a new deck; artists the customer already passed in this design session are not shown again as new cards unless they pick "show passed artists" (decision in 8.2).
4. If saving fails, the customer is not interrupted; the decision is retried quietly. After repeated failures a small "not saved — check your connection" line appears.

### 4.2 Data and API

- **Storage.** Firestore collection `match_decisions`, one document per `(uid, artistId)`: id `${uid}__${artistId}`, fields `{uid, artistId, decision: 'pin'|'pass', dsId?: string, source: 'swipe', decidedAt, updatedAt}`. Client access denied in `firestore.rules` (server-only, like `booking_holds` at `firestore.rules:62`); read/written through the routes below. Firestore is the right home: per-user, small, already used for sessions and holds. Not Neo4j (matching reads the graph; user decisions should not mutate it) and not Supabase.
- **Write.** `POST /api/v1/match/decision` body `{artistId, decision: 'pin'|'pass', dsId?}`; auth via `verifyApiAuth` + `verifyFirebaseToken` (uid from the token only, never from the body, unlike the hard-coded `'user-123'`); validates `artistId` is a non-empty string ≤ 128 chars and `dsId` a UUID if present; upsert; returns 204. A `DELETE /api/v1/match/decision?artistId=` removes one (used by spec 14's undo). New rate limiter `match-decision` (e.g. 120/min per uid) in `src/lib/rate-limit.ts` (limiter definitions at `:10,31,33,51-55`); note the existing `semantic-match` 100/h limiter is defined and unused (map §F2), so reuse the same wiring pattern deliberately.
- **Read.** `GET /api/v1/match/decisions?ds={dsId}` returns `{decisions: [{artistId, decision}]}` for the caller, optionally scoped to a design session (`dsId` match) or all recent (cap 500, newest first). Used by `/swipe` on mount and by "Deck complete".
- **Client.** Replace `trackSwipe`'s `localStorage` write in `SwipeClient.tsx:76-80` with a small `decisionsClient.record(artistId, decision, dsId)`: updates local state first, then fires the POST, with a bounded in-memory retry queue (3 tries, backoff 1/3/9 s) and `keepalive: true` on `pagehide` so the last swipe survives a tab close. On mount: `GET`, then seed `swipedIds` and `liked` and advance the deck past decided cards. The legacy `tattester_swipes` key is ignored and, after a successful first hydrate, removed (pre-launch, no real data; the key only ever held `'user-123'` entries).
- **Scope of "decided".** A decision is global per uid+artist (re-pinning overwrites), with `dsId` recording the deck that produced it. This matches the product meaning "I liked this artist" better than "I liked this artist in this search"; open question 8.2.
- **Privacy.** Decisions are personal data about the customer's preferences. They are not exposed to artists, are keyed by uid, and are removed with the account. **Unverified:** whether an account-deletion path exists that enumerates user-keyed Firestore collections; read it and add `match_decisions` (and `generation_credits`-style per-user docs already there) if there is one.
- **Idempotency.** Upserts are naturally idempotent per `(uid, artistId)`; no key needed (contrast spec 5).

### 4.3 Copy (ADR-0036)

No money mentioned. "TattTester" for any new name.

- Save failure (after retries): "Not saved yet — we'll keep trying."
- Show-passed toggle (if built): "Show artists I passed."
- Header counter and Deck complete copy unchanged ("Pinned: n"; "Swipe right to pin, left to pass.").

## 5. Failure and edge cases

1. Signed-out visitor reaching `/swipe` with a persisted deck from an earlier sign-in: decisions are not written; the page shows the existing sign-in prompt path (`SignInRequiredError`) on first action. **Unverified** whether `/swipe` itself requires auth on load; the deck store is a localStorage persist (`tatt-match-storage`) that survives sign-out, so a signed-out visitor could swipe a stale deck. Decide: block writes silently, or require sign-in (preferred, consistent with `/smart-match`).
2. Artist removed after being pinned (takedown, ADR-0025): pins pointing at removed artists must not render; the hydration join to the deck handles it (decisions only apply to cards present), and the pin list on any future "my pins" page must filter by the same `NOT_REMOVED` guard (`neo4jService.ts` `NOT_REMOVED`, which every matching read applies).
3. Two devices swiping the same deck: last write wins per artist; counters reconcile on next load.
4. Decision for an artist id that never appears in any deck (hand-crafted request): accepted (validated shape only); harmless, capped at 500 reads. Add a per-uid document cap (e.g. 2,000) with oldest-first eviction to bound abuse.
5. Rapid double swipe on the same card: two writes, same document; last wins.
6. Network down for a whole session: the queue holds up to 200 decisions in memory; the tab closing loses them, accepted.
7. The deck is regenerated by a new search: old decisions are kept; the new deck is filtered by them per 4.1.3.
8. Clock: `decidedAt` set on the server; the client time is never trusted.

## 6. Test plan

Add:
- `src/app/api/v1/match/decision/__tests__/route.test.ts` (new): requires auth; uid comes from the token and a body `uid` is ignored; upsert pin then pass overwrites; DELETE removes; invalid `decision`, oversized ids rejected; rate limit; cap eviction.
- `src/app/api/v1/match/decisions/__tests__/route.test.ts` (new): returns only the caller's decisions, filtered by `ds`, newest first, capped at 500.
- `src/app/swipe/decisionsClient.test.ts` (new): optimistic update before the POST resolves; retry/backoff; `keepalive` on pagehide; queue cap.

Extend:
- `src/app/swipe/page.test.tsx`: hydration seeds `swipedIds`/`liked` and skips decided cards; counter correct after reload; no `localStorage.tattester_swipes` write.
- `src/store/useMatchStore.test.ts`: persisted deck plus hydrated decisions yield the right remaining cards.

## 7. Effort and dependencies

M: two routes, one collection with rules, a client module and the hydration logic. Spec 14's undo needs the DELETE route from here.

## 8. Open questions for Samson

1. Are swipe pins and the existing favourites (`tatt:favorites`, the "Pinned" badge on `ArtistCard`) one list or two? Recommendation: one list, with this server collection as the source and `tatt:favorites` migrated or retired; decide before building because it changes where "my pins" lives.
2. Should an artist the customer passed in an earlier search ever reappear? Recommendation: hidden by default for 30 days, with a "show artists I passed" toggle.
3. Should signed-out visitors be allowed to swipe at all? Recommendation: no; `/smart-match` already demands sign-in, so `/swipe` should too.
