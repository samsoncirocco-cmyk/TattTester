/**
 * GET: the signed-in customer's remaining cuts, for display on /design.
 * POST: start a one-time Checkout session for the $10 / 25-generation credit pack.
 */
import { NextRequest, NextResponse } from 'next/server';
import { verifyApiAuth } from '@/lib/api-auth';
import { verifyFirebaseToken } from '@/lib/auth-dal';
import { stripe, stripeConfigured, STRIPE_NOT_CONFIGURED } from '@/lib/stripe';
import { CREDIT_PACK_GENERATIONS, getGenerationCreditBalance } from '@/lib/generation-credits';

export const runtime = 'nodejs';

function getBaseUrl(req: NextRequest): string {
  const fromEnv = process.env.NEXT_PUBLIC_APP_URL;
  if (fromEnv && fromEnv.trim().length > 0) return fromEnv.replace(/\/$/, '');
  const origin = req.headers.get('origin');
  if (origin) return origin.replace(/\/$/, '');
  return 'http://localhost:3000';
}

/**
 * Read-only balance. Same gate as POST; the uid comes from the verified token,
 * never the request, and nothing is written.
 */
export async function GET(req: NextRequest) {
  const authError = await verifyApiAuth(req);
  if (authError) return authError;

  const user = await verifyFirebaseToken(req);
  if (!user) {
    return NextResponse.json({ error: 'Authentication required', code: 'AUTH_REQUIRED' }, { status: 401 });
  }

  try {
    const balance = await getGenerationCreditBalance(user.uid);
    return NextResponse.json(balance, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (error) {
    console.error('[Billing] credit balance read failed:', error instanceof Error ? error.message : error);
    return NextResponse.json(
      { error: 'Could not read your balance.', code: 'CREDITS_UNAVAILABLE' },
      { status: 503 }
    );
  }
}

export async function POST(req: NextRequest) {
  const authError = await verifyApiAuth(req);
  if (authError) return authError;

  const user = await verifyFirebaseToken(req);
  if (!user) {
    return NextResponse.json({ error: 'Authentication required', code: 'AUTH_REQUIRED' }, { status: 401 });
  }

  if (!stripeConfigured) {
    return NextResponse.json(STRIPE_NOT_CONFIGURED, { status: 503 });
  }

  const priceId = process.env.STRIPE_PRICE_CONSUMER_CREDITS;
  if (!priceId) {
    return NextResponse.json(
      { error: 'Credit pack is not configured yet.', code: 'CREDITS_NOT_CONFIGURED' },
      { status: 503 }
    );
  }

  const baseUrl = getBaseUrl(req);
  try {
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      line_items: [{ price: priceId, quantity: 1 }],
      customer_email: user.email,
      success_url: `${baseUrl}/pricing?credits=success&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${baseUrl}/pricing?credits=cancelled`,
      metadata: {
        kind: 'consumer_generation_credits',
        uid: user.uid,
        credits: String(CREDIT_PACK_GENERATIONS),
      },
    });

    if (!session.url) {
      return NextResponse.json({ error: 'Stripe did not return a checkout URL.' }, { status: 502 });
    }
    return NextResponse.json({ sessionUrl: session.url });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to start credit checkout.';
    console.error('[Billing] credit checkout failed:', message);
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
