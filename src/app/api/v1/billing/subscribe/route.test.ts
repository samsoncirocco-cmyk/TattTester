// POST /api/v1/billing/subscribe stamped a client-supplied artistId straight
// into the Checkout Session's metadata.tattArtistId with no ownership check.
// The webhook (checkout.session.completed) reads that metadata and writes
// subscriptionStatus: 'active' onto whichever Artist node it names — so any
// signed-in user paying for their own subscription could tag the resulting
// active-subscription status onto an artist profile they never claimed.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const {
  verifyApiAuthMock,
  verifyFirebaseTokenMock,
  getArtistStripeMock,
  getArtistByClaimedUidMock,
  createCheckoutSessionMock,
} = vi.hoisted(() => ({
  verifyApiAuthMock: vi.fn(),
  verifyFirebaseTokenMock: vi.fn(),
  getArtistStripeMock: vi.fn(),
  getArtistByClaimedUidMock: vi.fn(),
  createCheckoutSessionMock: vi.fn(),
}));

vi.mock('@/lib/api-auth', () => ({ verifyApiAuth: verifyApiAuthMock }));
vi.mock('@/lib/auth-dal', () => ({ verifyFirebaseToken: verifyFirebaseTokenMock }));
vi.mock('@/lib/artist-stripe', () => ({
  getArtistStripe: getArtistStripeMock,
  getArtistByClaimedUid: getArtistByClaimedUidMock,
}));
vi.mock('@/lib/stripe', () => ({
  stripe: { checkout: { sessions: { create: createCheckoutSessionMock } } },
  stripeConfigured: true,
  STRIPE_NOT_CONFIGURED: { error: 'Stripe not configured.' },
}));

import { POST } from './route';

function makeRequest(body: Record<string, unknown>) {
  return new NextRequest('http://localhost/api/v1/billing/subscribe', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-token' },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  verifyApiAuthMock.mockResolvedValue(null);
  verifyFirebaseTokenMock.mockResolvedValue({ uid: 'uid_caller', email: 'caller@example.com' });
  getArtistByClaimedUidMock.mockResolvedValue(null);
  createCheckoutSessionMock.mockResolvedValue({ url: 'https://checkout.stripe.com/session/xyz' });
});

describe('POST /api/v1/billing/subscribe — ownership', () => {
  it('refuses to tag a subscription onto an artist the caller has not claimed', async () => {
    getArtistStripeMock.mockResolvedValue({
      id: 'artist_1',
      name: 'Nadia Ink',
      email: null,
      stripeAccountId: null,
      chargesEnabled: false,
      claimedByUid: 'uid_actual_owner',
    });

    const response = await POST(makeRequest({ priceId: 'price_123', artistId: 'artist_1' }));

    expect(response.status).toBe(403);
    expect(createCheckoutSessionMock).not.toHaveBeenCalled();
  });

  it('allows the artist who claimed the profile to start their own subscription', async () => {
    getArtistStripeMock.mockResolvedValue({
      id: 'artist_1',
      name: 'Nadia Ink',
      email: null,
      stripeAccountId: null,
      chargesEnabled: false,
      claimedByUid: 'uid_caller',
      claimVerified: true,
    });

    const response = await POST(makeRequest({ priceId: 'price_123', artistId: 'artist_1' }));

    expect(response.status).toBe(200);
    expect(createCheckoutSessionMock).toHaveBeenCalledWith(
      expect.objectContaining({ metadata: expect.objectContaining({ tattArtistId: 'artist_1' }) })
    );
  });

  it('allows subscribing without naming an artist at all (no ownership to check)', async () => {
    const response = await POST(makeRequest({ priceId: 'price_123' }));

    expect(response.status).toBe(200);
    expect(getArtistStripeMock).not.toHaveBeenCalled();
    expect(createCheckoutSessionMock).toHaveBeenCalled();
  });
});

// #97: the client used to send the Firebase uid AS the artistId, which flowed
// into metadata.tattArtistId and made the webhook's MATCH (a:Artist {id: ...})
// silently write nothing. The route now derives the caller's claimed artist
// (graph id) server-side via claimedByUid, so the stamped metadata is the id
// the webhook can actually persist against.
describe('POST /api/v1/billing/subscribe — server-side artist derivation', () => {
  it('stamps the claimed artist GRAPH id (not the uid) when the body names no artist', async () => {
    getArtistByClaimedUidMock.mockResolvedValue({
      id: 'artist_graph_42',
      name: 'Nadia Ink',
      email: null,
      stripeAccountId: null,
      chargesEnabled: false,
      claimedByUid: 'uid_caller',
      claimVerified: true,
    });

    const response = await POST(makeRequest({ priceId: 'price_123', email: 'caller@example.com' }));

    expect(response.status).toBe(200);
    expect(getArtistByClaimedUidMock).toHaveBeenCalledWith('uid_caller');
    expect(createCheckoutSessionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({ tattArtistId: 'artist_graph_42' }),
        subscription_data: { metadata: { tattArtistId: 'artist_graph_42' } },
      })
    );
  });

  it('falls back to a bare checkout (empty tattArtistId) when the caller has no claimed profile', async () => {
    getArtistByClaimedUidMock.mockResolvedValue(null);

    const response = await POST(makeRequest({ priceId: 'price_123' }));

    expect(response.status).toBe(200);
    expect(createCheckoutSessionMock).toHaveBeenCalledWith(
      expect.objectContaining({ metadata: expect.objectContaining({ tattArtistId: '' }) })
    );
  });

  it('falls back to a bare checkout when there is no verified token at all', async () => {
    verifyFirebaseTokenMock.mockResolvedValue(null);

    const response = await POST(makeRequest({ priceId: 'price_123' }));

    expect(response.status).toBe(200);
    expect(getArtistByClaimedUidMock).not.toHaveBeenCalled();
    expect(createCheckoutSessionMock).toHaveBeenCalledWith(
      expect.objectContaining({ metadata: expect.objectContaining({ tattArtistId: '' }) })
    );
  });

  it('fails loudly (no checkout) when the claimed-artist lookup errors — never a silent no-op', async () => {
    getArtistByClaimedUidMock.mockRejectedValue(new Error('neo4j down'));

    const response = await POST(makeRequest({ priceId: 'price_123' }));

    expect(response.status).toBe(502);
    expect(createCheckoutSessionMock).not.toHaveBeenCalled();
  });
});
