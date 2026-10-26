/**
 * Credit constants and copy that both the server ledger and the browser read.
 *
 * Kept apart from `generation-credits.ts` because that module imports
 * firebase-admin and must never reach a client bundle. Nothing here touches
 * money: the pack price lives on /pricing and in Stripe, not in chat copy.
 */
export const LIFETIME_FREE_GENERATIONS = 25;
export const CREDIT_PACK_GENERATIONS = 25;

/** Where an exhausted customer goes to buy the next pack. */
export const BUY_CREDITS_HREF = '/pricing';

/** The link that replaces a dead end once the meter is empty. */
export const BUY_CREDITS_LINK_LABEL = `Get ${CREDIT_PACK_GENERATIONS} more cuts`;

/**
 * The 402 sentence every charged route and the SMS lane send. The web UI adds
 * the BUY_CREDITS_LINK_LABEL link under it; the sentence itself carries no
 * URL so it reads the same over SMS.
 */
export const CREDITS_EXHAUSTED_MESSAGE = `You've used your free cuts. Get ${CREDIT_PACK_GENERATIONS} more to keep designing.`;

export const CREDITS_EXHAUSTED_CODE = 'GENERATION_CREDITS_EXHAUSTED';
