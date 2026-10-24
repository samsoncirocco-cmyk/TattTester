// Shared policy helpers for the design-session route adapters.
//
// These routes are thin adapters (same shape as /api/v1/generate): auth,
// rate limiting, budget policy, input validation, and response mapping live
// here — every domain decision (phase transitions, axis selection, the
// ADR-0013 hard stop) lives inside the designSession service, consumed only
// via its public entry point '@/services/designSession'.
//
// Service surface (public entry '@/services/designSession'):
//   startSession(request: StartSessionRequest): Promise<DesignSession>
//   recordPick(sessionId: string, request: PickRequest): Promise<DesignSession>
//   refine(sessionId: string, request: RefineRequest): Promise<DesignSession>
//   getSession(sessionId: string): Promise<DesignSession>  // throws when absent
// Domain errors (DesignSessionError) carry a stable `code` and a `status`;
// the mapper below translates them to HTTP.

import { NextResponse } from 'next/server';

// Spend recording moved into the designSession service
// (src/services/designSession/internal/spend.ts): only the orchestrator knows
// how many renders a step actually bought, since a retry can reuse an
// already-staged image and a failed step can still have paid. Routes keep the
// pre-flight checkBudget policy below.

// Domain error codes → HTTP status. The service owns the vocabulary; the
// route only translates. Unknown codes fall through to 500.
const NOT_FOUND_CODES = new Set(['SESSION_NOT_FOUND']);
// One-way phase machine violations (ADR-0013 hard stop included) are
// conflicts with current resource state → 409.
const CONFLICT_CODES = new Set([
    'INVALID_PHASE',
    'REFINEMENT_CLOSED',
    // The round machinery (ADR-0049): a frozen pick, a pickless refine, and
    // a round already rendering are all conflicts with current resource state.
    'ROUND_PICK_FROZEN',
    'ROUND_UNPICKED',
    'ROUND_IN_FLIGHT',
    // The first reveal shares the round slot: a confirm that arrives while
    // the reveal is already rendering is the same conflict.
    'REVEAL_IN_FLIGHT',
]);
// Request referenced something that can't apply (e.g. a pickId that isn't
// one of the session's variations) → 400.
const BAD_REQUEST_CODES = new Set(['INVALID_VARIATION']);

/*
 * Upstream statuses that mean "try again shortly" rather than "this request
 * is wrong". Replicate's low-credit throttle (429) is the observed one: the
 * generation provider already retries it 5 times internally honoring
 * `retry_after`, so an error reaching here means the throttle window
 * outlasted the whole request. A later retry is the correct recovery — a
 * throttled render never reached the provider, so it recorded no spend, and
 * any render the throttled attempt DID buy is reused from its durable object
 * rather than bought again.
 */
const RETRYABLE_UPSTREAM_STATUS = new Set([429, 502, 503, 504]);

/** Fallback wait when the upstream gave no usable `retry_after`. */
const DEFAULT_RETRY_AFTER_MS = 10_000;

/**
 * The structured error envelope every design-session route returns. The
 * client needs more than a sentence: `code` to branch on, `retryable` to
 * know whether retrying is meaningful at all, and `retryAfterMs` to know
 * how long to wait — without these the UI can only print a generic string
 * and offer a manual button (the observed "Design session request failed"
 * that then succeeded on a manual retry).
 */
export interface DesignSessionErrorBody {
    error: string;
    code: string;
    retryable: boolean;
    retryAfterMs?: number;
    message?: string;
}

/** Pull a retry-after hint off a provider error, in milliseconds. */
function retryAfterMsFrom(err: { retryAfterMs?: number; details?: unknown }): number {
    if (typeof err.retryAfterMs === 'number' && err.retryAfterMs > 0) return err.retryAfterMs;
    const retryAfter = (err.details as { retry_after?: unknown } | undefined)?.retry_after;
    if (typeof retryAfter === 'number' && retryAfter > 0) return retryAfter * 1000;
    return DEFAULT_RETRY_AFTER_MS;
}

function errorResponse(
    body: DesignSessionErrorBody,
    status: number
): NextResponse {
    const res = NextResponse.json(body, { status });
    // Standards-correct companion to the JSON hint, for any non-JS caller.
    if (body.retryable && body.retryAfterMs) {
        res.headers.set('Retry-After', String(Math.ceil(body.retryAfterMs / 1000)));
    }
    return res;
}

/** Map a designSession service error to the route's HTTP response. */
export function designSessionErrorResponse(error: unknown): NextResponse {
    const err = (error ?? {}) as {
        code?: string;
        message?: string;
        status?: number;
        retryAfterMs?: number;
        details?: unknown;
    };
    const code = err.code || 'DESIGN_SESSION_FAILED';

    if (NOT_FOUND_CODES.has(code) || err.status === 404) {
        return errorResponse(
            { error: 'Session not found', code: 'SESSION_NOT_FOUND', retryable: false },
            404
        );
    }

    if (CONFLICT_CODES.has(code) || err.status === 409) {
        return errorResponse(
            { error: err.message || 'Session phase conflict', code, retryable: false },
            409
        );
    }

    if (BAD_REQUEST_CODES.has(code) || err.status === 400) {
        return errorResponse(
            { error: err.message || 'Invalid request', code, retryable: false },
            400
        );
    }

    // Transient upstream trouble — the one case where retrying is the fix.
    if (err.status !== undefined && RETRYABLE_UPSTREAM_STATUS.has(err.status)) {
        return errorResponse(
            {
                error: 'The image provider is busy right now — retrying shortly usually clears it.',
                code: 'GENERATION_UNAVAILABLE',
                retryable: true,
                retryAfterMs: retryAfterMsFrom(err),
                message: err.message,
            },
            503
        );
    }

    // Unknown failure: deliberately NOT retryable. It may have consumed
    // paid renders, and a blind auto-retry would spend again.
    return errorResponse(
        { error: 'Design session request failed', code, retryable: false, message: err.message },
        500
    );
}

/** Uniform 400 for input validation failures. */
export function invalidRequestResponse(message: string, code: string): NextResponse {
    return NextResponse.json({ error: message, code }, { status: 400 });
}
