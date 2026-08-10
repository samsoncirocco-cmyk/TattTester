> **This is a live working document (a running task queue agents edit as they
> go), not a source of product or architecture truth.** It is not on the
> entry-point list in `docs/status/document-classification.md` and it goes
> stale between edits — "DONE" markers here reflect the state at the time an
> agent wrote them, not a verified current state. For current product/system
> facts, use `docs/product/current-product.md` and
> `docs/architecture/current-architecture.md`.

# TatT — Shared TODO

Single source of truth for what needs doing next, across all sessions and
agents. **Every agent: read this before starting work, update it when you
finish or discover work.** Keep entries short; link PRs/issues; date your
changes. Newest state wins — resolve edit conflicts by merging both lists.

_Last updated: 2026-07-25 (branch sweep executed — 85 → 49 → 47, auto-delete
turned ON, legacy/closed-PR pass archive-tagged then deleted 30 more; booking
loop Phase 1 landed on main via #108's branch — 01d962a + Bugbot fixes
772853e; duplicate PR #113 closed as superseded, its two deltas ported via
merged #117; see "Repo hygiene" below)_

## Now (in priority order) — THE JOURNEY QUEUE

**North star (Samson, 2026-07-17): one real user journey — idea → design →
real matching artists → booked appointment. Work not on this path is frozen.**
**Cross-cutting rule: every user-facing change lands in the punk/StudioShell
design system (src/components/punk/, studio/). Never resurrect old-theme
(ducks-yellow) pages — port their logic, not their look. Aesthetic cohesion
is an acceptance criterion, not a nice-to-have.**

J1. ~~**Generation for real**~~ — **DONE 2026-07-20**: keys were already in
    tatt-app's Vercel prod env (Vertex + Replicate fallback). Budget cap now
    env-configurable (`BUDGET_MAX_SPEND_CENTS`, commit be63366); prod set to
    5000 = **$50/mo (Samson's number — the earlier $10 was for demo only)**.
    Demo mode confirmed off. End-to-end verified in the live UI: prompt →
    /api/v1/generate 200 → four real Vertex Imagen cuts rendered on
    /generate/stencil (PNGs carry C2PA TrainedAlgorithmicMedia metadata —
    provably not mocks). Vertex spend records at 4¢/image via budget-tracker.
J2+J3. ~~Real matching wired into live /matches~~ — **DONE 2026-07-17
    (PR #46)**: server-side Neo4j execution, vector half degrades soft
    (embeddings not yet populated), functional Style/City/Has-portfolio
    pills, real scores, honest offline states, punk aesthetic verified.
    ~~PROD TODO: set NEO4J_*, NEXT_PUBLIC_NEO4J_ENABLED, and the
    FRONTEND_AUTH_TOKEN pair in the deploy target's env (J7).~~ **DONE
    2026-07-20: all 8 vars set in tatt-app prod via Vercel CLI, rebuilt,
    verified in-browser — live matching is ON at tatt-app.vercel.app/matches
    (real graph artists, scores, no offline notice). VERCEL_TOKEN in
    /opt/org/.env (gitignored).**
    **REGRESSION (2026-07-20, caused by PR #48):** the security session
    removed the shared FRONTEND_AUTH_TOKEN path from verifyApiAuth (correctly
    — the token was extractable from the public bundle). Auth is now
    Firebase-only, so **signed-out visitors to /matches get the offline
    notice** — live matching only works after sign-in. The env-var pair in
    Vercel is now dead weight (safe to delete). Proposed fix, needs a
    decision: make /api/v1/match/semantic public + rate-limited (it serves
    public artist listings), or accept sign-in as a journey prerequisite.
J4. ~~**Design→artist signal**~~ — **DONE 2026-07-20 (audited)**: Forge
    (/generate/stencil) links to /matches?styles=…&from=design; MatchesClient
    parses via src/lib/design-style-signal (validated against
    CANONICAL_STYLES), feeds styles into the live match query, shows the
    "Matched to your design" chip; manual style pick overrides the signal.
    Verified in code + 292→307 test suite on main c039219.
J5. ~~**Real booking path**~~ — **DONE 2026-07-20 (audited)**: match cards
    carry bookHref=/book?artistId=<real graph id>; punk /book flow posts to
    /api/v1/book (Firebase-auth-only via verifyApiAuth, rate-limited,
    Firestore capture with owner uid) then /api/checkout for the Stripe
    deposit. Honest degradation verified: no STRIPE_SECRET_KEY → 503
    "Payments are not configured" (or demo-labeled success only when
    NEXT_PUBLIC_DEMO_MODE=true); booking request is saved either way and the
    UI says no deposit was charged. Old /book/[artistId] page is now a
    redirect (kept for old links/Stripe cancel_urls).
    **Samson ops (not code):** set STRIPE_SECRET_KEY + FIREBASE_* admin
    creds in tatt-app Vercel env; run `firebase deploy --only
    firestore:rules` for the new booking/availability rules.
J6. ~~**Minimal availability model**~~ — **DONE 2026-07-20 (audited)**:
    grep confirms zero Math.random() availability anywhere in src (remaining
    Math.random uses are ID generation, cosmetic tile colors, and one
    randomVariety tiebreaker in match scoring — none present fake
    availability). Model: artist_availability/{artistId} Firestore docs,
    ops-written only (no client writes per firestore.rules); missing doc or
    creds resolves to status "unknown" rendered as "availability on
    request". No fake green dots.
J8. ~~**Auth gate**~~ — **DONE 2026-07-20 (audited, live in prod)**:
    /generate (Forge), /matches, /designs, /book wrapped in ProtectedRoute
    layouts → redirect to /login?redirect=<dest> for anonymous, styled hold
    state while Firebase resolves. Homepage and /artists stay public.
    Verified anonymous-curl on localhost prod build AND tatt-app.vercel.app.
    This also settles the J2/J3 regression below: sign-in is now an explicit
    journey prerequisite, so signed-out users never see the offline notice —
    they get the login gate. The dead FRONTEND_AUTH_TOKEN env pair in Vercel
    can be deleted (Samson).
J7. ~~**One deploy target, auto-deploy, live URL**~~ — **DONE (verified
    2026-07-21)**: tatt-app is the only Vercel project linked to this repo
    (generous-success no longer exists; manama-next has no git link).
    Custom domains all wired + Firebase-authorized: tatt-t.com,
    image2ink.com, tatttester.com. Canonical-domain pick is #81 (Samson).

J9. **Close the booking loop** — roadmap merged 2026-07-22 (PR #106):
    `docs/audits/2026-07-22-booking-gap-analysis.md` (supersedes the
    `docs/booking-gap-analysis` branch, which can be deleted). Decision
    recorded: **Firestore-first** system-of-record for bookings; Supabase
    M003 deferred to a Phase 3 analytics mirror. Same-day Stripe Connect
    merge (1e4dd5a, PRs #92/#99) already shipped held deposits + claim flow
    + a functional webhook — see the doc's Addendum for what that closed.
    ~~**Remaining Phase 1 blockers (doc §5, tasks 1.1–1.9)**~~ — **DONE,
    landed on main 2026-07-24** (#108's branch pushed direct as 01d962a +
    Bugbot fixes 772853e; duplicate PR #113 closed as superseded — two
    parallel sessions built the same J9 scope; #113's two better deltas,
    the bookings ip-echo privacy fix and the DEPOSIT_BY_SIZE dedupe,
    landed via merged #117):
    1.1 `bookingId` threaded through `BookClient` → `/api/checkout` →
    Stripe metadata + `success_url`; 1.2 booking state machine
    (`BookingStatus`, `canTransition`, `appendStatus`, `statusHistory`) in
    `src/lib/booking.ts` + unit tests; 1.3 webhook idempotently transitions
    `booking_requests` `pending → deposit_paid` (event-id + status guards,
    Firestore txn) persisting session/PI/amount/paidAt; 1.4 `/api/v1/book`
    validates `artistId` against the graph (fail-closed on "not found",
    fail-open on Neo4j outage); 1.5 owner-scoped `GET /api/v1/bookings` +
    `/[id]` read API (registered in api-route-security); 1.6 `/book/success`
    + `/bookings` now read server truth; 1.7 deleted dead
    `useBookingStore`/`BookingModal`; 1.8 `notify.ts` + `emailQueueService`
    real transactional email (Resend/webhook, honest degrade); 1.9 webhook
    reconciliation integration test. **Still open:** ~~(a) real email provider
    env~~ — **DONE 2026-07-25**: `RESEND_API_KEY`/`EMAIL_FROM`/
    `OPS_NOTIFY_EMAIL` (and `STRIPE_CONNECT_WEBHOOK_SECRET`) are now set in
    Vercel production, so 1.8's delivery is no longer env-gated;
    (b) artist confirm/decline dashboard (Phase 2); (c) scheduling: merge
    PR #112 (accepted as-is 2026-07-22), then wire the slot picker into the
    booking wizard — integration point is `BookClient.tsx` step 1 (the
    spec's original "replace Math.random()" target no longer exists).
    **Before #112 merges**, fix #162 (a mid-day booking strands the rest of
    the day's slots — confirmed reproducing on `feat/scheduling-engine`) and
    settle #155's remaining items (ADR 0024 availability model is still
    `Proposed` and is Samson's call; stale `scheduling-engine.ts` docstring).
    Also renumber one of the three colliding ADR-0023 files (`main`, PR #156
    and `feat/scheduling-engine` each claim it). Note #150-#154 are closed:
    they were fixed on `feat/scheduling-engine` by PRs #160/#161, and their
    shared "merged to main as scaffolding" premise was false — the engine
    files have never been on `main`;
    ~~DEPOSIT_BY_SIZE dedupe~~ **DONE via #117**.

(Prior items now secondary: PR #40 feedback folds into J2/J3 scope; security
reconciliation continues in parallel. Branch protection still blocked on
GitHub plan.)

**Enrichment (corrected 2026-07-25):** the *shop-site* deterministic pipeline
(`~/tatt-scraper/execution/enrich_artists.py`) is still at pilot scale (~212
artists, `pilot-run.log`); its gate was never reviewed. **The separate
Instagram/Apify sweep, however, has fully run** — the earlier "full run NOT
launched" line described the wrong pipeline. Verified counts:

- IG enrichment queue: **10,427** artists (`jq length` on
  `~/tatt-scraper/data/enrichment/instagram/artist-queue.json`).
- Profiles scraped: **10,427 of 10,427**, of which 9,252 had images
  (`apify-run.log`; `apify-profiles/` holds exactly 10,427 files).
- `portfolioImages` written to Neo4j: **7,828 artists / 62,313 images**
  (7,828 distinct `SET portfolioImages` lines in `host_only.log`).
  These are *write operations from the run log*, and the URLs written were the
  artists' own external links. A read-only production query on 2026-07-30 found
  the current state to be **7,511 artists / 68,532 URLs**, only 26 of them
  GCS-hosted. Do not read "portfolioImages written" as "images re-hosted" —
  that conflation is what produced the retracted 62,313-re-hosted claim.

⚠️ **The figure "2,606" that has circulated is wrong** — it is shard 2's
`hosted:` count from a 3-shard parallel run (2605 / 2606 / 2617), not a total.
Do not quote it. Note also that the graph-side artist count (8,949, from
`data/cleanup-report.json` `counts.kept`) and the IG queue (10,427) disagree,
and nothing in the repo reconciles them — worth resolving before either number
is used for planning.

## Next

- ~~**Synthetic artists.json still imported by old-theme surfaces**~~ —
  **RESOLVED 2026-07-21 (PR #54 merged)**: /smart-match and /swipe ported to
  the live graph + punk design system; the four old-theme source files
  deleted. Remaining artists.json imports are seed tooling in scripts/.
- **Samson-only ops checklist** (executed 2026-07-21; one item left):
  1. **DEFERRED TO PRE-LAUNCH (Samson, 2026-07-24):** live Stripe
     end-to-end verification. Not urgent — TatT is not taking customers
     yet; do the real-booking + live-dashboard check before the first
     customer, then strike this. Partially verified from a session
     (2026-07-24): /api/checkout is live in prod at tatt-app.vercel.app
     (auth-gated, not 503), and the Stripe sandbox shows zero traffic, so
     prod is not misconfigured onto test keys. Note the claim → Connect
     onboarding → deposit-release leg **cannot be verified end to end yet**:
     `src/app/claim/[artistId]/page.tsx:58-59` mints a Connect
     `clientSecret` then discards it, and `@stripe/react-connect-js` isn't
     installed, so no artist can finish KYC (#96). Test that leg after #96
     lands. Agents: do not re-flag this as a blocking ops item.
  2. ~~FIREBASE_* admin credentials~~ — **already set** (FIREBASE_PRIVATE_KEY,
     FIREBASE_CLIENT_EMAIL, FIREBASE_PROJECT_ID in production+preview;
     verified via Vercel API 2026-07-21). A real-booking end-to-end check in
     prod is still worth doing once Stripe is in.
  3. ~~Firestore rules deploy~~ — **DONE 2026-07-21**: rules compiled +
     released to tatt-pro via firebase-tools; minimal firebase.json added to
     the repo so this works from a clean checkout.
  4. ~~Delete dead FRONTEND_AUTH_TOKEN pair~~ — **DONE 2026-07-21** (both
     vars deleted from tatt-app via Vercel API).
  5. ~~Disconnect manama-next + generous-success~~ — **already done**:
     generous-success is deleted; manama-next has no git link (verified via
     Vercel API 2026-07-21). tatt-app is the sole deploy target.
- ~~**Share API store is ephemeral in-memory**~~ — **FIXED 2026-07-25 (PR
  #157, `be555b3`)**: shared designs persist in Firestore, so links survive
  redeploy. **But sharing is still half a feature**: nothing in the UI calls
  the create endpoint. `POST src/app/api/v1/designs/share/route.ts` has zero
  callers — grep for `designs/share` hits only the route files, their tests,
  `api-route-security.ts:53-54`, and the *read* side
  `src/app/share/[shareId]/page.tsx:18`. The one `Share2` icon
  (`src/components/DesignLibrary.jsx:98`) is labelled "Export Database" and
  calls `exportLibrary`; `DesignLibrary` is never imported by any page. A
  working, tested, secured backend no user can reach — tracked under #83.

8. ~~Merge PR #35 (README truth sync)~~ — **superseded**: README truth sync
   landed on main via PR #84 (2026-07-20); #35 is closed.
9. ~~100 synthetic AZ seed artists in Aura~~ — **DONE 2026-07-17**: Samson chose
   delete. Seed artists (float ids), their Tattoo/Instagram/State/Website nodes,
   null-placeId shops, and orphaned tags/cities removed. Live graph is now 100%
   real scraped data. Re-seeding (if ever needed): `scripts/import-to-neo4j.js`.

## Repo hygiene — branch & PR close-out (executed 2026-07-25)

**~~Delete 35 stale branches~~ — DONE 2026-07-25.** Branch count **85 → 49**;
all 35 verified landed on main first, cross-checked so no open PR's head was
on the list, and confirmed after the fact (0 of 35 remaining, all live heads
intact). Caveat for the record: that pass deleted without archive tags — the
remote had **zero** tags afterwards — so those 35 are recoverable only from
the SHAs noted here and GitHub's own ref retention. Every later pass tags
first.

**~~"Automatically delete head branches" was OFF~~ — turned ON 2026-07-25.**
It is now `true` on `repos/samsoncirocco-cmyk/TatT` and demonstrably working:
`chore/raise-council-test-timeout` (#147, merged 19:40 UTC) is the first head
that self-deleted, and #143, #135 and #110 all vanished on merge afterwards
with nobody running a delete. #145 (19:35) and #146 (19:30) merged just before
the flip and were left behind, which dates the change to that five-minute
window. **Anything in this file still describing the setting as OFF, or the
remote as 70/83/85 branches, is stale** — the remote held **47** when this
pass started and **18** when it finished.

**But turning it on does not drive the count to zero**, because auto-delete
fires on **merge only**. Four kinds of branch are outside its reach and always
need a manual sweep:
- **Legacy heads** pre-dating the setting (and the 2026-07-17 history
  rewrite) — the bulk of the residue.
- **PRs closed without merging** — #103, #104, #105, #136, #144, #39, #35, #40.
- **Branches pushed with no PR at all** —
  `audit/engineering-guidelines-2026-07-14`, `samson/desktop-tatt-v1-gitignore-fix`.
- **Heads re-pushed after their PR merged**, which resurrects the ref.

**Branch-deletion rule:** "its PR merged" is not sufficient grounds to
delete — check for a *newer* open PR on the same head first.
`feat/design-bot` was on the delete list on those grounds and would have
taken #125's unmerged commit (1019ca9) with it.

**Verification method — two checks, because one alone gives false answers:**
- **Ancestor or patch-equivalent to `origin/main`** (`git cherry` shows every
  commit already upstream) — catches the merge-commit-merged branches.
- **Squash-merged, so patch IDs differ** — these look unmerged to git and must
  be verified by merged-PR head instead: e.g. `claude/hopeful-wilson-7107ac`
  showed 8 "missing" commits but PR #111 squashed them into `37342b3`, and a
  content diff over the 17 files it touched was empty.

⚠️ **"N commits not on main" is NOT evidence of unmerged work** in a repo that
squash-merges — roughly a third of the branches checked would have been kept
by that reasoning alone. Verify by content or by PR state.

**Batching outcome (2026-07-25).** #104+#105 were batched as **#135** —
**merged**, so thin-result broadening and the rating signal are both on main.
#103+#110+#109 were batched as **#136** — **closed unmerged**; the originals
were taken individually instead: #110 **merged** direct, #109 still **open**
and being worked.

⚠️ **#103's work is currently lost.** PR #103 and batch #136 were both closed
unmerged, so the first-time-visitor signup fix never landed —
`hasEverAuthed` exists nowhere on main and `generate/stencil` still sends
every signed-out visitor to `/login`. **Issue #101 is open with nothing
pointing at it.** The commit is intact at `4e940dd` on `crew/101-cta-signup`
if it should be revived; delete that branch only if the drop was deliberate.
Lesson: don't let a fallback PR's fate depend on a batch PR — closing the
batch orphaned the fallback.

### Legacy + closed-PR sweep (2026-07-25)

**Recovery first:** every branch below — deleted *and* held — was tagged
`archive/<branch>` and the tags pushed to the remote **before** any deletion.
Restore with `git push origin archive/<branch>:refs/heads/<branch>`.

**Deleted — 30 branches**, each re-verified against the live remote on
2026-07-25 as carrying nothing missing from `main`:

- Legacy group A (19, pre-rewrite): design/punk-site-redesign,
  fix/rate-limit-always-429, feat/handoff-screens-2, fix/ci-test-suites,
  feat/import-scraper-pipeline, feat/user-persistence,
  fix/firebase-admin-bootstrap, fix/council-vertex-project-id,
  fix/startup-probe-and-ci-green, audit/engineering-guidelines-2026-07-14,
  fix/critical-spend-security, refactor/dead-code-config,
  fix/forge-toast-provider, docs/readme-truth-sync (#35 closed, superseded
  by #84), update-atticus-neo4j, chore/cherry-pick-audit-and-gitignore,
  worktree-roadmap-and-branch-triage, docs/roadmap-state-rescope,
  security-hardening-followups
- Legacy group C (7, ancient/abandoned): deploy-ready, demo-polish,
  samsoncirocco-cmyk/map-codebase, fix/frontend-audit-yc,
  samson/desktop-tatt-v1-gitignore-fix, codex/main-manama-integration,
  manama/next
- Merged pre-flip, no newer open PR on the head (2):
  fix/monochrome-subject-color-scrub (#146), fix/presentation-flash-art (#145)
- Closed crew PRs whose content landed via the merged batch #135 (2):
  crew/70-weighted-rating (#105), crew/73-thin-match-broaden (#104) — both
  patch-equivalent to `main` (`git cherry` reports zero unmerged commits)

**Held — 10 branches tagged but NOT deleted:**

- B (7, scraper/dataset — hold until the datasets are confirmed safe in
  ~/tatt-scraper): feat/artist-scraper, feat/scrape-scheduler,
  perf/parallel-scrape, data/national-dataset, data/scrape-20k,
  feat/wire-national-dataset, samson/port-artist-crawler.
  `feat/wire-national-dataset` is the only real unique-content risk —
  **357 commits ahead of main, 325 of them not patch-equivalent** (the
  earlier "807 commits" figure was wrong). The other six are already
  ancestors of `main`, but the group is held together pending the review.
- Closed-PR heads with genuinely unlanded work (3): crew/101-cta-signup
  (#103 — see the warning above), crew/batch-forge-storage (#136, 6 unmerged
  commits, overlaps open PR #109), fix/log-conversation-fallback (#144
  closed unmerged).

**Skipped — heads of open PRs:** #122 (this branch), #131, #148, #109, #125,
#112, plus `chore/purge-manama-identity`. Never delete a head with an open PR
against it — re-fetch the open-PR list immediately before deleting, not from a
survey written days earlier.

**Result: 47 → 18 remote branches** = `main` + 7 open-PR heads + the 10 held.
40 `archive/*` tags are live on the remote (30 deleted + 10 held).

**One honest caveat on the deleted set:** `security-hardening-followups`
(#39, closed) was *not* landed — it is an abandoned older fork of
`src/lib/client-api-auth.ts` that predates main's `authStateReady()` race fix,
so re-applying it would regress. It was deleted as abandoned, not as merged;
the code survives at `archive/security-hardening-followups`.


## Backlog

- **Forge polish (from 2026-07-20 UX review):** ~~(1) raise the tape-label
  font-size floor to ~10px (7-9px "SELECTED"/"LINES" labels fail WCAG
  readability; keep letter-spacing/punk look)~~ — **FIXED**: every punk
  surface is now ≥10px, tracking untouched; two-line stickers scaled both
  lines together to keep the pricetag proportion, and
  `src/components/punk/type-scale.test.ts` fails the build if the floor
  regresses. Remaining sub-10px text lives only in the unreachable
  old-theme files, which are slated for deletion. (2) add an expand/zoom
  affordance on generated cut cards — click already means "select", so
  there is no way to view a design large. Fold into any Forge-touching PR.

- **Artist style tags are still empty** (corrected 2026-07-25) — the old
  "~1.5k of 8,949 have style tags" line overstated it. `README.md:11` is
  right: **style tags are not populated at all**, because Instagram bios
  don't list styles. This needs the vision pass (#63), not a bio re-scrape.
  Portfolio/bio enrichment is a *separate* and largely finished job —
  7,511 artists have `portfolioImages` attached in production (see the
  Enrichment block above). Sizing note for #63: the corpus is **68,532
  portfolio image URLs across 7,511 artists, of which 68,506 are external
  links and only 26 are GCS-hosted** (read-only production query 2026-07-30,
  `docs/legal/artist-data-counsel-notes.md`). A vision pass must therefore
  fetch from external sources or host first — it cannot assume a local
  corpus. `scripts/generate-portfolio-embeddings.js` is **not** a
  starting point — it runs CLIP over the orphaned synthetic
  `src/data/artists.json`, which nothing reads.
- Ask GitHub Support to purge the orphaned pre-scrub commits (password
  history) if repo visibility ever changes.
- 99+ more cities can be queued in `~/tatt-scraper/data/queue.json` if the
  dataset should grow beyond this run.
- ~~**Full-codebase review, medium/low-severity findings**~~ — **FIXED
  2026-07-17, PR #45** (all 6 items below, tests green: 226 passed unchanged,
  build succeeds): broken `share/[shareId]` route (Next.js 16 `params`
  Promise fix — was 404ing on every share-link view + failing
  `tsc --noEmit`); `/api/health` info leak removed
  (`hasReplicateToken`/etc.); `generate-neo4j-cypher.js`'s
  `MATCH (n) DETACH DELETE n;` made opt-in via `--wipe` (matches
  `import-to-neo4j.js`'s existing fix, smoke-tested both modes); `aria-label`
  added to `DesignLibrary.jsx`/`BookingModal.tsx` icon buttons + `alt` text
  on a `VisualizeContent.jsx` thumbnail; the real dead-code bug in
  `VisualizeContent.jsx` (`setSavedPlacements` after a `useEffect`'s cleanup
  `return`, so it never ran — saved placements now actually restore) and the
  unmount-leak in `startCamera()` (added `isMountedRef` guards on the
  setTimeout/depth-calibration async chain); deleted 1,445 lines of
  confirmed-dead code (`DesignGenerator.jsx`, `DesignGeneratorRefactored.jsx`,
  `DesignGeneratorWithCouncil.jsx` + test file — zero import sites anywhere,
  live flow is `src/features/Generate.jsx` via `next/dynamic`, and the
  deleted test file's own comment already said it targeted "a legacy React
  Router UI that isn't part of the current Next.js app flow"). PR:
  https://github.com/samsoncirocco-cmyk/TatT/pull/45 (not yet merged).
  - **Not done in this pass, still open**: the scraper cost/backoff/dedupe
    gaps in `parallel_crawler.js` (scrape for the current dataset is
    already finished, so no urgency — will matter if the dataset grows
    again) and the 4–5x duplication of the RRF/weighted-match-scoring
    formula across `neo4jService.ts`, `hybridMatchService.ts`,
    `matchService.js`, `demoMatchService.js` (consolidation candidate, not
    urgent, already-drifted `hourlyRate` null-handling constants across the
    copies).

## Working agreements (multi-agent hygiene)

- `git fetch && git reset --hard origin/<branch>` before ANY push — history
  was rewritten 2026-07-17 to remove committed credentials.
- Never commit credentials; `.env`/`.env.local` are gitignored on purpose.
- Dataset changes go through `data/` PRs with counts in the commit message.
- The live Aura instance holds real + seed data side by side; never run an
  importer with a wipe flag against it casually.
