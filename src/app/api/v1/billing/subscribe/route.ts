/**
 * SaaS Billing — start an artist subscription to TatT ("run your business" plan).
 *
 * This is money flow #2: the PLATFORM charges the ARTIST directly (not a
 * Connect/marketplace payment). Uses a subscription-mode Checkout Session with
 * Stripe Tax enabled. The price is a recurring Price created in the Stripe
 * dashboard and referenced by STRIPE_PRICE_ARTIST_SUB (or passed as priceId).
 */
import { NextRequest, NextResponse } from 'next/server';
import { verifyApiAuth } from '@/lib/api-auth';
import { verifyFirebaseToken } from '@/lib/auth-dal';
import { stripe, stripeConfigured, STRIPE_NOT_CONFIGURED } from '@/lib/stripe';
import { getArtistStripe, getArtistByClaimedUid } from '@/lib/artist-stripe';

export const runtime = 'nodejs';

function getBaseUrl(req: NextRequest): string {
  const fromEnv = process.env.NEXT_PUBLIC_APP_URL;
  if (fromEnv && fromEnv.trim().length > 0) return fromEnv.replace(/\/$/, '');
  const origin = req.headers.get('origin');
  if (origin) return origin.replace(/\/$/, '');
  return 'http://localhost:3000';
}

export async function POST(req: NextRequest) {
  const authError = await verifyApiAuth(req);
  if (authError) return authError;

  if (!stripeConfigured) {
    return NextResponse.json(STRIPE_NOT_CONFIGURED, { status: 503 });
  }

  let body: { priceId?: string; artistId?: string; email?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 });
  }

  const priceId = body.priceId || process.env.STRIPE_PRICE_ARTIST_SUB;
  if (!priceId) {
    return NextResponse.json(
      { error: 'No subscription price configured. Set STRIPE_PRICE_ARTIST_SUB or pass priceId.' },
      { status: 400 }
    );
  }

  // Which Artist node does this subscription belong to? The resulting
  // subscription's metadata.tattArtistId is what the webhook later uses to
  // write stripeCustomerId/subscriptionStatus onto that Artist node, so it
  // must be a GRAPH artist id (never a Firebase uid — issue #97: sending the
  // uid made setArtistSubscription's MATCH silently find nothing).
  //
  // Preferred path: no artistId in the body — derive the artist server-side
  // from the VERIFIED caller via claimedByUid, the one uid→artist binding
  // that exists (written by /api/v1/connect/claim). If the caller has no
  // verified claimed profile (or no token at all), fall back to a bare
  // price-only checkout with empty metadata, as before.
  //
  // Legacy path: an explicit body.artistId is still accepted, but only when
  // the verified caller actually claimed that profile.
  let tattArtistId = '';
  if (body.artistId) {
    const user = await verifyFirebaseToken(req);
    if (!user) {
      return NextResponse.json({ error: 'Authentication required', code: 'AUTH_REQUIRED' }, { status: 401 });
    }
    const artist = await getArtistStripe(body.artistId);
    if (!artist) {
      return NextResponse.json({ error: 'Artist not found.' }, { status: 404 });
    }
    if (artist.claimedByUid !== user.uid) {
      return NextResponse.json(
        { error: 'This profile has not been claimed by your account.', code: 'NOT_OWNER' },
        { status: 403 }
      );
    }
    if (!artist.claimVerified) {
      return NextResponse.json(
        { error: 'Identity review must finish before managing this profile.', code: 'CLAIM_NOT_VERIFIED' },
        { status: 403 },
      );
    }
    tattArtistId = artist.id;
  } else {
    const user = await verifyFirebaseToken(req);
    if (user) {
      try {
        const artist = await getArtistByClaimedUid(user.uid);
        if (artist) tattArtistId = artist.id;
      } catch (error) {
        // Proceeding with empty metadata here would recreate the silent
        // no-op this route exists to fix: checkout succeeds, but the webhook
        // could never key the subscription back to the artist. Fail loudly.
        console.error('[Billing] subscribe: claimed-artist lookup failed:', error);
        return NextResponse.json(
          { error: 'Could not resolve your artist profile. Try again shortly.' },
          { status: 502 }
        );
      }
    }
  }

  const baseUrl = getBaseUrl(req);

  try {
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      line_items: [{ price: priceId, quantity: 1 }],
      customer_email: body.email,
      automatic_tax: { enabled: true },
      // Collect the address Stripe Tax needs to determine the artist's jurisdiction.
      billing_address_collection: 'required',
      success_url: `${baseUrl}/dashboard?subscribed=1&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${baseUrl}/pricing`,
      subscription_data: {
        metadata: { tattArtistId },
      },
      metadata: { tattArtistId, kind: 'artist_subscription' },
    });

    if (!session.url) {
      return NextResponse.json({ error: 'Stripe did not return a checkout URL.' }, { status: 502 });
    }
    return NextResponse.json({ sessionUrl: session.url });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to start subscription.';
    console.error('[Billing] subscribe failed:', message);
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
