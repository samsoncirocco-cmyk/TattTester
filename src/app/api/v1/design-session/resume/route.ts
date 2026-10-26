import { NextRequest, NextResponse } from 'next/server';
import { verifyApiAuthWithUser } from '@/lib/api-auth';
import { dismissDesignResume, resolveDesignResume } from '@/services/designSession';
import { rateLimit, rateLimitResponse } from '@/lib/rate-limit';
import { createRequestLogger } from '@/lib/logger';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET  /api/v1/design-session/resume[?sessionId=]
 * POST /api/v1/design-session/resume  { sessionId }  — start over
 *
 * Open to signed-out visitors for the same reason converse is: the design
 * door is in front of the account wall, and a reload during intake has no
 * owner yet. The hinted id is the capability. A Bearer token is verified
 * when present and never required. A bad token is still a 401.
 */

async function callerUid(req: NextRequest): Promise<{ uid: string | null; error?: NextResponse }> {
  const hasBearer = req.headers.get('authorization')?.startsWith('Bearer ') === true;
  if (!hasBearer) return { uid: null };
  const auth = await verifyApiAuthWithUser(req);
  if (auth.error) return { uid: null, error: auth.error };
  return { uid: auth.user.uid };
}

export async function GET(req: NextRequest) {
  const reqLogger = createRequestLogger('design-session-resume');
  try {
    const caller = await callerUid(req);
    if (caller.error) return caller.error;

    const rateResult = await rateLimit(req, 'default', caller.uid ?? undefined);
    if (!rateResult.allowed) return rateLimitResponse(rateResult);

    const hinted = req.nextUrl.searchParams.get('sessionId');
    const resume = await resolveDesignResume({
      uid: caller.uid,
      hintedSessionId: hinted,
    });

    reqLogger.complete('design_session.resume', {
      found: Boolean(resume),
      phase: resume?.phase,
    });
    return NextResponse.json({ resume });
  } catch (error) {
    reqLogger.error('design_session.resume.failed', error as Error);
    return NextResponse.json({ resume: null });
  }
}

export async function POST(req: NextRequest) {
  const reqLogger = createRequestLogger('design-session-resume');
  try {
    const caller = await callerUid(req);
    if (caller.error) return caller.error;

    const rateResult = await rateLimit(req, 'default', caller.uid ?? undefined);
    if (!rateResult.allowed) return rateLimitResponse(rateResult);

    const body = (await req.json().catch(() => null)) as { sessionId?: unknown } | null;
    const sessionId = typeof body?.sessionId === 'string' ? body.sessionId.trim() : '';
    if (!sessionId) {
      return NextResponse.json({ error: 'sessionId is required' }, { status: 400 });
    }

    await dismissDesignResume({ uid: caller.uid, sessionId });
    reqLogger.complete('design_session.resume.dismissed', { session_id: sessionId });
    return NextResponse.json({ ok: true });
  } catch (error) {
    reqLogger.error('design_session.resume.dismiss_failed', error as Error);
    return NextResponse.json({ ok: true });
  }
}
