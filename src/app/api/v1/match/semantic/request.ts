/**
 * Request boundary for POST /api/v1/match/semantic (#363).
 *
 * Style preferences used to be forwarded raw. The graph query expands them
 * through `styleMatchVariants` two layers down, which drops unknown words
 * only after they have already been accepted — and a list that resolves to
 * nothing must not become "no filter". Canonical resolution happens here,
 * with the shape checks the route never had.
 */
import { resolveCanonicalStyle } from '@/lib/style-vocabulary';

const QUERY_MAX = 2000;
const LOCATION_MAX = 120;
const STYLE_MAX = 20;
const STYLE_LABEL_MAX = 80;
const BUDGET_MAX = 1_000_000;
const RADIUS_MIN = 1;
const RADIUS_MAX = 500;
const RADIUS_DEFAULT = 25;
const RESULTS_MIN = 1;
const RESULTS_MAX = 50;
const RESULTS_DEFAULT = 10;

export interface SemanticMatchInput {
  query: string;
  location: string | null;
  styles: string[];
  budget: number | null;
  distance: number;
  hasPortfolio: boolean;
  maxResults: number;
}

export type SemanticMatchParseResult =
  | { ok: true; value: SemanticMatchInput }
  | { ok: false; error: string; code: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function rejection(error: string, code: string): SemanticMatchParseResult {
  return { ok: false, error, code };
}

export function parseSemanticMatchRequest(body: unknown): SemanticMatchParseResult {
  if (!isRecord(body)) {
    return rejection('Request body must be a JSON object', 'INVALID_BODY');
  }

  if (typeof body.query !== 'string') {
    return rejection('query is required', 'INVALID_QUERY');
  }
  const query = body.query.trim();
  if (query.length < 1 || query.length > QUERY_MAX) {
    return rejection(`query must be 1–${QUERY_MAX} characters`, 'INVALID_QUERY');
  }

  let location: string | null = null;
  if (body.location !== undefined && body.location !== null) {
    if (typeof body.location !== 'string') {
      return rejection('location must be a string', 'INVALID_LOCATION');
    }
    const trimmed = body.location.trim();
    if (trimmed.length > LOCATION_MAX) {
      return rejection(`location must be at most ${LOCATION_MAX} characters`, 'INVALID_LOCATION');
    }
    location = trimmed.length > 0 ? trimmed : null;
  }

  const styles: string[] = [];
  if (body.style_preferences !== undefined && body.style_preferences !== null) {
    if (!Array.isArray(body.style_preferences)) {
      return rejection('style_preferences must be an array of strings', 'INVALID_STYLES');
    }
    if (body.style_preferences.length > STYLE_MAX) {
      return rejection(`style_preferences accepts at most ${STYLE_MAX} styles`, 'INVALID_STYLES');
    }
    const seen = new Set<string>();
    for (const raw of body.style_preferences) {
      if (typeof raw !== 'string' || raw.trim().length === 0 || raw.trim().length > STYLE_LABEL_MAX) {
        return rejection('style_preferences must be an array of strings', 'INVALID_STYLES');
      }
      const canonical = resolveCanonicalStyle(raw);
      if (canonical && !seen.has(canonical)) {
        seen.add(canonical);
        styles.push(canonical);
      }
    }
    if (body.style_preferences.length > 0 && styles.length === 0) {
      return rejection(
        'None of the requested styles are in the artist vocabulary',
        'UNKNOWN_STYLES'
      );
    }
  }

  let budget: number | null = null;
  if (body.budget !== undefined && body.budget !== null) {
    if (typeof body.budget !== 'number' || !Number.isFinite(body.budget) || body.budget <= 0 || body.budget > BUDGET_MAX) {
      return rejection('budget must be a positive number', 'INVALID_BUDGET');
    }
    budget = body.budget;
  }

  let distance = RADIUS_DEFAULT;
  if (body.radius !== undefined && body.radius !== null) {
    if (
      typeof body.radius !== 'number' ||
      !Number.isFinite(body.radius) ||
      body.radius < RADIUS_MIN ||
      body.radius > RADIUS_MAX
    ) {
      return rejection(`radius must be between ${RADIUS_MIN} and ${RADIUS_MAX}`, 'INVALID_RADIUS');
    }
    distance = body.radius;
  }

  let maxResults = RESULTS_DEFAULT;
  if (body.max_results !== undefined && body.max_results !== null) {
    if (
      typeof body.max_results !== 'number' ||
      !Number.isInteger(body.max_results) ||
      body.max_results < RESULTS_MIN ||
      body.max_results > RESULTS_MAX
    ) {
      return rejection(
        `max_results must be an integer from ${RESULTS_MIN} to ${RESULTS_MAX}`,
        'INVALID_MAX_RESULTS'
      );
    }
    maxResults = body.max_results;
  }

  if (body.has_portfolio !== undefined && body.has_portfolio !== null && typeof body.has_portfolio !== 'boolean') {
    return rejection('has_portfolio must be a boolean', 'INVALID_HAS_PORTFOLIO');
  }

  return {
    ok: true,
    value: {
      query,
      location,
      styles,
      budget,
      distance,
      hasPortfolio: body.has_portfolio === true,
      maxResults,
    },
  };
}
