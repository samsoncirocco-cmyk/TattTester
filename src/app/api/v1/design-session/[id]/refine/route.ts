import { NextRequest, NextResponse } from 'next/server';
import { verifyApiAuthWithUser } from '@/lib/api-auth';
import { claimSessionOwnership, refine } from '@/services/designSession';
import { rateLimit, rateLimitResponse } from '@/lib/rate-limit';
import { checkBudget } from '@/lib/budget-tracker';
import { createRequestLogger } from '@/lib/logger';
import {
    designSessionErrorResponse,
    invalidRequestResponse,
} from '../../shared';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// Two renders + council must survive Replicate's low-credit throttle
// (burst of 1 per ~10s window): 4 renders can need ~1min of retry waits
// plus generation. Fluid compute is enabled on this project, so 300s is
// legal on every plan tier.
export const maxDuration = 300;

/**
 * POST /api/v1/design-session/[id]/refine — the one regeneration allowed per
 * session (ADR-0013 hard stop). A second attempt is a domain conflict the
 * service raises and this route maps to 409. Generates exactly 1 image on the
 * session's locked provider, so budget policy applies.
 *
 * Demo mode (NEXT_PUBLIC_DEMO_MODE): the real service still runs (the
 * orchestrator substitutes a free stock image for the regen, and the ADR-0013
 * hard stop stays enforced) — no cost, so rate/budget policy is skipped,
 * matching the start route.
 */
export async function POST(
    req: NextRequest,
    { params }: { params: Promise<{ id: string }> }
) {
    const reqLogger = createRequestLogger('design-session-refine');
    // Seeded before the try so a setup failure — including one thrown by
    // `await params` itself — still logs a session_id.
    let sessionId = 'unknown';

    try {
        const auth = await verifyApiAuthWithUser(req);
        if (auth.error) return auth.error;

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

        // Ownership guard (#338 item 1): an owned session refuses any other
        // uid with 404. Uncharged, so no stamp — the session stays unbound
        // until its first charged action.
        await claimSessionOwnership(sessionId, auth.user.uid, { stamp: false });
        const body = await req.json().catch(() => ({}));
        const { answer } = body;

        if (!answer || typeof answer !== 'string' || !answer.trim()) {
            return invalidRequestResponse('answer is required', 'INVALID_ANSWER');
        }

        if (demoMode) await new Promise(r => setTimeout(r, 1500));

        const session = await refine(sessionId, { answer: answer.trim() });

        reqLogger.complete('design_session.refine.success', {
            session_id: session.id,
            provider: session.provider,
        });

        return NextResponse.json({
            success: true,
            refinedVariation: session.refinedVariation ?? null,
            brief: session.brief ?? null,
            session,
        });
    } catch (error) {
        reqLogger.error('design_session.refine.failed', error as Error, {
            session_id: sessionId,
            error_code: (error as { code?: string }).code || 'DESIGN_SESSION_FAILED',
        });
        return designSessionErrorResponse(error);
    }
}
