# ADR 0025 — Artist takedown: soft-delete the node, hard-delete the content, permanent tombstone

**Status:** Accepted (mechanism only — no live data has been removed)
**Date:** 2026-07-25
**Issue:** #78

## Context

TatT scraped 7,828 artists and re-hosted 62,313 of their portfolio photographs on
`gs://tatt-pro-assets`. None of them opted in. Before this ADR the codebase had
**zero** takedown capability — no route, no flow, no `takedown` string anywhere.
If an artist emailed "that's my work, take it down", there was nothing to action
it with.

That is the gap this ADR closes. The questions that actually needed deciding:

1. What does "removed" mean across four stores (Neo4j, GCS, Supabase, static JSON)?
2. Soft-delete or hard delete?
3. **Does a later re-scrape silently resurrect them?** — the one that matters most.
4. How much identity proof do we require, without making takedown a weapon?

## Decision

### 1. The content is hard-deleted

The re-hosted photographs and everything derived from them are destroyed, not hidden.

| Store | What | Action |
|---|---|---|
| GCS | `artists/<artistId>/*` (the re-hosted photos) | **hard delete** |
| Supabase | `portfolio_embeddings` where `artist_id = <id>` | **hard delete** |

These are the artist's property. We have no basis for retaining a copy, and a
"suppressed but still stored" photograph is still a copy we shouldn't hold. The
embedding is derived from their work and drives matching, so it goes with them.

### 2. The `:Artist` node is soft-deleted and scrubbed

The node is **not** deleted. It is marked and emptied:

- `SET a.removedAt`, `a.removalReason`, `a.takedownRequestId`
- Scraped identity and content properties are **scrubbed** to null:
  `name, bio, instagram, handle, shopName, city, state, lat, lng, location,
  email, profile_url, portfolioImages, portfolioImageCount, rating, reviewCount,
  hourlyRate, yearsExperience`
- Presence-expressing relationships are **deleted**:
  `SPECIALIZES_IN, HAS_INSTAGRAM, HAS_WEBSITE, CREATED, TAGGED_WITH,
  APPRENTICED_UNDER, INFLUENCED_BY`, and the inbound `(:Shop)-[:HAS_ARTIST]->`.

What survives is an id-keyed husk carrying `removedAt` and the money-bearing
properties (`stripeAccountId`, `claimedByUid`, `subscriptionStatus`).

**Why not a hard delete?** Three reasons, in order of weight:

**(a) Money.** `:BookingRelay` nodes reference `artistId` and can hold real
customer funds (ADR 0005). Hard-deleting the Artist while a held deposit exists
orphans money that must be refunded or transferred. The husk keeps that path
intact. `scripts/execute-takedown.mjs` refuses to run when pending relays exist,
precisely so this is a deliberate decision and not an accident.

**(b) Audit.** We need durable, timestamped proof that we honoured the request —
for the artist, and for us.

**(c) Resurrection detection.** The importers use `MERGE (a:Artist {id: ...})`.
Against a husk that carries `removedAt`, a re-import hits the existing node and
the artist **stays suppressed**. A hard delete would hand a re-scrape a blank
slate and silently undo the takedown.

The husk holds no personal data, so the privacy objection to soft-delete does not
apply here: the scrub is what makes soft-delete acceptable.

### 3. The tombstone is a separate node and outlives everything

```
(:TakedownTombstone { key, keyType, artistId, createdAtEpoch, reason })
```

`key` is a normalized stable identifier. Every takedown writes one tombstone per
known identifier:

- `instagram:<handle>` — **the primary key**
- `artist:<id>`
- `source:<url>` for each known source page

**Why Instagram handle is primary, not the artist id:** the national dataset's
ids are literally derived from the handle (`artist_tattoosbyging`), but the
crawler cohort mints *random* ids (`artist_dvpyb68gp`, from
`Math.random()` in `artist_validator.js`). An id-keyed tombstone would not
survive a re-crawl. The handle is the only identifier stable across runs.

**Why a separate node, not a flag on `:Artist`:** the crawler discovers a handle
*before* it has any node to look at, and mints the id afterwards. A flag on the
Artist node is invisible at the moment the decision needs to be made. The
separate node is also what makes a future hard delete safe — the tombstone
outlives the thing it tombstones.

### 4. The tombstone check fails **closed**

If the tombstone lookup errors, ingest **skips** the artist. A takedown that a
database blip undoes is not a takedown.

This is deliberately the opposite of `/api/v1/book`, which fails *open* on a
Neo4j error so an outage never drops a real booking. Different risk directions:
there, the harm is a lost booking; here, the harm is re-publishing someone's work
after they asked us not to. We accept losing a scrape over breaking a promise.

### 5. Execution is never automatic

The public request route **records a request and notifies a human. It changes
nothing.** It cannot remove anything, by construction — it has no write path to
GCS, Supabase, or the Artist node.

Removal runs from `scripts/execute-takedown.mjs`, which is **dry-run by default**
and requires both `--execute` and `--confirm <artistId>` to touch anything.

### 6. Identity proof: human review, not a credential

**To request: nothing.** No account, no verification. An artist who finds their
scraped profile can act immediately — requiring a TatT account before you can ask
TatT to stop using your photos is backwards.

**To execute: a human.** The reviewer is the identity check.

This is what stops takedown becoming a way to delete a competitor. The structural
answer is that no request, however convincing, removes anything on its own.

**Recommended proof for the reviewer** (documented, deliberately *not* enforced in
code): the requester posts a one-time code to the Instagram handle on the profile,
or messages from it. For this dataset the handle *is* the identity — the artist id
is derived from it — so handle control is the closest available analogue to
domain-control proof.

**What this explicitly does not cover:**

- It does not prove **copyright ownership**. A shop owner and the artist who made
  the work may both credibly claim the same portfolio. That is a legal call, not
  a code one.
- It does not survive a **hijacked Instagram account**.
- It has **no anchor** for an artist with no Instagram on file — there is nothing
  to prove control of. Those requests need out-of-band judgement.
- It does not bound **request volume** beyond a per-IP rate limit. Someone can
  still flood ops with requests; only human review stops those landing.
- It is **deliberately asymmetric with the claim flow**, which binds *money* to a
  profile on a first-finder-wins basis with no identity check at all
  (`/api/v1/connect/claim`). Takedown is now the more careful of the two. **That
  asymmetry is a known hole and is not fixed here** — see "Open questions".

## Consequences

**Read paths must respect `removedAt`.** Suppression is added at:

- `buildRosterFilter()` — covers the `/artists` roster list and count
- `getRosterArtistById()` — covers the public profile page and `/book`
- `buildNotRemovedClause()` in `neo4jService` — covers the matching engine
  (`findMatchingArtists`, `findArtistMatchesForPulse`, `getArtistById`,
  `getArtistsByIds`, `findArtistsByEmbeddingIds`)
- `/api/v1/book` — a removed artist is **not bookable**, and this check fails
  *closed* even though the neighbouring existence check fails open

**Two things a graph filter does not reach**, and the executor reports both
rather than pretending otherwise:

- ~~`src/data/featured-artists.json` is a **committed static snapshot** consumed
  by the homepage. A DB filter does not remove anyone from it. It must be
  regenerated (`scripts/pick-featured-artists.mjs`) and redeployed.~~
  **Closed by ADR 0026's PR.** The snapshot is now a *candidate* list:
  `src/lib/featured-artists.ts` asks the graph on every render which candidates
  may still be published and drops the rest, failing closed. A removed artist
  leaves the homepage within the 60s revalidation window with no redeploy. The
  curated file is kept because the four cards are an editorial choice; what
  changed is that it no longer gets the last word.
- CDN / browser caches of `storage.googleapis.com` URLs may serve deleted objects
  for a while after the delete.

**Ingest gates.** The supported graph importer,
`scripts/import-to-neo4j.js`, checks the tombstone list before writing artist
data. `scripts/host-artist-images.mjs` applies the same gate so a stale scrape
directory cannot re-upload deleted photos. Both fail closed when tombstones
cannot be read.

## Alternatives rejected

- **Hard-delete everything.** Orphans held deposits, destroys the audit trail,
  and hands a re-scrape a blank slate. The resurrection problem alone rules it out.
- **Soft-delete without scrubbing.** Keeps the artist's personal data indefinitely
  in a node nobody can see. That is hiding, not removing.
- **Tombstone as a property on `:Artist`.** Invisible to the crawler at the moment
  it matters, and dies with the node.
- **Self-service execution behind email verification.** An email round-trip proves
  control of an email address, not that it is the artist's. It would make deletion
  of a competitor a two-minute job.

## Open questions (product / legal, not code)

1. **Should the scrape have happened at all?** This ADR builds the exit door. It
   does not address whether 7,828 non-consenting artists should be in the graph in
   the first place, or whether an opt-out model is defensible pre-launch. That is a
   call for the owner, likely with counsel.
2. **Retention of the husk.** How long does a `removedAt` husk live? Indefinitely
   is probably wrong; deleting it re-opens the resurrection hole unless the
   tombstone is kept forever (which is the current design and should be stated in
   any privacy policy — we retain a hash-free handle specifically to honour the
   request).
3. **The claim flow's missing identity check.** Unclaimed profiles receive real
   money on a first-finder-wins basis. That is a larger hole than the one this ADR
   closes and needs its own decision.
4. **Statutory response windows.** If any takedown request is a formal DMCA or
   GDPR erasure request, there are deadlines. Nothing here tracks them.

---

## Correction — 2026-08-06 (factual, does not change the decision)

The Context above states that TatT "scraped 7,828 artists and re-hosted 62,313
of their portfolio photographs." A read-only query against production Neo4j on
2026-07-30 does not support the re-hosting half of that sentence.

| | |
|---|---|
| Artist records in production | 18,002 |
| With at least one portfolio image URL | 7,511 |
| Portfolio image URLs total | 68,532 |
| External URLs | 68,506 |
| Re-hosted on `gs://tatt-pro-assets` | 26, across 6 artists |

The 7,828 / 62,313 pair came from `host_only.log`, which records
`SET portfolioImages` write operations. The URLs written were the artists' own
external links, so "portfolioImages written" was misread as "photographs
re-hosted." See `docs/legal/artist-data-counsel-notes.md` for the counsel-facing
version.

**Why the decision still stands.** This ADR's reasoning does not depend on the
volume of re-hosted content — a takedown mechanism is required because we hold
18,002 non-consenting records at all, and that number is larger than the one in
the Context. The mechanism is per-artist and enumerates whatever objects exist
for that artist, so it is unaffected.

**What it does change** is what a takedown means to a requester: for 6 artists
it deletes photographs from our storage, and for the rest it removes our copy of
their profile data and our links to images that stay on their own sites.
`directives/artist-takedown.md` now states this distinction.
