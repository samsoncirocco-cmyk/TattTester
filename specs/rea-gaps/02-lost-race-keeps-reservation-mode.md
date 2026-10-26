# Spec 2 — A lost race keeps reservation mode

Status: draft · Effort: **S** · Depends on: none (richer once [1](01-resumable-releasable-slot-hold.md) stops orphaning booking records and [6](06-availability-endpoint-and-slot-check.md) supplies a refetch endpoint; ships without either) · Rollup rank 2 (gaps K4, C1)

## 1. Problem

When another customer takes the slot first, the product silently becomes a different product. Wrong on day one: a customer who chose a confirmed time is moved to "pick dates and the artist will confirm", still having been told they were reserving.

Current behaviour (booking map §F, main @ 6b1a0af; `BookClient.tsx` and the checkout route are unchanged at 1e301a1):

- Hold 409 (`SLOT_GONE`, either variant: slot no longer in the live offer `src/app/api/v1/book/hold/route.ts:111-116`, or overlapping live hold `:126-130` "Someone just took that time.") clears the selected slot, sets `reservationLost` to "That time was taken while you were filling this in. Pick your dates and the artist will confirm.", jumps to step 0 and drops to the request-mode date picker because `reserving` goes false (`src/app/book/BookClient.tsx:308-317`; `reserving` `:187-188`; message render `:602-606`). The booking record from step 1 is orphaned as `pending`.
- Hold non-409 failures (503 not reservable, 403, 400, no `holdId`) show "We couldn't hold that time. Your request is saved — the artist will confirm a slot with you." and go to the "Request sent" card (`BookClient.tsx:318-329`, `:435-483`). This is correct only when the server says the artist is no longer in reservation mode.
- Checkout 409 `HOLD_LOST` ("That time is no longer held. Pick another." / "That time is no longer available.", `src/app/api/checkout/route.ts:245-253,272-277`) is not special-cased; it renders as the generic inline error with the phase back to the form (`BookClient.tsx:377-385`). It reads like a bug.
- Slots are rendered once per page load (`src/app/book/page.tsx:70`), so the lost slot still appears free in the grid after the failure.

## 2. Competitor evidence

Cal.com error copy is keyed, specific and says what to do next ("return to the previous page and select another time"); the final arbiter is a DB unique constraint surfaced as one error key (rollup K4, K2; `~/reports/tatttester/2026-10-23-rea-calcom.html`; source `common.json:1176`). Observed in source only. Calendly's lost-race copy was **not observed** (no submit was performed; rollup "What was not verified"). Calendly's range endpoint is the model for the refetch (C1, `ev_51e4c2a5`).

## 3. Scope and non-goals

In scope: on hold 409, stay in reservation mode, refetch slots, mark the lost slot "Taken", keep the form; give `HOLD_LOST` its own message and a "Pick another time" action.

Non-goals: the availability endpoint itself (spec 6; this spec uses a page refresh until then); resumable bookings (spec 1); offering a waitlist; automatically choosing the next-nearest slot.

## 4. Proposed change

### 4.1 User-visible behaviour

1. Customer loses the race at hold time. They stay on the reservation screen, the slot they picked now shows "Taken" and cannot be selected, the other open times are fresh, and everything they typed is still there. Message: a single line above the slots saying that time just went and to pick another.
2. If the artist has no other open times, the page says so and offers the request path as an explicit choice, not an automatic demotion.
3. Customer loses the race at checkout (`HOLD_LOST`). They return to the slot step with the same message and a "Pick another time" action; the lost slot shows "Taken".
4. If the server says reservation is no longer available at all (non-409 with `mode !== "reservation"`, e.g. the calendar sync went stale, `src/lib/booking-mode.ts:189-194`), the current demotion to request mode is kept, now with copy that says the artist's calendar is not live right now. That is the honest case.
5. Any other failure (network, 400, 403, missing `holdId`) stays on the form with a retry, not on the "Request sent" card. **Changed from today:** these are not evidence that reservation is unavailable.

### 4.2 Data and API

- `hold/route.ts`: keep `code: 'SLOT_GONE'` on both 409 variants; add a stable `reason` (`not_offered` | `taken`) for tests only. No change to status codes. Return the already-computed live `slots` in the 409 body (the route recomputes the live offer at `:94-116`), so the client can mark the slot taken and refresh the grid without a second round trip. Unverified: whether returning slots in an error body is acceptable for the route's cache/rate semantics; same data the page already ships.
- `BookClient.tsx`: new state `takenSlots: Set<string>` (key `date|startTime`); on 409 add the slot, replace `offer.slots` with the 409 body's slots (or `router.refresh()` as the fallback while the body field is absent), clear `selectedSlot` only, set `reservationLost` to the new message, keep `reserving` true and the step at the slot step. Do not jump to step 0 unless the form's slot step is step 0; the point is that the form data is not cleared.
- Special-case `HOLD_LOST` at `BookClient.tsx:377-385`: same handling as a hold 409 plus mark the lost slot taken. The checkout response must carry the lost slot (it knows `date/startTime/endTime`, `checkout/route.ts:245-277`); add it to the 409 body.
- Stop orphaning the booking record: until spec 1 lands, send the same `bookingId` on retry is not possible, so mark the orphan `cancelled` via the existing transition when the customer re-submits. If spec 1 has landed, the booking is reused and nothing is orphaned.

### 4.3 Copy (ADR-0036)

Quiet voice, "TattTester" in any user string. No money is mentioned, so the money sentence is not required.

- Hold or checkout lost: "That time just went. Pick another and we'll hold it."
- Slot chip: "Taken".
- No times left: "No other times are open right now. You can send a request instead and the artist will confirm a time."
- Reservation unavailable (calendar not live): "This artist's calendar isn't live right now, so this is a request. They'll confirm a time."

## 5. Failure and edge cases

1. The refreshed slot list is empty: show copy 3 and the explicit "Send a request" button; do not auto-switch.
2. The customer's own previous hold is what blocks them (the inferred self-lockout in spec 1): spec 1 fixes the cause. Until it lands, this spec's 409 branch will show "Taken" for the customer's own slot; note this in the PR and sequence 1 before 2 if both are in flight.
3. Two lost races in a row: no limit; each is its own message.
4. Offer recomputation itself fails on the hold route (it fails closed, 503 with `mode`/`reason`, `hold/route.ts:94-104`): follow the "reservation unavailable" branch only if the body's `mode` is not `reservation`; otherwise retry on the form.
5. Screen readers: the message sits in an `aria-live="polite"` region and focus moves to the first open slot.

## 6. Test plan

Extend:
- `src/app/api/v1/book/__tests__/route.test.ts` is for capture; add hold coverage in a new file (below).
- `src/app/api/checkout/route.test.ts`: `HOLD_LOST` 409 includes the lost slot.
- `src/app/book/page.test.tsx`: no change needed beyond a regression that `excludeBookingId` is honoured on the owner's reload.

Add:
- `src/app/api/v1/book/hold/__tests__/hold-409.test.ts` (new): both 409 variants return `SLOT_GONE` with a `reason` and the live slots.
- `src/app/book/BookClient.lostrace.test.tsx` (new, jsdom, fetch mocked): hold 409 keeps `reserving`, marks the slot "Taken", keeps typed fields, and does not render the request-mode date picker; hold 503 with `mode:"request"` does demote; hold 500/network stays on the form with retry; checkout `HOLD_LOST` shows the new copy and the "Pick another time" action.

## 7. Effort and dependencies

S. One client state branch, two server body additions, copy. Do not wait for spec 6; use `router.refresh()` or the 409 body slots. Share the `submit()` branch with specs 1 and 5.

## 8. Open questions for Samson

1. When no other times are open, is "send a request instead" the right fallback, or should the customer be sent back to the artist list to pick another artist?
2. Is the 409 body returning the live slot list acceptable, or should the client always call the spec 6 endpoint? Recommendation: body now, endpoint later.
