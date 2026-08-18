import { NextRequest, NextResponse } from 'next/server';
import { verifyApiAuthWithUser } from '@/lib/api-auth';
import { claimSessionOwnership, startSession } from '@/services/designSession';
import { rateLimit, rateLimitResponse } from '@/lib/rate-limit';
import { checkBudget } from '@/lib/budget-tracker';
import { createRequestLogger } from '@/lib/logger';
import {
    GenerationCreditsExhaustedError,
    releaseGenerationCredit,
    reserveGenerationCredit,
    type GenerationCreditReservation,
} from '@/lib/generation-credits';
import {
    designSessionErrorResponse,
    invalidRequestResponse,
} from './shared';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// Two renders + council must survive Replicate's low-credit throttle
// (burst of 1 per ~10s window): 4 renders can need ~1min of retry waits
// plus generation. Fluid compute is enabled on this project, so 300s is
// legal on every plan tier.
export const maxDuration = 300;

// POST /api/v1/design-session — start a session: intake → council → the
// 4-variation reveal. Thin adapter over the designSession service; this route
// only does auth/rate/budget/credit policy, validation, and response-shape
// mapping; the service records the spend of the renders it actually buys.
//
// This route GENERATES, so it meters (ADR-0041: one gate in front of
// generation). It previously ran renders without ever touching the credit
// ledger, which made the 25-cut lifetime allowance bypassable by starting a
// new session instead of paying — a global budget ceiling bounded the spend
// but nothing billed it. One credit per start, reserved before the renders
// and released if they never land, exactly as confirm/round do.
//
// Demo mode (NEXT_PUBLIC_DEMO_MODE): the REAL service still runs — and
// persists the session, so the follow-up pick/refine/get routes work — but
// the orchestrator substitutes free stock images for the round's renders. No
// cost, so rate/budget policy is skipped; a short simulated latency keeps
// the /api/v1/generate demo feel.

export async function POST(req: NextRequest) {
    const reqLogger = createRequestLogger('design-session');
    let uid: string | null = null;
    let creditReservation: GenerationCreditReservation | null = null;
    let generationSucceeded = false;

    // Setup lives inside the try so an auth/rate/budget failure still returns
    // the structured error envelope and logs, instead of escaping as a bare 500.
    try {
        // Auth check
        const auth = await verifyApiAuthWithUser(req);
        if (auth.error) return auth.error;
        uid = auth.user.uid;

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

        const body = await req.json().catch(() => ({}));
        const { placementAnswer, meaningAnswer } = body;

        if (!placementAnswer || typeof placementAnswer !== 'string' || !placementAnswer.trim()) {
            return invalidRequestResponse('placementAnswer is required', 'INVALID_PLACEMENT_ANSWER');
        }
        if (!meaningAnswer || typeof meaningAnswer !== 'string' || !meaningAnswer.trim()) {
            return invalidRequestResponse('meaningAnswer is required', 'INVALID_MEANING_ANSWER');
        }

        if (demoMode) await new Promise(r => setTimeout(r, 1500));

        // One credit per start (ADR-0041). Reserved BEFORE the renders so a
        // customer out of cuts is refused without spending ours; released
        // below on any failure. Demo renders are free stock images, so demo
        // mode skips credit policy exactly as it skips rate/budget.
        if (!demoMode) {
            creditReservation = await reserveGenerationCredit(auth.user.uid);
        }

        const session = await startSession({
            placementAnswer: placementAnswer.trim(),
            meaningAnswer: meaningAnswer.trim(),
        });
        generationSucceeded = true;

        // The session is created unowned (#357) and this is its first charged
        // action, so it stamps. Stamping AFTER the renders is deliberate: the
        // customer already has cuts they paid for, and a store hiccup here
        // must not turn a delivered reveal into a 500. An unstamped session
        // stays `unbound`, which is the pre-#357 status quo, not a leak.
        await claimSessionOwnership(session.id, auth.user.uid, { stamp: true }).catch(
            (stampError: unknown) => {
                console.error('[Design session] failed to stamp ownership on start:', stampError);
            }
        );

        reqLogger.complete('design_session.start.success', {
            session_id: session.id,
            provider: session.provider,
            axis_mode: session.axisSelection.mode,
        });

        return NextResponse.json({ success: true, session, credits: creditReservation });
    } catch (error) {
        if (uid && creditReservation && !generationSucceeded) {
            await releaseGenerationCredit(uid, creditReservation).catch((releaseError) => {
                console.error('[Design session] failed to return unused start credit:', releaseError);
            });
        }
        if (
            error instanceof GenerationCreditsExhaustedError ||
            (error as { code?: string }).code === 'GENERATION_CREDITS_EXHAUSTED'
        ) {
            return NextResponse.json(
                {
                    error: 'You have used your free generations. Buy 25 more cuts to keep designing.',
                    code: 'GENERATION_CREDITS_EXHAUSTED',
                },
                { status: 402 }
            );
        }
        reqLogger.error('design_session.start.failed', error as Error, {
            error_code: (error as { code?: string }).code || 'DESIGN_SESSION_FAILED',
        });
        return designSessionErrorResponse(error);
    }
}
