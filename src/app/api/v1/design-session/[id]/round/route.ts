import { NextRequest, NextResponse } from 'next/server';
import { verifyApiAuth } from '@/lib/api-auth';
import { claimSessionOwnership, refineRound, DesignSessionError } from '@/services/designSession';
import { rateLimit, rateLimitResponse } from '@/lib/rate-limit';
import { checkBudget } from '@/lib/budget-tracker';
import { createRequestLogger } from '@/lib/logger';
import { designSessionErrorResponse } from '../../shared';
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
// throttle (burst of 1 per ~10s window). Fluid compute is enabled on this
// project, so 300s is legal on every plan tier — kept at the confirm
// route's ceiling for headroom rather than resized down (ADR-0049).
export const maxDuration = 300;

/**
 * The round failure line (ADR-0049 acceptance copy). The credit release
 * below is what makes the second sentence true — this copy is only sent
 * when the release actually succeeded; otherwise the neutral line goes out
 * and the ledger question stays honest.
 */
const ROUND_FAILED_COPY = "That round didn't take — your credit is back. Run it again?";
const ROUND_FAILED_NEUTRAL_COPY = "That round didn't take. Run it again?";

/**
 * POST /api/v1/design-session/[id]/round — one charged refine round
 * (ADR-0049): reserve ONE generation credit, then render two new cuts
 * spread on the next ladder axis, seeded by the previous round's picked
 * image (plus the customer's own reference photos). The pick itself was
 * free; this is the moment it freezes.
 *
 * No partial-charge path: if both cuts can't be delivered the service
 * throws with nothing persisted, the credit is released here, and the
 * response says so in the decided copy. A downgrade off the pinned lane
 * (ADR-0048) still delivers, but loudly — the credit goes back and the
 * response carries the flag.
 *
 * Demo mode (NEXT_PUBLIC_DEMO_MODE): the real service still runs — and
 * persists the new round — but the renders are free stock images, so
 * rate/budget/credit policy is skipped, matching the confirm route.
 */
export async function POST(
    req: NextRequest,
    { params }: { params: Promise<{ id: string }> }
) {
    const reqLogger = createRequestLogger('design-session-round');
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

        // One credit per round (ADR-0041 primitive, ADR-0049 metering).
        // Reserved BEFORE the renders; released on any failure below.
        if (!demoMode) {
            creditReservation = await reserveGenerationCredit(user.uid);
        }

        // The reservation id rides inside the service's round claim, so a
        // charge orphaned by a crash mid-render stays reconcilable from the
        // session record.
        const { session, round, downgraded } = await refineRound(
            sessionId,
            creditReservation ? { reservationId: creditReservation.id } : undefined
        );
        generationSucceeded = true;

        // Loud downgrade (ADR-0048): the round rendered, but on a fallback
        // lane instead of the pinned model. The round is not charged — the
        // credit goes back (at-most-once inside the primitive) and the
        // response says so. A release failure must not fail a round the
        // customer already has: log it and let the ledger err against us.
        let creditReleased = false;
        if (downgraded && creditReservation) {
            creditReleased = await releaseGenerationCredit(user.uid, creditReservation)
                .then(() => true)
                .catch((releaseError) => {
                    console.error('[Design session] failed to return credit for downgraded round:', releaseError);
                    return false;
                });
        }

        reqLogger.complete('design_session.round.success', {
            session_id: session.id,
            round: round.round,
            axis: round.axis,
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
                    console.error('[Design session] failed to return unused round credit:', releaseError);
                    return false;
                });
        }
        if (error instanceof GenerationCreditsExhaustedError || (error as { code?: string }).code === 'GENERATION_CREDITS_EXHAUSTED') {
            return NextResponse.json(
                { error: 'You have used your free generations. Buy 25 more cuts to keep designing.', code: 'GENERATION_CREDITS_EXHAUSTED' },
                { status: 402 }
            );
        }
        reqLogger.error('design_session.round.failed', error as Error, {
            session_id: sessionId,
            error_code: (error as { code?: string }).code || 'DESIGN_SESSION_FAILED',
            credit_released: creditReleased,
        });
        // Domain refusals (frozen pick, no pick yet, a round already in
        // flight, wrong phase) keep their own messages; a render that died
        // mid-round gets the decided copy — but only when the release above
        // actually succeeded, otherwise the neutral line.
        if (error instanceof DesignSessionError) {
            return designSessionErrorResponse(error);
        }
        return NextResponse.json(
            {
                error: creditReleased ? ROUND_FAILED_COPY : ROUND_FAILED_NEUTRAL_COPY,
                code: 'ROUND_FAILED',
                creditReleased,
            },
            { status: 502 }
        );
    }
}
