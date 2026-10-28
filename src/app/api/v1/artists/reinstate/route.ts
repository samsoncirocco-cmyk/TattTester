/**
 * POST /api/v1/artists/reinstate — "you removed me, and now I want to come back".
 *
 * The counterpart to /api/v1/artists/takedown, and the only door through the
 * permanent tombstone that takedown installs. See docs/adr/0026.
 *
 * Deliberate properties:
 *
 *  - AUTHENTICATED, unlike takedown. Asking to be *removed* must be
 *    frictionless — requiring a TatT account first would be backwards. Asking to
 *    be *re-added* is the opposite: the account is part of the proof, and gives
 *    the eventual ownership binding an identity that can be revoked.
 *
 *  - CHANGES NOTHING. It records a `:ReinstatementRequest` and emails a human.
 *    It cannot clear `removedAt`, cannot bind `claimedByUid`, and cannot touch a
 *    `:TakedownTombstone`. Same restraint as takedown, for the same reason: the
 *    publicly reachable half of a dangerous operation must be inert.
 *
 *  - REVEALS NOTHING. The response is identical whether or not a tombstone
 *    exists for the handle. A tombstone records that someone exercised a removal
 *    right, which is itself sensitive; a route that confirmed them would be an
 *    oracle for "who asked to be taken down?". The code is always issued, the
 *    request is always recorded, and only the operator's dry run knows the
 *    truth. This costs nothing, because a real artist's next step is the same
 *    either way.
 *
 *  - NEVER FAKES SUCCESS. If ops could not be notified, this returns 502 rather
 *    than leaving an artist waiting on a review that will never happen.
 */
import { NextRequest, NextResponse } from 'next/server';
import { randomUUID } from 'crypto';
import { verifyApiAuth } from '@/lib/api-auth';
import { verifyFirebaseToken } from '@/lib/auth-dal';
import {
  formatVerificationCode,
  reinstatementModerationText,
  validateReinstatementRequest,
  VERIFICATION_CODE_TTL_MS,
} from '@/lib/reinstatement';
import { recordReinstatementRequest } from '@/lib/reinstatement-graph';
import { notifyOpsOfReinstatementRequest } from '@/lib/notify';
import { moderationNotice, screenContent } from '@/lib/typesafeModeration';

export const runtime = 'nodejs';

// Keyed on the verified uid, not the IP: this route requires an account, so the
// uid is the meaningful unit of abuse. Per-instance only, like /api/v1/book.
const rateLimitMap = new Map<string, number[]>();
const RATE_LIMIT = 5;
const RATE_WINDOW = 60 * 60 * 1000; // 1 hour

function checkRateLimit(key: string): boolean {
  const now = Date.now();
  const timestamps = (rateLimitMap.get(key) ?? []).filter((t) => now - t < RATE_WINDOW);
  if (timestamps.length >= RATE_LIMIT) return false;
  timestamps.push(now);
  rateLimitMap.set(key, timestamps);
  return true;
}

/** Short, human-quotable id — this ends up in an email subject and a reply. */
function newRequestId(): string {
  return `RI-${randomUUID().replace(/-/g, '').slice(0, 8).toUpperCase()}`;
}

export async function POST(request: NextRequest) {
  const authError = await verifyApiAuth(request);
  if (authError) return authError;

  const user = await verifyFirebaseToken(request);
  if (!user) {
    return NextResponse.json(
      {
        received: false,
        error:
          'Sign in first. Reinstating a removed profile binds it to an account, so we need ' +
          'to know which account is asking.',
        code: 'AUTH_REQUIRED',
      },
      { status: 401 },
    );
  }

  if (!checkRateLimit(user.uid)) {
    return NextResponse.json(
      {
        received: false,
        error: 'Too many reinstatement requests from this account. Please email us directly.',
        fallbackEmail: process.env.OPS_NOTIFY_EMAIL || 'support@tatttester.com',
      },
      { status: 429 },
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ received: false, error: 'Invalid JSON body.' }, { status: 400 });
  }

  const parsed = validateReinstatementRequest(body, user.uid);
  if (!parsed.ok) {
    return NextResponse.json({ received: false, error: parsed.error }, { status: 400 });
  }

  const requestId = newRequestId();

  // Classify the appeal text before we record it. Block and review still
  // record a pending request. Nothing is restored and nothing is resolved.
  // A failed call is a pass.
  const moderation = await screenContent({
    surface: 'appeal',
    text: reinstatementModerationText(parsed.value),
    subjectId: requestId,
  }).catch(() => ({
    action: 'pass' as const,
    userMessage: null,
    skipped: true,
    reason: 'error',
    hazards: [] as string[],
  }));

  // Unpredictable so it cannot be pre-published by someone guessing. It is not a
  // secret — the artist publishes it — it is a proof of control of the account.
  const verificationCode = formatVerificationCode(randomUUID().replace(/-/g, ''));

  // Record first, notify second: a failed email then still leaves a trace a
  // human can find, where the reverse ordering would lose the request entirely.
  let logged = false;
  try {
    logged = await recordReinstatementRequest(parsed.value, requestId, verificationCode);
  } catch (err) {
    console.error(
      `[reinstate] graph record threw for ${requestId} — continuing to notify:`,
      err instanceof Error ? err.message : err,
    );
  }

  let delivery: { delivered: boolean; reason?: string };
  try {
    delivery = await notifyOpsOfReinstatementRequest(
      parsed.value,
      requestId,
      verificationCode,
      moderationNotice(moderation),
    );
  } catch (err) {
    delivery = { delivered: false, reason: err instanceof Error ? err.message : String(err) };
  }

  if (!delivery.delivered) {
    console.error(`[reinstate] request ${requestId} NOT delivered: ${delivery.reason}`);
    return NextResponse.json(
      {
        received: false,
        reinstated: false,
        requestId,
        logged,
        error:
          'We could not deliver your request to our team, so we will not pretend it went ' +
          'through. Please email us directly and quote the reference below.',
        fallbackEmail: process.env.OPS_NOTIFY_EMAIL || 'support@tatttester.com',
      },
      { status: 502 },
    );
  }

  return NextResponse.json(
    {
      received: true,
      // Said explicitly. Nothing has been restored, and a human decides.
      reinstated: false,
      requestId,
      logged,
      verificationCode,
      expiresInDays: Math.round(VERIFICATION_CODE_TTL_MS / (24 * 60 * 60 * 1000)),
      nextStep:
        `Post this code on the Instagram account @${parsed.value.instagram} — in your bio, ` +
        `a post, or a story — so we can confirm the account is yours. Then reply to our ` +
        `email, or wait for us to check.`,
      status:
        !moderation.skipped && moderation.action !== 'pass' && moderation.userMessage
          ? moderation.userMessage
          : 'Received and awaiting review by a person.',
      ...(!moderation.skipped && moderation.action !== 'pass'
        ? { moderation: moderation.action }
        : {}),
      // Set expectations honestly, up front: this is not an undo button.
      restores:
        'Nothing that was deleted comes back. Your photographs and profile details were ' +
        'permanently erased when you were removed. If we approve this, you get an empty ' +
        'profile that belongs to your account and that you fill in yourself. Our scrapers ' +
        'stay permanently blocked from re-adding you either way.',
    },
    { status: 202 },
  );
}
