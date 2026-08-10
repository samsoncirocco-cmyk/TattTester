/**
 * Twilio inbound SMS/MMS webhook — the SketchBot SMS channel's front door
 * (TAT-49).
 *
 * Security posture mirrors /api/webhooks/stripe exactly:
 *  - the whole channel ships dark: SKETCHBOT_SMS_ENABLED !== 'true' → 404
 *  - unconfigured credentials FAIL CLOSED → 503 (never accept a payload we
 *    cannot verify), with the same explicit non-production bypass flag
 *    discipline (SKETCHBOT_SMS_ALLOW_UNSIGNED) as the Stripe route
 *  - X-Twilio-Signature verified via the official SDK against the exact
 *    public URL and POST params → 403 on missing/invalid
 *
 * Twilio gives webhooks ~15 seconds; a round's renders take minutes. So the
 * route answers conversational turns synchronously (one TwiML message) and
 * defers reveal generation to after() — the ack goes back immediately, the
 * two cuts arrive as MMS via the REST sender once they exist.
 *
 * MMS delivery is SEQUENTIAL (one cut per message + a closing link text),
 * not a server-side collage: Twilio caps a message's media at 5MB total and
 * carriers transcode aggressively, so four ~1–2MB renders in one message
 * would routinely fail or arrive mangled, and a collage would add image
 * compositing just to lose per-cut zoom. Four captioned messages survive
 * every carrier and read like a reveal.
 *
 * STOP/HELP: Twilio's advanced opt-out answers compliance keywords before
 * we ever see them and suppresses sends to opted-out numbers (error 21610).
 * This route additionally records opt-out state (so the async reveal path
 * never messages a stopped number) and NEVER replies to any opt-out
 * traffic, even when Twilio still forwards it with OptOutType set.
 *
 * Rate limiting ('sms-inbound', per PHONE, env-tunable) answers with empty
 * TwiML — silence, deliberately: every reply to a flooder is a message we
 * pay for. Spend-guardrail refusals (caps, budget) are in-voice replies
 * decided by the service, which owns that policy.
 */
import { NextRequest, NextResponse } from 'next/server';
import { after } from 'next/server';
import {
  sketchbotSmsEnabled,
  twilioConfigured,
  validateTwilioSignature,
  sendSms,
  sendMms,
  TWILIO_NOT_CONFIGURED,
} from '@/lib/twilio';
import { rateLimit } from '@/lib/rate-limit';
import {
  handleInbound,
  executeReveal,
  executeCritique,
  executeRefine,
  executeRefineRound,
  executePlacement,
  recordOptOut,
  isOptedOut,
  parseInboundMedia,
  INTERNAL_ERROR_TEXT,
} from '@/services/sketchbotSms';
import { createRequestLogger, logger } from '@/lib/logger';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// The after() reveal work needs the same headroom as the web confirm route:
// a round's renders through Replicate's low-credit throttle can take minutes.
export const maxDuration = 300;

/** Twilio's compliance keywords (default + advanced opt-out vocabulary). */
const STOP_WORDS = new Set(['stop', 'stopall', 'unsubscribe', 'cancel', 'end', 'quit']);
const START_WORDS = new Set(['start', 'yes', 'unstop']);
const HELP_WORDS = new Set(['help', 'info']);

function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function twiml(message?: string): NextResponse {
  const body = message
    ? `<?xml version="1.0" encoding="UTF-8"?><Response><Message>${escapeXml(message)}</Message></Response>`
    : `<?xml version="1.0" encoding="UTF-8"?><Response></Response>`;
  return new NextResponse(body, {
    status: 200,
    headers: { 'Content-Type': 'text/xml' },
  });
}

/**
 * The exact URL Twilio signed — resolved DETERMINISTICALLY, never from
 * request headers.
 *
 * The first deploy reconstructed this from x-forwarded-proto/host, and
 * genuine Twilio traffic 403'd in production (Twilio error 11200): behind
 * Vercel's proxy chain the reconstructed string is not guaranteed to be
 * byte-identical to the SmsUrl configured on the number (multi-hop
 * x-forwarded-* values are comma-joined, and internal deployment hosts leak
 * through), and HMAC validation is byte-exact by design. Headers are also
 * attacker-controlled input; the URL the signature was computed over is
 * static config, so it must come from config:
 *
 *   1. TWILIO_WEBHOOK_URL — byte-identical to the number's configured
 *      webhook URL (authoritative; documented in .env.example + setup doc)
 *   2. derived from the public base URL (NEXT_PUBLIC_APP_URL /
 *      NEXT_PUBLIC_BASE_URL) + this route's path
 *   3. header reconstruction — last resort for tunnel-based local dev only
 */
const WEBHOOK_PATH = '/api/webhooks/twilio';

function webhookValidationUrl(req: NextRequest): {
  url: string;
  source: string;
} {
  const configured = (process.env.TWILIO_WEBHOOK_URL || '').trim();
  if (configured) return { url: configured, source: 'env' };

  const base = (process.env.NEXT_PUBLIC_APP_URL || process.env.NEXT_PUBLIC_BASE_URL || '')
    .trim()
    .replace(/\/$/, '');
  if (base) return { url: `${base}${WEBHOOK_PATH}`, source: 'derived' };

  const url = new URL(req.url);
  const proto = req.headers.get('x-forwarded-proto') ?? url.protocol.replace(':', '');
  const host = req.headers.get('x-forwarded-host') ?? req.headers.get('host') ?? url.host;
  return {
    url: `${proto}://${host}${url.pathname}${url.search}`,
    source: 'headers',
  };
}

export async function POST(req: NextRequest) {
  const reqLogger = createRequestLogger('twilio-webhook');
  // Flips once the request is proven to be Twilio's. It decides what an
  // unexpected failure returns: an in-voice text to a real texter, or a bare
  // 500 to an unauthenticated caller (see the catch below).
  let verified = false;
  // Compliance traffic (STOP/HELP/START) is answered by Twilio, never by us.
  // Tracked separately so a failure while RECORDING that state still can't
  // turn the catch-all into a reply to an opt-out message.
  let complianceTraffic = false;

  try {
    // Dark by default: while the flag is off this endpoint does not exist.
    if (!sketchbotSmsEnabled()) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }

    // Fail closed: without real credentials the signature cannot be
    // verified and replies cannot be sent — same 503 posture as Stripe.
    if (!twilioConfigured()) {
      const allowUnsigned =
        process.env.SKETCHBOT_SMS_ALLOW_UNSIGNED === 'true' &&
        process.env.NODE_ENV !== 'production';
      if (!allowUnsigned) {
        return NextResponse.json(TWILIO_NOT_CONFIGURED, { status: 503 });
      }
    }

    // Twilio posts application/x-www-form-urlencoded; the raw body decodes
    // straight into the field map validateRequest expects (the SDK sorts
    // keys itself — order here is irrelevant). Never JSON, never reshaped.
    const rawBody = await req.text();
    const params = Object.fromEntries(new URLSearchParams(rawBody));

    const allowUnsigned =
      process.env.SKETCHBOT_SMS_ALLOW_UNSIGNED === 'true' && process.env.NODE_ENV !== 'production';
    if (!allowUnsigned) {
      const signature = req.headers.get('x-twilio-signature');
      const validation = webhookValidationUrl(req);
      if (!validateTwilioSignature(signature, validation.url, params)) {
        // A rejected signature is either an attack or a config mismatch —
        // both deserve a loud, diagnosable log line (the prod 403s on
        // genuine traffic were invisible without it). Values stay redacted.
        logger.warn({
          event_type: 'twilio_webhook.signature_rejected',
          validation_url: validation.url,
          validation_url_source: validation.source,
          has_signature: !!signature,
          param_count: Object.keys(params).length,
          from_last4: (params.From ?? '').slice(-4),
        });
        reqLogger.complete('twilio_webhook.rejected', {
          reason: 'bad_signature',
        });
        return NextResponse.json({ error: 'Invalid Twilio signature.' }, { status: 403 });
      }
    }
    // Past the gate: signature-verified, or the explicit non-prod bypass.
    verified = true;

    const phone = (params.From ?? '').trim();
    const body = (params.Body ?? '').trim();
    if (!phone) {
      return NextResponse.json({ error: 'Missing From.' }, { status: 400 });
    }

    // ── Opt-out traffic: record state, never reply ─────────────────────
    // Twilio's advanced opt-out already sent the compliance response; a
    // second reply from us would be noise at best and a violation at worst.
    const keyword = body.toLowerCase();
    const optOutType = (params.OptOutType ?? '').toUpperCase();
    if (optOutType || STOP_WORDS.has(keyword) || HELP_WORDS.has(keyword)) {
      complianceTraffic = true;
      const effective = optOutType || (STOP_WORDS.has(keyword) ? 'STOP' : 'HELP');
      await recordOptOut(phone, effective);
      reqLogger.complete('twilio_webhook.opt_out', { type: effective });
      return twiml();
    }
    // START/UNSTOP re-opens the door; Twilio auto-confirms, we stay quiet.
    // Mark this as compliance traffic BEFORE the store lookup. If that lookup
    // fails, the catch below must not turn START (or an opted-out YES) into an
    // application apology. When the sender is not opted out, clear the marker
    // so an ordinary conversational "yes" still gets the normal fail-soft
    // reply if later application work fails.
    if (START_WORDS.has(keyword)) {
      complianceTraffic = true;
      if (await isOptedOut(phone)) {
        await recordOptOut(phone, 'START');
        reqLogger.complete('twilio_webhook.opt_out', { type: 'START' });
        return twiml();
      }
      complianceTraffic = false;
    }

    // ── Per-phone inbound rate limit (REQUIRED guardrail) ──────────────
    // Keyed on the sender's number — every request here comes from
    // Twilio's IPs, so IP-keying would rate-limit Twilio, not the texter.
    const rateResult = await rateLimit(req, 'sms-inbound', `sms:${phone}`);
    if (!rateResult.allowed) {
      reqLogger.complete('twilio_webhook.rate_limited', {
        phone_last4: phone.slice(-4),
      });
      return twiml(); // silence — replying to a flood costs money per segment
    }

    // MMS attachments (TAT-50): MediaUrl0..N + content types ride along;
    // the adapter fetches, caps, analyzes, and acknowledges them.
    const media = parseInboundMedia(params);
    const outcome = await handleInbound({
      phone,
      body,
      ...(media.length > 0 ? { media } : {}),
    });

    if (outcome.kind === 'silent') {
      reqLogger.complete('twilio_webhook.silent', {});
      return twiml();
    }

    if (outcome.kind === 'reveal') {
      // Generation outlives the webhook window: ack now, deliver via the
      // REST sender once the renders exist. after() keeps the function
      // alive post-response (Fluid compute, maxDuration above).
      after(async () => {
        const delivery = await executeReveal(
          outcome.sessionId,
          outcome.phone,
          outcome.armedAt
        );
        // Re-check STOP between ack and delivery — never message an
        // opted-out number (Twilio would refuse too; we don't even try).
        if (await isOptedOut(outcome.phone)) return;
        // Empty delivery = this arm was superseded (stale recovery / newer
        // arm). Sending nothing is correct; an empty SMS is not.
        if (delivery.cuts.length === 0 && !delivery.closingText) return;
        for (const cut of delivery.cuts) {
          await sendMms(outcome.phone, cut.caption, [cut.mediaUrl]);
        }
        await sendSms(outcome.phone, delivery.closingText);
      });
      reqLogger.complete('twilio_webhook.reveal_armed', {
        session_id: outcome.sessionId,
      });
      return twiml(outcome.text);
    }

    // Critique, refinement, and charged rounds defer for the same reason a
    // reveal does: a render still outlives the webhook window. Each delivers
    // whatever cuts it produced (possibly none) plus a closing text turn.
    if (
      outcome.kind === 'critique' ||
      outcome.kind === 'refine' ||
      outcome.kind === 'refine-round' ||
      outcome.kind === 'placement'
    ) {
      after(async () => {
        const delivery =
          outcome.kind === 'critique'
            ? await executeCritique(
                outcome.sessionId,
                outcome.phone,
                outcome.message,
                outcome.armedAt
              )
            : outcome.kind === 'placement'
              ? await executePlacement(
                  outcome.sessionId,
                  outcome.phone,
                  { url: outcome.mediaUrl, contentType: outcome.contentType },
                  outcome.message,
                  outcome.armedAt
                )
              : outcome.kind === 'refine-round'
                ? await executeRefineRound(
                    outcome.sessionId,
                    outcome.phone,
                    outcome.uid,
                    outcome.credit,
                    outcome.armedAt
                  )
                : await executeRefine(
                    outcome.sessionId,
                    outcome.phone,
                    outcome.answer,
                    outcome.armedAt
                  );
        if (await isOptedOut(outcome.phone)) return;
        if (delivery.cuts.length === 0 && !delivery.closingText) return;
        for (const cut of delivery.cuts) {
          await sendMms(outcome.phone, cut.caption, [cut.mediaUrl]);
        }
        await sendSms(outcome.phone, delivery.closingText);
      });
      reqLogger.complete(`twilio_webhook.${outcome.kind}_armed`, {
        session_id: outcome.sessionId,
      });
      return twiml(outcome.text);
    }

    reqLogger.complete('twilio_webhook.reply', {});
    return twiml(outcome.text);
  } catch (error) {
    reqLogger.error('twilio_webhook.failed', error as Error, {});
    // A verified inbound that dies downstream (store, engine, provider) must
    // still ANSWER. Twilio sends the texter nothing on a 500 and only retries
    // connection failures, so the 500 was pure silence — the one outcome this
    // channel never allows, and indistinguishable from the number being dead.
    // Unverified callers still get the bare 500: no voice, no information.
    // Compliance traffic stays silent even here — Twilio already answered it,
    // and an apology text is still a reply to a STOP.
    if (verified) return complianceTraffic ? twiml() : twiml(INTERNAL_ERROR_TEXT);
    return NextResponse.json({ error: 'Webhook processing failed.' }, { status: 500 });
  }
}
