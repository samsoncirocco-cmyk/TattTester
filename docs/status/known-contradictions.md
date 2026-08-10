---
status: current
verified_against: 86e1c18
verified_on: 2026-07-30
---

# Known contradictions

These conflicts are visible rather than “resolved” through whichever document
an author happened to open first.

## Brand — RESOLVED 2026-07-27

- Commits `6cb6dd4` ("flip every user-facing TatT to TattTester", TAT-43) and
  `d5c0d7c` (canonical URL tags point at tatttester.com) implemented
  ADR-0004/ADR-0033: `src/app/layout.tsx` now titles the app "TattTester —
  Think it. Ink it.", `TattTesterWordmark.tsx` renders the TattTester mark,
  and the marketing copy across the app follows the same law.
- `TatT` survives only as internal/code-identifier usage (`package.json` name
  `tatt-app`, code comments, route/module names) — the commit message
  explicitly scopes that carve-out.
- This section previously described the brand as unresolved based on a
  verification snapshot from `8db5d3e` (2026-07-27, same day as the fix but
  apparently just before it landed). No further decision is required unless
  the carve-out itself needs revisiting.

## Fundraising ask

- Google Slides deck: $750K Seed.
- Retired repository pitch page: $500K Seed.
- YC demo script: $2.5M Seed.

Required decision: founder-confirmed amount, round label, use of funds, runway,
and milestones.

## Placement terminology

- Current honest implementation: static photo compositing and manually
  positioned camera overlay.
- Older documents: AR body tracking, depth mapping, and placement accuracy.

Resolution: ADR-0024 is authoritative. Older claims are historical and must
not be repeated.

## Artist and image counts — RESOLVED 2026-08-06

Counts varied among `README.md`, `CLAUDE.md`, handoffs, cleanup reports, and
research material.

Required procedure: compute counts from the active production source at the
time of publication and include the query date. Do not copy a number from a
handoff.

Resolved by applying that procedure. The canonical figures, from a read-only
production Neo4j query on 2026-07-30 (`docs/legal/artist-data-counsel-notes.md`):

| | |
|---|---|
| Artist records in production | 18,002 |
| With at least one portfolio image URL | 7,511 |
| Portfolio image URLs total | 68,532 |
| External URLs | 68,506 |
| Re-hosted on `gs://tatt-pro-assets` | 26, across 6 artists |

The competing "7,828 artists / 62,313 images" pair came from `host_only.log`,
which records `SET portfolioImages` **write operations** — and the URLs written
were the artists' own external links. Reading "portfolioImages written" as
"photographs re-hosted" is what produced the retracted claim. That sentence had
propagated into `directives/artist-takedown.md`, `TODO.md`, ADR-0025 and
ADR-0026; all four were corrected (ADRs by appended note, not rewrite).

Still true, and the reason this entry stays rather than being deleted: the
procedure above is the fix. Any future count must be recomputed from production
with its query date stated. `host_only.log` is a record of writes, not of
current state, and is not a source for either number.

## Artist verification

- Archived session recap: fake `Math.random()` artist verification was replaced
  by real Gemini calls.
- Repository at `8db5d3e`: both legacy validator scripts still simulated every
  result, including the branch selected when `GEMINI_API_KEY` was present.
- ADR-0032: those validators and their direct automation are retired. Current
  acquisition yields discovered candidates, not verified professionals.

Resolution: do not reuse a `verified` value produced by the retired pipeline.
Future verification must include its evidence and method; identity and media
consent remain separate gates.

## Deposit amount — RESOLVED 2026-08-03

- The 2026-07-20 grill recorded a flat ~$25 booking deposit; the shipped code
  (`DEPOSIT_CENTS_BY_SIZE` in `src/lib/booking.ts`) charges $75/$150/$300/$500
  by tattoo size.
- ADR-0040 (2026-08-03 grill) is authoritative: deposits are tiered by size,
  exactly as shipped. The flat-$25 decision is struck and must not be
  repeated.

## Consumer free tier and subscription copy — RESOLVED 2026-08-03

- Older copy and design artifacts describe "5 generations / month free" (or 3
  designs/month) plus a "$19 Pro" (or $12 Pro) consumer subscription. No code
  ever backed these.
- ADR-0041 (2026-08-03 grill) is authoritative: 25 free generations lifetime
  per user, identical across web and SMS and enforced server-side, then a
  single $10/25-generation credit pack via one-off Stripe Checkout. There is
  no consumer subscription; that lane is parked. Enforcement build work is
  tracked in GitHub issue #80.
- Old pitch scripts and design specs retain the dead copy as history with
  superseded notices; do not reuse it.

## Launch supply: recruited artists vs scraped profiles — RESOLVED 2026-08-03

- The Phoenix soft-launch runbook (`docs/operations/phoenix-soft-launch.md`)
  made consented, identity-checked recruited artists the first supply and a
  launch gate ("five launch-ready artists"). The relay lane (ADR-0005–0008)
  was built so unclaimed scraped artists are bookable — two supply models with
  no decision about which one gates launch.
- ADR-0042 (2026-08-03 grill) is authoritative: the soft launch runs
  end-to-end on scraped, UNCLAIMED profiles via the booking relay; recruited/
  claimed artists are an upgrade lane that continues in parallel, not a launch
  gate. ADR-0043 gates which scraped profiles may take a deposit (real tattoo
  evidence + working contact channel; everything else browsable with "request
  intro" only). The runbook is annotated, not rewritten; its recruiting phases
  stand.
- Scraped profiles are still never labeled "verified" (ADR-0032; artist
  verification entry above).

## ADR numbering — RESOLVED 2026-08-05

Two files used the `0026` prefix. `0026-reinstatement-self-signup.md` has 11
inbound references across code and docs and kept its number.
`0026-money-in-cents-reject-out-of-range.md` had no inbound references from
code, so it was renamed. (It did have one from `CLAUDE.md`, missed at the time
and left pointing at the dead `0026` path until this change.) `0038` was already assigned to `0038-the-studio-is-the-refinery.md`,
so it was not reusable. The documentation validator now rejects every duplicate
ADR prefix instead of carrying a permanent exception for this one.

The first rename sent the money ADR to `0048`, which looked free on disk but was
not free in practice: `0048` was already the routing/cast-lane decision, cited 24
times across 14 source files, and the ADR itself was written and waiting in an
open PR. The money ADR moved again to
`0054-money-in-cents-reject-out-of-range.md` — it still has no inbound code
references, so it is the cheap side of the collision, whereas renumbering the
router would have meant ~33 citation edits in files with PRs in flight.

Reserved by open ADR PRs at the time of this rename, and not reusable: `0048`
(router — Gemini via Replicate) and `0049` (two cuts a round), plus `0050`–`0053`
(likeness/reference photos and siblings). Check open PRs' file lists, not just
`docs/adr/` on main, before claiming the next free ADR number.
