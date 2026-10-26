// The customer's remaining generation credits, as the browser last heard
// them (spec 8). Display only: the server ledger is the authority, and a
// stale number here is corrected by the next charged response.

import { create } from 'zustand';
import { getOptionalApiAuthHeaders } from '@/lib/client-api-auth';

export interface CreditBalanceState {
  free: number;
  paid: number;
  /** False until a read or a charged response has told us the real numbers. */
  known: boolean;
}

/** The `credits` object every charged route returns (post-debit). */
export interface CreditReservationPayload {
  source?: 'free' | 'paid';
  freeRemaining?: number;
  paidRemaining?: number;
}

const UNKNOWN: CreditBalanceState = { free: 0, paid: 0, known: false };

export const useCreditBalanceStore = create<CreditBalanceState>()(() => ({ ...UNKNOWN }));

function count(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;
}

/**
 * Fold a charged response into the store with no extra request. `credits` is
 * the post-debit balance; when the route also says the credit was released
 * (a failed or downgraded render), the debited source gets its one back.
 */
export function applyCreditsFromResponse(
  credits: CreditReservationPayload | null | undefined,
  creditReleased = false
): void {
  if (!credits) return;
  const free = count(credits.freeRemaining);
  const paid = count(credits.paidRemaining);
  if (free === null || paid === null) return;
  const refund = creditReleased ? 1 : 0;
  useCreditBalanceStore.setState({
    free: credits.source === 'free' ? free + refund : free,
    paid: credits.source === 'paid' ? paid + refund : paid,
    known: true,
  });
}

/** The meter is empty: record it so the UI swaps Refine for the buy link. */
export function markCreditsExhausted(): void {
  useCreditBalanceStore.setState({ free: 0, paid: 0, known: true });
}

export function resetCreditBalance(): void {
  useCreditBalanceStore.setState({ ...UNKNOWN });
}

/**
 * GET /api/v1/billing/credits for a signed-in customer. Signed out, or any
 * failure, leaves the balance unknown: showing nothing beats a wrong number.
 */
export async function refreshCreditBalance(): Promise<void> {
  try {
    const headers = await getOptionalApiAuthHeaders();
    if (!headers.Authorization) return;
    const res = await fetch('/api/v1/billing/credits', { method: 'GET', headers });
    if (!res.ok) return;
    const data = (await res.json()) as { freeRemaining?: unknown; paidRemaining?: unknown };
    const free = count(data.freeRemaining);
    const paid = count(data.paidRemaining);
    if (free === null || paid === null) return;
    useCreditBalanceStore.setState({ free, paid, known: true });
  } catch {
    // Display-only read; the next charged response fills it in.
  }
}

/** Total, split and known flag for components. */
export function useCreditBalance(): CreditBalanceState & { total: number } {
  const free = useCreditBalanceStore((s) => s.free);
  const paid = useCreditBalanceStore((s) => s.paid);
  const known = useCreditBalanceStore((s) => s.known);
  return { free, paid, known, total: free + paid };
}

/** "12 free, 6 bought" — the split behind the total, on hover or tap. */
export function creditSplitLabel(free: number, paid: number): string {
  return `${free} free, ${paid} bought`;
}
