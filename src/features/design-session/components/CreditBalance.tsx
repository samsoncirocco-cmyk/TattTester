'use client';

import Link from 'next/link';
import {
  BUY_CREDITS_HREF,
  BUY_CREDITS_LINK_LABEL,
} from '@/lib/generation-credits-shared';
import { creditSplitLabel, useCreditBalance } from '../services/creditBalance';

/**
 * The way forward once the meter is empty (spec 8): a plain link to
 * /pricing, where the price is stated. No amount in chat.
 */
export function BuyCreditsLink({ className }: { className?: string }) {
  return (
    <Link
      href={BUY_CREDITS_HREF}
      data-testid="buy-credits-link"
      className={
        className ??
        'press inline-flex items-center font-body text-[10px] uppercase tracking-[0.2em] text-black bg-pink hover:bg-white px-3 py-2'
      }
    >
      {BUY_CREDITS_LINK_LABEL}
    </Link>
  );
}

/** "18 cuts left." — one quiet line, shown only when the number is known. */
export function CreditCountLine() {
  const { free, paid, total, known } = useCreditBalance();
  if (!known) return null;
  return (
    <p
      data-testid="credit-count-line"
      title={creditSplitLabel(free, paid)}
      className="font-body text-[11px] uppercase tracking-[0.18em] text-white/50 tabular-nums"
    >
      {total === 1 ? '1 cut left.' : `${total} cuts left.`}
    </p>
  );
}
