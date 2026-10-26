# Spec 1 — Resumable and releasable slot hold

Status: draft · Effort: **M** · Depends on: none (pairs with [5](05-idempotency-keys-and-in-flight-guard.md), which adds keys to the same three routes) · Rollup rank 1 (gaps C3, K1, C7)

## 1. Problem

A customer who reloads, retries after an error, or presses Back from Stripe is stranded and then blocked by their own hold until it lapses. Wrong on day one: a customer who reaches the last step of a reservation and then hits any hiccup cannot book the chair they were already holding for up to 35 minutes.

Current behaviour (citations from the booking map, main @ 6b1a0af; `src/app/book/*`, `src/lib/booking-holds*`, `src/app/api/checkout/*` and the Stripe webhook are unchanged at the worktree base 1e301a1):

- The hold is placed only inside `submit()` after the capture call; `holdId` is a local variable that never leaves the function (`src/app/book/BookClient.tsx:295-351`). Nothing is stored in the URL, localStorage or a cookie (booking map §B, §G).
- Every `submit()` begins with `POST /api/v1/book`, which mints a new `BK-` id (`src/app/api/v1/book/route.ts:123`). If a hold exists for the earlier id, `requestHold` treats it as another booking's hold (`bookingId !==` conflict, `src/lib/booking-holds.ts:196-202`) and the offer hides the slot (`src/lib/booking-offer.ts:144-146`), so the retry gets 409 `SLOT_GONE` on the customer's own slot until the 35-minute TTL lapses. **Inferred from code, not executed.** The same mechanism applies after returning from Stripe via `cancel_url` (`src/app/api/checkout/route.ts:351-353`).
- The server can already treat a same-booking re-hold as a refresh (`booking-holds.ts:199`; `src/lib/booking-holds-persistence.ts:122-128`), but the client never reuses a booking id, so the path is never taken.
- No client-callable release route exists. `releaseHoldById` (`booking-holds-persistence.ts:153-170`) is called only from `/api/checkout` refusal paths via `releaseHoldQuietly` (`checkout/route.ts:77-91`; callers `:157`, `:163`, `:185`).
- Holds are **not** released on: checkout 404 from `getArtistStripe` (`checkout/route.ts:317-320`), Stripe-not-configured 503 (`:291-297`), Stripe session-create 502 (`:464-470`), or Stripe cancel (`cancel_url` just returns to `/book`, `:351-353`). **Inferred:** those holds sit until TTL.
- There is no handler for `checkout.session.expired`; the webhook cases are at `src/app/api/webhooks/stripe/route.ts:330,403,414,449,455,462`.
- `releaseExpired` (`booking-holds.ts:236-247`) has no non-test caller; expiry is decided by the clock at read time (`booking-holds.ts:103-107`), so a lapsed doc stays `status:"active"` but is ignored. This is fine for correctness and is a non-goal here.
- `src/app/bookings/bookingStatus.ts:21-27` states the product position: a `held` booking "has no resumable checkout link".
- A `held -> pending` edge is declared (`src/lib/booking.ts:169-171,194`) but nothing writes it on lapse (booking map §B).

## 2. Competitor evidence

- Calendly keeps the chosen month, date and slot in the URL; reload and Back both work (rollup C3; `~/reports/tatttester/2026-10-23-rea-calendly.html`, evidence `ev_0a06479d`). Calendly takes no hold at all (C7: contention resolved once at submit; the Stripe-step behaviour was not observed).
- Cal.com takes the hold the instant a slot is picked, renews it silently, releases it on unmount, and keys it by a cookie so a reload refreshes the same hold (rollup K1; `~/reports/tatttester/2026-10-23-rea-calcom.html`; source `useSlots.ts:140-155`, `reserveSlot.handler.ts:26`). Observed in source only; hosted Cal.com was not exercised.
- TattTester needs the hold because Stripe Checkout is a separate page (C7). The goal is to keep the hold and remove its failure cost, not to copy Calendly's no-hold model.

## 3. Scope and non-goals

In scope: the booking id and hold id survive a reload; a repeat hold for the same booking is a refresh; a release route; release on Stripe cancel and on every checkout refusal path; a `checkout.session.expired` webhook case.

Non-goals: a countdown timer (see open question 2); changing `HOLD_TTL_MINUTES` (35, `booking-holds.ts:50`); an expiry sweep cron; auto-refund of a paid deposit on a lapsed hold (rollup rank 17, separate); idempotency keys (spec 5); slot refresh (spec 6).

## 4. Proposed change

### 4.1 User-visible behaviour

1. Picking a slot and moving on keeps the customer's place. Reloading `/book` mid-form returns them to the same step with the same slot and fields still holding where possible (the typed fields are an open question, see 8.1).
2. A retry after an error, a double attempt, or pressing Back from Stripe re-uses the same booking and extends the hold; it never reports "taken" for the customer's own slot.
3. Leaving on purpose frees the chair: pressing Cancel on Stripe, or abandoning the Stripe page until it expires, releases the hold within seconds rather than at TTL.
4. If the hold has genuinely lapsed on return, the customer sees the lost-race state from spec 2, not a generic error.

### 4.2 Data and API

- **State carrier.** Put `bookingId` in the URL as `?bk=BK-…` alongside `artistId` and `ds`. Hold id is not needed client-side if the server can find it from the booking doc (`holdId` is already stamped on the booking at `src/app/api/v1/book/hold/route.ts:141-161`). Recommended: URL carries `bk`; the page's server component loads the booking (owner-checked, same ownership check as `hold/route.ts:71-73`) and passes `{bookingId, heldSlot, holdExpiresAt, step}` to `BookClient`. A cookie is the alternative (Cal.com's pattern), rejected as primary because the URL survives share-to-self and device switch and is inspectable in tests. Open question 1.
- **`BookClient.submit()`.** Reuse an existing `bookingId` instead of calling `POST /api/v1/book` again. `POST /api/v1/book` accepts an optional `bookingId` and, when it names a booking owned by the caller in a pre-payment state (`pending|held`), updates it in place rather than creating a new one. Validation stays in `src/lib/booking.ts:284-318`. The 5/hour IP limit (`book/route.ts:11-23`) then counts creations, not retries.
- **Same-booking re-hold.** Already supported server-side; add a test pinning it (section 6). `offer` computation for the owner's page load must pass `excludeBookingId = bk` so their own held slot stays selectable (`booking-offer.ts:144-146` already has the parameter).
- **Release route.** `DELETE /api/v1/book/hold` body `{bookingId}` (ownership-checked like `hold/route.ts:71-73`; 204 on success and on already-released). Implemented over `releaseHoldById`. Booking status returns to `pending` (the declared `held -> pending` edge, `booking.ts:169-171`).
- **Release on every checkout refusal.** In `src/app/api/checkout/route.ts`, call `releaseHoldQuietly` on the `getArtistStripe` 404 (`:317-320`), the Stripe-not-configured 503 (`:291-297`; but see edge case 5.4) and the session-create 502 (`:464-470`), in addition to the three existing sites.
- **Stripe cancel.** Change `cancel_url` (`:351-353`) to `/book?artistId=…&bk=…&cancelled=1`. On load with `cancelled=1` the client calls the release route only if the customer then picks a different slot or leaves the form; do not release immediately, since Back-from-Stripe is usually "I changed my mind about the size", not "give up the chair". Open question 3.
- **Webhook.** Add a `checkout.session.expired` case in `src/app/api/webhooks/stripe/route.ts` that reads `metadata.holdId` / `bookingId` (already set at `checkout/route.ts:384`), releases the hold, and moves the booking `held -> pending`. It must be idempotent through the same `processedStripeEvents` mechanism as the other cases (`webhooks/stripe/route.ts:151-158`). Stripe fires this when the session reaches its pinned `expires_at` (`checkout/route.ts:449-454`), which is the same moment the hold lapses.
- **Client unmount.** Optional: `navigator.sendBeacon` to the release route on `pagehide` when on the review step with a live hold. Marked optional: `sendBeacon` cannot set the `Authorization` header that `verifyApiAuth` / `verifyFirebaseToken` read in `hold/route.ts:38-41`, so it would need a token in the body. Unverified whether the API-key check accepts that.

### 4.3 Copy (ADR-0036)

Quiet voice, "TattTester" never "TatT". No money is mentioned in the new strings, so the money sentence is not required here; the existing deposit sentences are untouched.

- Resumed: "Picking up where you left off. Your time is still held."
- Hold lapsed on return: handled by spec 2's `HOLD_LOST` copy.
- Cancel return: "You're back. Your time is held until {time}."
- Fix the stale comments in `hold/route.ts:5,163` ("30 minutes") while there; the code is 35.

## 5. Failure and edge cases

1. `bk` names a booking owned by someone else: behave as no `bk` (fresh form); never reveal that the id exists. 403 stays on the API.
2. `bk` names a booking already `deposit_paid` or later: redirect to `/bookings` or `/book/success?bookingId=`; do not reopen the form.
3. Hold expired but booking still `held`: page load recomputes the live offer; if the slot is free, re-hold on submit as a refresh; if not, spec 2's lost-race state. The booking doc is reused, not orphaned.
4. Stripe unset (demo / payments not configured): today the client shows the in-page "Request sent" card and the hold is deliberately not released (`BookClient.tsx:435-483`, booking map §F). Decide: release it, since no payment can follow. Default: release.
5. Two tabs on the same booking: last write wins on the hold; both see consistent server state on next load. Not worth locking.
6. Release route racing the webhook that converts a hold to booked: `convertHoldById` (`booking-holds-persistence.ts:172-189`) must win; the release route must no-op when the hold is already `converted`. Tested.
7. Anonymous bookings. Ownership today is `doc.uid` compared with the caller's token uid; a booking with `uid: null` (signed-out capture, `src/app/api/v1/book/route.ts:133`) passes the check for any caller (`src/app/api/v1/book/hold/route.ts:70-79`, read at 1e301a1). So a release or resume route built on the same check would let anyone who learns an anonymous `BK-` id release or resume it. Mitigation: for `uid: null` bookings require a signed per-booking token (HMAC of the id) in the cookie or URL. Open question 4.

## 6. Test plan

Extend:
- `src/lib/booking-holds.test.ts`: same-booking re-hold refreshes; different-booking overlap still conflicts; release is idempotent; release after convert is a no-op.
- `src/app/api/checkout/route.test.ts`: each refusal path (artist 404, Stripe unset, Stripe 502, intro-required, bookability 503) releases the hold exactly once.
- `src/app/api/webhooks/stripe/route.test.ts`: `checkout.session.expired` releases the hold, flips `held -> pending`, is idempotent on replay, and ignores sessions with no `holdId`.
- `src/app/book/page.test.tsx`: `?bk=` for an owned held booking hydrates the held slot; for someone else's booking it does not.
- `src/app/api/v1/book/__tests__/route.test.ts`: posting with an owned `bookingId` updates in place and does not create a second booking or consume the rate limit.

Add:
- `src/app/api/v1/book/hold/__tests__/release.test.ts` (new): DELETE happy path, 403 not owner, 204 already released.
- `src/app/book/BookClient.resume.test.tsx` (new): reload with `bk` reuses the booking id, does not call `/api/v1/book` a second time, and a simulated 409 on the owner's own slot does not occur.

## 7. Effort and dependencies

M. One new route, one webhook case, URL state plumbing, a booking-reuse branch in the capture route. Shares `submit()` with specs 2, 5 and 6: land 1 first, then 5; 2 can land in parallel on the 409 branch only.

## 8. Open questions for Samson

1. URL param (`?bk=`) or cookie for the booking id? Recommendation: URL, because it also survives a copy-link to another device.
2. Should the customer see a hold countdown ("held for 31 more minutes")? Not in this spec; it is a follow-up if the resume path alone does not remove the confusion.
3. On returning from Stripe via Cancel, release at once or keep until the customer leaves? Recommendation: keep; release on leaving or on TTL.
4. Signed-out bookings have `uid: null` and the ownership check lets any caller through (edge case 7). Sign-in required at capture, or a signed resume token for anonymous bookings? Recommendation: signed token; sign-in at capture adds friction before the customer has seen a price.
