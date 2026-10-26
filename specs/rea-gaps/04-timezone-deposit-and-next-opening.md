# Spec 4 — Timezone label, deposit ladder and next opening

Status: draft · Effort: **S** for the timezone label and window fix; **M** if the roster card needs a cached next-opening field (see 4.2) · Depends on: none to start; the window fix in 4.2 is reused by [6](06-availability-endpoint-and-slot-check.md) · Rollup ranks 4 and 5 (gaps C2, K7, C4, C6, K6)

## 1. Problem

Two day-one problems in the same place. (a) Slot times have no timezone, so a customer on a different clock cannot tell what "2:00 PM" means, and the window can be off by a day. (b) Price and availability appear only mid-funnel, so a customer commits to an artist before learning the deposit or whether there is an opening.

Current behaviour (booking map §A and §E, main @ 6b1a0af; no booking or artist-page file changed by #400/#401):

- Timezone: `BookClient.tsx:65` declares `timezone?: string` on the offer type and never reads it again; slot buttons print `slot.startTime` raw (`src/app/book/BookClient.tsx:631`). The server does return the artist's schedule timezone (`src/lib/booking-offer.ts:135,154-158`). Request-mode dates come from `upcomingDays(28)` on the browser's local date (`BookClient.tsx:105-117`).
- Window: `getBookingOffer` starts the 28-day window at `toISODate(new Date(nowMs))` (`booking-offer.ts:95`) and `toISODate` is `toISOString().slice(0,10)`, the **UTC** date, not the artist's local date (`src/lib/scheduling-engine.ts:155-157`). For a US-evening request the first day shown can be one day ahead of the artist's calendar.
- Roster cards show only slug, name, city, hero image, handle and first style (`src/components/punk/ArtistCard.tsx:22-46`, rendered by `src/app/artists/page.tsx:81-93`); `RosterArtist` has no price, response-time or availability field (`src/lib/artists-graph.ts:43-76`).
- Profile CTA is `bookingTier`-driven: "Book the chair" or "Request an intro"; sub-copy "A deposit holds your request — the artist confirms the time." / "No deposit is taken."; deposit amount not shown (`src/app/artists/[slug]/page.tsx:301-312,336-338,444-450`).
- `/book` artist strip shows name, shop, location and one coarse `availabilityLabel` pill (`BookClient.tsx:503-518`). Deposit shows per size option (`:773`) and in the review breakdown (`:934-946`). The coarse pill and the live-slot `offer.label` are independent signals that can disagree (`:589`; inferred).
- Deposit ladder in cents: small 7500 / medium 15000 / large 30000 / sleeve 50000 (`src/lib/booking.ts:88-93`); dollars exist for UI copy only (`depositDollarsForSize`, ADR-0054).
- The review CTA reads "Preparing checkout…" while submitting (`BookClient.tsx:1000-1001`), not the amount.

## 2. Competitor evidence

- Calendly: every spot carries an ISO start with offset and the page shows the zone with the current local time (rollup C2; `~/reports/tatttester/2026-10-23-rea-calendly.html`, `ev_51e4c2a5` lookup body and DOM). The event-type lookup publishes `next_availability` and `last_availability`, and days before the first are visibly disabled (C4). Price is part of the event name and visible from first paint (C6, DOM).
- CoCreate (published, not observed; `~/reports/tatttester/2026-10-26-rea-cocreate.html`): states a flat $10 client fee with the artist keeping 100% in one sentence on its home page (row O1, "published"); its directory card shows years tattooing ("est. 2018"), a "+1" marker for additional locations and an instant-book badge, with no price, rating, response time or next opening (rows O4, O5, "published"). Its only availability signal is a binary Books Open / Books Closed set by the artist.
- Cal.com: timezone and 12/24-hour preference persist in localStorage and the invitee zone drives slot keys (K7, source). Price with currency is a first-paint sidebar block and the CTA says "Pay to book" (K6; source `Details.tsx:175-195`, observed in source only).

## 3. Scope and non-goals

In scope: artist-zone label and current local time on slots; the customer's own time shown when the zones differ; the window starting on the artist's local date; deposit ladder on the profile CTA and `/book` header; the CTA naming the amount; next opening on the roster card, profile and `/book` header.

Non-goals: letting the customer choose a display timezone (a preference toggle is a follow-up); a 12/24-hour setting; request-mode date picker semantics beyond using the artist zone for "tomorrow"; the availability endpoint (spec 6); changing deposit amounts or the fee model.

## 4. Proposed change

### 4.1 User-visible behaviour

1. Under the slot grid heading: "Times are in {artist city}'s time ({PT}). It's {5:47 pm} there now." When the customer's browser zone differs, each chosen slot also shows "= 8:00 pm your time" on the review step.
2. The first day offered is the artist's local tomorrow or later, per their minimum notice, never a UTC artifact.
3. The artist card shows "Next opening Nov 3" when known, and "Deposits from $75" (see the money-law question in 8.1).
4. The profile CTA reads for bookable artists "Book the chair — deposit from $75"; the `/book` header shows the ladder ("$75 small · $150 medium · $300 large · $500 sleeve") and the next opening.
5. Once a size is chosen, the review CTA reads "Pay $150 deposit to hold" (reservation) or "Pay $150 deposit to request" (request).

### 4.2 Data and API

- **Slots carry instants.** `getBookingOffer` returns each slot with `startsAt`/`endsAt` ISO strings including offset (computed from artist zone, using the schedule's `timezone`), in addition to the existing wall-clock `date/startTime/endTime`. `src/app/book/page.tsx:71-81` passes them through (note it currently drops `durationMinutes`, `:71-81`; pass it too since it is free).
- **Window in artist zone.** Replace `toISODate(new Date(nowMs))` (`booking-offer.ts:95`) with a helper `toZonedISODate(nowMs, timezone)` in `scheduling-engine.ts`; keep `toISODate` for UTC callers. Check every caller of `toISODate` before changing: `scheduling-engine.test.ts` pins current behaviour.
- **Label.** `BookClient.tsx` reads `offer.timezone`; format with `Intl.DateTimeFormat(undefined, {timeZone, timeZoneName:'short'})`. The "now" clock re-renders on a 60-second interval; stop it when the tab is hidden.
- **Next opening.** `getBookingOffer` already computes the full slot list; `nextAvailability` is its first element. For `/book` and the profile this costs nothing extra. For **roster cards** it would mean a calendar free/busy read per artist per page, which is the expensive part (reservation mode depends on a Google read no older than 10 minutes, `src/lib/artist-calendar.ts:74`, `booking-mode.ts:189-194`). Recommended: write `nextOpeningAt` onto the artist's availability doc whenever calendar sync or the schedule changes, and have the roster read that field; absent field = no chip. **Unverified:** where calendar sync writes and whether a hook exists; read `src/lib/artist-calendar*.ts` before sizing. This is what makes the roster part M.
- **Deposit ladder.** Read from `DEPOSIT_CENTS_BY_SIZE` through `depositDollarsForSize` (ADR-0054); never hard-code dollars in components. Add a small `depositLadder()` helper returning the four sizes in cents so cards, profile and header agree.
- **Roster data.** Extend `RosterArtist` (`artists-graph.ts:43-76`) with `nextOpeningAt?: string` and `depositFromCents?: number` (the latter is the ladder's minimum and does not vary per artist today).
- **Optional card fields from CoCreate's card (row O5).** `activeSinceYear?: number` (render "est. 2018") and `extraLocations?: number` (render "+1"). **Unverified** that the Neo4j artist graph holds either: `RosterArtist` has neither (`artists-graph.ts:43-76`) and the scraper schema was not read. If the data is absent the fields stay unset and the card shows nothing; do not infer tenure from scraped post dates.

### 4.3 Copy (ADR-0036)

Names say "TattTester". **Money is mentioned**, so each money-bearing surface carries the money sentence in its claimed/unclaimed variant (`src/lib/money-copy.ts`), not only the card chip. See 8.1.

- Zone line: "Times are in {Austin} time (CT). It's 5:47 pm there now."
- Review conversion: "8:00 pm your time".
- Card: "Next opening {Nov 3}". No opening: say nothing, never "unavailable" (it may only mean the field is absent).
- CTA: "Pay {$150} deposit to hold". Fee line already exists in `CheckoutEstimate` (`BookingConfidence.tsx:111-146`).

### 4.4 Fee-model copy (decision pending; see 8.4)

Whichever fee model stays must be one sentence on the pricing page and in the `/book` header, in the claimed-artist variant of the money sentence (ADR-0036 amendment: the artist keeps 100% of the deposit, and the booking fee is the only part we keep). Copy for each, ready to paste:

- **Percentage (today, ADR-0007; `PLATFORM_FEE_BPS` default 1000, `src/lib/stripe.ts:44`):** "You pay the deposit plus a 10% booking fee. The artist keeps 100% of the deposit; the booking fee is the only part TattTester keeps."
- **Flat (CoCreate's published model, row O1):** "You pay the deposit plus a $10 booking fee. The artist keeps 100% of the deposit; the booking fee is the only part TattTester keeps."

The unclaimed-artist variant (held deposit, ADR-0006/0008) is unchanged under both. This spec does not recommend changing ADR-0007; it only records that the sentence must exist on both surfaces whichever way the decision goes. Today the fee percentage appears at the review step only (`BookingConfidence.tsx:111-146`).

## 5. Failure and edge cases

1. `timezone` missing from the schedule: label reads "Times are in the artist's local time" with no clock; do not guess.
2. Daylight-saving transitions: a slot at a skipped or repeated local hour; the scheduling engine currently builds wall-clock strings (unverified how it handles DST). Add cases to `scheduling-engine.test.ts` for the two transition dates; if the engine is wrong, record it as a bug rather than silently fixing inside this spec.
3. Customer browser zone unknown or blocked: omit the "your time" conversion.
4. Request mode (no slots): show the artist-zone line only on the time-of-day preference ("Morning" means artist-morning); say so.
5. `nextOpeningAt` stale (artist booked out since sync): the chip is a hint; the grid is the truth. The chip's time is tolerable to be stale by minutes; if older than a day, hide it.
6. Roster pages for artists in request mode: no next-opening chip (there are no concrete slots, `booking-offer.ts:131-133`).

## 6. Test plan

Extend:
- `src/lib/scheduling-engine.test.ts`: `toZonedISODate` at an evening-UTC instant for `America/Los_Angeles` and `Pacific/Auckland`; DST spring-forward and fall-back days; window start equals artist-local date.
- `src/app/book/page.test.tsx`: props include `startsAt` and `timezone`.
- `src/components/punk/ArtistCard.test.tsx`: renders the next-opening chip when provided, nothing when absent.
- `src/lib/booking.test.ts`: `depositLadder()` equals `DEPOSIT_CENTS_BY_SIZE` and `depositDollarsForSize` for every size.
- `src/app/book/BookingConfidence.test.tsx`: CTA amount formatting.

Add:
- `src/app/book/BookClient.timezone.test.tsx` (new): label and "now" clock render for a given zone; "your time" conversion appears only when zones differ; slot button text unchanged for same-zone customers.
- `src/app/artists/__tests__/profile-cta.test.tsx` (new): deposit-from line and money sentence present for bookable artists, absent for `/intro` artists ("No deposit is taken").

## 7. Effort and dependencies

S for 4.1 items 1, 2, 4, 5 (all data already on hand). M if the roster chip is built (cached field + sync hook). Spec 6 reuses `toZonedISODate`; build this first or together.

## 8. Open questions for Samson

1. ADR-0036 law 2 says every surface mentioning money states who pays what in one visible sentence, with no exceptions without a superseding ADR. Does a card chip like "Deposits from $75" need the full sentence, or should the card carry no money and only the profile and `/book` do? Recommendation: card shows next opening only; money lives on profile and `/book`.
2. Roster next-opening: build the cached field now, or ship the label, header and profile first and add cards later?
3. Should the artist city be named in the zone line, or only the abbreviation ("CT")? The city is friendlier but the schedule may not store one distinct from the artist's location.
4. Fee model. CoCreate publishes a flat $10 client fee with the artist keeping 100% (`~/reports/tatttester/2026-10-26-rea-cocreate.html`, O1, published); TattTester charges a percentage on top of the deposit (ADR-0007). This spec makes no recommendation to change ADR-0007. Question: is the percentage staying? Either way the one-sentence copy in 4.4 has to ship on the pricing page and the `/book` header before launch; with the ladder at $75–$500 a 10% fee is $7.50–$50, a flat $10 is $10 for all.
5. Should the card show tenure ("est. 2018") and "+1 location" at all if the graph only has them for some artists? A partial signal can make unlisted artists look newer.
