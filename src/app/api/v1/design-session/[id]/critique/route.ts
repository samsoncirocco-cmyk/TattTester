import { NextRequest, NextResponse } from 'next/server';
import { verifyApiAuthWithUser } from '@/lib/api-auth';
import { claimSessionOwnership, critique, type RoundCreditPort } from '@/services/designSession';
import { rateLimit, rateLimitResponse } from '@/lib/rate-limit';
import { checkBudget } from '@/lib/budget-tracker';
import { createRequestLogger } from '@/lib/logger';
import {
    designSessionErrorResponse,
    invalidRequestResponse,
} from '../../shared';
import {
    releaseGenerationCredit,
    reserveGenerationCredit,
    type GenerationCreditReservation,
} from '@/lib/generation-credits';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// One render, but on the same throttle-prone providers as the reveal — a
// low-credit Replicate window can outlast a short budget. Matches /refine.
export const maxDuration = 300;

/**
 * POST /api/v1/design-session/[id]/critique — one post-reveal critique turn
 * (ADR-0039). The chat no longer dies at the reveal: plain criticism re-cuts
 * the design on the session's pinned provider (ADR-0016), bounded by the same
 * env-tunable fix allowance as the Studio (ADR-0038).
 *
 * At most 1 image per turn, so the same rate/budget policy as /refine applies
 * — but spend is recorded only when the service says a render actually ran.
 * A chatter turn, an unresolvable target, and a spent allowance all reply in
 * voice without touching a provider, and must not be billed as if they had.
 *
 * Demo mode (NEXT_PUBLIC_DEMO_MODE): the real service still runs and still
 * decrements the allowance, but the re-cut is a free stock image, so policy
 * and spend recording are skipped — matching /confirm and /refine.
 */
export async function POST(
    req: NextRequest,
    { params }: { params: Promise<{ id: string }> }
) {
    const reqLogger = createRequestLogger('design-session-critique');
    // Seeded before the try so a setup failure — including one thrown by
    // `await params` itself — still logs a session_id.
    let sessionId = 'unknown';

    try {
        // ONE decode for the whole request: the gate and the uid come from
        // the same verifyIdToken round-trip. Verifying twice was a race — a
        // transient failure on the second decode silently downgraded a
        // signed-in customer to the account-gate line instead of charging
        // them normally. The uid stands the generation meter behind a
        // reroll-set turn (ADR-0056 → ADR-0049: one credit); every free
        // critique arm serves exactly the callers it always served.
        const auth = await verifyApiAuthWithUser(req);
        if (auth.error) return auth.error;
        const user = auth.user;

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
        const body = await req.json().catch(() => ({}));
        const { message } = body;

        if (!message || typeof message !== 'string' || !message.trim()) {
            return invalidRequestResponse('message is required', 'INVALID_MESSAGE');
        }

        // Ownership gate (#338 item 1): a charged action stamps the first
        // owner and refuses any other uid — BEFORE any critique lane can
        // reserve a credit, so a refused caller is never charged.
        await claimSessionOwnership(sessionId, user.uid, { stamp: true });

        // Spend is recorded inside the service, at the moment the provider
        // answers — not here. A route can only bill on a successful return,
        // which misses a render that was paid for and then failed to store,
        // and double-bills nothing only by luck. The pre-flight checkBudget
        // above stays: that is the route's job.
        //
        // The credit PORT is this route's half of the reroll-set arm: the
        // service calls reserve() only when the turn classifies as a fresh
        // round (one credit, ADR-0049 — never the fix allowance) and
        // release() on failure or ADR-0048 downgrade. An exhausted meter is
        // settled inside the service as spoken copy, not thrown back here.
        // Always present on this route: the gate that admitted the request
        // decoded the uid, so an authorized web caller can never be
        // silently treated as meterless.
        const roundCredit: RoundCreditPort = {
            reserve: () => reserveGenerationCredit(user.uid),
            release: (reservation) =>
                releaseGenerationCredit(user.uid, reservation as GenerationCreditReservation)
                    .then(() => true)
                    .catch((releaseError) => {
                        console.error('[Design session] failed to return reroll credit:', releaseError);
                        return false;
                    }),
        };
        const result = await critique(sessionId, { message: message.trim() }, { roundCredit });

        reqLogger.complete('design_session.critique.success', {
            session_id: result.session.id,
            provider: result.session.provider,
            generated: result.generated,
            fixes_remaining: result.fixesRemaining,
        });

        return NextResponse.json({ success: true, ...result });
    } catch (error) {
        reqLogger.error('design_session.critique.failed', error as Error, {
            session_id: sessionId,
            error_code: (error as { code?: string }).code || 'DESIGN_SESSION_FAILED',
        });
        return designSessionErrorResponse(error);
    }
}
