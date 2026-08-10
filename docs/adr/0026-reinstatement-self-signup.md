# ADR 0026 — Reinstatement: the tombstone is never lifted, a different door is opened

**Status:** Accepted (mechanism only — no artist has been reinstated, and no live data has been changed)
**Date:** 2026-07-26
**Builds on:** [ADR 0025](0025-artist-takedown-semantics.md)
**Related:** issue #192 (the claim flow has no identity check)

## Context

ADR 0025 made a takedown permanent. A `:TakedownTombstone` keyed on the Instagram
handle blocks every ingest path, forever, failing closed. Against a re-scrape
that is exactly right.

As a life sentence it is wrong. An artist who had TatT remove their scraped
profile in 2026 must still be able to *choose* to be on TatT in 2027. The owner's
requirement was precise: artists stay out **"unless they signup themselves."**

So there must be one door through a wall that exists to protect people. This ADR
is about making that door narrower than the wall.

## Decision

### 1. The tombstone is never lifted. The ingest gate stays shut forever.

This is the load-bearing decision and it looks counter-intuitive, so it is worth
being explicit about what was being conflated:

1. blocking automated, non-consensual **re-ingest** by the crawler, and
2. blocking **the person** from ever using TatT.

A tombstone should only ever have meant (1). Reinstatement therefore does not
knock a hole in the wall — it opens a different door. After a successful
reinstatement:

- `TOMBSTONE_KEYS_CYPHER` still returns the key,
- `filterTombstoned` still rejects the handle,
- `import-to-neo4j.js`, the crawler importer and `host-artist-images.mjs` all
  still refuse it.

Permanently. `scripts/execute-reinstatement.mjs` contains no `DELETE` against a
tombstone and never modifies `key`; it only sets audit properties the gate does
not read.

**This is better than lifting, not a compromise.** Once the artist owns their
profile, a later crawl finding their handle must not overwrite what *they* wrote
with scraped data. Permanent suppression of the scrape path is the correct end
state for a reinstated artist.

A regression test pins this: `TOMBSTONE_KEYS_CYPHER` must contain no `WHERE` and
no mention of `reinstated`. A future "helpful" `WHERE t.reinstatedAt IS NULL`
would silently make every reinstated artist re-scrapeable.

### 2. Reinstatement restores nothing, and structurally cannot

The takedown executor hard-deleted the photographs from GCS and the embedding
from Supabase, and scrubbed name, bio, handle, location, and portfolio off the
node (ADR 0025 §1–2). What survives is an id-keyed husk.

Clearing `removedAt` therefore yields an **empty profile** bound to the artist's
account, which they fill in themselves, from their own hands, with their consent.

There is no code path by which reinstatement returns scraped content, because the
scraped content no longer exists. This is a property of the system, not a policy
that could be relaxed — and it is what makes offering reinstatement safe at all.
The route says so to the artist, in the response body, before they start.

### 3. The door is harder to walk through than the wall was to build

| | Takedown (build the wall) | Reinstatement (walk through) |
|---|---|---|
| Account | none — deliberately | **required, signed in** |
| Proof | none enforced in code | **one-time code published on the tombstoned handle** |
| Human | required to execute | required to execute |
| Default | dry run | dry run |

The account requirement is deliberately asymmetric. Asking to be *removed* must
be frictionless — requiring a TatT account before you may ask TatT to stop using
your photographs would be backwards. Asking to be *re-added* is the opposite: the
account is part of the proof, and it gives the eventual ownership binding an
identity that can be revoked.

The handle-control proof is anchored to the same fact the removal was: the
tombstone is keyed on the handle, and for this dataset the handle *is* the
identity (national-dataset ids are literally derived from it). The artist
publishes a `TATT-XXXXXXXX` code on the account; an operator looks.

The code is **not a secret** — it is published. It is a capability proof: only
whoever controls the account can put it there. It is unpredictable so it cannot
be pre-published, and it expires after 7 days, because control of a handle a year
ago is not control of it now.

### 4. The request route has no power, exactly like takedown's

`POST /api/v1/artists/reinstate` records a `:ReinstatementRequest` and emails a
human. It cannot clear `removedAt`, cannot bind `claimedByUid`, and cannot touch
a tombstone. The publicly reachable half of a dangerous operation is inert.

### 5. The route reveals nothing about who has been taken down

The response is **identical** whether or not a tombstone exists for the handle.
The code is always issued, the request is always recorded, and only the
operator's dry run learns the truth.

A tombstone records that a specific person exercised a removal right, which is
itself sensitive information. A route that confirmed them would be an oracle for
*"who asked to be taken down?"* — queryable by anyone who can create an account.
This costs nothing, because a real artist's next step is the same either way.

### 6. There is no admin path that skips the artist's own request

`planReinstatement` blocks outright when no pending `:ReinstatementRequest`
exists for the handle. An operator who wants to reinstate someone who never asked
cannot; the script refuses, and the refusal names why.

This is the whole point of the owner's condition. "Unless they signup themselves"
means the artist's own deliberate act is a *precondition*, not a nicety, and
convenience must not be able to route around it.

### 7. A lifted tombstone leaves a permanent record

`markTombstoneReinstated` sets `reinstatedAt`, `reinstatedByUid`,
`reinstatementRequestId` and `reinstatedArtistId` on the tombstone, which is
never deleted. A second reinstatement of the same handle is blocked on sight.

So a remove-then-relist pattern is visible in the graph, and the artist node
carries `selfRegistered = true` — the one flag in the system that means *this
person consented*, distinguishing them from the ~18,002 who did not.[^counts]

[^counts]: Corrected 2026-08-06. This ADR originally said ~7,828, a figure taken
    from hosting-run logs. A read-only production query on 2026-07-30 found
    18,002 non-consenting artist records (7,511 of them with portfolio image
    URLs). See the correction note in `docs/adr/0025-artist-takedown-semantics.md`.
    The decision is unaffected — the flag's meaning does not depend on the count,
    which is larger than originally stated, not smaller.

The audit mark is written **before** ownership changes hands, and a failed mark
aborts the run. Handing someone a profile without a durable record of why would
erase the history this mechanism exists to keep.

## Relationship to issue #192 — read this before trusting any of the above

Issue #192: `/api/v1/connect/claim` binds `claimedByUid` — the key the money path
trusts — to whoever calls it first, with **no identity verification at all**.

**Reinstatement does not build on it.** It never calls that route. It performs
its own binding, after handle-control proof and human review, and it **refuses
outright** when the husk is already claimed by a different uid — that is #192
surfacing on a profile that may hold a connected Stripe account, and a script
must not resolve it.

**One thing had to be fixed for that to be true.** `/api/v1/connect/claim`
matched on `(a:Artist {id})` with no `removedAt` guard, and the husk deliberately
retains `stripeAccountId` (ADR 0025 §2). So anyone could claim a removed artist's
husk through the *unverified* route and inherit their connected account —
bypassing this ADR entirely. That guard is now in place; without it, reinstatement
is not the only door and nothing here holds.

**What #192 must still fix, independently:** the other ~18,002 artists who have
*not* been removed are still claimable by the first person to ask (see
[^counts] — the exposure is larger than this ADR originally stated). Reinstatement
is arguably the template for the fix — handle-control proof plus a human before
the binding — but applying it there is a separate product decision about
onboarding friction, not something this ADR settles.

## Attack surface — honestly

**What this stops:**

- A re-crawl re-adding a removed artist. Unchanged from ADR 0025, and unchanged
  *after* a reinstatement.
- An operator quietly restoring someone who never asked.
- A stranger claiming a removed artist's husk and its Stripe account.
- Enumeration of who has filed a takedown.
- A second, ownership-shifting reinstatement of the same handle.

**What it does not stop, and these are real:**

- **A hijacked Instagram account.** Whoever controls the handle can publish the
  code. This is the same weakness ADR 0025 named for takedown, and it is
  structural: the handle is the only identity anchor this dataset has. An
  attacker who takes over an artist's Instagram can take their TatT profile too.
- **An artist whose tombstone carries no Instagram handle.** There is nothing to
  prove control of, so there is no self-serve path at all. Those artists must be
  handled out of band, by judgement. The takedown dry run already warns when an
  artist has no handle on file; the same gap re-appears here, worse, because it
  is now a door someone cannot use rather than a lock that might not hold.
- **A shop-versus-artist dispute over the same portfolio.** Handle control does
  not establish who authored the work. Unchanged from ADR 0025, and still a legal
  question rather than a code one.
- **An operator who does not actually look.** `--handle-verified` is an
  assertion, not a check. No code here can read Instagram, and pretending
  otherwise would be the lie that makes this unsafe. The ops email is written to
  lead with the check for this reason, but the mechanism ultimately rests on the
  reviewer doing their job. This is the single weakest link in the design.
- **Rate limiting is per-instance.** On Vercel the enforced limit is looser than
  the code suggests, as with every other route in this repo. The blast radius is
  bounded by the fact that the route changes nothing.

## Alternatives rejected

- **Delete the tombstone on reinstatement.** Re-opens the resurrection hole the
  moment the artist's own profile exists, and lets a later scrape overwrite what
  they wrote. Strictly worse for the artist.
- **Let the artist reinstate themselves with no human.** Handle control alone,
  automated, would make profile takeover a matter of one compromised Instagram
  account and no oversight — on profiles that can receive money.
- **Build reinstatement on `/api/v1/connect/claim`.** It has no identity check
  (#192). Building the one door through the takedown wall on top of the least
  verified path in the codebase would make the door the attack.
- **An admin "undo takedown" command.** Fails the owner's condition directly. The
  artist's own act must be a precondition.
- **Email verification instead of handle control.** Proves control of an email
  address, not that it is the artist's — the same objection ADR 0025 raised
  against self-service takedown execution.
- **Create a fresh node instead of reusing the husk.** Leaves two nodes for one
  person, and strands the husk's `stripeAccountId`. Reuse is cleaner and, because
  the husk is scrubbed, leaks nothing.

## Open questions (product / legal, not code)

1. **Should the ingest gate ever expire?** Current answer: no, never. It is
   stated here so it is a decision rather than an accident, and so it can be
   stated in the privacy policy — TatT retains a handle *forever*, specifically
   in order to honour a removal request. That retention is itself processing of
   personal data and needs counsel's view.
2. **Does a reinstated artist's `selfRegistered` profile need fresh consent
   capture** — terms acceptance, a record of what they agreed to — beyond the
   binding? Probably yes, and nothing here does it.
3. **Statutory deadlines.** If a reinstatement request is framed as a GDPR
   rectification request, there are response windows. Nothing here tracks them.
   Same gap ADR 0025 left open for takedown.
