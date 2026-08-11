import { NextRequest, NextResponse } from 'next/server';
import { verifyApiAuthWithUser } from '@/lib/api-auth';
import { attachPlacementPreview, claimSessionOwnership } from '@/services/designSession';
import { createRequestLogger } from '@/lib/logger';
import { designSessionErrorResponse, invalidRequestResponse } from '../../shared';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// The flattened canvas export arrives as a PNG data URL. 8MB of base64
// (~6MB decoded) comfortably covers a 1600px composite while keeping a
// bound on the request body.
const MAX_IMAGE_DATA_LENGTH = 8 * 1024 * 1024;
const DATA_URL_PATTERN = /^data:image\/(png|jpeg);base64,(.+)$/;

/**
 * POST /api/v1/design-session/[id]/placement-preview — persist the /design
 * placement-preview screenshot (design composited on the user's own photo)
 * onto the completed session's Brief, so it travels into the booking record
 * with the rest of the Brief. No image generation happens here — it's a
 * canvas artifact upload, so rate/budget policy for paid renders does not
 * apply. Storage: GCS when wired (signed URL, same durability class as
 * finalImageUrl); the raw data URL as the creds-less dev/demo fallback,
 * where the in-memory session store holds it without a document-size limit.
 */
export async function POST(
    req: NextRequest,
    { params }: { params: Promise<{ id: string }> }
) {
    const reqLogger = createRequestLogger('design-session-placement-preview');
    // Seeded before the try so a setup failure — including one thrown by
    // `await params` itself — still logs a session_id.
    let sessionId = 'unknown';

    try {
        const auth = await verifyApiAuthWithUser(req);
        if (auth.error) return auth.error;

        ({ id: sessionId } = await params);

        // Ownership guard (#338 item 1): an owned session refuses any other
        // uid with 404. Uncharged, so no stamp — the session stays unbound
        // until its first charged action.
        await claimSessionOwnership(sessionId, auth.user.uid, { stamp: false });
        const body = await req.json().catch(() => ({}));
        const { imageData } = body as { imageData?: unknown };

        if (typeof imageData !== 'string' || !imageData) {
            return invalidRequestResponse('imageData is required', 'INVALID_IMAGE_DATA');
        }
        if (imageData.length > MAX_IMAGE_DATA_LENGTH) {
            return invalidRequestResponse('imageData exceeds the 8MB limit', 'IMAGE_TOO_LARGE');
        }
        const match = imageData.match(DATA_URL_PATTERN);
        if (!match) {
            return invalidRequestResponse(
                'imageData must be a PNG or JPEG data URL',
                'INVALID_IMAGE_DATA'
            );
        }

        let previewUrl = imageData;
        try {
            const { ensureAdminApp } = await import('@/lib/firebase-admin');
            const gcsWired = process.env.NEXT_PUBLIC_DEMO_MODE !== 'true' && ensureAdminApp();
            if (gcsWired) {
                const { uploadToGCS } = await import('@/services/gcs-service');
                const buffer = Buffer.from(match[2], 'base64');
                const result = await uploadToGCS(
                    buffer,
                    `design-sessions/${sessionId}/placement-preview.png`,
                    { contentType: `image/${match[1]}` }
                );
                previewUrl = result.url;
            }
        } catch (error) {
            // Firestore-backed sessions can't hold a multi-MB data URL (1MB doc
            // limit), so a failed GCS upload is terminal here — never fall
            // through to persisting the raw payload. Its own 502 stays distinct
            // from the structured envelope the outer catch returns.
            reqLogger.error('design_session.placement_preview.upload_failed', error as Error, {
                session_id: sessionId,
            });
            return NextResponse.json(
                { error: 'Preview image upload failed — try again.' },
                { status: 502 }
            );
        }

        const session = await attachPlacementPreview(sessionId, previewUrl);

        reqLogger.complete('design_session.placement_preview.success', {
            session_id: session.id,
        });

        return NextResponse.json({
            success: true,
            placementPreviewUrl: session.brief?.placementPreviewUrl ?? null,
            session,
        });
    } catch (error) {
        reqLogger.error('design_session.placement_preview.failed', error as Error, {
            session_id: sessionId,
            error_code: (error as { code?: string }).code || 'DESIGN_SESSION_FAILED',
        });
        return designSessionErrorResponse(error);
    }
}
