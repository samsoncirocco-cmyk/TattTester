# Spec 16 — Artist policies, FAQ and travel dates on the claimed profile

Status: draft · Effort: **M** · Depends on: none to build; reads best after [4](04-timezone-deposit-and-next-opening.md) (profile CTA block) and must stay consistent with [3](03-reply-time-promise-and-request-expiry.md) (platform-level reply and refund promises) · Added by amendment from the CoCreate report (published rows only); not one of the rollup's fifteen ranked changes

## 1. Problem

A customer cannot read anything about an artist's deposit, cancellation or travel before paying. Wrong on day one: the profile asks for a deposit ("A deposit holds your request — the artist confirms the time.") and says nothing about what happens to it, whether the artist is in town next month, or the answers to the ten questions every artist gets asked.

Current behaviour (main @ 6b1a0af; `src/app/artists/[slug]/page.tsx` and `src/lib/artist-profile.ts` are unchanged at base 1e301a1):

- The public profile shows a rating sticker when the shop has one (`src/app/artists/[slug]/page.tsx:213-228,272-290`), the portfolio (`:107-174`, `:363-374`), the provenance label for unclaimed profiles (`:342-381`, gated on `!artist.claimed` at `:351`) and a booking module with the CTA and one sub-line (`:296-339`). No policy, FAQ, travel or video content exists (booking map §E: deposit amount, price and response time "[not found]" on the profile).
- The artist-editable surface is narrow by design. `ARTIST_MANAGED_PROFILE_FIELDS` is `name, shopName, bio, bookingUrl, city, state` with per-field length limits (`src/lib/artist-profile.ts:1-21`); `validateArtistProfilePatch` rejects any other key (`:30-38`). The route `GET/PATCH /api/v1/artist/profile` resolves identity from the verified Firebase uid and the human-approved claim, never from the client (`src/app/api/v1/artist/profile/route.ts:1-10,52-56`); the editor UI is `src/app/artist/profile/ArtistProfileEditor.tsx`, linked from the console (`src/app/console/page.tsx:282-285`). Instagram is deliberately immutable (identity anchor). Writes land on the Neo4j `:Artist` node (`artistManagedFields`, `profileManagedAtEpochMs` in `PROFILE_RETURN`, route `:52-56`).
- A cancellation-policy concept exists elsewhere: ADR-0054 constrains `cancellationPolicyPartialRefundBps` to 0–10000 (`docs/adr/0054-money-in-cents-reject-out-of-range.md`). **Unverified** where that value is stored and whether any customer surface reads it; check `src/lib/session-types.ts` before wiring policy text to it.

## 2. Competitor evidence

CoCreate (published, not observed; its terms bar competitors from using the service, so only its public pages were read): artist profiles carry FAQs and policies ("when do you travel, what's your rate, when do Books Open"), a video intro, and guest-spot and convention availability; artist cancellation and deposit policies are the artist's own, published on their profile FAQ; clients are told payments are final on the platform level (`~/reports/tatttester/2026-10-26-rea-cocreate.html`, row O7 and the "Booking and payment contract" table, status "published"). Nothing about how a customer reacts to these fields, or how they are edited, was observed.

## 3. Scope and non-goals

In scope: three new artist-editable content areas on a **claimed** profile — policy text (deposit, cancellation/rescheduling, aftercare/health notes), FAQ entries, and travel/guest-spot/convention dates — edited in the existing profile editor and rendered above the booking CTA. The honesty rule: unclaimed profiles show none of it, and show no placeholder implying the artist wrote it.

Non-goals: changing how money moves (policy text does not alter refunds; see 5.1); a video intro (open question 8.2; the media-licensing path is its own thread, TAT-40 per the profile route's header comment); an instant-book priced-design product (CoCreate row O2, parked in the study); artist tenure/location chips on the roster card (spec 4); a free-text rich editor; translations.

## 4. Proposed change

### 4.1 User-visible behaviour

1. A claimed artist opens Edit profile and sees three new sections: "Policies", "Questions I get asked", "Where I'll be". Each is optional and starts empty.
2. On the public profile of a claimed artist who filled any of them, a "Before you book" block sits directly above the booking module: the policies in plain text, the FAQ as a short list, and upcoming travel dates with city and date range. Empty sections do not render at all.
3. An unclaimed profile renders none of this and gains no new text; the provenance label and claim door (ADR-0036 law 3) are unchanged. A visitor can never read policy text that the artist did not write.
4. A customer in the booking flow sees a one-line pointer on `/book` ("Read {Artist}'s policies") only when policies exist.
5. Past travel dates disappear automatically; a visit that is in progress shows "In {city} until {date}".

### 4.2 Data and API

- **Fields.** Extend the profile data with `policies: { deposit?: string, cancellation?: string, aftercare?: string }`, `faqs: [{ q, a }]` (max 8 entries, `q` ≤ 140, `a` ≤ 600), and `travelDates: [{ city, region?, startsOn, endsOn, kind: 'guest_spot'|'convention'|'travel', note? }]` (max 12). Plain text only, no HTML or links in v1 (links invite abuse; open question 8.3). Per-field limits live next to the existing `LIMITS` in `src/lib/artist-profile.ts` and are enforced by an extended `validateArtistProfilePatch`; keep its "reject unknown keys" behaviour and ADR-0054's reject-don't-clamp rule for any numeric field. Dates are ISO `YYYY-MM-DD`; `endsOn >= startsOn`; reject ranges over 120 days.
- **Storage.** Structured arrays do not fit scalar Neo4j node properties cleanly. Recommended: store `policies`, `faqs`, `travelDates` as one JSON string property per group on the `:Artist` node (as the existing `artistManagedFields` array already shows the node tolerates managed metadata), or in a Firestore doc `artist_profile_extras/{artistId}` read alongside the node. Choose Firestore if the Neo4j write path would need new Cypher and a migration; unverified which is lighter, read `PATCH` in `src/app/api/v1/artist/profile/route.ts` first.
- **Route.** Extend `GET/PATCH /api/v1/artist/profile` (same claim resolution, `getArtistByClaimedUid`) to return and accept the three groups; add each to `artistManagedFields` so the existing "who edited what, when" metadata keeps working. The route must only ever resolve the artist from the verified uid, as today.
- **Render.** The public page reads the extras only `if (artist.claimed)`; the unclaimed branch must not even fetch them. The honesty rule is enforced in the data layer too: the profile read helper returns `undefined` extras for unclaimed artists, so a stale value left from a revoked claim cannot render (see 5.3).
- **Moderation.** Text goes through the same sanitiser/length guard as `bio`; unverified whether `bio` has a profanity or link check; read the editor and route before sizing. Reports use the existing takedown directive (`directives/artist-takedown.md`).

### 4.3 Copy (ADR-0036)

Name is "TattTester"; quiet voice. The block mentions money only through the artist's own words, but a policy that names a deposit amount is a money surface: the money sentence for the artist's claim state must sit in the same booking module (it already does for the CTA flow; keep it adjacent, do not move it below the policies).

- Section heading on profile: "Before you book".
- Attribution line under the block: "Written by {Artist}."
- Editor help text under Policies: "Say what you want clients to know before they pay. TattTester's own rules still apply: deposits are refunded in full if you don't reply in time."  (matches spec 3's promise; adjust if 3's numbers change.)
- Travel row: "{City} · {Mar 4 – Mar 9}".
- Empty state in editor: "Nothing here yet. Clients see this above the Book button."

## 5. Failure and edge cases

1. **Policy text contradicts platform behaviour.** An artist writes "all deposits non-refundable"; the platform auto-refunds an unanswered request (spec 3) and holds unclaimed deposits (ADR-0005/0006). Policy text is advisory and cannot override that. The editor shows the platform rules beside the field (4.3), and the profile block states "TattTester's refund rules apply where they differ" under the policies. Do not implement a policy-driven refund engine here.
2. Artist deletes a section: it disappears from the public page on the next request; `force-dynamic` is already set on the profile route (verify on the page, unverified).
3. **Claim revoked or profile reinstated/taken down.** Extras must stop rendering the moment `claimed` is false (4.2) and the takedown directive's scrub (`directives/artist-takedown.md`) must include the new fields. Unverified whether takedown scripts enumerate fields explicitly; add them.
4. Two claimed users editing: last write wins per group; the PATCH already stamps `profileManagedAtEpochMs`.
5. Very long FAQ answers or many entries on mobile: truncate with "Show more" past the first 3 entries; the full text stays in the DOM for search engines.
6. Past travel: filtered at render by comparing `endsOn` with today in the artist's timezone (spec 4's helper) so a "ends today" entry is not dropped early.
7. Abuse: links, phone numbers and emails in free text could route customers around the platform and its fee. v1 strips URLs, emails and phone-like strings from the three groups (reject with a clear error rather than silently strip, consistent with ADR-0054's reject-not-clamp spirit). Open question 8.3.

## 6. Test plan

Extend:
- `src/app/api/v1/artist/profile/route.test.ts`: GET returns the three groups; PATCH accepts valid input, rejects unknown keys, over-length strings, more than 8 FAQs, 13 travel dates, reversed or over-long ranges, URLs/emails in text; PATCH still resolves identity from the uid only.
- `src/app/console/page.test.tsx`: no change expected; keep green.

Add:
- `src/lib/artist-profile.test.ts` (new): validator unit cases for every limit and the unknown-key rule (`ARTIST_MANAGED_PROFILE_FIELDS` extended).
- `src/app/artists/[slug]/__tests__/before-you-book.test.tsx` (new): claimed + filled renders "Before you book" above the booking module; claimed + empty renders nothing; **unclaimed renders nothing and does not read extras even when stale values exist in the fixture**; past travel dates are hidden; "In {city} until" for an active range.
- `src/app/artist/profile/__tests__/ArtistProfileEditor.extras.test.tsx` (new): the three sections render, validation errors surface, a save round-trips.

## 7. Effort and dependencies

M: validator, route, storage choice, editor sections, one public render block, a handful of tests. Independent of the others; only copy coordination with spec 3 (refund line) and layout with spec 4 (CTA block). Does not touch money code.

## 8. Open questions for Samson

1. Storage: Neo4j node property or a Firestore extras doc? Recommendation: Firestore extras doc, to avoid a graph migration for content that is never queried by the matcher.
2. Video intro: CoCreate has one (published). Link-only to an allow-listed host, upload (needs the licensed-media path), or skip for v1? Recommendation: skip.
3. Free text may contain contact details that bypass the platform and its fee. Reject URLs/emails/phones in v1 (recommended), or allow them?
4. Should a stated deposit policy ever drive the real refund behaviour (ADR-0054's `cancellationPolicyPartialRefundBps`)? Recommendation: not in this spec; text only, platform rules win.
