import { NextRequest, NextResponse } from 'next/server';
import { verifyApiAuthWithUser } from '@/lib/api-auth';
import { claimSessionOwnership, recordPick } from '@/services/designSession';
import { rateLimit, rateLimitResponse } from '@/lib/rate-limit';
import { createRequestLogger } from '@/lib/logger';
import { designSessionErrorResponse, invalidRequestResponse } from '../../shared';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/v1/design-session/[id]/pick — record the pick + most-not-you tap
 * and surface the single refinement question (ADR-0013). No image generation
 * happens here, so no budget policy — just auth, rate, validation, mapping.
 */
export async function POST(
    req: NextRequest,
    { params }: { params: Promise<{ id: string }> }
) {
    const reqLogger = createRequestLogger('design-session-pick');
    // Seeded before the try so a setup failure — including one thrown by
    // `await params` itself — still logs a session_id.
    let sessionId = 'unknown';

    try {
        const auth = await verifyApiAuthWithUser(req);
        if (auth.error) return auth.error;

        const rateResult = await rateLimit(req, 'default');
        if (!rateResult.allowed) {
            return rateLimitResponse(rateResult);
        }

        ({ id: sessionId } = await params);

        // Ownership guard (#338 item 1): an owned session refuses any other
        // uid with 404. Uncharged, so no stamp — the session stays unbound
        // until its first charged action.
        await claimSessionOwnership(sessionId, auth.user.uid, { stamp: false });

        const body = await req.json().catch(() => ({}));
        const { pickId, mostNotYouId } = body;

        if (!pickId || typeof pickId !== 'string' || !pickId.trim()) {
            return invalidRequestResponse('pickId is required', 'INVALID_PICK_ID');
        }
        if (!mostNotYouId || typeof mostNotYouId !== 'string' || !mostNotYouId.trim()) {
            return invalidRequestResponse('mostNotYouId is required', 'INVALID_MOST_NOT_YOU_ID');
        }
        if (pickId.trim() === mostNotYouId.trim()) {
            return invalidRequestResponse(
                'pickId and mostNotYouId must be different variations',
                'PICK_IDS_IDENTICAL'
            );
        }

        const session = await recordPick(sessionId, {
            pickId: pickId.trim(),
            mostNotYouId: mostNotYouId.trim(),
        });

        reqLogger.complete('design_session.pick.success', {
            session_id: session.id,
            pick_id: session.pickId,
        });

        return NextResponse.json({
            success: true,
            refinementQuestion: session.refinementQuestion ?? null,
            session,
        });
    } catch (error) {
        reqLogger.error('design_session.pick.failed', error as Error, {
            session_id: sessionId,
            error_code: (error as { code?: string }).code || 'DESIGN_SESSION_FAILED',
        });
        return designSessionErrorResponse(error);
    }
}
