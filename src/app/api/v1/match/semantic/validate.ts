/**
 * Preference bounds (spec 15). Reject, never clamp — ADR-0054's rule for
 * out-of-range values. `budget` is an artist's hourly rate in whole dollars
 * (the unit the graph stores), not booking money. `radius` is accepted for
 * contract stability but the engine does not yet measure distance.
 */
const BUDGET_RANGE = { min: 1, max: 2000 };
const RADIUS_RANGE = { min: 1, max: 500 };
const DEFAULT_RADIUS = 25;

type Validated =
    | { ok: true; budget: number | null; radius: number; hasPortfolio: boolean }
    | { ok: false; error: string };

export function validatePreferences(body: {
    budget?: unknown;
    radius?: unknown;
    has_portfolio?: unknown;
}): Validated {
    let budget: number | null = null;
    if (body.budget !== undefined && body.budget !== null) {
        if (
            typeof body.budget !== 'number' ||
            !Number.isFinite(body.budget) ||
            body.budget < BUDGET_RANGE.min ||
            body.budget > BUDGET_RANGE.max
        ) {
            return { ok: false, error: `budget must be a number between ${BUDGET_RANGE.min} and ${BUDGET_RANGE.max} (dollars per hour).` };
        }
        budget = body.budget;
    }

    let radius = DEFAULT_RADIUS;
    if (body.radius !== undefined && body.radius !== null) {
        if (
            typeof body.radius !== 'number' ||
            !Number.isFinite(body.radius) ||
            body.radius < RADIUS_RANGE.min ||
            body.radius > RADIUS_RANGE.max
        ) {
            return { ok: false, error: `radius must be a number between ${RADIUS_RANGE.min} and ${RADIUS_RANGE.max}.` };
        }
        radius = body.radius;
    }

    let hasPortfolio = false;
    if (body.has_portfolio !== undefined && body.has_portfolio !== null) {
        if (typeof body.has_portfolio !== 'boolean') {
            return { ok: false, error: 'has_portfolio must be a boolean.' };
        }
        hasPortfolio = body.has_portfolio;
    }

    return { ok: true, budget, radius, hasPortfolio };
}
