import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

const { verifyApiAuthMock, verifyFirebaseTokenMock, createCheckoutSessionMock, getBalanceMock } = vi.hoisted(() => ({
  getBalanceMock: vi.fn(),
  verifyApiAuthMock: vi.fn(),
  verifyFirebaseTokenMock: vi.fn(),
  createCheckoutSessionMock: vi.fn(),
}));

vi.mock('@/lib/api-auth', () => ({ verifyApiAuth: verifyApiAuthMock }));
vi.mock('@/lib/auth-dal', () => ({ verifyFirebaseToken: verifyFirebaseTokenMock }));
vi.mock('@/lib/generation-credits', () => ({
  CREDIT_PACK_GENERATIONS: 25,
  getGenerationCreditBalance: getBalanceMock,
}));
vi.mock('@/lib/stripe', () => ({
  stripe: { checkout: { sessions: { create: createCheckoutSessionMock } } },
  stripeConfigured: true,
  STRIPE_NOT_CONFIGURED: { error: 'Stripe not configured.' },
}));

import { GET, POST } from './route';

function makeRequest() {
  return new NextRequest('https://tatttester.com/api/v1/billing/credits', {
    method: 'POST',
    headers: { Authorization: 'Bearer test-token', Origin: 'https://tatttester.com' },
  });
}

describe('POST /api/v1/billing/credits', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.STRIPE_PRICE_CONSUMER_CREDITS = 'price_credit_pack';
    verifyApiAuthMock.mockResolvedValue(null);
    verifyFirebaseTokenMock.mockResolvedValue({ uid: 'uid_customer', email: 'customer@example.com' });
    createCheckoutSessionMock.mockResolvedValue({ url: 'https://checkout.stripe.com/c/pay/cs_123' });
  });

  it('creates one fixed-price, one-time checkout for the authenticated customer', async () => {
    const response = await POST(makeRequest());

    expect(response.status).toBe(200);
    expect(createCheckoutSessionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: 'payment',
        line_items: [{ price: 'price_credit_pack', quantity: 1 }],
        customer_email: 'customer@example.com',
        metadata: {
          kind: 'consumer_generation_credits',
          uid: 'uid_customer',
          credits: '25',
        },
      })
    );
  });

  it('does not trust a browser-supplied price or user id', async () => {
    const request = new NextRequest('https://tatttester.com/api/v1/billing/credits', {
      method: 'POST',
      headers: { Authorization: 'Bearer test-token', 'Content-Type': 'application/json' },
      body: JSON.stringify({ priceId: 'price_free', uid: 'victim_uid' }),
    });

    await POST(request);

    expect(createCheckoutSessionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        line_items: [{ price: 'price_credit_pack', quantity: 1 }],
        metadata: expect.objectContaining({ uid: 'uid_customer' }),
      })
    );
  });

  it('requires a real Firebase identity after the API auth gate', async () => {
    verifyFirebaseTokenMock.mockResolvedValue(null);

    const response = await POST(makeRequest());

    expect(response.status).toBe(401);
    expect(createCheckoutSessionMock).not.toHaveBeenCalled();
  });

  it('does not start checkout until the Stripe Price is configured', async () => {
    delete process.env.STRIPE_PRICE_CONSUMER_CREDITS;

    const response = await POST(makeRequest());

    expect(response.status).toBe(503);
    expect(createCheckoutSessionMock).not.toHaveBeenCalled();
  });

  it('returns the existing auth response untouched', async () => {
    verifyApiAuthMock.mockResolvedValue(NextResponse.json({ error: 'nope' }, { status: 401 }));

    const response = await POST(makeRequest());

    expect(response.status).toBe(401);
    expect(verifyFirebaseTokenMock).not.toHaveBeenCalled();
  });
});

describe('GET /api/v1/billing/credits', () => {
  function makeGet() {
    return new NextRequest('https://tatttester.com/api/v1/billing/credits?uid=victim_uid', {
      method: 'GET',
      headers: { Authorization: 'Bearer test-token' },
    });
  }

  beforeEach(() => {
    vi.clearAllMocks();
    verifyApiAuthMock.mockResolvedValue(null);
    verifyFirebaseTokenMock.mockResolvedValue({ uid: 'uid_customer', email: 'customer@example.com' });
    getBalanceMock.mockResolvedValue({ freeRemaining: 12, paidRemaining: 6 });
  });

  it('returns the verified caller\'s balance, never a query-string uid', async () => {
    const response = await GET(makeGet());

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ freeRemaining: 12, paidRemaining: 6 });
    expect(getBalanceMock).toHaveBeenCalledWith('uid_customer');
    expect(response.headers.get('Cache-Control')).toContain('no-store');
  });

  it('starts no checkout and touches nothing else', async () => {
    await GET(makeGet());
    expect(createCheckoutSessionMock).not.toHaveBeenCalled();
  });

  it('requires auth', async () => {
    verifyApiAuthMock.mockResolvedValue(NextResponse.json({ error: 'nope' }, { status: 401 }));
    const response = await GET(makeGet());
    expect(response.status).toBe(401);
    expect(getBalanceMock).not.toHaveBeenCalled();
  });

  it('requires a real Firebase identity', async () => {
    verifyFirebaseTokenMock.mockResolvedValue(null);
    const response = await GET(makeGet());
    expect(response.status).toBe(401);
    expect(getBalanceMock).not.toHaveBeenCalled();
  });

  it('answers 503 rather than a made-up number when the ledger is unreadable', async () => {
    getBalanceMock.mockRejectedValue(new Error('firestore down'));
    const response = await GET(makeGet());
    expect(response.status).toBe(503);
  });
});
