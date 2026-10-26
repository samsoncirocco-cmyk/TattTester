/**
 * /api/webhooks/twilio — flag gating, fail-closed config, signature
 * validation, opt-out silence, per-phone rate limiting, TwiML rendering,
 * and the deferred MMS reveal delivery. No live Twilio anywhere: the lib
 * and service are mocked; after() is captured and invoked by hand.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { POST } from './route';
import {
  sketchbotSmsEnabled,
  twilioConfigured,
  validateTwilioSignature,
  sendSms,
  sendMms,
} from '@/lib/twilio';
import { handleInbound, executeReveal, recordOptOut, isOptedOut } from '@/services/sketchbotSms';
import { rateLimit } from '@/lib/rate-limit';

// Capture after() callbacks so the deferred reveal delivery can be driven
// synchronously in tests. Everything else in next/server stays real.
const afterCallbacks: Array<() => Promise<void>> = [];
vi.mock('next/server', async (importOriginal) => {
  const actual = await importOriginal<typeof import('next/server')>();
  return {
    ...actual,
    after: (fn: () => Promise<void>) => {
      afterCallbacks.push(fn);
    },
  };
});

vi.mock('@/lib/twilio', () => ({
  sketchbotSmsEnabled: vi.fn(() => true),
  twilioConfigured: vi.fn(() => true),
  validateTwilioSignature: vi.fn(() => true),
  sendSms: vi.fn(async () => ({ ok: true, sid: 'SM1' })),
  sendMms: vi.fn(async () => ({ ok: true, sid: 'MM1' })),
  TWILIO_NOT_CONFIGURED: {
    error: 'SMS is not configured.',
    code: 'TWILIO_NOT_CONFIGURED',
  },
}));

vi.mock('@/services/sketchbotSms', async () => ({
  // The real field parser (leaf module, no service deps): the media-flow
  // test below exercises the route's actual NumMedia wiring.
  parseInboundMedia: (
    await vi.importActual<typeof import('@/services/sketchbotSms/internal/media')>(
      '@/services/sketchbotSms/internal/media'
    )
  ).parseInboundMedia,
  handleInbound: vi.fn(async () => ({
    kind: 'reply',
    text: 'Where would it go?',
  })),
  executeReveal: vi.fn(async () => ({
    cuts: [
      { caption: 'Cut 1 of 2', mediaUrl: 'https://img/1.png' },
      { caption: 'Cut 2 of 2', mediaUrl: 'https://img/2.png' },
    ],
    closingText: 'See them big: https://tatttester.com/share/abc',
  })),
  recordOptOut: vi.fn(async () => {}),
  isOptedOut: vi.fn(async () => false),
  INTERNAL_ERROR_TEXT: 'Something went sideways on my end.',
}));

vi.mock('@/lib/rate-limit', () => ({
  rateLimit: vi.fn(async () => ({
    allowed: true,
    limit: 30,
    remaining: 29,
    reset: 0,
  })),
}));

const PHONE = '+15551234567';

function webhookRequest(
  params: Record<string, string>,
  headers: Record<string, string> = {}
): NextRequest {
  const body = new URLSearchParams(params).toString();
  return new NextRequest('https://tatttester.com/api/webhooks/twilio', {
    method: 'POST',
    body,
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      'x-twilio-signature': 'sig',
      ...headers,
    },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  afterCallbacks.length = 0;
  vi.mocked(sketchbotSmsEnabled).mockReturnValue(true);
  vi.mocked(twilioConfigured).mockReturnValue(true);
  vi.mocked(validateTwilioSignature).mockReturnValue(true);
  vi.mocked(isOptedOut).mockResolvedValue(false);
  vi.mocked(rateLimit).mockResolvedValue({
    allowed: true,
    limit: 30,
    remaining: 29,
    reset: 0,
  });
  vi.stubEnv('SKETCHBOT_SMS_ALLOW_UNSIGNED', '');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('gating', () => {
  it('404s while the channel flag is off — the endpoint does not exist', async () => {
    vi.mocked(sketchbotSmsEnabled).mockReturnValue(false);
    const res = await POST(webhookRequest({ From: PHONE, Body: 'hi' }));
    expect(res.status).toBe(404);
    expect(handleInbound).not.toHaveBeenCalled();
  });

  it('fails closed with 503 when Twilio is unconfigured', async () => {
    vi.mocked(twilioConfigured).mockReturnValue(false);
    const res = await POST(webhookRequest({ From: PHONE, Body: 'hi' }));
    expect(res.status).toBe(503);
    expect(handleInbound).not.toHaveBeenCalled();
  });

  it('403s a missing or invalid signature', async () => {
    vi.mocked(validateTwilioSignature).mockReturnValue(false);
    const res = await POST(webhookRequest({ From: PHONE, Body: 'hi' }));
    expect(res.status).toBe(403);
    expect(handleInbound).not.toHaveBeenCalled();
  });

  it('validates against TWILIO_WEBHOOK_URL verbatim, ignoring request headers', async () => {
    vi.stubEnv('TWILIO_WEBHOOK_URL', 'https://tatttester.com/api/webhooks/twilio');
    // Vercel-style: internal deployment host on the request, junk forwards.
    const req = new NextRequest('https://tatt-app-abc123.vercel.app/api/webhooks/twilio', {
      method: 'POST',
      body: new URLSearchParams({
        From: PHONE,
        Body: 'hello there',
      }).toString(),
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'x-twilio-signature': 'sig',
        'x-forwarded-proto': 'https,https',
        'x-forwarded-host': 'internal.proxy.example',
      },
    });
    await POST(req);
    expect(validateTwilioSignature).toHaveBeenCalledWith(
      'sig',
      'https://tatttester.com/api/webhooks/twilio',
      { From: PHONE, Body: 'hello there' }
    );
  });

  it('derives the validation URL from the public base when the env is unset', async () => {
    vi.stubEnv('TWILIO_WEBHOOK_URL', '');
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://tatttester.com/');
    const req = new NextRequest('https://tatt-app-abc123.vercel.app/api/webhooks/twilio', {
      method: 'POST',
      body: new URLSearchParams({ From: PHONE, Body: 'hi' }).toString(),
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'x-twilio-signature': 'sig',
      },
    });
    await POST(req);
    expect(validateTwilioSignature).toHaveBeenCalledWith(
      'sig',
      'https://tatttester.com/api/webhooks/twilio',
      { From: PHONE, Body: 'hi' }
    );
  });

  it('400s when From is missing', async () => {
    const res = await POST(webhookRequest({ Body: 'hi' }));
    expect(res.status).toBe(400);
  });
});

describe('opt-out compliance', () => {
  it('records STOP and never replies', async () => {
    const res = await POST(webhookRequest({ From: PHONE, Body: 'STOP', OptOutType: 'STOP' }));
    expect(res.status).toBe(200);
    expect(await res.text()).not.toContain('<Message>');
    expect(recordOptOut).toHaveBeenCalledWith(PHONE, 'STOP');
    expect(handleInbound).not.toHaveBeenCalled();
  });

  it('honors STOP keywords even without OptOutType', async () => {
    const res = await POST(webhookRequest({ From: PHONE, Body: 'unsubscribe' }));
    expect(await res.text()).not.toContain('<Message>');
    expect(recordOptOut).toHaveBeenCalledWith(PHONE, 'STOP');
  });

  it('stays quiet on HELP — Twilio already answered it', async () => {
    const res = await POST(webhookRequest({ From: PHONE, Body: 'HELP' }));
    expect(await res.text()).not.toContain('<Message>');
    expect(handleInbound).not.toHaveBeenCalled();
  });

  it('re-opens on START from an opted-out number, still without replying', async () => {
    vi.mocked(isOptedOut).mockResolvedValue(true);
    const res = await POST(webhookRequest({ From: PHONE, Body: 'START' }));
    expect(await res.text()).not.toContain('<Message>');
    expect(recordOptOut).toHaveBeenCalledWith(PHONE, 'START');
  });
});

describe('rate limiting', () => {
  it('is keyed on the phone number, not the request IP', async () => {
    await POST(webhookRequest({ From: PHONE, Body: 'hi' }));
    expect(rateLimit).toHaveBeenCalledWith(expect.anything(), 'sms-inbound', `sms:${PHONE}`);
  });

  it('answers a flood with silence — replies cost money', async () => {
    vi.mocked(rateLimit).mockResolvedValue({
      allowed: false,
      limit: 30,
      remaining: 0,
      reset: 0,
    });
    const res = await POST(webhookRequest({ From: PHONE, Body: 'hi' }));
    expect(res.status).toBe(200);
    expect(await res.text()).not.toContain('<Message>');
    expect(handleInbound).not.toHaveBeenCalled();
  });
});

describe('conversation round trip', () => {
  it('returns the bot turn as TwiML', async () => {
    const res = await POST(webhookRequest({ From: PHONE, Body: 'a snake tattoo' }));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/xml');
    expect(await res.text()).toContain('<Message>Where would it go?</Message>');
    expect(handleInbound).toHaveBeenCalledWith({
      phone: PHONE,
      body: 'a snake tattoo',
    });
  });

  it('XML-escapes the reply', async () => {
    vi.mocked(handleInbound).mockResolvedValueOnce({
      kind: 'reply',
      text: 'Bold & fine <both> work',
    });
    const res = await POST(webhookRequest({ From: PHONE, Body: 'hm' }));
    expect(await res.text()).toContain('Bold &amp; fine &lt;both&gt; work');
  });

  it('says nothing on a silent outcome', async () => {
    vi.mocked(handleInbound).mockResolvedValueOnce({ kind: 'silent' });
    const res = await POST(webhookRequest({ From: PHONE, Body: 'x' }));
    expect(await res.text()).not.toContain('<Message>');
  });

  it('passes MMS media fields through to the adapter (TAT-50)', async () => {
    await POST(
      webhookRequest({
        From: PHONE,
        Body: 'like this',
        NumMedia: '1',
        MediaUrl0: 'https://api.twilio.com/m/0',
        MediaContentType0: 'image/jpeg',
      })
    );
    expect(handleInbound).toHaveBeenCalledWith({
      phone: PHONE,
      body: 'like this',
      media: [{ url: 'https://api.twilio.com/m/0', contentType: 'image/jpeg' }],
    });
  });
});

describe('reveal delivery', () => {
  beforeEach(() => {
    vi.mocked(handleInbound).mockResolvedValueOnce({
      kind: 'reveal',
      text: 'On it — four takes coming.',
      sessionId: 's1',
      phone: PHONE,
      armedAt: '2026-08-04T00:00:00.000Z',
    });
  });

  it('acks immediately and defers generation past the response', async () => {
    const res = await POST(webhookRequest({ From: PHONE, Body: 'yes' }));
    expect(await res.text()).toContain('On it — four takes coming.');
    // Generation has NOT run yet — it lives in after().
    expect(executeReveal).not.toHaveBeenCalled();
    expect(afterCallbacks).toHaveLength(1);
  });

  it('delivers each cut as its own MMS, then the closing link', async () => {
    await POST(webhookRequest({ From: PHONE, Body: 'yes' }));
    await afterCallbacks[0]();

    expect(executeReveal).toHaveBeenCalledWith(
      's1',
      PHONE,
      '2026-08-04T00:00:00.000Z',
      undefined,
      undefined
    );
    expect(sendMms).toHaveBeenCalledTimes(2);
    expect(sendMms).toHaveBeenNthCalledWith(1, PHONE, 'Cut 1 of 2', ['https://img/1.png']);
    expect(sendMms).toHaveBeenNthCalledWith(2, PHONE, 'Cut 2 of 2', ['https://img/2.png']);
    expect(sendSms).toHaveBeenCalledWith(PHONE, 'See them big: https://tatttester.com/share/abc');
  });

  it('never messages a number that opted out between ack and delivery', async () => {
    await POST(webhookRequest({ From: PHONE, Body: 'yes' }));
    vi.mocked(isOptedOut).mockResolvedValue(true);
    await afterCallbacks[0]();

    expect(sendMms).not.toHaveBeenCalled();
    expect(sendSms).not.toHaveBeenCalled();
  });
});

describe('unexpected failures answer instead of going silent', () => {
  it('replies in voice with TwiML when a verified inbound throws downstream', async () => {
    // The store/engine dying is the realistic case: before this, it returned
    // a 500 and Twilio sent the texter NOTHING — the number looked dead.
    vi.mocked(handleInbound).mockRejectedValue(new Error('firestore unavailable'));

    const res = await POST(webhookRequest({ From: PHONE, Body: 'hi' }));

    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('text/xml');
    const body = await res.text();
    expect(body).toContain('<Message>');
    expect(body).toContain('Something went sideways on my end.');
  });

  it('stays silent when recording opt-out state throws — never replies to a STOP', async () => {
    // The apology is still a reply, and replying to compliance traffic is
    // the one thing this route must never do.
    vi.mocked(recordOptOut).mockRejectedValue(new Error('firestore unavailable'));

    const res = await POST(webhookRequest({ From: PHONE, Body: 'STOP' }));

    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).not.toContain('<Message>');
    expect(body).not.toContain('Something went sideways');
  });

  it('stays silent when START opt-out lookup fails — never guesses on compliance traffic', async () => {
    vi.mocked(isOptedOut).mockRejectedValue(new Error('firestore unavailable'));

    const res = await POST(webhookRequest({ From: PHONE, Body: 'START' }));

    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).not.toContain('<Message>');
    expect(body).not.toContain('Something went sideways');
    expect(handleInbound).not.toHaveBeenCalled();
  });

  it('still fail-soft replies to a normal YES when the sender is not opted out', async () => {
    vi.mocked(isOptedOut).mockResolvedValue(false);
    vi.mocked(handleInbound).mockRejectedValue(new Error('engine unavailable'));

    const res = await POST(webhookRequest({ From: PHONE, Body: 'yes' }));

    expect(res.status).toBe(200);
    expect(await res.text()).toContain('Something went sideways');
  });

  it('still gives an UNVERIFIED caller a bare 500, never the in-voice copy', async () => {
    // Failure before the signature gate must not hand an unauthenticated
    // caller a TwiML body or any channel voice.
    vi.mocked(validateTwilioSignature).mockImplementation(() => {
      throw new Error('boom');
    });

    const res = await POST(webhookRequest({ From: PHONE, Body: 'hi' }));

    expect(res.status).toBe(500);
    expect(await res.text()).not.toContain('<Message>');
  });
});
