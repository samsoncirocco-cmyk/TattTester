/**
 * POST /api/v1/artists/takedown — "this is my work, take it down".
 *
 * TatT re-hosts portfolio photographs for artists who never opted in. This is
 * how one of them asks us to stop. It is the sibling of /api/v1/connect/claim:
 * the same recognition moment ("this is my profile"), with the other ending.
 *
 * Deliberate properties (see docs/adr/0025):
 *
 *  - PUBLIC. No Firebase token. Requiring a TatT account before you may ask TatT
 *    to stop using your photographs would be backwards. Abuse is bounded by an
 *    IP rate limit and by the fact that this route cannot remove anything.
 *
 *  - REMOVES NOTHING. It records a `:TakedownRequest` and emails a human. It has
 *    no write path to GCS, Supabase, or the `:Artist` node. That is what stops a
 *    takedown request being a way to delete a competitor — no request, however
 *    convincing, removes anything on its own. A human runs the executor.
 *
 *  - NEVER FAKES SUCCESS. If ops could not be notified, this returns 502 and
 *    tells the artist where else to write. An artist who is shown a confirmation
 *    while the request evaporates is worse off than one who sees an error.
 */
import { NextRequest, NextResponse } from 'next/server';
import { randomUUID } from 'crypto';
import { takedownModerationText, validateTakedownRequest } from '@/lib/takedown';
import { recordTakedownRequest } from '@/lib/takedown-graph';
import { notifyOpsOfTakedownRequest } from '@/lib/notify';
import { moderationNotice, screenContent } from '@/lib/typesafeModeration';

export const runtime = 'nodejs';

// In-memory IP limiter, matching /api/v1/book. Per-instance only — on Vercel the
// real enforced limit is looser than this suggests. Acceptable here because the
// route's blast radius is "an email to ops", not a mutation.
const rateLimitMap = new Map<string, number[]>();
const RATE_LIMIT = 10;
const RATE_WINDOW = 60 * 60 * 1000; // 1 hour

function checkRateLimit(ip: string): boolean {
  const now = Date.now();
  const timestamps = (rateLimitMap.get(ip) ?? []).filter((t) => now - t < RATE_WINDOW);
  if (timestamps.length >= RATE_LIMIT) return false;
  timestamps.push(now);
  rateLimitMap.set(ip, timestamps);
  return true;
}

/** Short, human-quotable id — this ends up in an email subject and a reply. */
function newRequestId(): string {
  return `TD-${randomUUID().replace(/-/g, '').slice(0, 8).toUpperCase()}`;
}

export async function POST(request: NextRequest) {
  const ip = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown';
  if (!checkRateLimit(ip)) {
    return NextResponse.json(
      {
        received: false,
        error: 'Too many takedown requests from this address. Please email us directly.',
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

  const parsed = validateTakedownRequest(body);
  if (!parsed.ok) {
    return NextResponse.json({ received: false, error: parsed.error }, { status: 400 });
  }

  const requestId = newRequestId();

  // Classify the message before we record it. A block or a review still
  // records a pending request and still emails a person. The screen never
  // deletes data and never resolves the request. A failed call is a pass.
  const moderation = await screenContent({
    surface: 'takedown',
    text: takedownModerationText(parsed.value),
    subjectId: requestId,
  }).catch(() => ({
    action: 'pass' as const,
    userMessage: null,
    skipped: true,
    reason: 'error',
    hazards: [] as string[],
  }));

  // Record first, notify second. If the email then fails we still have a durable
  // trace a human can find; the reverse ordering would lose the request entirely.
  // A graph failure must not block the notification, which is the real contract.
  let logged = false;
  try {
    logged = await recordTakedownRequest(parsed.value, requestId);
  } catch (err) {
    console.error(
      `[takedown] graph record threw for ${requestId} — continuing to notify:`,
      err instanceof Error ? err.message : err,
    );
  }

  let delivery: { delivered: boolean; reason?: string };
  try {
    delivery = await notifyOpsOfTakedownRequest(
      parsed.value,
      requestId,
      moderationNotice(moderation),
    );
  } catch (err) {
    delivery = { delivered: false, reason: err instanceof Error ? err.message : String(err) };
  }

  if (!delivery.delivered) {
    // Honest degradation. We could not reach a human, so we do not tell the
    // artist we did. Hand them the request id (the graph record may exist) and
    // an address that does not depend on the path that just failed.
    console.error(`[takedown] request ${requestId} NOT delivered: ${delivery.reason}`);
    return NextResponse.json(
      {
        received: false,
        removed: false,
        requestId,
        logged,
        error:
          'We could not deliver your request to our team, so we will not pretend it went through. ' +
          'Please email us directly and quote the reference below — we will action it.',
        fallbackEmail: process.env.OPS_NOTIFY_EMAIL || 'support@tatttester.com',
      },
      { status: 502 },
    );
  }

  const held = !moderation.skipped && moderation.action !== 'pass';
  return NextResponse.json(
    {
      received: true,
      // Said explicitly: the artist must not leave believing their work is gone.
      removed: false,
      requestId,
      logged,
      status: held && moderation.userMessage
        ? moderation.userMessage
        : 'Received and awaiting review by a person.',
      ...(held ? { moderation: moderation.action } : {}),
    },
    { status: 202 },
  );
}
