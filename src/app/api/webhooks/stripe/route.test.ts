// Seam tests for the Stripe webhook's booking reconciliation (Tasks 1.3/1.9).
//
// Stripe, firebase-admin, and the relay/notify side-modules are all mocked so
// these tests exercise ONLY the reconciliation logic: on a
// `checkout.session.completed` event whose metadata carries a bookingId, the
// booking_requests doc moves pending → deposit_paid; a replay of the same event
// id is a no-op (idempotency).
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

// ── firebase-admin/firestore fake ──────────────────────────────────────────
// A tiny in-memory doc store that supports the exact surface the route uses:
// collection().doc(), runTransaction(tx => …), tx.get()/tx.set({merge}), and
// FieldValue.arrayUnion (applied at set time).
const ARRAY_UNION = Symbol('arrayUnion');
const DELETE_FIELD = Symbol('deleteField');

type DocStore = Map<string, Record<string, unknown>>;
const docStore: DocStore = new Map();

function makeRef(id: string) {
  return {
    id,
    async get() {
      const data = docStore.get(id);
      return {
        exists: data !== undefined,
        data: () => data,
      };
    },
    set(patch: Record<string, unknown>, options?: { merge?: boolean }) {
      const prev = options?.merge ? docStore.get(id) ?? {} : {};
      const next: Record<string, unknown> = { ...prev };
      for (const [k, v] of Object.entries(patch)) {
        if (v === DELETE_FIELD) {
          delete next[k];
        } else if (v && typeof v === 'object' && (v as { __op?: symbol }).__op === ARRAY_UNION) {
          const existing = Array.isArray(next[k]) ? (next[k] as unknown[]) : [];
          const additions = (v as { values: unknown[] }).values.filter((x) => !existing.includes(x));
          next[k] = [...existing, ...additions];
        } else {
          next[k] = v;
        }
      }
      docStore.set(id, next);
    },
  };
}

const fakeDb = {
  collection: (_name: string) => ({
    doc: (id: string) => makeRef(id),
  }),
  async runTransaction(fn: (tx: unknown) => Promise<void>) {
    // Single-writer webhook: run the callback with a tx that proxies the ref's
    // own get/set (good enough for the reconciliation's read-then-write).
    const tx = {
      get: (ref: ReturnType<typeof makeRef>) => ref.get(),
      set: (ref: ReturnType<typeof makeRef>, patch: Record<string, unknown>, options?: { merge?: boolean }) =>
        ref.set(patch, options),
    };
    await fn(tx);
  },
};

const FieldValue = {
  arrayUnion: (...values: unknown[]) => ({ __op: ARRAY_UNION, values }),
  delete: () => DELETE_FIELD,
};

vi.mock('firebase-admin/firestore', () => ({
  getFirestore: () => fakeDb,
  FieldValue,
}));

vi.mock('@/lib/firebase-admin', () => ({
  ensureAdminApp: () => 'sa-json',
}));

// ── Stripe fake ─────────────────────────────────────────────────────────────
// constructEvent returns whatever event we stashed; the payment-intent retrieve
// is only touched by the held-deposit relay path (unused here) but stubbed safe.
const { constructEventMock, retrievePiMock, listLineItemsMock } = vi.hoisted(() => ({
  constructEventMock: vi.fn(),
  retrievePiMock: vi.fn(),
  listLineItemsMock: vi.fn(),
}));

vi.mock('@/lib/stripe', () => ({
  stripe: {
    webhooks: { constructEvent: constructEventMock },
    paymentIntents: { retrieve: retrievePiMock },
    checkout: { sessions: { listLineItems: listLineItemsMock } },
  },
}));

// ── Side-modules stubbed so unrelated paths never explode ───────────────────
vi.mock('@/lib/booking-relay', () => ({
  createRelay: vi.fn().mockResolvedValue(undefined),
  transferHeldDeposits: vi.fn().mockResolvedValue({ count: 0 }),
  setArtistSubscription: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/lib/artist-stripe', () => ({
  setArtistChargesEnabled: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/lib/notify', () => ({
  notifyArtistOfBooking: vi.fn().mockResolvedValue(undefined),
}));

const { grantPurchasedGenerationCreditsMock } = vi.hoisted(() => ({
  grantPurchasedGenerationCreditsMock: vi.fn().mockResolvedValue({ granted: true, paidRemaining: 25 }),
}));
vi.mock('@/lib/generation-credits', () => ({
  grantPurchasedGenerationCredits: grantPurchasedGenerationCreditsMock,
}));

// The account.updated fallback resolves the artist from the graph by
// connected-account id; rows are staged per-test via `cypherRows`.
const { cypherRows } = vi.hoisted(() => ({ cypherRows: [] as Array<Record<string, unknown>> }));
vi.mock('@/features/match-pulse/services/neo4jService', () => ({
  executeServerCypherQuery: vi.fn(async () => cypherRows),
}));

import { createRelay, transferHeldDeposits } from '@/lib/booking-relay';
import { setArtistChargesEnabled } from '@/lib/artist-stripe';
import { notifyArtistOfBooking } from '@/lib/notify';
import { POST } from './route';

const CREATED_EPOCH = 1_700_000_000; // fixed → deterministic paidAt
const CREATED_ISO = new Date(CREATED_EPOCH * 1000).toISOString();

function makeEvent(id: string) {
  return {
    id,
    type: 'checkout.session.completed',
    created: CREATED_EPOCH,
    data: {
      object: {
        id: 'cs_test_123',
        mode: 'payment',
        payment_status: 'paid',
        amount_total: 8250,
        payment_intent: 'pi_test_abc',
        customer_details: { email: 'client@example.com' },
        metadata: {
          bookingId: 'BK-TEST01',
          // 'routed' (not 'held') → the relay branch is skipped.
          depositState: 'routed',
          // Deposit in DOLLARS (75). amount_total (8250 cents) is deposit + fee.
          depositAmount: '75',
        },
      },
    },
  };
}

function makeRequest(event: unknown) {
  const body = JSON.stringify(event);
  return new Request('http://localhost/api/webhooks/stripe', {
    method: 'POST',
    headers: { 'stripe-signature': 't=1,v1=deadbeef' },
    body,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as any;
}

describe('Stripe webhook — booking reconciliation (Task 1.3)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    docStore.clear();
    process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test_dummy';
    // Seed a captured, unpaid booking.
    docStore.set('BK-TEST01', {
      bookingId: 'BK-TEST01',
      status: 'pending',
      clientEmail: 'client@example.com',
    });
  });

  it('transitions pending → deposit_paid and stamps Stripe fields', async () => {
    const event = makeEvent('evt_1');
    constructEventMock.mockReturnValueOnce(event);

    const res = await POST(makeRequest(event));
    expect(res.status).toBe(200);

    const doc = docStore.get('BK-TEST01')!;
    expect(doc.status).toBe('deposit_paid');
    expect(doc.stripeSessionId).toBe('cs_test_123');
    expect(doc.stripePaymentIntent).toBe('pi_test_abc');
    expect(doc.depositAmount).toBe(75); // dollars — the deposit, not the cents total
    expect(doc.amountPaidCents).toBe(8250); // full charged total (deposit + fee), cents
    expect(doc.paidAt).toBe(CREATED_ISO);
    expect(doc.processedStripeEvents).toEqual(['evt_1']);

    const history = doc.statusHistory as Array<Record<string, unknown>>;
    expect(history).toHaveLength(1);
    expect(history[0]).toEqual({ status: 'deposit_paid', at: CREATED_ISO, by: 'stripe-webhook' });
  });

  it('is idempotent: replaying the same event id is a no-op', async () => {
    const event = makeEvent('evt_1');
    constructEventMock.mockReturnValue(event);

    // First delivery.
    await POST(makeRequest(event));
    const afterFirst = docStore.get('BK-TEST01')!;
    expect((afterFirst.statusHistory as unknown[]).length).toBe(1);

    // Stripe retries the SAME event id.
    const res = await POST(makeRequest(event));
    expect(res.status).toBe(200);

    const afterReplay = docStore.get('BK-TEST01')!;
    // No double-append, still exactly one processed id.
    expect((afterReplay.statusHistory as unknown[]).length).toBe(1);
    expect(afterReplay.processedStripeEvents).toEqual(['evt_1']);
  });

  it('skips reconciliation when the session carries no bookingId', async () => {
    const event = makeEvent('evt_2');
    // Strip the bookingId (older sessions).
    (event.data.object.metadata as Record<string, unknown>).bookingId = undefined;
    constructEventMock.mockReturnValueOnce(event);

    const res = await POST(makeRequest(event));
    expect(res.status).toBe(200);

    // The seeded booking is untouched — still pending, no Stripe stamps.
    const doc = docStore.get('BK-TEST01')!;
    expect(doc.status).toBe('pending');
    expect(doc.stripeSessionId).toBeUndefined();
  });

  it('does NOT mark deposit_paid when the session is not yet paid', async () => {
    const event = makeEvent('evt_3');
    event.data.object.payment_status = 'unpaid'; // async method still clearing
    constructEventMock.mockReturnValueOnce(event);

    const res = await POST(makeRequest(event));
    expect(res.status).toBe(200);

    const doc = docStore.get('BK-TEST01')!;
    expect(doc.status).toBe('pending'); // untouched until money clears
    expect(doc.stripeSessionId).toBeUndefined();
  });

  it('seeds the booking doc from metadata when it is missing (file-fallback recovery)', async () => {
    docStore.delete('BK-TEST01'); // capture only reached the file fallback
    const event = makeEvent('evt_4');
    (event.data.object.metadata as Record<string, unknown>).clientUid = 'uid-owner-1';
    (event.data.object.metadata as Record<string, unknown>).artistId = 'artist_x';
    constructEventMock.mockReturnValueOnce(event);

    const res = await POST(makeRequest(event));
    expect(res.status).toBe(200);

    const doc = docStore.get('BK-TEST01')!;
    expect(doc.status).toBe('deposit_paid');
    expect(doc.uid).toBe('uid-owner-1'); // owner can still read it via /api/v1/bookings
    expect(doc.artistId).toBe('artist_x');
    expect(doc.depositAmount).toBe(75);
    expect(doc.reconstructedFromStripe).toBe(true);
    expect(doc.processedStripeEvents).toEqual(['evt_4']);
  });
});

// ── Held-deposit relay branch (ADR-0005 / ADR-0007) ─────────────────────────
// The relay's amountCents is what transferHeldDeposits later pays the artist.
// It must be the DEPOSIT, never the client's total (deposit + booking fee) —
// recording amount_total here would silently hand TatT's fee to the artist on
// every held booking.
const HELD_EPOCH = 1_700_000_000;

function makeHeldEvent(id: string, metadataOverrides: Record<string, string> = {}) {
  return {
    id,
    type: 'checkout.session.completed',
    created: HELD_EPOCH,
    data: {
      object: {
        id: 'cs_held_1',
        mode: 'payment',
        payment_status: 'paid',
        // $150 deposit + $15 booking fee.
        amount_total: 16_500,
        payment_intent: 'pi_held_1',
        customer_details: { email: 'client@example.com' },
        metadata: {
          depositState: 'held',
          artistId: 'artist_1',
          clientEmail: 'client@example.com',
          depositAmount: '150',
          depositCents: '15000',
          bookingFeeCents: '1500',
          ...metadataOverrides,
        },
      },
    },
  };
}

describe('Stripe webhook — held-deposit relay', () => {
  const originalHoldDays = process.env.DEPOSIT_HOLD_DAYS;

  beforeEach(() => {
    vi.clearAllMocks();
    docStore.clear();
    process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test_dummy';
    delete process.env.DEPOSIT_HOLD_DAYS;
    retrievePiMock.mockResolvedValue({ id: 'pi_held_1', latest_charge: 'ch_held_1' });
  });

  afterAll(() => {
    if (originalHoldDays === undefined) delete process.env.DEPOSIT_HOLD_DAYS;
    else process.env.DEPOSIT_HOLD_DAYS = originalHoldDays;
  });

  it("records the artist's share as the deposit, NOT the client's total", async () => {
    const event = makeHeldEvent('evt_held_1');
    constructEventMock.mockReturnValueOnce(event);

    const res = await POST(makeRequest(event));
    expect(res.status).toBe(200);

    expect(createRelay).toHaveBeenCalledTimes(1);
    const relay = vi.mocked(createRelay).mock.calls[0][0];
    expect(relay.amountCents).toBe(15_000);
    // amount_total (16500) includes TatT's fee and must never be the relay amount.
    expect(relay.amountCents).not.toBe(16_500);
  });

  it('keys the relay on the PaymentIntent and captures the charge for source_transaction', async () => {
    const event = makeHeldEvent('evt_held_2');
    constructEventMock.mockReturnValueOnce(event);

    await POST(makeRequest(event));

    const relay = vi.mocked(createRelay).mock.calls[0][0];
    expect(relay.id).toBe('pi_held_1');
    expect(relay.paymentIntentId).toBe('pi_held_1');
    expect(relay.chargeId).toBe('ch_held_1');
    expect(relay.artistId).toBe('artist_1');
    expect(relay.customerEmail).toBe('client@example.com');
  });

  it('stamps a 7-day hold window by default (ADR-0006)', async () => {
    const event = makeHeldEvent('evt_held_3');
    constructEventMock.mockReturnValueOnce(event);

    await POST(makeRequest(event));

    const relay = vi.mocked(createRelay).mock.calls[0][0];
    expect(relay.createdAtEpoch).toBe(HELD_EPOCH);
    expect(relay.expiresAtEpoch).toBe(HELD_EPOCH + 7 * 86_400);
  });

  it('honours DEPOSIT_HOLD_DAYS', async () => {
    process.env.DEPOSIT_HOLD_DAYS = '3';
    const event = makeHeldEvent('evt_held_4');
    constructEventMock.mockReturnValueOnce(event);

    await POST(makeRequest(event));

    expect(vi.mocked(createRelay).mock.calls[0][0].expiresAtEpoch).toBe(HELD_EPOCH + 3 * 86_400);
  });

  it('prefers checkout-stamped metadata.holdDays over a live DEPOSIT_HOLD_DAYS change', async () => {
    process.env.DEPOSIT_HOLD_DAYS = '3';
    const event = makeHeldEvent('evt_held_meta', { holdDays: '14' });
    constructEventMock.mockReturnValueOnce(event);

    await POST(makeRequest(event));

    expect(vi.mocked(createRelay).mock.calls[0][0].expiresAtEpoch).toBe(HELD_EPOCH + 14 * 86_400);
  });

  it('notifies the artist so they can claim and release the funds', async () => {
    const event = makeHeldEvent('evt_held_5');
    constructEventMock.mockReturnValueOnce(event);

    await POST(makeRequest(event));

    expect(notifyArtistOfBooking).toHaveBeenCalledTimes(1);
    expect(vi.mocked(notifyArtistOfBooking).mock.calls[0][0]).toMatchObject({
      id: 'pi_held_1',
      artistId: 'artist_1',
      amountCents: 15_000,
      status: 'pending',
    });
  });

  it('does NOT record a relay for a routed (claimed-artist) session', async () => {
    const event = makeEvent('evt_routed_1'); // depositState: 'routed'
    constructEventMock.mockReturnValueOnce(event);

    await POST(makeRequest(event));

    expect(createRelay).not.toHaveBeenCalled();
    expect(notifyArtistOfBooking).not.toHaveBeenCalled();
  });
});

// ── Consumer credit pack fulfillment ────────────────────────────────────────
function makeCreditEvent(
  id: string,
  type: 'checkout.session.completed' | 'checkout.session.async_payment_succeeded',
  paymentStatus: 'paid' | 'unpaid'
) {
  return {
    id,
    type,
    created: CREATED_EPOCH,
    data: {
      object: {
        id: 'cs_credits_1',
        mode: 'payment',
        payment_status: paymentStatus,
        amount_total: 1000,
        payment_intent: 'pi_credits_1',
        metadata: {
          kind: 'consumer_generation_credits',
          uid: 'uid_buyer_1',
        },
      },
    },
  };
}

describe('Stripe webhook — consumer generation credits', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    docStore.clear();
    process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test_dummy';
    process.env.STRIPE_PRICE_CONSUMER_CREDITS = 'price_credit_pack';
    listLineItemsMock.mockResolvedValue({
      data: [{ price: { id: 'price_credit_pack' }, quantity: 1 }],
    });
  });

  it('grants credits on checkout.session.completed when already paid', async () => {
    const event = makeCreditEvent('evt_credits_1', 'checkout.session.completed', 'paid');
    constructEventMock.mockReturnValueOnce(event);

    const res = await POST(makeRequest(event));
    expect(res.status).toBe(200);
    expect(listLineItemsMock).toHaveBeenCalledWith('cs_credits_1', { limit: 10 });
    expect(grantPurchasedGenerationCreditsMock).toHaveBeenCalledWith('uid_buyer_1', 'cs_credits_1');
  });

  it('skips grant on completed while async payment is still unpaid', async () => {
    const event = makeCreditEvent('evt_credits_2', 'checkout.session.completed', 'unpaid');
    constructEventMock.mockReturnValueOnce(event);

    const res = await POST(makeRequest(event));
    expect(res.status).toBe(200);
    expect(listLineItemsMock).not.toHaveBeenCalled();
    expect(grantPurchasedGenerationCreditsMock).not.toHaveBeenCalled();
  });

  it('grants credits on checkout.session.async_payment_succeeded', async () => {
    const event = makeCreditEvent(
      'evt_credits_3',
      'checkout.session.async_payment_succeeded',
      'paid'
    );
    constructEventMock.mockReturnValueOnce(event);

    const res = await POST(makeRequest(event));
    expect(res.status).toBe(200);
    expect(grantPurchasedGenerationCreditsMock).toHaveBeenCalledWith('uid_buyer_1', 'cs_credits_1');
  });

  it('returns 500 when a paid credit checkout is missing uid so Stripe retries', async () => {
    const event = makeCreditEvent('evt_credits_4', 'checkout.session.completed', 'paid');
    delete (event.data.object.metadata as { uid?: string }).uid;
    constructEventMock.mockReturnValueOnce(event);

    const res = await POST(makeRequest(event));
    expect(res.status).toBe(500);
    expect(listLineItemsMock).not.toHaveBeenCalled();
    expect(grantPurchasedGenerationCreditsMock).not.toHaveBeenCalled();
  });

  it('refuses grant when the session charged a different price than the configured pack', async () => {
    listLineItemsMock.mockResolvedValueOnce({
      data: [{ price: { id: 'price_cheap_spoof' }, quantity: 1 }],
    });
    const event = makeCreditEvent('evt_credits_5', 'checkout.session.completed', 'paid');
    constructEventMock.mockReturnValueOnce(event);

    const res = await POST(makeRequest(event));
    expect(res.status).toBe(200);
    expect(grantPurchasedGenerationCreditsMock).not.toHaveBeenCalled();
  });
});

// ── account.updated → release held deposits ─────────────────────────────────
// The other half of the money path: a relay recorded above only pays out if
// this event actually reaches transferHeldDeposits. Nothing covered this, so
// the chain could rot silently — and the failure mode is a customer refund
// seven days later, not an error anyone sees.
function makeAccountEvent(
  id: string,
  account: Record<string, unknown>
) {
  return {
    id,
    type: 'account.updated',
    created: HELD_EPOCH,
    data: { object: { id: 'acct_live_1', ...account } },
  };
}

describe('Stripe webhook — account.updated releases held deposits', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    docStore.clear();
    process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test_dummy';
    cypherRows.length = 0;
  });

  it('caches charges_enabled and flushes held deposits, keyed by account metadata', async () => {
    const event = makeAccountEvent('evt_acct_1', {
      charges_enabled: true,
      metadata: { tattArtistId: 'artist_1' },
    });
    constructEventMock.mockReturnValueOnce(event);
    vi.mocked(transferHeldDeposits).mockResolvedValueOnce({ count: 1, totalTransferredCents: 15_000 });

    const res = await POST(makeRequest(event));
    expect(res.status).toBe(200);
    expect(setArtistChargesEnabled).toHaveBeenCalledWith('acct_live_1', true);
    expect(transferHeldDeposits).toHaveBeenCalledWith('artist_1');
  });

  it('falls back to the Artist node keyed by the connected-account id', async () => {
    // Accounts created before the metadata wiring (or restored by hand) have no
    // tattArtistId — without this fallback their deposits would never release.
    const event = makeAccountEvent('evt_acct_2', { charges_enabled: true, metadata: {} });
    constructEventMock.mockReturnValueOnce(event);
    cypherRows.push({ id: 'artist_from_graph' });

    await POST(makeRequest(event));
    expect(transferHeldDeposits).toHaveBeenCalledWith('artist_from_graph');
  });

  it('does NOT release while charges are still disabled', async () => {
    const event = makeAccountEvent('evt_acct_3', {
      charges_enabled: false,
      metadata: { tattArtistId: 'artist_1' },
    });
    constructEventMock.mockReturnValueOnce(event);

    await POST(makeRequest(event));
    expect(setArtistChargesEnabled).toHaveBeenCalledWith('acct_live_1', false);
    expect(transferHeldDeposits).not.toHaveBeenCalled();
  });

  it('still acknowledges the event when the transfer throws (Stripe must not retry-storm)', async () => {
    const event = makeAccountEvent('evt_acct_4', {
      charges_enabled: true,
      metadata: { tattArtistId: 'artist_1' },
    });
    constructEventMock.mockReturnValueOnce(event);
    vi.mocked(transferHeldDeposits).mockRejectedValueOnce(new Error('transfer blew up'));

    const res = await POST(makeRequest(event));
    expect(res.status).toBe(200);
  });
});

// ── checkout.session.expired releases the slot hold (REA gap #1) ────────────
// The session's expires_at is pinned to the hold, so this event means the
// customer never paid. The hold doc must flip to released and the booking
// record must walk back from `held` to `pending`; a converted (paid) hold must
// never be touched, however the event arrives.
function makeExpiredEvent(id: string, metadata: Record<string, string>) {
  return {
    id,
    type: 'checkout.session.expired',
    created: CREATED_EPOCH,
    data: {
      object: {
        id: 'cs_expired_1',
        mode: 'payment',
        payment_status: 'unpaid',
        status: 'expired',
        metadata,
      },
    },
  };
}

const EXPIRED_HOLD = {
  holdId: 'hold_exp',
  artistId: 'artist_1',
  bookingId: 'BK-EXP00001',
  date: '2026-08-01',
  startTime: '14:00',
  endTime: '16:00',
  timezone: 'America/Phoenix',
  createdAt: CREATED_ISO,
  expiresAt: CREATED_ISO,
  status: 'active',
};

describe('Stripe webhook — checkout.session.expired releases the hold', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    docStore.clear();
    process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test_dummy';
    docStore.set('hold_exp', { ...EXPIRED_HOLD });
    docStore.set('BK-EXP00001', {
      bookingId: 'BK-EXP00001',
      status: 'held',
      holdId: 'hold_exp',
      holdExpiresAt: CREATED_ISO,
      heldSlot: { date: '2026-08-01' },
    });
  });

  it('releases the hold and walks the booking back to pending', async () => {
    const event = makeExpiredEvent('evt_exp_1', { holdId: 'hold_exp', bookingId: 'BK-EXP00001' });
    constructEventMock.mockReturnValueOnce(event);

    const res = await POST(makeRequest(event));
    expect(res.status).toBe(200);

    expect(docStore.get('hold_exp')!.status).toBe('released');
    const booking = docStore.get('BK-EXP00001')!;
    expect(booking.status).toBe('pending');
    expect(booking.holdId).toBeUndefined();
    expect(booking.heldSlot).toBeUndefined();
  });

  it('never un-sells a converted hold, even if an expired event arrives for it', async () => {
    docStore.set('hold_exp', { ...EXPIRED_HOLD, status: 'converted' });
    docStore.set('BK-EXP00001', { ...docStore.get('BK-EXP00001')!, status: 'deposit_paid' });
    const event = makeExpiredEvent('evt_exp_2', { holdId: 'hold_exp', bookingId: 'BK-EXP00001' });
    constructEventMock.mockReturnValueOnce(event);

    await POST(makeRequest(event));
    expect(docStore.get('hold_exp')!.status).toBe('converted');
    expect(docStore.get('BK-EXP00001')!.status).toBe('deposit_paid');
  });

  it('leaves a booking alone when it has moved on to a newer hold', async () => {
    docStore.set('BK-EXP00001', { ...docStore.get('BK-EXP00001')!, holdId: 'hold_newer' });
    const event = makeExpiredEvent('evt_exp_3', { holdId: 'hold_exp', bookingId: 'BK-EXP00001' });
    constructEventMock.mockReturnValueOnce(event);

    await POST(makeRequest(event));
    expect(docStore.get('hold_exp')!.status).toBe('released');
    expect(docStore.get('BK-EXP00001')!.status).toBe('held');
    expect(docStore.get('BK-EXP00001')!.holdId).toBe('hold_newer');
  });

  it('is a no-op for a request-mode session (no holdId in metadata)', async () => {
    const event = makeExpiredEvent('evt_exp_4', { bookingId: 'BK-EXP00001' });
    constructEventMock.mockReturnValueOnce(event);

    const res = await POST(makeRequest(event));
    expect(res.status).toBe(200);
    expect(docStore.get('hold_exp')!.status).toBe('active');
    expect(docStore.get('BK-EXP00001')!.status).toBe('held');
  });
});
