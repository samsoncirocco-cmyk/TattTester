import { beforeEach, describe, expect, it, vi } from 'vitest';

const { ensureAdminAppMock, runTransactionMock, txGetMock, txSetMock, docGetMock } = vi.hoisted(() => ({
  docGetMock: vi.fn(),
  ensureAdminAppMock: vi.fn(),
  runTransactionMock: vi.fn(),
  txGetMock: vi.fn(),
  txSetMock: vi.fn(),
}));

vi.mock('./firebase-admin', () => ({ ensureAdminApp: ensureAdminAppMock }));
vi.mock('firebase-admin/firestore', () => ({
  getFirestore: () => ({
    collection: (name: string) => ({
      doc: (id: string) => ({ path: `${name}/${id}`, get: () => docGetMock(`${name}/${id}`) }),
    }),
    runTransaction: runTransactionMock,
  }),
  FieldValue: {
    arrayUnion: (value: string) => ({ __arrayUnion: value }),
    serverTimestamp: () => ({ __serverTimestamp: true }),
  },
}));

import {
  CREDIT_PACK_GENERATIONS,
  GenerationCreditsExhaustedError,
  LIFETIME_FREE_GENERATIONS,
  getGenerationCreditBalance,
  grantPurchasedGenerationCredits,
  releaseGenerationCredit,
  reserveGenerationCredit,
} from './generation-credits';

function snapshot(data: Record<string, unknown> | null) {
  return { exists: data !== null, data: () => data ?? undefined };
}

function givenTransaction(data: Record<string, unknown> | null) {
  txGetMock.mockResolvedValue(snapshot(data));
  runTransactionMock.mockImplementation(
    async (callback: (tx: { get: typeof txGetMock; set: typeof txSetMock }) => Promise<unknown>) =>
      callback({ get: txGetMock, set: txSetMock })
  );
}

describe('generation credits', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ensureAdminAppMock.mockReturnValue('sa-json');
  });

  it('starts every account with 25 lifetime free cuts and takes free cuts first', async () => {
    givenTransaction(null);

    const reservation = await reserveGenerationCredit('uid_1');

    expect(reservation).toEqual({
      id: expect.any(String),
      source: 'free',
      freeRemaining: 24,
      paidRemaining: 0,
    });
    expect(txSetMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ freeRemaining: LIFETIME_FREE_GENERATIONS - 1, paidRemaining: 0 }),
      { merge: true }
    );
  });

  it('uses purchased cuts only after the free allowance is gone', async () => {
    givenTransaction({ freeRemaining: 0, paidRemaining: 3 });

    await expect(reserveGenerationCredit('uid_1')).resolves.toEqual({
      id: expect.any(String),
      source: 'paid',
      freeRemaining: 0,
      paidRemaining: 2,
    });
  });

  it('denies atomically when no free or paid cuts remain', async () => {
    givenTransaction({ freeRemaining: 0, paidRemaining: 0 });

    await expect(reserveGenerationCredit('uid_1')).rejects.toBeInstanceOf(
      GenerationCreditsExhaustedError
    );
    expect(txSetMock).not.toHaveBeenCalled();
  });

  it('adds one credit pack once for a completed Checkout Session', async () => {
    givenTransaction({ freeRemaining: 0, paidRemaining: 4, processedCheckoutSessionIds: [] });

    const result = await grantPurchasedGenerationCredits('uid_1', 'cs_123');

    expect(result).toEqual({ granted: true, paidRemaining: 4 + CREDIT_PACK_GENERATIONS });
    expect(txSetMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ paidRemaining: 4 + CREDIT_PACK_GENERATIONS }),
      { merge: true }
    );
  });

  it('does not add another pack when Stripe retries the same Checkout Session', async () => {
    givenTransaction({ freeRemaining: 0, paidRemaining: 29, processedCheckoutSessionIds: ['cs_123'] });

    await expect(grantPurchasedGenerationCredits('uid_1', 'cs_123')).resolves.toEqual({
      granted: false,
      paidRemaining: 29,
    });
    expect(txSetMock).not.toHaveBeenCalled();
  });

  it('fails closed if Firebase Admin is unavailable', async () => {
    ensureAdminAppMock.mockReturnValue(false);

    await expect(reserveGenerationCredit('uid_1')).rejects.toThrow(
      'Firebase Admin not configured for generation credits'
    );
    expect(runTransactionMock).not.toHaveBeenCalled();
  });

  it('releases against the reservation balances when the ledger doc is missing', async () => {
    givenTransaction(null);

    await releaseGenerationCredit('uid_1', {
      id: 'res_1',
      source: 'paid',
      freeRemaining: 0,
      paidRemaining: 2,
    });

    expect(txSetMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        freeRemaining: 0,
        paidRemaining: 3,
        releasedReservationIds: { __arrayUnion: 'res_1' },
      }),
      { merge: true }
    );
  });

  it('does not restore a credit twice for the same reservation', async () => {
    givenTransaction({
      freeRemaining: 25,
      paidRemaining: 0,
      releasedReservationIds: ['res_1'],
    });

    await releaseGenerationCredit('uid_1', {
      id: 'res_1',
      source: 'free',
      freeRemaining: 24,
      paidRemaining: 0,
    });

    expect(txSetMock).not.toHaveBeenCalled();
  });

  describe('getGenerationCreditBalance', () => {
    it('reads an untouched account as the full lifetime free allowance', async () => {
      docGetMock.mockResolvedValue(snapshot(null));
      await expect(getGenerationCreditBalance('uid_new')).resolves.toEqual({
        freeRemaining: LIFETIME_FREE_GENERATIONS,
        paidRemaining: 0,
      });
      expect(docGetMock).toHaveBeenCalledWith('generation_credits/uid_new');
    });

    it.each([
      ['free only', { freeRemaining: 12, paidRemaining: 0 }, { freeRemaining: 12, paidRemaining: 0 }],
      ['paid only', { freeRemaining: 0, paidRemaining: 7 }, { freeRemaining: 0, paidRemaining: 7 }],
      ['mixed', { freeRemaining: 3, paidRemaining: 25 }, { freeRemaining: 3, paidRemaining: 25 }],
      ['corrupt values', { freeRemaining: -4, paidRemaining: 'x' }, { freeRemaining: 25, paidRemaining: 0 }],
    ])('returns %s balances', async (_label, doc, expected) => {
      docGetMock.mockResolvedValue(snapshot(doc));
      await expect(getGenerationCreditBalance('uid_1')).resolves.toEqual(expected);
    });

    it('never opens a transaction or writes', async () => {
      docGetMock.mockResolvedValue(snapshot({ freeRemaining: 1, paidRemaining: 0 }));
      await getGenerationCreditBalance('uid_1');
      expect(runTransactionMock).not.toHaveBeenCalled();
      expect(txSetMock).not.toHaveBeenCalled();
    });
  });
});
