# Spec 3 — Reply-time promise, artist reminders and expiry for request mode

Status: draft · Effort: **M** for Variant A (L if the claimed-artist refund path needs new Stripe work, see 8.2) · Depends on: none · Touches ADR-0005/0006 territory and needs a new ADR (see 4.2) · Rollup rank 3 (gap K5)

## 1. Problem

Request mode takes a deposit and then goes quiet. Wrong on day one: at launch most artists will be in request mode, since reservation needs a claimed profile with a live synced calendar (`src/lib/booking-mode.ts:165-208`), so the typical first booking is a customer paying into an open-ended wait.

Current behaviour (booking map §D, main @ 6b1a0af; unchanged at 1e301a1):

- The request path is **not** a no-money enquiry: after capture the client immediately calls `/api/checkout` and sends the customer to Stripe (`src/app/book/BookClient.tsx:335-361`). The only no-deposit path is `/intro` for non-bookable artists (`src/app/book/page.tsx:48-52`).
- No response-time promise is rendered anywhere. "The artist will contact you within 24 hours." exists only in the capture API's `message` field (`src/app/api/v1/book/route.ts:173`), and `BookClient` never reads `bookData.message` (booking map §D). Searching `src/` for 24 hours / response time / 48 hours finds nothing else.
- Success copy after payment: "Your deposit cleared. Your requested time is with the artist — they confirm the final slot." (`src/app/book/success/page.tsx:338`). In-page card: "They'll confirm a time from your requested dates." (`BookClient.tsx:435-483`).
- There is no expiry for a captured request on a **claimed** artist. The `expired` status exists in the state machine (`src/lib/booking.ts:193-194,201`) and in customer copy (`src/app/bookings/bookingStatus.ts:80-81`) but no code sets it (booking map §D).
- The only clock is for **unclaimed**-artist held deposits: `DEPOSIT_HOLD_DAYS` default 7 (`src/lib/deposit-hold.ts:7-10`), refunded by the daily cron `GET|POST /api/cron/expire-deposits` (`src/app/api/cron/expire-deposits/route.ts:35-57`, `CRON_SECRET` bearer `:21-33`; schedule `0 9 * * *`, `vercel.json`) through `refundRelay` (`src/lib/booking-relay.ts`). That window is an artist-onboarding deadline, not a reply deadline (`src/lib/money-copy.ts:28-59`).
- There are no artist reminders. The existing artist notification fires once on `checkout.session.completed` for held deposits (`src/app/api/webhooks/stripe/route.ts:344-379`).

## 2. Competitor evidence

- CoCreate (published, not observed; its terms bar competitors from using the service, so only public pages were read): its custom booking request is idea + budget, the artist replies with an estimate and availability, and a deposit is taken afterwards (`~/reports/tatttester/2026-10-26-rea-cocreate.html`, row O3, status "published"). This is the basis for Variant B below.

Cal.com's requires-confirmation bookings do not block the slot by default, remind the host at 48/24/3 hours and tell the attendee exactly who still has to act (rollup K5; `~/reports/tatttester/2026-10-23-rea-calcom.html`; source `bookingReminder/route.ts:22-45`). Observed in source only. Hosted Cal.com's unpaid-booking expiry is unknown (rollup "What was not verified"). The rollup proposes "the artist replies within 48 h"; that number is the rollup's proposal, not an observed competitor value.

## 3. Scope and non-goals

In scope: a visible reply-time promise on the request card, review step and success page; reminders to the artist; an expiry that moves an unanswered request to `expired` and refunds the deposit automatically; customer notification of the outcome.

Non-goals: the artist's confirm/counter UI (exists elsewhere, not traced, booking map §C); changing reservation mode; the `/intro` flow; SMS reminders; changing `DEPOSIT_HOLD_DAYS`; chasing a paid deposit on a lapsed hold (rollup rank 17).

## 4. Proposed change

### 4.1 User-visible behaviour

1. Before paying, a request-mode customer sees: the artist replies within N hours; if they have not, the deposit is returned in full automatically.
2. After paying, the success page and `/bookings` show the deadline as a date and time in the customer's local zone (see spec 4 for zones) and who still has to act.
3. If the artist replies in time, nothing new. If not, the booking moves to Expired, the customer is told by email and on `/bookings`, and the deposit is refunded without them asking.
4. The artist gets reminders at roughly the halfway point and with 6 hours left, from the existing daily cron cadence (so granularity is daily; see 4.2).

### 4.2 Data and API

- **Promise length.** New env var `REQUEST_REPLY_HOURS` (default 48) declared in `src/config/envSchema.js`, `.env.example` regenerated with `npm run env:example`. 48 is the rollup's proposal; the existing API string says 24 (open question 8.1).
- **Deadline field.** On booking creation in request mode, stamp `replyBy` (ISO) on the booking doc. Reservation mode does not get one. For unclaimed artists the earlier of `replyBy` and the relay expiry applies; the existing relay refund path remains authoritative for them.
- **Cron.** Extend the daily `/api/cron/expire-deposits` handler or add `/api/cron/request-expiry` with its own `vercel.json` entry (preferred, separate failure domain; same `CRON_SECRET` bearer). Each run: (a) find bookings in `deposit_paid` or `pending` request mode with `replyBy` in the past and no artist action → transition to `expired` via the existing state machine (`booking.ts:193-194,201`) and refund; (b) find those with `replyBy` within the reminder windows → send a reminder once per window (record `remindersSent: [..]` on the doc for idempotency).
- **Refund.** Unclaimed artists: existing `refundRelay`. **Claimed artists**: the charge is a destination charge with `application_fee_amount` and `transfer_data` (`src/app/api/checkout/route.ts:323-326,399-405`), so the deposit has already moved to the artist's connected account. Refunding needs `reverse_transfer: true` and `refund_application_fee: true` so the customer gets the deposit and the booking fee back. **Unverified:** whether any existing code does a destination-charge refund; search `src/lib/stripe.ts` and the artist cancel flow before sizing. Money stays in integer cents with out-of-range values rejected (ADR-0054).
- **Reminder channel.** Unverified which artist channel exists (email vs the claim-flow notification used at `webhooks/stripe/route.ts:344-379`). The spec requires "the channel the artist already receives new-request notices on"; the implementer names it in the PR.
- **Surface.** `bookingStatus.ts` gains a request-pending line with the deadline; `book/success/page.tsx:338` adds the deadline sentence; `BookClient.tsx` request card and review step render the promise (use `offer.mode === 'request'`).
- **ADR.** Write ADR-0062 recording: request mode has a reply deadline; the deadline outcome is `expired` + full refund; the cron owns it. This is a product commitment about customer money and belongs in an ADR, as ADR-0005/0006 did for held deposits.

### 4.3 Copy (ADR-0036)

Money is mentioned, so the money sentence rides along in the variant for the artist's claim state (ADR-0036 amendment: claimed = artist keeps 100% of the deposit and the booking fee is the only part we keep; unclaimed = held deposit, released on claim or refunded in full).

- Request card / review: "{Artist} replies within {48} hours. If they don't, your deposit comes back in full — automatically." followed by the existing money-sentence variant from `src/lib/money-copy.ts`.
- Success: "Your request is with {Artist}. They'll reply by {Thu 7:00pm your time}."
- Expired: "{Artist} didn't reply in time, so your deposit is on its way back. You can try another artist."
- Artist reminder: "A booking request from {first name} is waiting. Reply by {time} or their deposit is returned."

### 4.4 Variant B — estimate before deposit (option, not the recommendation for launch)

Variant A above keeps today's shape: capture, then Stripe, then wait for the artist. Variant B changes the order for request mode: the customer sends the idea, a budget and preferred dates with **no payment**; the artist replies with an estimate and a time; the customer accepts and only then pays the deposit through the existing checkout. CoCreate publishes this shape for custom requests (row O3). Nothing in this variant was observed in use.

What changes:
- `BookClient.tsx:335-361` stops calling `/api/checkout` after capture in request mode; the "Request sent" card (`:435-483`) becomes the normal end state, with the same reply-time promise ("replies within N hours; nothing is charged until you accept").
- New booking states between `pending` and the existing paid states, e.g. `quoted` (artist replied with estimate + time) and `accepted`, added to the state machine in `src/lib/booking.ts:193-194`. The customer gets a link to a pay page that creates the checkout session with the artist's quoted slot; reservation-mode artists are unaffected.
- A minimal artist reply surface (estimate in cents per ADR-0054, a date/time, a note). The artist-side confirm/counter flow was not traced in the booking map (§C) — **unverified** whether it can carry an estimate.
- Expiry still applies, now to the unanswered request (no money to return) and to an unaccepted quote (shorter, e.g. 72 hours).

Trade-offs:
- For: no money moves until both sides agree, which removes the claimed-artist refund-reversal problem in Variant A (8.2) and answers "why did I pay before anyone replied".
- Against: a second round trip and a drop-off point between quote and payment; ADR-0027 and ADR-0005/0006 assume the deposit precedes confirmation (ADR-0027's table: "deposit precedes confirmation; artist may counter"), so this needs a superseding ADR; and **unclaimed** artists cannot reply in-product, so Variant B can only apply to claimed artists, leaving the held-deposit model in place for the rest (two request flows to maintain).
- Effort: L (state machine, quote UI for artists, accept/pay page, copy for four new states).

## 5. Failure and edge cases

1. Artist replies at the last minute while the cron is mid-run: transition guard `canTransition` (`booking.ts`) makes the second writer lose; expiry is a Firestore transaction on the doc, re-reading status.
2. Refund fails (Stripe error): leave the booking in `deposit_paid`, record `expiryRefundFailedAt`, retry on the next run, alert via the existing logging; never mark `expired` without a successful refund.
3. Daily cron granularity means a 48-hour promise can lapse up to ~24 hours late. State the promise as "within 48 hours" in copy and treat expiry as "after 48 hours" (never earlier than promised). Consider an hourly schedule if the lateness matters (open question 8.3).
4. Cron secret unset: the handler already refuses (`expire-deposits/route.ts:21-33`); copy that pattern.
5. Request made while Stripe is unconfigured: no deposit exists; show the promise without the refund clause (`BookClient.tsx:461-469` path).
6. Timezone of the displayed deadline: customer-local if known, else UTC with a label; see spec 4.

## 6. Test plan

Extend:
- `src/lib/booking.test.ts`: `expired` transition legality from `deposit_paid` request-mode; `replyBy` stamping only in request mode.
- `src/app/api/webhooks/stripe/route.test.ts`: a request-mode paid booking gets `replyBy` on reconcile if absent (reconstructed bookings, `webhooks/stripe/route.ts:108-143`).
- `src/lib/deposit-hold.test.ts`: unclaimed `min(replyBy, relayExpiry)` rule.
- `src/app/bookings/bookingStatus.test.ts`: request-pending copy includes the deadline; expired copy mentions the refund.
- `src/app/book/success/page.test.tsx`: deadline sentence renders for request mode only.

Add:
- `src/app/api/cron/request-expiry/__tests__/route.test.ts` (new): bearer required; expires past-deadline requests; skips answered ones; idempotent reminders; refund failure leaves state unchanged; claimed artist refund passes `reverse_transfer` and `refund_application_fee` (Stripe mocked).

## 7. Effort and dependencies

M for the promise, reminders and unclaimed refunds; adds L-sized risk for claimed-artist destination-charge refunds. No code dependency. Specs 4 (zone display) and 1 (releasing the hold) are adjacent but independent.

## 8. Open questions for Samson

1. 48 hours (rollup) or 24 hours (the string already in the API)? Whatever is chosen is a public promise.
2. Claimed artists have already received the transfer. Is reversing it automatically on expiry acceptable, or should expiry hold the deposit on the platform for claimed artists in request mode, as it does for unclaimed ones? (Changes ADR-0007's flow; needs your call.)
3. Is a daily reminder/expiry cadence good enough, or does an hourly cron cost matter?
4. Variant A (promise + expiry + refund, this spec's main body) or Variant B (estimate before deposit, 4.4)? Recommendation: ship A first, because it works for claimed and unclaimed artists and is mostly reminders and a cron; treat B as the target flow for claimed artists once real artists are replying, and decide it with your first artist conversations. If B is chosen later, A's promise copy and cron expiry still apply to the unanswered-request stage.
5. Should the customer be able to cancel a pending request themselves and get the deposit back before expiry?
