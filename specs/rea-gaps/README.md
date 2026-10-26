# REA gap specs 1–16

Implementation specs for the product changes that came out of the 2026-10-23 to 2026-10-26 competitor study. Specs only: nothing here changes product code. TattTester is pre-launch (see `CLAUDE.md`, Status), so "problem" means "this would be wrong on day one", not "someone is affected now".

Spec ids 1–15 follow the order Samson asked for, **not** the roll-up's rank numbers (see the crosswalk). Spec 16 was added by amendment from the CoCreate report.

## Index

| # | Spec | Area | Effort | Depends on | Roll-up rank / gaps |
|---|------|------|--------|------------|---------------------|
| 1 | [Resumable and releasable slot hold](01-resumable-releasable-slot-hold.md) | Booking | M | none (shares `submit()` with 2, 5, 6) | 1 · C3, K1, C7 |
| 2 | [Lost race keeps reservation mode](02-lost-race-keeps-reservation-mode.md) | Booking | S | none; better after 1; refetch upgraded by 6 | 2 · K4, C1 |
| 3 | [Reply-time promise, reminders, request expiry](03-reply-time-promise-and-request-expiry.md) | Booking | M (L if claimed-artist refund reversal is new Stripe work); Variant B "estimate before deposit" is L | none; new ADR proposed | 3 · K5; CoCreate O3 |
| 4 | [Timezone label, deposit ladder, next opening](04-timezone-deposit-and-next-opening.md) | Booking | S (M if a cached next-opening field is built for roster cards) | none; 6 reuses its zone helper | 4 and 5 · C2, K7, C4, C6, K6; CoCreate O1, O4, O5 |
| 5 | [Idempotency keys and in-flight guard](05-idempotency-keys-and-in-flight-guard.md) | Booking | S | after 1 | 7 · K2 |
| 6 | [Availability endpoint and slot check](06-availability-endpoint-and-slot-check.md) | Booking | M | 4 (zone-aware window, ISO slots); feeds 2 | 6 · C1, K3 |
| 7 | [/design session in the URL, with resume](07-design-session-in-the-url.md) | Generation | M | none; 9 builds on it | 8 · G1, R4 |
| 8 | [Credit balance visible, exhausted link](08-credit-balance-visible.md) | Generation | S | none | 9 · R1, G5 |
| 9 | [First cut as it lands, elapsed time](09-first-cut-as-it-lands-and-elapsed-time.md) | Generation | M (counter alone S) | 7 | 10 · G2, R2 |
| 10 | [Narration, "changed:" prefix, guess-first intake](10-narration-because-you-said-and-guess-first-intake.md) | Generation | S (narration) + M (guess-first, separable) | none | 15 and 14 · V2, V3, V4, V1 |
| 11 | [Flux-pinned refine reference-image test, then fix](11-flux-pinned-refine-reference-image-test.md) | Generation | S (test), M (fix if real) | none; do early | 12 · G3 |
| 12 | [Seed and lane per cut](12-seed-and-lane-per-cut.md) | Generation | S | after 11 | 13 · R3 |
| 13 | [Persist swipe decisions](13-persist-swipe-decisions.md) | Matching | M | none; 14 builds on it | 11 (part) · T2, T4 |
| 14 | [Swipe card evidence, undo, broadened deck](14-swipe-card-evidence-undo-and-broadened-deck.md) | Matching | M (L if distance needs new geo data) | 13 for server undo; 15 for radius | 11 (part) · T1, T4, T5 |
| 15 | [Intent and budget pills](15-intent-and-budget-pills.md) | Matching | S (radius blocked on data) | none; radius needs 14 tier 2 | T3 (not separately ranked) |
| 16 | [Artist policies, FAQ, travel dates](16-artist-policies-faq-and-travel-dates.md) | Booking / artist profile | M | none; copy-coordinates with 3 and 4 | CoCreate O7 (published) |

### Crosswalk: roll-up rank → spec

Roll-up rank 1→1, 2→2, 3→3, 4+5→4, 6→6, 7→5, 8→7, 9→8, 10→9, 11→13+14 (T3 → 15), 12→11, 13→12, 14+15→10. Roll-up ranks 16–19 are **not specced here**: 16 (artist-configurable intake questions, C5), 17 (paid deposit on a lapsed hold is flagged, not refunded, K8 — closely related to spec 1's webhook work and worth doing together), 18 (participant-terms line and Turnstile, C8), 19 (SMS intake, V5, parked).

### Suggested order

1. **11** first (a test; $0; decides whether the refine loop works at all).
2. Booking: **1 → 5**, with **2** and **4** alongside, then **6**, then **3**. 17 (lapsed-hold refund) fits next to 1.
3. Generation: **8** (quick), **7 → 9**, then **12**, **10**.
4. Matching: **13 → 14**, **15** anytime; 14's distance only after coordinates exist.
5. **16** whenever the first real artists are onboarding.

## Conventions used in every spec

- Citations are `file:line`. The booking and generation/matching maps (`~/reports/tatttester/rea-competitors/calcom/tatt-booking-map.md` and `~/reports/tatttester/rea-competitors/tatt-generation-matching-map.md`) were taken on main @ 6b1a0af. This branch is based on 1e301a1, two commits later (#400 security headers, #401 reveal render claim). The diff between them touches only the design-session files (confirm route, `shared.ts`, store, orchestrator, conversation, service index and two tests), so booking, matching and artist-page citations are unchanged; orchestrator and confirm-route lines were re-read at 1e301a1 and are labelled.
- "unverified" marks anything not confirmed from code in this pass. Nothing was executed; no test was run, no data was queried, nothing was spent.
- Competitor facts come only from the reports under `~/reports/tatttester/`: `2026-10-23-rea-calendly.html`, `2026-10-23-rea-calcom.html`, `2026-10-23-rea-veri.html`, `2026-10-24-rea-gemini.html`, `2026-10-24-rea-krea.html`, `2026-10-24-rea-tinder.html`, and `2026-10-26-rea-cocreate.html`. Evidence classes follow the reports: *observed*, *observed-in-source* (Cal.com code reading), *inferred*, and for CoCreate *published* (its public pages only; its terms bar competitors from using the service, so nothing about its behaviour was observed).
- Copy follows ADR-0036: the name is "TattTester"; any surface that mentions booking money carries the money sentence in its claimed or unclaimed variant; quiet voice. Where a spec was unsure the law applies, it is raised as an open question.
- Money stays in integer cents with out-of-range values rejected (ADR-0054); ADR-0007 (client pays the fee on top, artist keeps 100% of the deposit) and ADR-0027 (reservation only with a live calendar, request as the permanent fallback) are not changed by any spec. Spec 3 Variant B would need a superseding ADR and says so.

## Findings from writing the specs that go beyond the maps

These are things the specs rely on that the maps did not state; each is cited inside its spec.

- Spec 1: signed-out bookings have `uid: null` and the hold route's ownership check lets any caller through (`src/app/api/v1/book/hold/route.ts:70-79`), so a resume or release route needs a signed token for anonymous bookings.
- Spec 7: `GET /api/v1/design-session/[id]` has no uid check, and the public projection excludes the transcript and the in-flight claim; resume needs both added with an ownership rule.
- Spec 11: the mechanism of the suspected refine failure is confirmed by code reading end to end (reference image goes first in round two, flux/krea refuse it, the fallback chain filters to reference-capable models and is empty), and the existing round tests mock the whole generation module so they cannot see it. Still not executed.
- Spec 12: the durable-render staging fingerprint omits seed and serving lane, so both must travel in staged-object metadata the way the downgrade reason already does.
- Spec 15: the `budget` the matcher takes is an **hourly rate** ceiling, `radius` is accepted and ignored everywhere, and `has_portfolio` counts stored images rather than displayable ones.
- Spec 14: the match query returns `Tattoo.imageUrl` nodes, not the artist node's `portfolioImages` the roster uses, and does not apply the `SHOW_UNCLAIMED_PORTFOLIOS` gate; a hero image must go through `filterPortfolioForDisplay` and `pickHeroImage` on the server.
- Spec 8: `POST /api/v1/billing/credits` exists (starts the pack checkout); there is no balance read and `generation-credits.ts` has no plain read function.

## Open questions that need Samson first

Each spec ends with its own list. The decisions that block the most work: spec 3 Variant A or B and the claimed-artist refund path; spec 4 whether ADR-0036's money sentence applies on roster cards and the fee-model copy; spec 7 whether a render survives the browser disconnecting; spec 11 Option A or B if the test fails; spec 13 one pin list or two; spec 14 how to credit scraped portfolio images on a swipe card.
