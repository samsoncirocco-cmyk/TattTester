/**
 * POST   /api/v1/match/decision   body {artistId, decision: 'pin'|'pass', dsId?}  → 204
 * DELETE /api/v1/match/decision?artistId=                                        → 204
 *
 * The uid is the verified token's, never the body's: the path this replaces
 * stored every swipe in localStorage under a hardcoded 'user-123'. A body
 * `uid` is ignored. Upserts are idempotent per (uid, artistId).
 */
import { NextRequest, NextResponse } from 'next/server';
import { verifyApiAuthWithUser } from '@/lib/api-auth';
import { rateLimit, rateLimitResponse } from '@/lib/rate-limit';
import {
  recordDecision,
  removeDecision,
  type Decision,
} from '@/features/match-pulse/services/matchDecisionsPersistence';

export const runtime = 'nodejs';

// Doubles as the Firestore doc-id guard: no slashes, no whitespace, bounded.
const ARTIST_ID = /^[A-Za-z0-9_.:-]{1,128}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isValidArtistId(value: unknown): value is string {
  return typeof value === 'string' && ARTIST_ID.test(value);
}

function invalid(error: string) {
  return NextResponse.json({ error, code: 'INVALID_DECISION' }, { status: 400 });
}

export async function POST(req: NextRequest) {
  const { error, user } = await verifyApiAuthWithUser(req);
  if (error) return error;

  const limit = await rateLimit(req, 'match-decision', user.uid);
  if (!limit.allowed) return rateLimitResponse(limit);

  let body: { artistId?: unknown; decision?: unknown; dsId?: unknown };
  try {
    body = await req.json();
  } catch {
    return invalid('Invalid JSON body.');
  }

  if (!isValidArtistId(body.artistId)) {
    return invalid('artistId must be a non-empty string of at most 128 characters.');
  }
  if (body.decision !== 'pin' && body.decision !== 'pass') {
    return invalid("decision must be 'pin' or 'pass'.");
  }
  let dsId: string | null = null;
  if (body.dsId !== undefined && body.dsId !== null) {
    if (typeof body.dsId !== 'string' || !UUID.test(body.dsId)) {
      return invalid('dsId must be a UUID when present.');
    }
    dsId = body.dsId;
  }

  try {
    const stored = await recordDecision({
      uid: user.uid,
      artistId: body.artistId,
      decision: body.decision as Decision,
      dsId,
    });
    if (!stored) {
      return NextResponse.json({ error: 'Decision store unavailable.' }, { status: 503 });
    }
    return new NextResponse(null, { status: 204 });
  } catch (err) {
    console.error('[match/decision] write failed:', err instanceof Error ? err.message : err);
    return NextResponse.json({ error: 'Could not save decision.' }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  const { error, user } = await verifyApiAuthWithUser(req);
  if (error) return error;

  const limit = await rateLimit(req, 'match-decision', user.uid);
  if (!limit.allowed) return rateLimitResponse(limit);

  const artistId = req.nextUrl.searchParams.get('artistId');
  if (!isValidArtistId(artistId)) {
    return invalid('artistId query parameter is required.');
  }

  try {
    const removed = await removeDecision(user.uid, artistId);
    if (!removed) {
      return NextResponse.json({ error: 'Decision store unavailable.' }, { status: 503 });
    }
    return new NextResponse(null, { status: 204 });
  } catch (err) {
    console.error('[match/decision] delete failed:', err instanceof Error ? err.message : err);
    return NextResponse.json({ error: 'Could not remove decision.' }, { status: 500 });
  }
}
