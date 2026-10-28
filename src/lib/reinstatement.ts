/**
 * Reinstatement — the one door through the takedown wall. See docs/adr/0026.
 *
 * ## The problem this solves
 *
 * ADR 0025 made a takedown permanent: a `:TakedownTombstone` keyed on the
 * Instagram handle blocks every ingest path, forever, failing closed. That is
 * correct against a re-scrape and wrong as a life sentence — an artist who had
 * TatT remove their scraped profile in 2026 must still be able to *choose* to be
 * on TatT in 2027. The owner's condition was exact: kept out **"unless they
 * signup themselves"**.
 *
 * ## The design, in one line
 *
 * **The tombstone is never lifted. The ingest gate stays shut forever.**
 *
 * Two different things were being conflated:
 *
 *   1. blocking automated, non-consensual **re-ingest** by the crawler, and
 *   2. blocking **the person** from ever using TatT.
 *
 * A tombstone should only ever mean (1). So reinstatement does not knock a hole
 * in the wall; it opens a different door — a consented, identity-checked
 * self-signup that binds the profile to the artist. `TOMBSTONE_KEYS_CYPHER` keeps
 * returning the key afterwards and `filterTombstoned` keeps rejecting it.
 *
 * Leaving the gate shut is not merely safe, it is *better*: once the artist owns
 * their profile, a later crawl finding their handle must not overwrite what they
 * wrote with scraped data. Permanent suppression of the scrape path is the
 * correct end state for a reinstated artist, not a compromise.
 *
 * ## Reinstatement restores nothing, and cannot
 *
 * The executor hard-deleted the photographs from GCS and the embedding from
 * Supabase, and scrubbed name, bio, handle, location and portfolio off the node
 * (ADR 0025 §1–2). What survives is an id-keyed husk. Clearing `removedAt`
 * therefore yields an **empty profile** bound to the artist's uid, which they
 * then fill in themselves — with their consent, from their own hands.
 *
 * This is a structural property, not a policy: there is no code path by which
 * reinstatement can bring back scraped content, because the scraped content no
 * longer exists. It is why reinstatement can be offered at all.
 *
 * ## What proves it is really them
 *
 * The wall exists to protect people, so the door must be harder to walk through
 * than the wall was to build. Takedown requires: a public form, no account, then
 * a human. Reinstatement requires all of:
 *
 *   1. **A signed-in account.** Deliberately asymmetric with takedown, which
 *      requires none — asking to be *removed* must be frictionless; asking to be
 *      *re-added* must not be. It also gives the binding an identity to revoke.
 *   2. **Proof of control of the tombstoned Instagram handle**, via a one-time
 *      code the requester publishes on that account. The tombstone is keyed on
 *      the handle and, for this dataset, the handle *is* the identity — so the
 *      proof is anchored to the same fact the removal was.
 *   3. **A human.** Same restraint as takedown: the request route has no write
 *      path to the tombstone or the Artist node. A wall built by a human decision
 *      comes down by a human decision.
 *
 * Honest limits are in ADR 0026 §"Attack surface" — chiefly that this does not
 * survive a hijacked Instagram account, and has no anchor at all for an artist
 * whose tombstone carries no handle.
 *
 * ## Why this does not sit on top of the claim flow
 *
 * Issue #192: `/api/v1/connect/claim` binds `claimedByUid` — the key the money
 * path trusts — to whoever calls it first, with **no identity check at all**.
 * Reinstatement therefore never calls it. It performs its own binding, after
 * handle-control proof and human review, and refuses outright when the husk is
 * already claimed by a different uid (that is #192 surfacing, and it must not be
 * auto-resolved).
 *
 * The converse leak is closed in `/api/v1/connect/claim` itself, which now
 * refuses removed artists — otherwise the unverified route would be a way around
 * this one, since the husk deliberately retains `stripeAccountId`.
 *
 * Everything in this module is pure. Nothing here writes anything.
 */

/** How long a published verification code stays actionable. */
export const VERIFICATION_CODE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export type ReinstatementRequest = {
  /** The tombstoned Instagram handle, normalized. The identity anchor. */
  instagram: string;
  /** The Firebase uid that will own the profile if this is approved. */
  uid: string;
  /** Where to reply. */
  contactEmail: string;
  message: string | null;
};

export type ReinstatementDecision =
  | { ok: true }
  | { ok: false; blockers: string[] };

/** Deliberately permissive — rejecting a real artist's odd address is worse. */
const EMAIL_SHAPE = /^[^\s@]+@[^\s@.]+\.[^\s@]+$/;

/** Instagram's own rule: letters, digits, underscore, period; 1–30 chars. */
const HANDLE_SHAPE = /^[a-z0-9._]{1,30}$/;

const MAX_MESSAGE_LENGTH = 5000;

export type ValidationResult<T> = { ok: true; value: T } | { ok: false; error: string };

/** Normalize "@Foo", an instagram URL, or "foo/" to a bare lowercase handle. */
export function normalizeInstagramHandle(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const clean = raw
    .trim()
    .replace(/^https?:\/\/(www\.)?instagram\.com\//i, '')
    .replace(/^@/, '')
    .replace(/\/.*$/, '')
    .trim()
    .toLowerCase();
  return clean || null;
}

/** The tombstone key a handle would have been recorded under. */
export function tombstoneKeyForHandle(handle: string): string {
  return `instagram:${handle}`;
}

/**
 * Format a verification code for publication.
 *
 * The code is *published publicly* on the artist's Instagram, so it is not a
 * secret. It is a capability proof: only whoever controls the account can put it
 * there. It needs to be unpredictable enough that it cannot be pre-published by
 * someone guessing, which 8 hex characters comfortably is.
 */
export function formatVerificationCode(rawHex: string): string {
  return `TATT-${rawHex.replace(/[^a-f0-9]/gi, '').slice(0, 8).toUpperCase()}`;
}

export function isVerificationCodeExpired(issuedAtEpochMs: number, now: number = Date.now()): boolean {
  if (!Number.isFinite(issuedAtEpochMs)) return true;
  return now - issuedAtEpochMs > VERIFICATION_CODE_TTL_MS;
}

/**
 * Validate an inbound reinstatement request.
 *
 * Gates shape only. The identity check is the published code plus a human
 * (ADR 0026) — but unlike takedown, the caller must already be signed in, so
 * `uid` is supplied by the route from a verified Firebase token and never by
 * the request body.
 */
export function validateReinstatementRequest(
  body: unknown,
  uid: string,
): ValidationResult<ReinstatementRequest> {
  if (!uid) return { ok: false, error: 'A signed-in account is required to request reinstatement.' };

  const b =
    body !== null && typeof body === 'object' && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : null;
  if (!b) return { ok: false, error: 'Request body must be a JSON object.' };

  const instagram = normalizeInstagramHandle(
    typeof b.instagram === 'string' ? b.instagram : null,
  );
  if (!instagram) {
    return {
      ok: false,
      error:
        'instagram is required — the Instagram handle is what a removal was recorded ' +
        'against, and is how we verify this is you.',
    };
  }
  if (!HANDLE_SHAPE.test(instagram)) {
    return { ok: false, error: 'instagram does not look like an Instagram handle.' };
  }

  const contactEmail =
    typeof b.contactEmail === 'string' ? b.contactEmail.trim().toLowerCase() : '';
  if (!contactEmail) return { ok: false, error: 'contactEmail is required — we cannot reply otherwise.' };
  if (!EMAIL_SHAPE.test(contactEmail)) {
    return { ok: false, error: 'contactEmail does not look like an email address.' };
  }

  let message: string | null = null;
  if (b.message !== undefined && b.message !== null) {
    if (typeof b.message !== 'string') return { ok: false, error: 'message must be a string.' };
    if (b.message.length > MAX_MESSAGE_LENGTH) {
      return { ok: false, error: `message must be ${MAX_MESSAGE_LENGTH} characters or fewer.` };
    }
    message = b.message.trim() || null;
  }

  return { ok: true, value: { instagram, uid, contactEmail, message } };
}

/**
 * The appeal text a moderation call may read.
 *
 * The handle, uid, and email stay out of the model call. The decision that
 * comes back must not lift a tombstone, must not restore a profile, and must
 * not move this request off `pending` — callers record it either way. An
 * empty string means there is no message to screen.
 */
export function reinstatementModerationText(request: ReinstatementRequest): string {
  return request.message?.trim() ?? '';
}

/**
 * Everything the operator must be able to see before approving, as facts read
 * from the graph. Assembled by the executor; kept as a type here so the decision
 * rule below can be unit-tested without a driver.
 */
export type ReinstatementFacts = {
  handle: string;
  /** The tombstone recorded for this handle, if any. */
  tombstone: {
    key: string;
    artistId: string | null;
    reinstatedAt: number | null;
  } | null;
  /** The husk the tombstone points at, if it still exists. */
  artist: {
    id: string;
    removedAt: number | null;
    claimedByUid: string | null;
  } | null;
  /** The pending request being actioned. */
  request: {
    id: string;
    uid: string;
    issuedAtEpochMs: number;
  } | null;
  /**
   * Whether the operator asserts they saw the code on the Instagram account.
   * Supplied on the command line — code cannot check Instagram, and pretending
   * otherwise would be the lie that makes this unsafe.
   */
  handleVerifiedByOperator: boolean;
};

/**
 * Decide whether a reinstatement may proceed.
 *
 * Every blocker is a refusal, never a warning: this path hands someone ownership
 * of a profile that can receive real money, so anything unclear stops it. All
 * blockers are collected rather than short-circuited so the operator sees the
 * whole picture in one dry run.
 */
export function decideReinstatement(
  facts: ReinstatementFacts,
  now: number = Date.now(),
): ReinstatementDecision {
  const blockers: string[] = [];

  if (!facts.tombstone) {
    blockers.push(
      `No takedown tombstone exists for ${tombstoneKeyForHandle(facts.handle)}. There is ` +
        'nothing to reinstate — this artist was never removed, so they should sign up ' +
        'normally rather than through this path.',
    );
  } else if (facts.tombstone.reinstatedAt) {
    blockers.push(
      `${facts.handle} was already reinstated at ${new Date(facts.tombstone.reinstatedAt).toISOString()}. ` +
        'Re-running would re-bind ownership; if the artist has lost access, that is an ' +
        'account recovery question, not a reinstatement.',
    );
  }

  if (!facts.request) {
    blockers.push(
      'No pending reinstatement request found for this handle. Reinstatement is only ' +
        'ever actioned against a request the artist themselves submitted while signed in.',
    );
  } else if (isVerificationCodeExpired(facts.request.issuedAtEpochMs, now)) {
    blockers.push(
      'The verification code on this request has expired. Ask the artist to submit a new ' +
        'request — an old code proves control of the handle at some point in the past, ' +
        'which is not the same as now.',
    );
  }

  if (!facts.handleVerifiedByOperator) {
    blockers.push(
      `Handle control has not been confirmed. Check that the code is published on ` +
        `instagram.com/${facts.handle}, then re-run with --handle-verified. This is the ` +
        'identity check; nothing else in this flow performs one.',
    );
  }

  if (!facts.artist) {
    blockers.push(
      'The artist node this tombstone points at no longer exists, so there is nothing to ' +
        'unsuppress. The artist can sign up fresh — reinstatement is not required for that.',
    );
  } else {
    // The issue #192 scenario, surfacing exactly where it matters. The husk
    // retains stripeAccountId and claimedByUid by design (ADR 0025 §2), so
    // silently re-pointing ownership here could hand one person's connected
    // account to another. Refuse and escalate; never resolve this in code.
    if (
      facts.artist.claimedByUid &&
      facts.request &&
      facts.artist.claimedByUid !== facts.request.uid
    ) {
      blockers.push(
        `Artist ${facts.artist.id} is already claimed by a DIFFERENT account ` +
          `(${facts.artist.claimedByUid}) than the one requesting reinstatement ` +
          `(${facts.request.uid}). This is the unverified-claim hole in issue #192 showing ` +
          'up on a profile that may hold a connected Stripe account. Resolve who the artist ' +
          'actually is out of band before reinstating — do not let this script decide.',
      );
    }

    if (facts.tombstone?.artistId && facts.tombstone.artistId !== facts.artist.id) {
      blockers.push(
        `Tombstone ${facts.tombstone.key} records artistId ${facts.tombstone.artistId}, but the ` +
          `node resolved is ${facts.artist.id}. Reinstating the wrong node would unsuppress ` +
          'someone who did not ask for it.',
      );
    }
  }

  return blockers.length ? { ok: false, blockers } : { ok: true };
}
