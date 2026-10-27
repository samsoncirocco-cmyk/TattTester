/**
 * Artist takedown — domain rules shared by the request route, the read-path
 * suppression, and the offline executor. See docs/adr/0025.
 *
 * TatT re-hosts portfolio photographs for ~7.8k artists who never opted in.
 * This module is the vocabulary for undoing that for one artist:
 *
 *   - `validateTakedownRequest` — what a request must contain to be actionable.
 *   - `tombstoneKeysFor`        — the identifiers a removal must be remembered
 *                                 under so a later scrape cannot resurrect them.
 *   - `NOT_REMOVED_CLAUSE`      — the Cypher predicate every artist read path
 *                                 interpolates so a removal is actually invisible.
 *
 * Everything here is pure. Nothing in this module can delete anything: the
 * public request path deliberately has no write access to GCS, Supabase or the
 * Artist node. Removal happens only from scripts/execute-takedown.mjs, run by a
 * human, dry-run by default.
 */

/** Who the requester says they are. Recorded for the reviewer; never trusted. */
export const TAKEDOWN_RELATIONSHIPS = ['artist', 'representative', 'shop', 'other'] as const;
export type TakedownRelationship = (typeof TAKEDOWN_RELATIONSHIPS)[number];

/**
 * How much to remove. 'images' is a real request ("take my photos down but the
 * listing is fine"); 'all' also suppresses the profile. Ambiguity defaults to
 * 'all' — over-removing is recoverable, under-removing is the thing we're
 * apologising for.
 */
export const TAKEDOWN_SCOPES = ['all', 'images'] as const;
export type TakedownScope = (typeof TAKEDOWN_SCOPES)[number];

export type TakedownRequest = {
  artistId: string;
  contactEmail: string;
  relationship: TakedownRelationship;
  scope: TakedownScope;
  message: string | null;
};

export type TombstoneKey = {
  key: string;
  keyType: 'instagram' | 'artist' | 'source';
};

export type ValidationResult<T> = { ok: true; value: T } | { ok: false; error: string };

/**
 * Artist ids are used as GCS path segments (`artists/<id>/…`), so they must be
 * inert. The property that matters is "cannot escape its prefix or name a
 * different object" — not "contains no dots".
 *
 * An earlier `/^[A-Za-z0-9_-]+$/` conflated the two and **rejected 1,621 of the
 * 10,427 artists in the national dataset (15.5%)**. Ids there are derived from
 * the Instagram handle (`artist_pham.minh.phuc`), and Instagram allows dots — so
 * the strict form meant an artist with a dot in their handle could not file a
 * takedown request at all, and `tombstoneKeysFor` threw on them. A validator
 * that silently refuses one in seven of the people this mechanism exists for is
 * worse than the traversal risk it was guarding.
 *
 * Dots are therefore allowed, and traversal is blocked directly: no leading
 * dot, and no `..` anywhere. `/` and `\` remain excluded by the character class.
 */
const SAFE_ARTIST_ID = /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/;

/** True when `id` is safe to interpolate into a storage path. */
export function isSafeArtistId(id: string): boolean {
  return SAFE_ARTIST_ID.test(id) && !id.includes('..');
}

/** Deliberately permissive: rejecting a real artist's odd address is the worse error. */
const EMAIL_SHAPE = /^[^\s@]+@[^\s@.]+\.[^\s@]+$/;

const MAX_MESSAGE_LENGTH = 5000;

/**
 * Cypher predicate gating every artist read on "not taken down".
 *
 * Assumes the artist node is bound as `a`. Interpolated by
 * artists-graph.buildRosterFilter, getRosterArtistById, and
 * neo4jService.buildNotRemovedClause.
 */
export const NOT_REMOVED_CLAUSE = 'a.removedAt IS NULL';

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

/**
 * The identifiers a takedown must be remembered under.
 *
 * The instagram handle leads deliberately. National-dataset ids are derived
 * from the handle (`artist_tattoosbyging`), but the crawler mints random ids
 * (`artist_dvpyb68gp` — `Math.random()` in artist_validator.js), so an id-keyed
 * tombstone would not survive a re-crawl. The handle is the only identifier
 * stable across ingest runs, and it is what the crawler knows *before* it mints
 * an id. See ADR 0025 §3.
 */
export function tombstoneKeysFor(input: {
  artistId: string;
  instagram?: string | null;
  sourcePages?: readonly string[] | null;
}): TombstoneKey[] {
  const artistId = input.artistId?.trim();
  if (!artistId || !isSafeArtistId(artistId)) {
    throw new Error(`Unsafe artistId for tombstone: ${JSON.stringify(input.artistId)}`);
  }

  const keys: TombstoneKey[] = [];

  const handle = normalizeInstagramHandle(input.instagram);
  if (handle) keys.push({ key: `instagram:${handle}`, keyType: 'instagram' });

  keys.push({ key: `artist:${artistId}`, keyType: 'artist' });

  const seen = new Set<string>();
  for (const page of input.sourcePages ?? []) {
    const url = typeof page === 'string' ? page.trim() : '';
    if (!url || seen.has(url)) continue;
    seen.add(url);
    keys.push({ key: `source:${url}`, keyType: 'source' });
  }

  return keys;
}

function asRecord(body: unknown): Record<string, unknown> | null {
  return body !== null && typeof body === 'object' && !Array.isArray(body)
    ? (body as Record<string, unknown>)
    : null;
}

/**
 * Validate a takedown request body.
 *
 * Intentionally shallow: this gates *shape*, not identity. Anyone may ask. The
 * identity check is a human reviewing the request before running the executor
 * (ADR 0025 §6) — which is also what stops takedown becoming a way to delete a
 * competitor.
 */
export function validateTakedownRequest(body: unknown): ValidationResult<TakedownRequest> {
  const b = asRecord(body);
  if (!b) return { ok: false, error: 'Request body must be a JSON object.' };

  const artistId = typeof b.artistId === 'string' ? b.artistId.trim() : '';
  if (!artistId) return { ok: false, error: 'artistId is required.' };
  if (!isSafeArtistId(artistId)) {
    return { ok: false, error: 'artistId contains unsupported characters.' };
  }

  const contactEmail = typeof b.contactEmail === 'string' ? b.contactEmail.trim().toLowerCase() : '';
  if (!contactEmail) return { ok: false, error: 'contactEmail is required — we cannot reply otherwise.' };
  if (!EMAIL_SHAPE.test(contactEmail)) {
    return { ok: false, error: 'contactEmail does not look like an email address.' };
  }

  const relationship = typeof b.relationship === 'string' ? b.relationship.trim() : '';
  if (!TAKEDOWN_RELATIONSHIPS.includes(relationship as TakedownRelationship)) {
    return {
      ok: false,
      error: `relationship must be one of: ${TAKEDOWN_RELATIONSHIPS.join(', ')}.`,
    };
  }

  const rawScope = b.scope === undefined || b.scope === null ? 'all' : b.scope;
  const scope = typeof rawScope === 'string' ? rawScope.trim() : '';
  if (!TAKEDOWN_SCOPES.includes(scope as TakedownScope)) {
    return { ok: false, error: `scope must be one of: ${TAKEDOWN_SCOPES.join(', ')}.` };
  }

  let message: string | null = null;
  if (b.message !== undefined && b.message !== null) {
    if (typeof b.message !== 'string') return { ok: false, error: 'message must be a string.' };
    // Truncating would quietly drop the part of the request that explains it.
    if (b.message.length > MAX_MESSAGE_LENGTH) {
      return { ok: false, error: `message must be ${MAX_MESSAGE_LENGTH} characters or fewer.` };
    }
    message = b.message.trim() || null;
  }

  return {
    ok: true,
    value: {
      artistId,
      contactEmail,
      relationship: relationship as TakedownRelationship,
      scope: scope as TakedownScope,
      message,
    },
  };
}

/**
 * The words a moderation call may read from a takedown.
 *
 * The contact email stays out of the model call. The decision that comes
 * back must not delete an artist and must not move this request off
 * `pending` — callers record it either way. An empty string means there is
 * no message to screen, and the request proceeds as it does today.
 */
export function takedownModerationText(request: TakedownRequest): string {
  const message = request.message?.trim() ?? '';
  if (!message) return '';
  return `Takedown request (${request.relationship}, scope ${request.scope}):\n${message}`;
}
