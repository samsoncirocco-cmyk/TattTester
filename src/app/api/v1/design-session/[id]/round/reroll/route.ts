import { NextRequest, NextResponse } from 'next/server';
import { verifyApiAuth } from '@/lib/api-auth';
import { claimSessionOwnership, rerollRound, DesignSessionError } from '@/services/designSession';
import { rateLimit, rateLimitResponse } from '@/lib/rate-limit';
import { checkBudget } from '@/lib/budget-tracker';
import { createRequestLogger } from '@/lib/logger';
import { designSessionErrorResponse } from '../../../shared';
import { verifyFirebaseToken } from '@/lib/auth-dal';
import {
    GenerationCreditsExhaustedError,
    releaseGenerationCredit,
    reserveGenerationCredit,
    type GenerationCreditReservation,
} from '@/lib/generation-credits';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// Two renders + reference signing must survive Replicate's low-credit
// throttle — same ceiling as the sibling round route (ADR-0049).
export const maxDuration = 300;

/**
 * The re-roll failure line — same honesty split as the round route: the
 * first copy is only sent when the release actually succeeded.
 */
const REROLL_FAILED_COPY = "That re-roll didn't take — your credit is back. Run it again?";
const REROLL_FAILED_NEUTRAL_COPY = "That re-roll didn't take. Run it again?";

/**
 * POST /api/v1/design-session/[id]/round/reroll — one charged re-roll
 * round (sprint fix #2, session 0f6234e9): the customer rejected the whole
 * live set, so reserve ONE generation credit and draw two fresh cuts on
 * the SAME axis as the rejected round. No pick is required — rejecting the
 * set is exactly the move a customer makes when they cannot pick — and no
 * pick is recorded on the rejected round: the absence IS the signal
 * (ADR-0049). Body may carry an optional freetext `hint` ("new ones, more
 * cinematic") threaded additively into both prompts.
 *
 * Credit policy is identical to the sibling round route: one credit
 * reserved before the renders, released on any failure or ADR-0048
 * downgrade, never a partial charge. Demo mode skips rate/budget/credit
 * while the real service still runs and persists.
 */
export async function POST(
    req: NextRequest,
    { params }: { params: Promise<{ id: string }> }
) {
    const reqLogger = createRequestLogger('design-session-reroll');
    // Seeded before the try so a setup failure — including one thrown by
    // `await params` itself — still logs a session_id.
    let sessionId = 'unknown';
    let uid: string | null = null;
    let creditReservation: GenerationCreditReservation | null = null;
    let generationSucceeded = false;

    try {
        const authError = await verifyApiAuth(req);
        if (authError) return authError;

        const user = await verifyFirebaseToken(req);
        if (!user) {
            return NextResponse.json({ error: 'Authentication required', code: 'AUTH_REQUIRED' }, { status: 401 });
        }
        uid = user.uid;

        const demoMode = process.env.NEXT_PUBLIC_DEMO_MODE === 'true';

        if (!demoMode) {
            const rateResult = await rateLimit(req, 'generation');
            if (!rateResult.allowed) {
                return rateLimitResponse(rateResult);
            }

            const budgetResult = await checkBudget();
            if (!budgetResult.allowed) {
                return NextResponse.json(
                    { error: 'Budget limit reached', spentCents: budgetResult.spentCents },
                    { status: 402 }
                );
            }
        }

        ({ id: sessionId } = await params);

        // Ownership gate (#338 item 1): a charged action stamps the first
        // owner and refuses any other uid — BEFORE the credit reserve, so a
        // refused caller is never charged.
        await claimSessionOwnership(sessionId, user.uid, { stamp: true });

        // The optional style hint, tolerant of an empty body — a bare
        // re-roll ("new ones") carries none.
        const body = await req.json().catch(() => ({}));
        const hint =
            typeof (body as { hint?: unknown }).hint === 'string'
                ? (body as { hint: string }).hint
                : undefined;

        // One credit per round (ADR-0041 primitive, ADR-0049 metering) —
        // a re-roll is a round, not a critique fix. Reserved BEFORE the
        // renders; released on any failure below.
        if (!demoMode) {
            creditReservation = await reserveGenerationCredit(user.uid);
        }

        // The reservation id rides inside the service's round claim, so a
        // charge orphaned by a crash mid-render stays reconcilable from the
        // session record.
        const { session, round, downgraded } = await rerollRound(sessionId, {
            ...(creditReservation ? { reservationId: creditReservation.id } : {}),
            ...(hint ? { hint } : {}),
        });
        generationSucceeded = true;

        // Loud downgrade (ADR-0048): delivered off the pinned lane — the
        // credit goes back and the response says so. A release failure must
        // not fail a round the customer already has.
        let creditReleased = false;
        if (downgraded && creditReservation) {
            creditReleased = await releaseGenerationCredit(user.uid, creditReservation)
                .then(() => true)
                .catch((releaseError) => {
                    console.error('[Design session] failed to return credit for downgraded re-roll:', releaseError);
                    return false;
                });
        }

        reqLogger.complete('design_session.reroll.success', {
            session_id: session.id,
            round: round.round,
            axis: round.axis,
            hinted: Boolean(hint),
            downgraded,
            credit_released: creditReleased,
        });

        return NextResponse.json({ success: true, session, round, credits: creditReservation, creditReleased });
    } catch (error) {
        // Track whether the refund actually landed: the failure copy only
        // claims "your credit is back" when it is true.
        let creditReleased = false;
        if (uid && creditReservation && !generationSucceeded) {
            creditReleased = await releaseGenerationCredit(uid, creditReservation)
                .then(() => true)
                .catch((releaseError) => {
                    console.error('[Design session] failed to return unused re-roll credit:', releaseError);
                    return false;
                });
        }
        if (error instanceof GenerationCreditsExhaustedError || (error as { code?: string }).code === 'GENERATION_CREDITS_EXHAUSTED') {
            return NextResponse.json(
                { error: 'You have used your free generations. Buy 25 more cuts to keep designing.', code: 'GENERATION_CREDITS_EXHAUSTED' },
                { status: 402 }
            );
        }
        reqLogger.error('design_session.reroll.failed', error as Error, {
            session_id: sessionId,
            error_code: (error as { code?: string }).code || 'DESIGN_SESSION_FAILED',
            credit_released: creditReleased,
        });
        // Domain refusals (wrong phase, a round already in flight) keep
        // their own messages; a render that died mid-round gets the decided
        // copy — but only when the release above actually succeeded.
        if (error instanceof DesignSessionError) {
            return designSessionErrorResponse(error);
        }
        return NextResponse.json(
            {
                error: creditReleased ? REROLL_FAILED_COPY : REROLL_FAILED_NEUTRAL_COPY,
                code: 'REROLL_FAILED',
                creditReleased,
            },
            { status: 502 }
        );
    }
}
