/**
 * GET /api/v1/match/decisions?ds={dsId}
 *   → { decisions: [{artistId, decision, dsId, updatedAt}] }
 *
 * Only the caller's own decisions, newest first, capped at 500. With `ds`,
 * scoped to that design session's deck; without it, everything in the last
 * 30 days. /swipe reads this on mount so a reload or another device resumes
 * where the customer left off.
 */
import { NextRequest, NextResponse } from 'next/server';
import { verifyApiAuthWithUser } from '@/lib/api-auth';
import { rateLimit, rateLimitResponse } from '@/lib/rate-limit';
import { listDecisions } from '@/features/match-pulse/services/matchDecisionsPersistence';

export const runtime = 'nodejs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(req: NextRequest) {
  const { error, user } = await verifyApiAuthWithUser(req);
  if (error) return error;

  const limit = await rateLimit(req, 'match-decision', user.uid);
  if (!limit.allowed) return rateLimitResponse(limit);

  const ds = req.nextUrl.searchParams.get('ds');
  if (ds !== null && !UUID.test(ds)) {
    return NextResponse.json(
      { error: 'ds must be a UUID when present.', code: 'INVALID_DECISION' },
      { status: 400 },
    );
  }

  try {
    const decisions = await listDecisions(user.uid, { dsId: ds });
    return NextResponse.json({ decisions });
  } catch (err) {
    console.error('[match/decisions] read failed:', err instanceof Error ? err.message : err);
    return NextResponse.json({ error: 'Could not load decisions.' }, { status: 500 });
  }
}
