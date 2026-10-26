/**
 * Request idempotency for the booking money path (spec 5, REA gap K2).
 *
 * The client mints one key per submit attempt and sends it as the
 * `Idempotency-Key` header on capture, hold and checkout. The server scopes it
 * by route and caller, so one header value covers all three calls without them
 * colliding (`{key}:capture`, `{key}:hold`, `{key}:checkout` in the spec).
 *
 *   - first request with a key runs the handler;
 *   - a concurrent second request with the same key gets 409 REQUEST_IN_FLIGHT;
 *   - a later request after a successful one gets the stored response replayed;
 *   - the same key with a different body is 422 IDEMPOTENCY_KEY_REUSED.
 *
 * Only successful (2xx) responses are stored. A refusal — a 429 rate limit, a
 * 409 lost slot, a 503 — is not an answer to replay to a later retry, so the
 * record is dropped and the retry runs fresh.
 *
 * FAIL OPEN. If the store is unreachable the handler runs as if no key had
 * been sent. That is deliberate (spec 5 open question 1): the slot is still
 * protected by the hold transaction and the Stripe session by Stripe's own
 * idempotency key, so the worst case is the old behaviour — a rare duplicate
 * booking record — rather than a booking that cannot be made at all.
 *
 * Without the header, behaviour is unchanged: the wrapper does nothing.
 */
import { createHash } from 'crypto';
import { NextResponse } from 'next/server';
import { ensureAdminApp } from './firebase-admin';

export const IDEMPOTENCY_HEADER = 'idempotency-key';
/**
 * A handler may set this header to say how long its response may be replayed
 * (epoch ms). The wrapper strips it before the response leaves. Checkout uses
 * it so a Stripe URL is never replayed after the session behind it expired.
 */
export const REPLAY_UNTIL_HEADER = 'x-idempotency-replay-until';

export const IDEMPOTENCY_COLLECTION = 'idempotency_keys';
export const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;
/** An in-progress record older than this is a timed-out function; take it over. */
export const STALE_IN_PROGRESS_MS = 60 * 1000;
const MAX_KEY_LENGTH = 200;

export type StoredResponse = { status: number; body: unknown };

export type IdempotencyRecord = {
  route: string;
  principal: string;
  bodyHash: string;
  status: 'in_progress' | 'done';
  response?: StoredResponse;
  createdAtMs: number;
  ttlAtMs: number;
};

export type BeginOutcome =
  | { kind: 'proceed' }
  | { kind: 'in_flight' }
  | { kind: 'mismatch' }
  | { kind: 'replay'; response: StoredResponse };

/** Storage seam: Firestore in production, an in-memory map in tests. */
export interface IdempotencyStore {
  begin(id: string, record: IdempotencyRecord, nowMs: number): Promise<BeginOutcome>;
  complete(id: string, response: StoredResponse, ttlAtMs: number): Promise<void>;
  abandon(id: string): Promise<void>;
}

/**
 * The decision `begin` makes, kept pure so both stores agree on it. `existing`
 * is whatever is stored under the id right now.
 */
export function decideBegin(
  existing: IdempotencyRecord | undefined,
  incoming: IdempotencyRecord,
  nowMs: number,
): BeginOutcome {
  if (!existing || existing.ttlAtMs <= nowMs) return { kind: 'proceed' };
  if (existing.bodyHash !== incoming.bodyHash) return { kind: 'mismatch' };
  if (existing.status === 'done' && existing.response) {
    return { kind: 'replay', response: existing.response };
  }
  if (nowMs - existing.createdAtMs > STALE_IN_PROGRESS_MS) return { kind: 'proceed' };
  return { kind: 'in_flight' };
}

export function createMemoryStore(): IdempotencyStore & {
  records: Map<string, IdempotencyRecord>;
} {
  const records = new Map<string, IdempotencyRecord>();
  return {
    records,
    async begin(id, record, nowMs) {
      const outcome = decideBegin(records.get(id), record, nowMs);
      if (outcome.kind === 'proceed') records.set(id, record);
      return outcome;
    },
    async complete(id, response, ttlAtMs) {
      const rec = records.get(id);
      if (rec) records.set(id, { ...rec, status: 'done', response, ttlAtMs });
    },
    async abandon(id) {
      records.delete(id);
    },
  };
}

/** Firestore store. Returns null when Firebase Admin is not configured. */
async function firestoreStore(): Promise<IdempotencyStore | null> {
  if (!ensureAdminApp()) return null;
  const { getFirestore } = await import('firebase-admin/firestore');
  const db = getFirestore();
  const col = db.collection(IDEMPOTENCY_COLLECTION);
  return {
    async begin(id, record, nowMs) {
      return db.runTransaction(async (tx) => {
        const ref = col.doc(id);
        const snap = await tx.get(ref);
        const existing = snap.exists ? (snap.data() as IdempotencyRecord) : undefined;
        const outcome = decideBegin(existing, record, nowMs);
        // `expireAt` is a real Timestamp so a Firestore TTL policy on it can
        // delete old records; `ttlAtMs` is what the logic reads.
        if (outcome.kind === 'proceed') tx.set(ref, { ...record, expireAt: new Date(record.ttlAtMs) });
        return outcome;
      });
    },
    async complete(id, response, ttlAtMs) {
      await col
        .doc(id)
        .set({ status: 'done', response, ttlAtMs, expireAt: new Date(ttlAtMs) }, { merge: true });
    },
    async abandon(id) {
      await col.doc(id).delete();
    },
  };
}

let storeOverride: IdempotencyStore | null | undefined;

/** Tests inject a store here; `undefined` restores the Firestore default. */
export function setIdempotencyStoreForTests(store: IdempotencyStore | null | undefined): void {
  storeOverride = store;
}

async function resolveStore(): Promise<IdempotencyStore | null> {
  if (storeOverride !== undefined) return storeOverride;
  return firestoreStore();
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/** Who the key belongs to: the verified uid, or the client IP for anonymous callers. */
export function principalFor(req: Request, uid: string | null | undefined): string {
  if (uid) return `uid:${uid}`;
  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown';
  return `ip:${ip}`;
}

/** Read the key from the request; null when absent or unusable. */
export function readIdempotencyKey(req: Request): string | null {
  const raw = req.headers.get(IDEMPOTENCY_HEADER)?.trim();
  if (!raw || raw.length > MAX_KEY_LENGTH) return null;
  return raw;
}

function stripReplayHeader(res: Response): Response {
  try {
    if (res.headers.has(REPLAY_UNTIL_HEADER)) res.headers.delete(REPLAY_UNTIL_HEADER);
  } catch {
    // Immutable headers (a proxied fetch response) — nothing to strip.
  }
  return res;
}

/**
 * Stripe idempotency key for one Checkout Session (spec 5 §4.2):
 * `checkout:{bookingId}:{holdId|nohold}:{amountCents}:{paramsHash}`.
 *
 * The params hash is the one addition to the spec's shape: Stripe refuses a
 * key reused with different parameters (a corrected email, a new placement),
 * so the hash makes "same key" mean "same request" and a changed request a
 * new key rather than a 400.
 */
export function stripeCheckoutIdempotencyKey(input: {
  bookingId?: string | null;
  holdId?: string | null;
  amountCents: number;
  params: unknown;
}): string {
  const paramsHash = sha256(JSON.stringify(input.params)).slice(0, 16);
  return `checkout:${input.bookingId || 'nobooking'}:${input.holdId || 'nohold'}:${input.amountCents}:${paramsHash}`;
}

export const REQUEST_IN_FLIGHT_MESSAGE = 'Still working on that one. Give it a moment.';

/**
 * Run `handler` at most once per (route, caller, key). See the file header for
 * the rules. `uid` is the verified caller (null for anonymous); the handler
 * reads the request body itself as before — the wrapper only reads a clone.
 */
export async function withIdempotency(
  req: Request,
  route: string,
  uid: string | null | undefined,
  handler: () => Promise<Response>,
  options: { nowMs?: () => number; ttlMs?: number } = {},
): Promise<Response> {
  const key = readIdempotencyKey(req);
  if (!key) return stripReplayHeader(await handler());

  const now = options.nowMs ?? Date.now;
  const principal = principalFor(req, uid);
  const id = sha256(`${route}\u0000${principal}\u0000${key}`);

  let bodyText = '';
  try {
    bodyText = await req.clone().text();
  } catch {
    bodyText = '';
  }

  let store: IdempotencyStore | null = null;
  let outcome: BeginOutcome = { kind: 'proceed' };
  const startedAt = now();
  try {
    store = await resolveStore();
    if (store) {
      outcome = await store.begin(
        id,
        {
          route,
          principal,
          bodyHash: sha256(bodyText),
          status: 'in_progress',
          createdAtMs: startedAt,
          ttlAtMs: startedAt + (options.ttlMs ?? DEFAULT_TTL_MS),
        },
        startedAt,
      );
    }
  } catch (err) {
    // Fail open — see the file header.
    console.warn(
      `[idempotency] ${route}: store unavailable, running without a key:`,
      err instanceof Error ? err.message : err,
    );
    store = null;
    outcome = { kind: 'proceed' };
  }

  if (outcome.kind === 'replay') {
    return NextResponse.json(outcome.response.body, {
      status: outcome.response.status,
      headers: { 'idempotent-replayed': 'true' },
    });
  }
  if (outcome.kind === 'in_flight') {
    return NextResponse.json(
      { error: REQUEST_IN_FLIGHT_MESSAGE, code: 'REQUEST_IN_FLIGHT' },
      { status: 409 },
    );
  }
  if (outcome.kind === 'mismatch') {
    return NextResponse.json(
      {
        error: 'This request key was already used for a different request.',
        code: 'IDEMPOTENCY_KEY_REUSED',
      },
      { status: 422 },
    );
  }

  let res: Response;
  try {
    res = await handler();
  } catch (err) {
    if (store) await store.abandon(id).catch(() => undefined);
    throw err;
  }

  if (!store) return stripReplayHeader(res);

  try {
    if (res.ok) {
      const body = await res.clone().json().catch(() => null);
      const replayUntil = Number(res.headers.get(REPLAY_UNTIL_HEADER));
      const ttlAtMs =
        Number.isFinite(replayUntil) && replayUntil > 0
          ? replayUntil
          : startedAt + (options.ttlMs ?? DEFAULT_TTL_MS);
      await store.complete(id, { status: res.status, body }, ttlAtMs);
    } else {
      await store.abandon(id);
    }
  } catch (err) {
    console.warn(
      `[idempotency] ${route}: could not record the response:`,
      err instanceof Error ? err.message : err,
    );
  }
  return stripReplayHeader(res);
}
