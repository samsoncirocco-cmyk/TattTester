/**
 * Held-deposit "booking relay" data model.
 *
 * When a customer books an UNCLAIMED artist (one with no Stripe connected
 * account yet, or one whose charges aren't enabled), we can't route the deposit
 * to them — so TatT collects the deposit to the PLATFORM and HOLDS it. This
 * module records that held state as its own node (:BookingRelay) on Neo4j and
 * owns the money movement that resolves it:
 *
 *   - accepted  → the artist finishes onboarding within the hold window; we
 *                 transfer the FULL deposit to their connected account via a
 *                 separate transfer with source_transaction = the charge. The
 *                 booking fee was charged to the client on top at checkout
 *                 (ADR-0007), so nothing is deducted here.
 *   - refunded  → the hold window expires; we fully refund the customer (TatT
 *                 absorbs the Stripe processing fee).
 *
 * Persistence mirrors src/lib/artist-stripe.ts: reads via the shared read-only
 * server cypher helper, writes via a small executeWrite (the shared helper is
 * read-only). The Stripe PaymentIntent id is the natural key.
 */
import { stripe, CURRENCY } from '@/lib/stripe';
import { getArtistStripe } from '@/lib/artist-stripe';

export type BookingRelayStatus = 'pending' | 'accepted' | 'declined' | 'expired' | 'refunded';

export interface BookingRelay {
  /** Natural key = the Stripe PaymentIntent id (pi_...). */
  id: string;
  artistId: string;
  customerEmail: string;
  /** Gross deposit in the smallest currency unit (cents). */
  amountCents: number;
  chargeId: string;
  paymentIntentId: string;
  status: BookingRelayStatus;
  /** Unix seconds after which a still-pending relay is refunded. */
  expiresAtEpoch: number;
  createdAtEpoch: number;
}

export interface CreateRelayInput {
  id: string;
  artistId: string;
  customerEmail: string;
  amountCents: number;
  chargeId: string;
  paymentIntentId: string;
  expiresAtEpoch: number;
  createdAtEpoch: number;
}

/**
 * Amount (cents) transferred to the artist when a held deposit is released.
 * The artist keeps 100% of the deposit — TatT's booking fee was charged to the
 * client ON TOP at checkout and is never part of this transfer, so a released
 * relay pays out its full recorded `amountCents` (which is the deposit only).
 * Pure. Never negative.
 */
export function netTransferCents(depositCents: number): number {
  return Math.max(0, depositCents);
}

/**
 * Pure hold-window predicate: a still-pending relay is expired (and thus due for
 * refund) once `nowEpoch` has passed its `expiresAtEpoch`. This is the canonical
 * definition mirrored by the `expiresAtEpoch < $nowEpoch` filter in
 * {@link listExpiredPending}.
 */
export function isExpired(relay: Pick<BookingRelay, 'expiresAtEpoch'>, nowEpoch: number): boolean {
  return relay.expiresAtEpoch < nowEpoch;
}

async function runRead(query: string, params: Record<string, unknown>) {
  const { executeServerCypherQuery } = await import('@/features/match-pulse/services/neo4jService');
  return executeServerCypherQuery(query, params);
}

async function runWrite(query: string, params: Record<string, unknown>): Promise<void> {
  const { getNeo4jDriver, NEO4J_DATABASE, NEO4J_QUERY_TIMEOUT } = await import('@/lib/neo4j');
  const neo4j = (await import('neo4j-driver')).default;
  const driver = getNeo4jDriver();
  if (!driver) {
    throw new Error('Neo4j driver not configured — cannot persist booking relay.');
  }
  const session = driver.session(NEO4J_DATABASE ? { database: NEO4J_DATABASE } : undefined);
  try {
    await session.executeWrite(
      (tx: { run: (q: string, p: Record<string, unknown>) => Promise<unknown> }) => tx.run(query, params),
      { timeout: neo4j.int(NEO4J_QUERY_TIMEOUT) }
    );
  } finally {
    await session.close();
  }
}

/** Wrap integer params as neo4j.Integer so they persist as ints, not floats. */
async function toInt(n: number) {
  const neo4j = (await import('neo4j-driver')).default;
  return neo4j.int(Math.trunc(n));
}

function rowToRelay(r: Record<string, unknown>): BookingRelay {
  return {
    id: String(r.id),
    artistId: String(r.artistId),
    customerEmail: (r.customerEmail as string) ?? '',
    amountCents: Number(r.amountCents),
    chargeId: (r.chargeId as string) ?? '',
    paymentIntentId: (r.paymentIntentId as string) ?? '',
    status: (r.status as BookingRelayStatus) ?? 'pending',
    expiresAtEpoch: Number(r.expiresAtEpoch),
    createdAtEpoch: Number(r.createdAtEpoch),
  };
}

/** Upsert a pending relay. Idempotent by id (the PaymentIntent id). */
export async function createRelay(input: CreateRelayInput): Promise<void> {
  await runWrite(
    `MERGE (r:BookingRelay {id: $id})
     ON CREATE SET
       r.artistId = $artistId,
       r.customerEmail = $customerEmail,
       r.amountCents = $amountCents,
       r.chargeId = $chargeId,
       r.paymentIntentId = $paymentIntentId,
       r.status = 'pending',
       r.expiresAtEpoch = $expiresAtEpoch,
       r.createdAtEpoch = $createdAtEpoch`,
    {
      id: input.id,
      artistId: input.artistId,
      customerEmail: input.customerEmail,
      amountCents: await toInt(input.amountCents),
      chargeId: input.chargeId,
      paymentIntentId: input.paymentIntentId,
      expiresAtEpoch: await toInt(input.expiresAtEpoch),
      createdAtEpoch: await toInt(input.createdAtEpoch),
    }
  );
}

/** Fetch one relay by id, or null. */
export async function getRelay(id: string): Promise<BookingRelay | null> {
  const rows = await runRead(
    `MATCH (r:BookingRelay {id: $id})
     RETURN r.id AS id, r.artistId AS artistId, r.customerEmail AS customerEmail,
            r.amountCents AS amountCents, r.chargeId AS chargeId,
            r.paymentIntentId AS paymentIntentId, r.status AS status,
            r.expiresAtEpoch AS expiresAtEpoch, r.createdAtEpoch AS createdAtEpoch`,
    { id }
  );
  if (!rows.length) return null;
  return rowToRelay(rows[0] as Record<string, unknown>);
}

/** All pending relays for one artist (the deposits awaiting their onboarding). */
export async function listPendingByArtist(artistId: string): Promise<BookingRelay[]> {
  const rows = await runRead(
    `MATCH (r:BookingRelay {artistId: $artistId, status: 'pending'})
     RETURN r.id AS id, r.artistId AS artistId, r.customerEmail AS customerEmail,
            r.amountCents AS amountCents, r.chargeId AS chargeId,
            r.paymentIntentId AS paymentIntentId, r.status AS status,
            r.expiresAtEpoch AS expiresAtEpoch, r.createdAtEpoch AS createdAtEpoch`,
    { artistId }
  );
  return rows.map((r) => rowToRelay(r as Record<string, unknown>));
}

/** Pending relays whose hold window has elapsed (expiresAtEpoch < now). */
export async function listExpiredPending(nowEpoch: number): Promise<BookingRelay[]> {
  const rows = await runRead(
    `MATCH (r:BookingRelay {status: 'pending'})
     WHERE r.expiresAtEpoch < $nowEpoch
     RETURN r.id AS id, r.artistId AS artistId, r.customerEmail AS customerEmail,
            r.amountCents AS amountCents, r.chargeId AS chargeId,
            r.paymentIntentId AS paymentIntentId, r.status AS status,
            r.expiresAtEpoch AS expiresAtEpoch, r.createdAtEpoch AS createdAtEpoch`,
    { nowEpoch: await toInt(nowEpoch) }
  );
  return rows.map((r) => rowToRelay(r as Record<string, unknown>));
}

/** Transition a relay to a new status. */
export async function setRelayStatus(id: string, status: BookingRelayStatus): Promise<void> {
  await runWrite(
    `MATCH (r:BookingRelay {id: $id})
     SET r.status = $status`,
    { id, status }
  );
}

export interface TransferHeldResult {
  /** Number of relays transferred in this call. */
  count: number;
  /** Total transferred to the artist across those relays, in cents. */
  totalTransferredCents: number;
}

/**
 * Release held deposits to a now-onboarded artist. For each PENDING relay we
 * transfer the FULL recorded deposit (ADR-0007 — the booking fee was charged to
 * the client on top, never deducted here) to the artist's connected account
 * using separate charges & transfers, with source_transaction = the original charge
 * so Stripe draws from the held funds rather than the platform float. Idempotent:
 * only pending relays are touched, and each is flipped to 'accepted' on success.
 */
export async function transferHeldDeposits(artistId: string): Promise<TransferHeldResult> {
  const artist = await getArtistStripe(artistId);
  if (!artist || !artist.claimVerified || !artist.stripeAccountId || !artist.chargesEnabled) {
    return { count: 0, totalTransferredCents: 0 };
  }
  const destination = artist.stripeAccountId;

  const pending = await listPendingByArtist(artistId);
  let count = 0;
  let totalTransferredCents = 0;

  for (const relay of pending) {
    const amount = netTransferCents(relay.amountCents);
    if (amount <= 0) continue;
    await stripe.transfers.create(
      {
        amount,
        currency: CURRENCY,
        destination,
        source_transaction: relay.chargeId,
        metadata: {
          relayId: relay.id,
          artistId,
          grossCents: String(relay.amountCents),
        },
      },
      // Idempotency key: one transfer per relay, safe to retry.
      { idempotencyKey: `relay-transfer-${relay.id}` }
    );
    await setRelayStatus(relay.id, 'accepted');
    count += 1;
    totalTransferredCents += amount;
  }

  return { count, totalTransferredCents };
}

/**
 * Fully refund a held deposit back to the customer (TatT absorbs the Stripe
 * fee). Used when the hold window expires before the artist onboards.
 */
export async function refundRelay(id: string): Promise<void> {
  const relay = await getRelay(id);
  if (!relay) return;
  if (relay.status !== 'pending') return; // idempotent: only refund live holds
  await stripe.refunds.create(
    { payment_intent: relay.paymentIntentId },
    { idempotencyKey: `relay-refund-${relay.id}` }
  );
  await setRelayStatus(id, 'refunded');
}

/**
 * Persist SaaS-subscription state onto the Artist node. Used by the webhook when
 * a subscription checkout completes or a subscription event fires.
 */
export async function setArtistSubscription(
  artistId: string,
  fields: { stripeCustomerId?: string | null; subscriptionStatus?: string | null }
): Promise<void> {
  await runWrite(
    `MATCH (a:Artist {id: $artistId})
     SET a.stripeCustomerId = coalesce($stripeCustomerId, a.stripeCustomerId),
         a.subscriptionStatus = coalesce($subscriptionStatus, a.subscriptionStatus)`,
    {
      artistId,
      stripeCustomerId: fields.stripeCustomerId ?? null,
      subscriptionStatus: fields.subscriptionStatus ?? null,
    }
  );
}

/**
 * Fallback keying for `customer.subscription.*` webhooks whose metadata
 * carries no tattArtistId (e.g. subscriptions started before the profile was
 * claimed, or created outside our checkout). Once a subscription checkout has
 * stamped `stripeCustomerId` onto the node, later lifecycle events can still
 * land by customer id.
 */
export async function setArtistSubscriptionStatusByCustomerId(
  stripeCustomerId: string,
  subscriptionStatus: string
): Promise<void> {
  await runWrite(
    `MATCH (a:Artist {stripeCustomerId: $stripeCustomerId})
     SET a.subscriptionStatus = $subscriptionStatus`,
    { stripeCustomerId, subscriptionStatus }
  );
}
