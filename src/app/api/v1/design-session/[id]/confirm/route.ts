import { NextRequest, NextResponse } from 'next/server';
import { verifyApiAuth } from '@/lib/api-auth';
import { claimSessionOwnership, confirmProposal } from '@/services/designSession';
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
// Two renders + council must survive Replicate's low-credit throttle
// (burst of 1 per ~10s window). Sized for four renders originally; kept at
// 300s rather than shrunk (ADR-0049's guidance: more headroom, not less) —
// the Replicate lane may not batch, and reference signing rides on top.
// Fluid compute is enabled on this project, so 300s is legal on every
// plan tier.
export const maxDuration = 300;

/**
 * POST /api/v1/design-session/[id]/confirm — the user's yes to the
 * conversation's proposal (ADR-0020). Fires the existing reveal pipeline
 * (round one's 2 renders on one pinned provider, ADR-0049), so the full budget policy of the start
 * route applies and the service records what those renders cost. A 'no' or correction is just
 * another converse message, never this endpoint. The ConfirmRequest body is
 * reserved-empty in the frozen contract, so no body validation exists yet.
 *
 * Demo mode (NEXT_PUBLIC_DEMO_MODE): the real service still runs — and
 * persists the revealed session — but the renders are free stock images, so
 * rate/budget policy is skipped, matching the start route (including its
 * simulated latency).
 */
export async function POST(
    req: NextRequest,
    { params }: { params: Promise<{ id: string }> }
) {
    const reqLogger = createRequestLogger('design-session-confirm');
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

        if (demoMode) await new Promise(r => setTimeout(r, 1500));

        if (!demoMode) {
            creditReservation = await reserveGenerationCredit(user.uid);
        }

        const session = await confirmProposal(sessionId);
        generationSucceeded = true;

        // Loud downgrade (ADR-0048): the reveal rendered, but on a fallback
        // lane instead of the model the cast routing chose. The round is not
        // charged — the credit goes back (at-most-once inside the primitive),
        // and the response says so alongside the session's own `downgraded`
        // flag so the reveal copy can tell the customer. A release failure
        // must not fail a reveal the customer already has: log it, keep
        // creditReleased false, and the ledger errs against us, not them.
        let creditReleased = false;
        if (session.downgraded && creditReservation) {
            creditReleased = await releaseGenerationCredit(user.uid, creditReservation)
                .then(() => true)
                .catch((releaseError) => {
                    console.error('[Design session] failed to return credit for downgraded reveal:', releaseError);
                    return false;
                });
        }

        reqLogger.complete('design_session.confirm.success', {
            session_id: session.id,
            provider: session.provider,
            axis_mode: session.axisSelection.mode,
            downgraded: session.downgraded === true,
            credit_released: creditReleased,
        });

        return NextResponse.json({ success: true, session, credits: creditReservation, creditReleased });
    } catch (error) {
        if (uid && creditReservation && !generationSucceeded) {
            await releaseGenerationCredit(uid, creditReservation).catch((releaseError) => {
                console.error('[Design session] failed to return unused generation credit:', releaseError);
            });
        }
        if (error instanceof GenerationCreditsExhaustedError || (error as { code?: string }).code === 'GENERATION_CREDITS_EXHAUSTED') {
            return NextResponse.json(
                { error: 'You have used your free generations. Buy 25 more cuts to keep designing.', code: 'GENERATION_CREDITS_EXHAUSTED' },
                { status: 402 }
            );
        }
        reqLogger.error('design_session.confirm.failed', error as Error, {
            session_id: sessionId,
            error_code: (error as { code?: string }).code || 'DESIGN_SESSION_FAILED',
        });
        return designSessionErrorResponse(error);
    }
}
