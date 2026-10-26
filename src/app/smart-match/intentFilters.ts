/**
 * Intent and hourly-rate pills on /smart-match (spec 15), and what each one
 * does to the request. Pure and total: any unknown value maps to "nothing
 * selected", never to an error — a stale bookmark must not 400.
 *
 * Money note: `budget` is the artist's listed HOURLY RATE in whole dollars,
 * because that is the unit the artist data has (`a.hourlyRate`); the field
 * keeps the name the route and engine already use. It is a search filter,
 * not booking money (ADR-0054 covers payment paths; those stay in cents).
 */

export const INTENTS = [
  { id: "first", label: "First small tattoo", hasPortfolio: false },
  { id: "big", label: "Big piece or sleeve", hasPortfolio: true },
  { id: "coverup", label: "Cover-up", hasPortfolio: true },
  { id: "exploring", label: "Just exploring", hasPortfolio: false },
] as const;

export type IntentId = (typeof INTENTS)[number]["id"];

export const RATES = [
  { id: "150", label: "Up to $150/hr", budget: 150 },
  { id: "250", label: "Up to $250/hr", budget: 250 },
  { id: "400", label: "Up to $400/hr", budget: 400 },
  { id: "any", label: "No limit", budget: null },
] as const;

export type RateId = (typeof RATES)[number]["id"];

export function parseIntentParam(value: string | null | undefined): IntentId | null {
  const hit = INTENTS.find((i) => i.id === value);
  return hit ? hit.id : null;
}

/** "any" is the default and is never written to the URL. */
export function parseRateParam(value: string | null | undefined): RateId {
  const hit = RATES.find((r) => r.id === value);
  return hit ? hit.id : "any";
}

/** A big piece or a cover-up asks for artists with shown work. */
export function intentToFilters(intent: IntentId | null): { hasPortfolio: boolean } {
  const hit = INTENTS.find((i) => i.id === intent);
  return { hasPortfolio: hit ? hit.hasPortfolio : false };
}

/** Dollars per hour, or null for no limit. */
export function rateToBudget(rate: RateId): number | null {
  const hit = RATES.find((r) => r.id === rate);
  return hit ? hit.budget : null;
}

/** The honest one-liner under the pills; empty when nothing is applied. */
export function appliedLine(intent: IntentId | null, rate: RateId): string {
  const parts: string[] = [];
  if (intentToFilters(intent).hasPortfolio) parts.push("Showing artists with portfolios.");
  if (rateToBudget(rate) !== null) {
    parts.push("Rates are a guide — artists who haven't listed one are still shown.");
  }
  return parts.join(" ");
}

/** Names the filters in play for the empty state, e.g. "with portfolios, up to $150/hr". */
export function filtersInPlay(intent: IntentId | null, rate: RateId): string {
  const parts: string[] = [];
  if (intentToFilters(intent).hasPortfolio) parts.push("with portfolios");
  const budget = rateToBudget(rate);
  if (budget !== null) parts.push(`up to $${budget}/hr`);
  return parts.join(", ");
}
