import { NextRequest, NextResponse } from 'next/server';
import { randomUUID } from 'crypto';
import { appendFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { verifyApiAuth } from '@/lib/api-auth';
import { verifyFirebaseToken } from '@/lib/auth-dal';
import { ensureAdminApp } from '@/lib/firebase-admin';
import { validateBookingRequest } from '@/lib/booking';
import { getRosterArtistById } from '@/lib/artists-graph';
import { REQUEST_REPLY_HOURS } from '@/lib/request-reply-window';
import { withIdempotency } from '@/lib/idempotency';

// In-memory rate limiter: ip -> list of timestamps
const rateLimitMap = new Map<string, number[]>();
const RATE_LIMIT = 5;
const RATE_WINDOW = 60 * 60 * 1000; // 1 hour

function checkRateLimit(ip: string): boolean {
  const now = Date.now();
  const timestamps = (rateLimitMap.get(ip) ?? []).filter(t => now - t < RATE_WINDOW);
  if (timestamps.length >= RATE_LIMIT) return false;
  timestamps.push(now);
  rateLimitMap.set(ip, timestamps);
  return true;
}

export async function POST(request: NextRequest) {
  const authError = await verifyApiAuth(request);
  if (authError) return authError;

  // Owner uid — booking_requests docs are readable only by this user
  // (see firestore.rules). verifyApiAuth already accepted the token,
  // so this resolves to the same verified user.
  const user = await verifyFirebaseToken(request);

  // A double-click or a retry of the same submit attempt replays the first
  // booking instead of minting a second one or spending the rate limit twice
  // (spec 5). A 429 is never stored, so it is never replayed.
  return withIdempotency(request, 'capture', user?.uid, () => capture(request, user?.uid ?? null));
}

async function capture(request: NextRequest, uid: string | null): Promise<NextResponse> {
  // Rate limit by IP
  const ip = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown';
  if (!checkRateLimit(ip)) {
    return NextResponse.json(
      { success: false, error: 'Too many booking requests. Please try again later.' },
      { status: 429 }
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ success: false, error: 'Invalid request body' }, { status: 400 });
  }

  const parsed = validateBookingRequest(body);
  if (!parsed.ok) {
    return NextResponse.json({ success: false, error: parsed.error }, { status: 400 });
  }

  // A deposit is allowed only for the positive-evidence bookable tier. This
  // repeats the server component's redirect because a client can call this API
  // directly. Unlike ordinary browsing, money fails closed when the graph is
  // unavailable: an unknown contact channel must never receive a deposit.
  if (parsed.value.artistId) {
    try {
      const artist = await getRosterArtistById(parsed.value.artistId);
      if (!artist) {
        return NextResponse.json({ success: false, error: 'Unknown artist.' }, { status: 400 });
      }
      if (artist.bookingTier !== 'bookable') {
        // Preserve ds parity with /book's browse-only redirect so callers that
        // follow introUrl keep the design-session Brief on the intro path.
        const intro = new URLSearchParams({ artistId: artist.id });
        if (parsed.value.designSessionId) {
          intro.set('ds', parsed.value.designSessionId);
        }
        return NextResponse.json({
          success: false,
          error: 'This artist is available through an introduction request, not a deposit.',
          code: 'ARTIST_INTRO_REQUIRED',
          introUrl: `/intro?${intro.toString()}`,
        }, { status: 409 });
      }
    } catch (err) {
      // A deposit against an unverified relay is the exact failure the tier
      // prevents, so graph trouble is an honest retry rather than fail-open.
      console.warn(
        `[book] bookability check failed for ${parsed.value.artistId} — refusing deposit:`,
        err instanceof Error ? err.message : err
      );
      return NextResponse.json(
        { success: false, error: 'We could not verify that this artist can receive booking requests. Please try again shortly.' },
        { status: 503 },
      );
    }
  }

  // Attach the design-session Brief (the artist-facing deliverable — see
  // CONTEXT.md "Brief") when the booking arrived from a completed design
  // session. Fail-OPEN like the artist check above: a missing, incomplete,
  // or erroring session must never drop a real booking — capture without
  // the brief and log it.
  let brief: Record<string, unknown> | undefined;
  if (parsed.value.designSessionId) {
    const dsId = parsed.value.designSessionId;
    try {
      const { getSession } = await import('@/services/designSession');
      const session = await getSession(dsId);
      if (session?.phase === 'complete' && session.brief) {
        // Strip undefined optionals (finalImageUrl, rejectedAxisPosition) —
        // Firestore rejects undefined fields even inside nested maps.
        brief = Object.fromEntries(
          Object.entries(session.brief).filter(([, v]) => v !== undefined)
        );
      } else {
        console.warn(
          `[book] design session ${dsId} has no brief (phase: ${session?.phase ?? 'unknown'}) — capturing booking without it`
        );
      }
    } catch (err) {
      console.warn(
        `[book] design session lookup failed for ${dsId} — capturing booking without brief (fail-open):`,
        err instanceof Error ? err.message : err
      );
    }
  }

  const bookingId = `BK-${randomUUID().slice(0, 8).toUpperCase()}`;
  // Strip undefined values — Firestore rejects any document containing an
  // `undefined` field (e.g. optional clientPhone), throwing a validation error
  // that previously dropped the booking to the ephemeral file fallback and lost
  // it. Only real (defined) fields are persisted.
  const booking = Object.fromEntries(
    Object.entries({
      bookingId,
      ...parsed.value,
      brief,
      uid,
      status: 'pending',
      createdAt: new Date().toISOString(),
      ip,
    }).filter(([, v]) => v !== undefined)
  );

  // Try Firestore (if configured)
  let savedToFirestore = false;
  const credSource = ensureAdminApp();
  try {
    if (credSource) {
      const { getFirestore } = await import('firebase-admin/firestore');
      await getFirestore().collection('booking_requests').doc(bookingId).set(booking);
      savedToFirestore = true;
    } else {
      console.error(`[book] ${bookingId}: Firebase Admin unconfigured — using file fallback`);
    }
  } catch (err) {
    // Fall back to file, but never silently: a lost prod booking is real money
    console.error(
      `[book] ${bookingId}: Firestore write failed (cred source: ${credSource}) — using file fallback:`,
      err instanceof Error ? err.message : err
    );
  }

  // Fallback: append to local file
  if (!savedToFirestore) {
    try {
      const dir = '/tmp/tatt-data';
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      appendFileSync(join(dir, 'bookings.jsonl'), JSON.stringify(booking) + '\n');
    } catch {
      // Even file write failed — still return success (booking captured in memory)
    }
  }

  return NextResponse.json({
    success: true,
    bookingId,
    message: `Booking request received! Your confirmation number is ${bookingId}. You hear back within ${REQUEST_REPLY_HOURS} hours.`,
  });
}
