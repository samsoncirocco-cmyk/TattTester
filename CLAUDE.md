# CLAUDE.md - TatT AI Agent Instructions

> How to work (values layer, repo-agnostic): `docs/AGENT_PRINCIPLES.md` — effort-matching, when to plan/interview/recon, and how to maintain this file. This file holds the repo facts; that one holds the judgment.

## Project Overview

**TatT** is an AI-powered tattoo design platform:
- **AI Tattoo Design Generation** — Council-enhanced prompts → Replicate (Flux/Krea) with a Gemini image lane; see "Generation routing" below
- **AR Preview** — Live camera compositing of a saved design onto a user-positioned overlay (drag/scale/rotate); no body tracking or depth estimation (ADR-0024)
- **Artist Matching** — Semantic search via Supabase vectors + Neo4j graph relationships + Firebase real-time updates

Tech stack: see `package.json` (Next.js App Router on Vercel; Replicate + Vertex AI + OpenRouter; Supabase pgvector, Neo4j, Firebase, GCS, Stripe).

## Status: pre-launch, stealth

**TatT is not live.** There are no customers, no onboarded artists, and no real
transactions. Everything here is being built so it is *ready* when those exist —
not to keep a running service alive.

**How to judge severity.** A defect found in this repo is "this would be broken
at launch", not "someone is suffering right now". Nobody is. Write findings that
way: no "customers are losing money", no "an artist will email you tomorrow", no
incident framing. The useful question is *would this be wrong on day one*, not
*is this on fire*. Reserve urgency for the things below, which are real today.

**What IS live and does deserve weight:**

- **Spend.** Vertex, Replicate and OpenRouter calls cost real money against a
  real cap (`BUDGET_MAX_SPEND_CENTS`, see `src/lib/budget-tracker.ts`). An
  unmetered generation path is a genuine problem now, not at launch.
- **Third-party data.** A read-only production Neo4j count on 2026-07-30 found
  18,002 artist records. 7,511 have portfolio images attached — 68,532 image
  URLs total. The current scraper stores external source URLs rather than image
  files, but this repo also contains `scripts/host-artist-images.mjs`, an
  operator tool that downloads images into TatT's public GCS bucket. Production
  currently has 26 GCS-hosted portfolio URLs across 6 artists; the other 68,506
  URLs are external. The earlier claim that roughly 62,000 photos were all
  re-hosted is false, but "none are re-hosted" is also false. The artist/shop
  directory data itself is stored in production today, independent of launch.
  Public rendering of unclaimed portfolio images is separately controlled by
  `SHOW_UNCLAIMED_PORTFOLIOS`; do not claim its production value without
  checking it.
- **The deployed site is public.** tatttester.com, tatt-t.com and image2ink.com
  serve anyone who finds them.
- **Security gaps still get fixed properly** — but the framing is "close it
  before anyone can reach it", not "we are being exploited".

Being pre-launch lowers the urgency, not the standard. The work still has to be
right; it just isn't an emergency.

### Mission
Democratize custom tattoo design by lowering the barrier between idea and execution. Empower users to iterate quickly, visualize accurately, and connect with the right artists.

---

## Layout & Architecture

- Workflow SOPs live in `directives/*.md`; `execution/README.md` maps each directive to routes, services and scripts. Code is `src/app/api/` (routes), `src/services/`, `src/features/`, `src/config/`, `scripts/`.
- For a current picture of service dependencies, read `execution/README.md` and `src/services/` directly — do not trust (or add) hand-drawn dependency maps here; they drift.

## Generation routing (gotchas)

- Routing config: `src/config/modelRoutingRules.js`; selection logic: `src/services/generation/internal/routing.ts`. Flux Dev is the primary, Flux Schnell the speed fallback, Krea 2 the style wildcard — all via Replicate. SDXL-era config keys are retired aliases only.
- Requests naming **3+ characters** route to the Gemini image lane because Flux drops cast identities (issue #293). That lane is served **through Replicate** as `nano-banana-2` — the same model as Gemini 3.1 Flash Image, but do not reach for it by its Vertex name; the route is the `nano_banana_2` key (#314, `docs/adr/0048-gemini-lane-served-through-replicate.md`). Preview and stencil modes still win over the cast lane.
- `src/services/generation/internal/vertexImagen.ts` no longer calls Imagen despite its name — Google retired the `imagen-*` endpoints; it talks to Gemini. The `imagen3` model key survives as the vertex-ai provider's routing key but is deliberately excluded from complexity-based selection.
- Flux/Krea/Gemini have no `negative_prompt` input; negatives are folded into the prompt as an "Avoid:" clause. Gemini also ignores `seed` (no determinism) and returns one image per call (N images = N parallel calls).

## Key Commands

```bash
npm run dev                # Dev server (http://localhost:3000)
npm run build              # Production build (build:clean if .next/lock is stale)
npm run lint               # ESLint
npm test                   # vitest run (test:watch for watch mode)
npm run docs:check         # Validate docs
npm run security:secrets   # Secret scan (also a CI merge gate)

# Database setup
node scripts/setup-supabase-vector-schema.js
node scripts/import-to-neo4j.js
node scripts/generate-vertex-embeddings.js
```

## Environment Variables

Single source of truth: `src/config/envSchema.js` (name, type, required/optional, default, purpose). `.env.example` is generated from it — `npm run env:example`; CI fails on drift via `npm run env:check`. Gotchas that are easy to get wrong:

- `GOOGLE_CALENDAR_WRITE_ENABLED=false` — calendar write-back stays off everywhere until deliberately enabled; unset `GOOGLE_OAUTH_CLIENT_ID` keeps every artist on booking requests (see `docs/google-calendar-setup.md`).
- `BUDGET_MAX_SPEND_CENTS` — real spend cap (see Status section).
- `SHOW_UNCLAIMED_PORTFOLIOS` — controls public rendering of unclaimed portfolio images; never assume its production value.
- `STRIPE_SECRET_KEY` — Stripe routes fail closed (503) when unset or placeholder.
- `CRON_SECRET` — bearer secret guarding `/api/cron/expire-deposits`.

## Booking & Payments (gotcha summary)

- A booking is a **reservation** only for artists with a live synced Google Calendar (claimed profile + published hours + fresh free/busy + writable hold store); `resolveBookingMode` fails closed to "request" (`docs/adr/0027`). Picking a slot takes a 35-minute exclusive hold and pins the Stripe Checkout `expires_at` to it.
- The client pays the booking fee (`PLATFORM_FEE_BPS`) **on top** of the deposit; the artist keeps 100% of the deposit (`docs/adr/0007`).
- Unclaimed-artist deposits are HELD on a `:BookingRelay` node and either transferred on claim or auto-refunded after `DEPOSIT_HOLD_DAYS` by the daily cron (`docs/adr/0005`–`0006`); claim flow has dual entry converging on `transferHeldDeposits` (`docs/adr/0008`).
- Money handling: cents only, reject out-of-range (`docs/adr/0054-money-in-cents-reject-out-of-range.md`).

---

## Testing & Merge Gate

Run the full `npm test` suite once at session start (catches stale
`node_modules` and pre-existing breakage) and again after any change; skip
redundant pre-change runs within a session. Run `npm run build` only when a
change plausibly affects compilation — Vercel runs the identical build on push.
Branch protection on `main` requires the CI checks (secret scan, JS + Python
tests, demo build) to pass and PR branches to be up to date with `main`.

## Worktrees & the Primary Checkout

Many agent sessions share the one primary checkout at `/Users/samson/TatT`.
Work in a **git worktree**, not in that checkout. Two sessions editing it at
once is exactly how changes end up uncommitted with no owner.

**A dirty tree in the primary checkout is a stop sign, not an obstacle.** Those
files are unsaved and exist nowhere else — not on GitHub, not on any branch.
Assume another session owns them.

- Never run `git checkout .`, `git restore`, `git stash`, `git clean`, or
  `git reset --hard` against the primary checkout.
- Never sweep someone else's unsaved files into your commit (`git add -A`,
  `git commit -a`).
- Never layer your edits on top of theirs.
- If your task needs those files, ask who owns the changes first.

The `SessionStart` hook in `.claude/hooks/dirty-tree-check.py` surfaces this
state at session start; it is silent when the tree is clean.

---

**Last Updated:** 2026-08-04
**Maintained by:** Samson via Hermes
