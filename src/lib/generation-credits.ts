/**
 * Server-side generation credits.
 *
 * Browser state is never an authority for paid usage. Each Firebase account
 * owns one Firestore document, and every debit or Stripe grant is a
 * transaction so concurrent requests cannot spend the same cut twice.
 */
import { randomUUID } from 'crypto';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { ensureAdminApp } from './firebase-admin';
import {
  CREDITS_EXHAUSTED_MESSAGE,
  CREDIT_PACK_GENERATIONS,
  LIFETIME_FREE_GENERATIONS,
} from './generation-credits-shared';

export { CREDIT_PACK_GENERATIONS, LIFETIME_FREE_GENERATIONS };

const COLLECTION = 'generation_credits';

export type CreditSource = 'free' | 'paid';

export type GenerationCreditReservation = {
  id: string;
  source: CreditSource;
  freeRemaining: number;
  paidRemaining: number;
};

export class GenerationCreditsExhaustedError extends Error {
  readonly code = 'GENERATION_CREDITS_EXHAUSTED';

  constructor() {
    super(CREDITS_EXHAUSTED_MESSAGE);
    this.name = 'GenerationCreditsExhaustedError';
  }
}

function requireFirestore() {
  if (!ensureAdminApp()) {
    throw new Error('Firebase Admin not configured for generation credits');
  }
  return getFirestore();
}

function nonNegativeNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : fallback;
}

export type GenerationCreditBalance = {
  freeRemaining: number;
  paidRemaining: number;
};

/**
 * Plain read of what the account has left, for display only. No transaction:
 * a stale number is corrected by the next charged response, and nothing is
 * ever debited or granted on the strength of this read. A missing document
 * means the account has never been charged, which is the same default
 * reserveGenerationCredit applies on its first debit.
 */
export async function getGenerationCreditBalance(uid: string): Promise<GenerationCreditBalance> {
  const db = requireFirestore();
  const snap = await db.collection(COLLECTION).doc(uid).get();
  const data = (snap.data() as Record<string, unknown> | undefined) ?? {};
  return {
    freeRemaining: nonNegativeNumber(data.freeRemaining, LIFETIME_FREE_GENERATIONS),
    paidRemaining: nonNegativeNumber(data.paidRemaining, 0),
  };
}

/** Atomically take one generation from free cuts first, then paid credits. */
export async function reserveGenerationCredit(uid: string): Promise<GenerationCreditReservation> {
  const db = requireFirestore();
  const ref = db.collection(COLLECTION).doc(uid);

  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const data = (snap.data() as Record<string, unknown> | undefined) ?? {};
    const freeRemaining = nonNegativeNumber(data.freeRemaining, LIFETIME_FREE_GENERATIONS);
    const paidRemaining = nonNegativeNumber(data.paidRemaining, 0);
    const id = randomUUID();

    if (freeRemaining > 0) {
      const next = {
        id,
        source: 'free' as const,
        freeRemaining: freeRemaining - 1,
        paidRemaining,
      };
      tx.set(
        ref,
        {
          freeRemaining: next.freeRemaining,
          paidRemaining,
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true }
      );
      return next;
    }

    if (paidRemaining > 0) {
      const next = {
        id,
        source: 'paid' as const,
        freeRemaining,
        paidRemaining: paidRemaining - 1,
      };
      tx.set(
        ref,
        {
          freeRemaining,
          paidRemaining: next.paidRemaining,
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true }
      );
      return next;
    }

    throw new GenerationCreditsExhaustedError();
  });
}

/** Return a reservation only when no generation was successfully purchased. */
export async function releaseGenerationCredit(
  uid: string,
  reservation: GenerationCreditReservation
): Promise<void> {
  const db = requireFirestore();
  const ref = db.collection(COLLECTION).doc(uid);

  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const data = (snap.data() as Record<string, unknown> | undefined) ?? {};
    const released = Array.isArray(data.releasedReservationIds)
      ? data.releasedReservationIds.filter((value): value is string => typeof value === 'string')
      : [];
    // At-most-once: retries / duplicate failure handlers must not mint credits.
    if (!reservation.id || released.includes(reservation.id)) {
      return;
    }
    // Fall back to the reservation's post-debit balances — never invent a full
    // free allowance here, or a missing/invalid doc would mint credits on release.
    const freeRemaining = nonNegativeNumber(data.freeRemaining, reservation.freeRemaining);
    const paidRemaining = nonNegativeNumber(data.paidRemaining, reservation.paidRemaining);
    tx.set(
      ref,
      {
        freeRemaining: reservation.source === 'free' ? freeRemaining + 1 : freeRemaining,
        paidRemaining: reservation.source === 'paid' ? paidRemaining + 1 : paidRemaining,
        releasedReservationIds: FieldValue.arrayUnion(reservation.id),
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
  });
}

/**
 * Grant a completed Checkout Session once. Session IDs, not browser redirects,
 * make the Stripe webhook replay-safe.
 */
export async function grantPurchasedGenerationCredits(
  uid: string,
  checkoutSessionId: string
): Promise<{ granted: boolean; paidRemaining: number }> {
  const db = requireFirestore();
  const ref = db.collection(COLLECTION).doc(uid);

  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const data = (snap.data() as Record<string, unknown> | undefined) ?? {};
    const processed = Array.isArray(data.processedCheckoutSessionIds)
      ? data.processedCheckoutSessionIds.filter((value): value is string => typeof value === 'string')
      : [];
    const freeRemaining = nonNegativeNumber(data.freeRemaining, LIFETIME_FREE_GENERATIONS);
    const paidRemaining = nonNegativeNumber(data.paidRemaining, 0);

    if (processed.includes(checkoutSessionId)) {
      return { granted: false, paidRemaining };
    }

    const nextPaidRemaining = paidRemaining + CREDIT_PACK_GENERATIONS;
    tx.set(
      ref,
      {
        freeRemaining,
        paidRemaining: nextPaidRemaining,
        processedCheckoutSessionIds: FieldValue.arrayUnion(checkoutSessionId),
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
    return { granted: true, paidRemaining: nextPaidRemaining };
  });
}
