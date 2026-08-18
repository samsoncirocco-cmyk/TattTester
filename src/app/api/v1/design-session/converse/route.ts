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
// Demo mode (NEXT_PUBLIC_DEMO_MODE): delegates to the real service — the
// engine's deterministic demo script serves the turn, free — so rate policy
// and spend recording are skipped, matching the other design-session routes.
//
// When every conversation provider is down the service raises
// CONVERSATION_UNAVAILABLE, mapped here to 503 with an explicit fallback
// hint: the UI downgrades to the scripted two-question intake (the ADR-0019
// degraded mode via POST /api/v1/design-session).

export async function POST(req: NextRequest) {
    const reqLogger = createRequestLogger('design-session-converse');

    // Setup lives inside the try so an auth/rate failure still returns the
    // structured error envelope and logs, instead of escaping as a bare 500.
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
        // session refuses any other uid with 404. An opening call has no
        // session yet, and an unowned session stays capability-model until
        // its first charged action stamps an owner.
        if (typeof sessionId === 'string') {
            await claimSessionOwnership(sessionId.trim(), auth.user.uid, { stamp: false });
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
