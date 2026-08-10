# Directive: Action an Artist Takedown Request

**ID:** DIR-019
**Owner:** Ops / Platform Team
**Last Updated:** 2026-07-25
**Last Tested:** Mechanism tested against fixtures. **Never yet run against live data.**
**Risk Level:** High — irreversible deletion of a third party's data
**Estimated Duration:** 10 minutes, plus however long verification takes

## Purpose

TatT holds 18,002 scraped artist records in production Neo4j. 7,511 of them have
at least one portfolio image URL attached, 68,532 URLs in total — of which
68,506 point at external sources and 26 are re-hosted on `gs://tatt-pro-assets`
across 6 artists. None of these artists opted in. This directive is how we
honour one of them asking us to stop.

Counts from a read-only production query on 2026-07-30, recorded in
`docs/legal/artist-data-counsel-notes.md`. Per
`docs/status/known-contradictions.md`, recompute from production and state the
query date rather than copying these forward.

The decisions behind it — soft vs hard delete, tombstones, what identity proof
we require — are recorded in **`docs/adr/0025-artist-takedown-semantics.md`**.
Read that first; this directive is only the runbook.

## When to use

An artist (or their representative) has asked for their profile or their
photographs to be removed. Requests arrive either through
`POST /api/v1/artists/takedown` (which emails `OPS_NOTIFY_EMAIL` with a
`TD-XXXXXXXX` reference) or directly by email.

## Prerequisites

- [ ] `NEO4J_URI`, `NEO4J_USERNAME`, `NEO4J_PASSWORD` in `.env.local`
- [ ] `GOOGLE_APPLICATION_CREDENTIALS` with `storage.objects.delete` on the bucket
- [ ] `NEXT_PUBLIC_SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`
- [ ] **The requester has been verified** (Step 1 — do not skip)

## Procedure

### Step 1 — Verify the requester

Anyone can claim to be anyone, and this route must never become a way to delete
a competitor. The structural protection is that nothing is automatic: you are
the identity check.

Ask the requester to prove control of the Instagram handle on the profile —
post a one-time code to their story or bio, or message you from the account.
For this dataset the handle **is** the identity: the artist id is derived from
it.

**What this does not prove**, and where you should stop and escalate:

- It does not establish **copyright ownership**. If a shop and an artist both
  claim the same portfolio, that is a legal call, not yours.
- It does not survive a **hijacked account**.
- If the profile has **no Instagram handle**, there is nothing to prove control
  of. Handle out-of-band.
- If the request cites **DMCA or GDPR erasure**, there may be a statutory
  deadline. Nothing in this system tracks one. Escalate.

### Step 2 — Dry run (safe, changes nothing)

```bash
node scripts/execute-takedown.mjs --artist-id artist_tattoosbyging
```

Prints exactly what would be removed: each GCS object, the Supabase embedding
row count, whether the node would be suppressed, and every tombstone key. It
also prints blockers and warnings. **It changes nothing, anywhere.**

Read the output before going further. In particular:

- **Blockers.** A pending held deposit stops the run. Removing the node while
  customer money references it would orphan the funds — refund or transfer
  first (`docs/adr/0005`), then re-run.
- **No instagram handle warning.** The tombstone can then only be keyed on the
  artist id, which the crawler does *not* reproduce across runs. A re-crawl may
  re-ingest under a new id. Verify manually after the next scrape.

### Step 3 — Execute

```bash
node scripts/execute-takedown.mjs \
  --artist-id artist_tattoosbyging \
  --scope all \
  --reason "artist request TD-ABC123" \
  --execute --confirm artist_tattoosbyging
```

`--confirm` must exactly equal `--artist-id`; a stray `--execute` on its own
does nothing. Use `--scope images` when the artist wants only the photographs
gone and is happy for the listing to stay.

### Step 4 — The two things the script cannot do

1. **The homepage snapshot.** `src/data/featured-artists.json` is committed and
   static. If the artist appears in it, no database filter removes them:
   ```bash
   node scripts/pick-featured-artists.mjs && git commit -am "chore: refresh featured artists" && git push
   ```
2. **Caches.** CDN and browser caches may serve the deleted
   `storage.googleapis.com` URLs for a while. Nothing to do but wait.

### Step 5 — Reply to the artist

Quote the `TD-` reference. Say what was removed and what was kept (the id-keyed
husk retains no personal data but does persist, and the tombstone is permanent
and deliberate — it is what stops a future scrape re-adding them).

## Verification

```bash
# Node is suppressed and scrubbed
MATCH (a:Artist {id: 'artist_...'}) RETURN a.removedAt, a.name, a.instagram

# Tombstone exists
MATCH (t:TakedownTombstone {artistId: 'artist_...'}) RETURN t.key, t.keyType
```

Then confirm the artist is gone from `/artists`, from their profile URL, from
match results, and that `/book` refuses them.

## Rollback

**There is none for the content.** The GCS objects and the Supabase embedding
are hard-deleted. The node can be un-suppressed (`REMOVE a.removedAt`) and the
tombstone deleted, but anything we hosted is gone. This is why Step 2 exists.

**What a takedown actually removes depends on the artist.** For the 6 artists
with re-hosted images, it deletes photographs from our storage. For the other
7,505 with portfolio URLs, their images were never copied — we hold external
links, so a takedown removes our reference and our copy of their profile data,
and nothing leaves the artist's own site. Step 2's dry run reports which case
you are in; read it before answering a requester, because "we deleted your
photographs" is only true for the first case.

## Notes

- The public request route removes nothing and cannot: it has no write path to
  GCS, Supabase, or the `:Artist` node.
- Ingest is gated on tombstones in `scripts/import-to-neo4j.js` and
  `scripts/host-artist-images.mjs`. Both
  **abort** if the tombstone list cannot be read — that is deliberate.
