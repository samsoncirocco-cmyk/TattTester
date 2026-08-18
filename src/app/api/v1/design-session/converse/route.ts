import { NextRequest, NextResponse } from 'next/server';
import { verifyApiAuthWithUser } from '@/lib/api-auth';
import { claimSessionOwnership, converse } from '@/services/designSession';
import { rateLimit, rateLimitResponse } from '@/lib/rate-limit';
import { recordConversationTurnSpend } from '@/lib/budget-tracker';
import { createRequestLogger } from '@/lib/logger';
import { designSessionErrorResponse, invalidRequestResponse } from '../shared';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// POST /api/v1/design-session/converse — one turn of the conversational
// intake (ADR-0019–0022). Thin adapter over the designSession service: this
// route only does auth/rate policy, ConverseRequest validation, turn-spend
// recording (its own budget line item), and response-shape mapping. No
// sessionId starts a new conversation (the bot sends the opener).
//
// OPEN TO SIGNED-OUT VISITORS. This is the product's front door, and it
// generates nothing: ADR-0041 puts one gate in front of *generation*, and a
// conversation turn is not a generation. #357 completed the other half —
// sessions are created unowned and stamped by the first CHARGED action —
// but this route still demanded a Bearer token, so a stranger could not
// reach SketchBot at all. The wall now sits at /confirm, where the renders
// (and the credit debit) actually happen.
//
// A signed-in caller still sends their token and gets the ordinary
// per-uid 'default' allowance. A signed-out one is rate-limited per IP on
// a much tighter 'converse-anon' tier — turns cost real model money, so an
// open door is not an open bar — and, when continuing an existing session,
// is refused any session that already has an owner.
//
// Demo mode (NEXT_PUBLIC_DEMO_MODE): delegates to the real service — the
// engine's deterministic demo script serves the turn, free — so rate policy
// and spend recording are skipped, matching the other design-session routes.
//
// When every conversation provider is down the service raises
// CONVERSATION_UNAVAILABLE, mapped here to 503 with an explicit fallback
// hint: the UI downgrades to the scripted two-question intake (the ADR-0019
// degraded mode via POST /api/v1/design-session).

/**
 * Stands in for a uid when nobody is signed in. Contains a colon, which a
 * Firebase uid cannot, so it can never collide with a real owner.
 */
const ANONYMOUS_CALLER = 'anonymous:web';

export async function POST(req: NextRequest) {
    const reqLogger = createRequestLogger('design-session-converse');

    // Setup lives inside the try so an auth/rate failure still returns the
    // structured error envelope and logs, instead of escaping as a bare 500.
    try {
        // A token is honored when present and never required. An INVALID
        // token is still refused: a caller who tried to authenticate and
        // failed is a bug or an attack, not an anonymous visitor, and
        // silently downgrading them to anonymous would hide both.
        const hasBearer = req.headers.get('authorization')?.startsWith('Bearer ') === true;
        let uid: string | null = null;
        if (hasBearer) {
            const auth = await verifyApiAuthWithUser(req);
            if (auth.error) return auth.error;
            uid = auth.user.uid;
        }

        const demoMode = process.env.NEXT_PUBLIC_DEMO_MODE === 'true';

        if (!demoMode) {
            // Signed-in: per-uid, the ordinary allowance. Signed-out: per-IP
            // on the tight anonymous tier.
            const rateResult = uid
                ? await rateLimit(req, 'default', uid)
                : await rateLimit(req, 'converse-anon');
            if (!rateResult.allowed) {
                return rateLimitResponse(rateResult);
            }
        }

        const body = await req.json().catch(() => ({}));
        const { sessionId, message } = body as { sessionId?: unknown; message?: unknown };

        if (sessionId !== undefined && (typeof sessionId !== 'string' || !sessionId.trim())) {
            return invalidRequestResponse(
                'sessionId must be a non-empty string when provided',
                'INVALID_SESSION_ID'
            );
        }
        if (message !== undefined && (typeof message !== 'string' || !message.trim())) {
            return invalidRequestResponse(
                'message must be a non-empty string when provided',
                'INVALID_MESSAGE'
            );
        }
        // The opening call (no sessionId) may omit the message — the bot sends
        // the opener. Every later turn needs the user's message.
        if (sessionId !== undefined && message === undefined) {
            return invalidRequestResponse(
                'message is required when continuing a conversation',
                'INVALID_MESSAGE'
            );
        }

        // Ownership guard (#338 item 1): a continuing turn on an owned
        // session refuses any other caller with 404. An opening call has no
        // session yet, and an unowned session stays capability-model until
        // its first charged action stamps an owner.
        //
        // A signed-out caller is checked with the anonymous sentinel, which
        // can never equal a real Firebase uid — so it matches nothing and
        // stamps nothing, and simply reads as "not the owner". Opening the
        // route to strangers must not open owned sessions to them.
        if (typeof sessionId === 'string') {
            await claimSessionOwnership(sessionId.trim(), uid ?? ANONYMOUS_CALLER, {
                stamp: false,
            });
        }

        const response = await converse({
            ...(typeof sessionId === 'string' ? { sessionId: sessionId.trim() } : {}),
            ...(typeof message === 'string' ? { message: message.trim() } : {}),
        });

        // Conversation turns are near-free but never untracked: each turn is
        // recorded as its own budget line item. Demo turns run the engine's
        // free script — nothing to record.
        if (!demoMode) await recordConversationTurnSpend();

        reqLogger.complete('design_session.converse.success', {
            session_id: response.sessionId,
            stage: response.stage,
            turn: response.turn,
        });

        return NextResponse.json(response);
    } catch (error) {
        reqLogger.error('design_session.converse.failed', error as Error, {
            error_code: (error as { code?: string }).code || 'DESIGN_SESSION_FAILED',
        });

        const err = (error ?? {}) as { code?: string; status?: number };
        if (err.code === 'CONVERSATION_UNAVAILABLE' || err.status === 503) {
            return NextResponse.json(
                {
                    error:
                        'The design conversation is temporarily unavailable — continue with the scripted intake questions instead.',
                    code: 'CONVERSATION_UNAVAILABLE',
                    fallback: 'scripted-intake',
                },
                { status: 503 }
            );
        }
        return designSessionErrorResponse(error);
    }
}
