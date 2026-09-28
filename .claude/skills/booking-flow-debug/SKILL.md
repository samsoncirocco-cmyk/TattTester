---
name: booking-flow-debug
description: Use when a booking surface misbehaves — "reservation mode never shows", hold placement 409/503s, slots missing from /book, checkout refusing with 404/503, stale availability, or triaging issue #312. Do not use for money-movement questions (deposits, transfers, refunds — see stripe-deposits) or for general test/CI failures (see verify-changes).
---

# Booking flow debugging runbook

Full error matrix with statuses and causes:
[references/error-matrix.md](references/error-matrix.md).

## The one function that decides everything

`resolveBookingMode` (`src/lib/booking-mode.ts`) fails closed to
`"request"` mode. Reservation requires ALL six gates, checked in order:

1. claimed profile (`claimedByUid` via `isArtistClaimed`,
   `src/lib/artist-ownership.ts`) — else `not_claimed`
2. live calendar connection (no `revokedAt`,
   `src/lib/artist-calendar-connection.ts`, Firestore
   `artist_calendar_connections/{artistId}`) — else `no_calendar`
3. published hours (`hasPublishedHours`, `src/lib/artist-availability.ts`,
   Firestore `artist_availability/{artistId}`) — else `no_published_hours`
4. free/busy fetch succeeded (`readArtistBusy` →
   `fetchFreeBusy`, `src/lib/artist-calendar.ts`) — else a mapped failure
   reason (`calendar_unauthorized`, `calendar_error`, `not_configured`, …)
5. free/busy fresh: age ≤ `MAX_SYNC_AGE_MINUTES = 10` — else `sync_stale`
6. hold store writable (`holdsWritable()`,
   `src/lib/booking-holds-persistence.ts`) — else `holds_unavailable`

The decision is computed per render by `getBookingOffer`
(`src/lib/booking-offer.ts`), never stored. Its only two callers:
`src/app/book/page.tsx` and `src/app/api/v1/book/hold/route.ts`. The 503
from the hold route includes the `reason` — read it before theorizing.

## Symptom → where to look

| Symptom | Look at |
|---|---|
| Artist shows "Availability on request" unexpectedly | Walk the six gates above, in order; the `reason` names the failing gate |
| Hold route returns 503 | `book/hold/route.ts` — three distinct 503s: ownership read failed, mode != reservation (carries `reason`), or `placeHold` unavailable (no admin credential / transaction threw) |
| "Someone just took that time" (409 `SLOT_GONE`) | `requestHold`/`slotsConflict` in `src/lib/booking-holds.ts`; overlap is half-open interval logic |
| Checkout 404/503 with a hold active | `src/app/api/checkout/route.ts` refusal branches — see issue #312 below |
| Booking stuck in a status | `BOOKING_TRANSITIONS` in `src/lib/booking.ts` (`canTransition` rejects same-state) |
| Booking request "succeeded" but no Firestore doc | `book/route.ts` falls back to `/tmp/tatt-data/bookings.jsonl` on Firestore failure and still returns 200 |
| Bookings page copy wrong | `bookingsListMoneyCopy` in `src/lib/money-copy.ts`; the regex tests in `money-copy.test.ts` are the spec — read them first |

## Gotchas

- **`sync_stale` is nearly unreachable.** There is no free/busy cache;
  `fetchedAtMs` is stamped at fetch time, so gate 5 only trips on clock
  skew (`ageMs < 0`) or an artificial input. If you see `sync_stale` in the
  wild, suspect clocks, not caching.
- **There is no hold-release endpoint.** Release is a side effect:
  `releaseHoldQuietly` inside checkout refusals, `releaseHoldById` (whose
  boolean result every caller ignores), lazy TTL expiry via `isHoldLive`
  (`HOLD_TTL_MINUTES = 35`), or `placeHold` replacing the same booking's
  prior hold in-transaction. No cron expires slot holds.
- **Issue #312 (open) is partially stale on main.** It reports the 503
  (bookability failure) and 404 (artist not found) checkout branches not
  releasing the hold; on current main both DO call `releaseHoldQuietly`.
  Remaining leaks: the 503 "Payments are not configured." branch, the later
  second 404 artist lookup, and the 409 `HOLD_LOST` branches. Verify with
  `gh issue view 312` and read the route before "fixing".
- **Bookings-list copy is pinned by tests.** `money-copy.test.ts` requires
  "deposit goes to your artist in full", "only part we keep", "unclaimed
  profile", "relay", "automatically refunded in full" and "within N days",
  and forbids "hold window", "held during verification" and "claim window
  closes". Change the tests deliberately, not reactively. (Issue #313,
  which drove this wording, closed 2026-08-10.)
- **35 vs 30 minutes.** `HOLD_TTL_MINUTES = 35` is authoritative; some
  comments (hold route header, Stripe expiry note) still say 30.
- **A calendar entry with `errors` is not "free".** `fetchFreeBusy` treats
  a missing calendar entry or entry errors as `calendar_error`
  deliberately — do not soften it into an empty busy list.
- **Reconnect clears revocation.** `saveCalendarConnection` uses `set`
  without merge, so reconnecting wipes `revokedAt`; a "revoked" artist who
  reconnected leaves no trace of the revocation.
