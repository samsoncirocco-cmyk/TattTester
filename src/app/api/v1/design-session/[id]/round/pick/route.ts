import { NextRequest, NextResponse } from 'next/server';
import { verifyApiAuthWithUser } from '@/lib/api-auth';
import { claimSessionOwnership, recordRoundPick } from '@/services/designSession';
import { rateLimit, rateLimitResponse } from '@/lib/rate-limit';
import { createRequestLogger } from '@/lib/logger';
import { designSessionErrorResponse, invalidRequestResponse } from '../../../shared';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/v1/design-session/[id]/round/pick — record (or change) the live
 * round's pick (ADR-0049). The pick is FREE and stays changeable until the
 * next round is charged, so no budget policy — just auth, rate, validation,
 * mapping. No image generation happens here.
 */
export async function POST(
    req: NextRequest,
    { params }: { params: Promise<{ id: string }> }
) {
    const reqLogger = createRequestLogger('design-session-round-pick');
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
        const { pickedId } = body;

        if (!pickedId || typeof pickedId !== 'string' || !pickedId.trim()) {
            return invalidRequestResponse('pickedId is required', 'INVALID_PICKED_ID');
        }

        const session = await recordRoundPick(sessionId, { pickedId: pickedId.trim() });
        const round = session.rounds?.[session.rounds.length - 1];

        reqLogger.complete('design_session.round_pick.success', {
            session_id: session.id,
            round: round?.round,
            picked_id: round?.pickedId,
        });

        return NextResponse.json({ success: true, round: round ?? null, session });
    } catch (error) {
        reqLogger.error('design_session.round_pick.failed', error as Error, {
            session_id: sessionId,
            error_code: (error as { code?: string }).code || 'DESIGN_SESSION_FAILED',
        });
        return designSessionErrorResponse(error);
    }
}
