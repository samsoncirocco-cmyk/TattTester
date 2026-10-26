import { NextRequest, NextResponse } from 'next/server';
import { verifyApiAuth, verifyApiAuthWithUser } from '@/lib/api-auth';
import { DESIGN_SESSION_KEY_HEADER, getSessionForResume } from '@/services/designSession';
import { rateLimit, rateLimitResponse } from '@/lib/rate-limit';
import { designSessionErrorResponse } from '../shared';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/v1/design-session/[id] — fetch a session in whatever phase it's
 * in. Read-only: no rate-limited generation, no spend.
 *
 * Signed in, the caller gets the public projection exactly as before (the
 * /smart-match and /book handoffs read it). Spec 7 adds a sibling `resume`
 * object — transcript, notes and whether a render is still running — and
 * only for a caller allowed to resume: the owner of an owned session, or
 * the browser holding the resume key of a still-unowned one.
 *
 * Signed out, the only way in is that resume key (an intake chat a
 * stranger started before making an account). Without a bearer token or a
 * key the route answers 401 as it always has; with a key that does not
 * match, 404, so a probe learns nothing about which ids exist.
 */
export async function GET(
    req: NextRequest,
    { params }: { params: Promise<{ id: string }> }
) {
    // Setup lives inside the try so an auth/rate failure still returns the
    // structured error envelope instead of escaping as a bare 500.
    try {
        const hasBearer = req.headers.get('authorization')?.startsWith('Bearer ') === true;
        const resumeKey = req.headers.get(DESIGN_SESSION_KEY_HEADER)?.trim() || null;

        let uid: string | null = null;
        if (hasBearer) {
            const auth = await verifyApiAuthWithUser(req);
            if (auth.error) return auth.error;
            uid = auth.user.uid;
        } else if (!resumeKey) {
            // Neither identity nor key: the unchanged firebase-auth refusal.
            const authError = await verifyApiAuth(req);
            if (authError) return authError;
        }

        const rateResult = uid ? await rateLimit(req, 'default', uid) : await rateLimit(req, 'default');
        if (!rateResult.allowed) {
            return rateLimitResponse(rateResult);
        }

        const { id } = await params;

        const found = await getSessionForResume(id, { uid, resumeKey });
        if (!found?.session || (!uid && !found.resume)) {
            return NextResponse.json(
                { error: 'Session not found', code: 'SESSION_NOT_FOUND' },
                { status: 404 }
            );
        }
        return NextResponse.json(
            { success: true, session: found.session, ...(found.resume ? { resume: found.resume } : {}) },
            { headers: { 'Cache-Control': 'private, no-store' } }
        );
    } catch (error) {
        return designSessionErrorResponse(error);
    }
}
