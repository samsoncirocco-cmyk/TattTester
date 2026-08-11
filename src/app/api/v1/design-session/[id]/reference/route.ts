import { NextRequest, NextResponse } from 'next/server';
import { verifyApiAuthWithUser } from '@/lib/api-auth';
import { attachReference, claimSessionOwnership, storeReferencePhoto } from '@/services/designSession';
import {
    analyzeReferenceImage,
    referenceAckText,
    referenceFollowUpText,
    REFERENCE_UNREADABLE_TEXT,
    REFERENCE_BUDGET_TEXT,
    ANALYZABLE_IMAGE_TYPES,
    MAX_REFERENCE_IMAGE_BYTES,
} from '@/services/vision';
import { rateLimit, rateLimitResponse } from '@/lib/rate-limit';
import { createRequestLogger } from '@/lib/logger';
import { designSessionErrorResponse, invalidRequestResponse } from '../../shared';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/v1/design-session/[id]/reference — the web channel's reference
 * upload (TAT-50): one image per call, analyzed by the SAME vision service
 * as SketchBot's inbound MMS, attached to the session as a reference entry
 * (style tags toward Council enhancement, a Brief reference line, the IP
 * rule for recognized characters), and acknowledged in-voice.
 *
 * Body: { imageBase64: string, mimeType: string } — raw base64, no
 * data-URL prefix, capped at the shared 5MB image ceiling.
 *
 * Vision failures are NOT HTTP errors: the bot owes the user a sentence,
 * not a status code. The response's `attached` flag plus the in-voice
 * `reply` line let the chat UI speak honestly either way; budget spend is
 * recorded inside the vision service itself.
 */
export async function POST(
    req: NextRequest,
    { params }: { params: Promise<{ id: string }> }
) {
    const reqLogger = createRequestLogger('design-session-reference');
    let sessionId = 'unknown';

    try {
        const auth = await verifyApiAuthWithUser(req);
        if (auth.error) return auth.error;

        const demoMode = process.env.NEXT_PUBLIC_DEMO_MODE === 'true';
        if (!demoMode) {
            const rateResult = await rateLimit(req, 'default');
            if (!rateResult.allowed) {
                return rateLimitResponse(rateResult);
            }
        }

        ({ id: sessionId } = await params);

        // Ownership guard (#338 item 1): an owned session refuses any other
        // uid with 404. Uncharged, so no stamp — the session stays unbound
        // until its first charged action.
        await claimSessionOwnership(sessionId, auth.user.uid, { stamp: false });

        const body = await req.json().catch(() => ({}));
        const { imageBase64, mimeType } = body as {
            imageBase64?: unknown;
            mimeType?: unknown;
        };

        if (typeof imageBase64 !== 'string' || !imageBase64.trim()) {
            return invalidRequestResponse(
                'imageBase64 must be a non-empty base64 string',
                'INVALID_IMAGE'
            );
        }
        if (typeof mimeType !== 'string' || !ANALYZABLE_IMAGE_TYPES.has(mimeType.toLowerCase())) {
            return invalidRequestResponse(
                `mimeType must be one of: ${[...ANALYZABLE_IMAGE_TYPES].join(', ')}`,
                'INVALID_IMAGE_TYPE'
            );
        }
        // Base64 inflates bytes by 4/3 — reject anything over the shared cap.
        if (imageBase64.length > (MAX_REFERENCE_IMAGE_BYTES * 4) / 3 + 4) {
            return invalidRequestResponse(
                'Image exceeds the 5MB reference cap',
                'IMAGE_TOO_LARGE'
            );
        }

        const outcome = await analyzeReferenceImage({
            data: imageBase64.trim(),
            mimeType: mimeType.toLowerCase(),
        });

        if (outcome.status !== 'analyzed') {
            // Honest in-voice line, not an error status: the upload worked,
            // the reading didn't (or the budget gate refused).
            reqLogger.complete('design_session.reference.skipped', {
                session_id: sessionId,
                reason: outcome.status,
            });
            return NextResponse.json({
                attached: false,
                code: outcome.status === 'budget_exhausted' ? 'BUDGET_EXHAUSTED' : 'UNREADABLE_IMAGE',
                reply:
                    outcome.status === 'budget_exhausted'
                        ? REFERENCE_BUDGET_TEXT
                        : REFERENCE_UNREADABLE_TEXT,
            });
        }

        // Keep the pixels too (ADR-0050): stored privately, fail-soft — a
        // reference whose photo upload failed still attaches its analysis.
        const imagePath = await storeReferencePhoto(sessionId, {
            data: imageBase64.trim(),
            mimeType: mimeType.toLowerCase(),
        });

        const result = await attachReference(sessionId, outcome.analysis, 'web', imagePath);

        reqLogger.complete('design_session.reference.success', {
            session_id: result.sessionId,
            characters: outcome.analysis.characters.length,
        });

        return NextResponse.json({
            attached: true,
            reference: { summary: result.summary },
            notes: result.notes,
            // The acknowledgment + the one useful follow-up, in voice — the
            // chat UI renders these as SketchBot speaking (never a silent
            // ingest, same promise as the SMS channel).
            reply: `${referenceAckText(outcome.analysis)} ${referenceFollowUpText(outcome.analysis)}`,
        });
    } catch (error) {
        reqLogger.error('design_session.reference.failed', error as Error, {
            session_id: sessionId,
        });
        return designSessionErrorResponse(error);
    }
}
