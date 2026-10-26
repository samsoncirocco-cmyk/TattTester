# Spec 5 — Idempotency keys on capture, hold and checkout, plus an in-flight guard

Status: draft · Effort: **S** · Depends on: none; sequence after [1](01-resumable-releasable-slot-hold.md) because both edit `submit()` and the capture route · Rollup rank 7 (gap K2)

## 1. Problem

A fast double-click or a retry can create two bookings and spend the 5-per-hour limit. Wrong on day one: the first customer who double-taps "Pay" on a phone gets two booking records, and the second one is an orphan the artist may see.

Current behaviour (booking map §F, main @ 6b1a0af; unchanged at 1e301a1):

- The only double-submit guard is `disabled={phase === "submitting"}` on the review CTA (`src/app/book/BookClient.tsx:999`), where `phase` is React state set at the top of `submit()` (`:243`). There is no ref or in-flight lock. A second click before React re-renders can start a second `submit()`. **Inferred, not executed.**
- No server idempotency key exists on `POST /api/v1/book` (`src/app/api/v1/book/route.ts:25`), `POST /api/v1/book/hold` (`hold/route.ts:37`) or `POST /api/checkout` (`src/app/api/checkout/route.ts:93`) (grep: none).
- Every `submit()` mints a new `BK-` id (`book/route.ts:123`) and consumes the in-memory per-instance IP limit of 5/hour (`:11-23,36-41`).
- The hold itself is sound: `placeHold` is a Firestore transaction (`src/lib/booking-holds-persistence.ts:101-131`); the Stripe webhook is idempotent on event id via `processedStripeEvents` (`src/app/api/webhooks/stripe/route.ts:151-158,197`). Stripe session creation at `checkout/route.ts:410` has no `idempotencyKey` option (grep: none found; unverified beyond the map).

## 2. Competitor evidence

Cal.com's final arbiter is a database unique constraint on (start, end, host), surfaced as one error key; it also has a deterministic booking idempotency key (rollup K2; `~/reports/tatttester/2026-10-23-rea-calcom.html`; source `booking-idempotency-key.ts:23-54`). Observed in source only. Calendly's and hosted Cal.com's double-submit behaviour was not observed.

## 3. Scope and non-goals

In scope: an `Idempotency-Key` request header accepted on the three routes; a synchronous in-flight ref in `submit()`; Stripe `idempotencyKey` on session creation.

Non-goals: replacing the Firestore hold transaction; a distributed rate limiter (the in-memory limit is a known weakness, separate); captcha (rollup rank 18); retry/backoff in the client.

## 4. Proposed change

### 4.1 User-visible behaviour

A double-click, a double-tap or a flaky-network retry produces exactly one booking, one hold and one Stripe session. The customer sees one "Preparing checkout…" state; a retry after a transient failure continues the same attempt instead of failing or duplicating.

### 4.2 Data and API

- **Key.** The client creates one UUID per submit attempt and sends it as `Idempotency-Key` on all three calls, derived per route as `${key}:capture|hold|checkout`. A new attempt after a **user-visible failure** gets a new key; a network retry of the same attempt reuses it.
- **Store.** A small Firestore collection `idempotency_keys/{hash}` with `{route, uid|ip, status:'in_progress'|'done', response:{status, body}, createdAt, ttlAt}`. Written in a transaction: first writer proceeds; a concurrent second request with the same key returns 409 `REQUEST_IN_FLIGHT` (client treats as "still working", polls nothing, just shows the busy state); a later request with a `done` record gets the stored response replayed. TTL 24 hours. Firestore client access denied in `firestore.rules`, as for `booking_holds` (`firestore.rules:62`).
- **Helper.** `src/lib/idempotency.ts`: `withIdempotency(req, routeName, handler)`; each of the three routes wraps its handler. Without the header, behaviour is unchanged (backward compatible; other callers exist, unverified: grep for other callers of these routes before shipping).
- **Capture.** With spec 1 landed, capture is already "update in place when `bookingId` supplied"; idempotency covers first creation.
- **Checkout.** Pass an `idempotencyKey` option (the string `checkout:{bookingId}:{holdId or nohold}:{amountCents}`) as the second argument to `stripe.checkout.sessions.create` (`checkout/route.ts:410`) so a duplicate request cannot create two live sessions. Stripe idempotency keys expire after 24 hours and conflict if the parameters differ; a changed size changes the amount and therefore the key.
- **Client.** `submit()` gets `const inFlight = useRef(false)`: return immediately if true, set true before the first await, clear in a `finally`. The disabled button stays as the visual cue.
- **Fail-open or closed.** If the idempotency store is unreachable: fail **open** for capture and checkout (a rare double beats blocking a booking), but keep the Stripe-side key, which does not depend on our store. The hold route stays protected by its transaction. State this choice in a code comment.

### 4.3 Copy (ADR-0036)

No money is mentioned. One new string for `REQUEST_IN_FLIGHT`, shown only if it ever surfaces: "Still working on that one. Give it a moment."

## 5. Failure and edge cases

1. Same key, different body: return 422 `IDEMPOTENCY_KEY_REUSED`; never replay a response for a different request.
2. In-progress record never completes (function timed out): treat `in_progress` older than 60 seconds as stale and allow takeover; `done` replay is unaffected.
3. Replayed response contains a Stripe URL after the session expired: replay only within the session's life; checkout records are keyed with the session `expires_at` and are not replayed after it.
4. Key header missing from older clients mid-deploy: behaves as today.
5. IP-limited 429 on capture: not stored as `done` (a rate-limit refusal must not be replayed as the answer to a later retry).
6. Two tabs: separate keys by design; the hold transaction and spec 1's booking reuse handle the rest.

## 6. Test plan

Add:
- `src/lib/idempotency.test.ts` (new): first writer proceeds; concurrent same-key returns `REQUEST_IN_FLIGHT`; completed key replays; different body returns 422; stale `in_progress` takeover; store failure fails open.
- `src/app/book/BookClient.doubleclick.test.tsx` (new): two synchronous clicks produce one `/api/v1/book` call.

Extend:
- `src/app/api/v1/book/__tests__/route.test.ts`: same key twice creates one booking and does not consume the limit twice; 429 not cached.
- `src/app/api/checkout/route.test.ts`: `stripe.checkout.sessions.create` called with the idempotency key option; same-key replay does not create a second session.
- `src/lib/booking-holds.test.ts`: unchanged semantics under concurrent identical requests (transaction already covers; add the regression).

## 7. Effort and dependencies

S: one helper, three route wrappers, one ref. Do after spec 1 (shared files). No dependency on 2, 3, 4, 6.

## 8. Open questions for Samson

1. Fail open or fail closed when the idempotency store is down? Recommendation: open, per 4.2, because the Stripe key and the hold transaction still protect money and the slot.
2. 24-hour key lifetime is Stripe's own; fine for bookings?
