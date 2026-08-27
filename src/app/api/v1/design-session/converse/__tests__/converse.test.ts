// Seam tests for POST /api/v1/design-session/converse: the designSession
// service is mocked at its public entry point; these tests pin the route's
// policy (optional auth, rate limiting, the ownership guard, ConverseRequest
// validation, turn-spend recording, 503 unavailable mapping, demo mode) and
// the response envelope.
//
// The route is deliberately open to signed-out visitors, so most requests
// here carry NO Authorization header — that is the anonymous path, and it is
// the one real users hit first. Use makeAuthedRequest for the signed-in one.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';
import { makeRequest } from '../../__tests__/helpers';
import type { ConverseResponse } from '@/services/designConversation/types';

const {
  converseMock,
  recordConversationTurnSpendMock,
  recordSpendMock,
  checkBudgetMock,
  rateLimitMock,
  rateLimitResponseMock,
  verifyApiAuthMock,
  claimSessionOwnershipMock,
} = vi.hoisted(() => ({
  converseMock: vi.fn(),
  recordConversationTurnSpendMock: vi.fn(),
  recordSpendMock: vi.fn(),
  checkBudgetMock: vi.fn(),
  rateLimitMock: vi.fn(),
  rateLimitResponseMock: vi.fn(),
  verifyApiAuthMock: vi.fn(),
  claimSessionOwnershipMock: vi.fn(),
}));

vi.mock('@/services/designSession', () => ({
  converse: converseMock,
  claimSessionOwnership: claimSessionOwnershipMock,
  confirmProposal: vi.fn(),
  startSession: vi.fn(),
  recordPick: vi.fn(),
  refine: vi.fn(),
  getSession: vi.fn(),
}));

vi.mock('@/lib/api-auth', () => ({
  verifyApiAuthWithUser: verifyApiAuthMock,
}));

vi.mock('@/lib/rate-limit', () => ({
  rateLimit: rateLimitMock,
  rateLimitResponse: rateLimitResponseMock,
}));

vi.mock('@/lib/budget-tracker', () => ({
  recordConversationTurnSpend: recordConversationTurnSpendMock,
  checkBudget: checkBudgetMock,
  recordSpend: recordSpendMock,
  VERTEX_IMAGEN_COST_CENTS: 4,
}));

vi.mock('@/lib/logger', () => ({
  createRequestLogger: () => ({
    start: vi.fn(),
    complete: vi.fn(),
    error: vi.fn(),
  }),
}));

import { POST } from '../route';

const URL = 'http://localhost/api/v1/design-session/converse';

/** The signed-in path: same body, plus the Bearer header. */
function makeAuthedRequest(url: string, body?: Record<string, unknown>) {
  return new NextRequest(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token-1' },
    body: JSON.stringify(body ?? {}),
  });
}

/** What the route passes to the ownership guard for a signed-out caller. */
const ANONYMOUS_CALLER = 'anonymous:web';

function converseResponse(overrides: Partial<ConverseResponse> = {}): ConverseResponse {
  return {
    sessionId: 'sess-1',
    reply: 'Where on your body are you thinking?',
    stage: 'chatting',
    turn: 0,
    ...overrides,
  };
}

describe('POST /api/v1/design-session/converse route adapter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    verifyApiAuthMock.mockResolvedValue({ error: null, user: { uid: 'uid-1' } });
    claimSessionOwnershipMock.mockResolvedValue(undefined);
    rateLimitMock.mockResolvedValue({ allowed: true });
    recordConversationTurnSpendMock.mockResolvedValue(undefined);
    delete process.env.NEXT_PUBLIC_DEMO_MODE;
  });

  afterEach(() => {
    delete process.env.NEXT_PUBLIC_DEMO_MODE;
  });

  it('opens a conversation with no sessionId and returns the ConverseResponse envelope', async () => {
    converseMock.mockResolvedValueOnce(converseResponse());

    const res = await POST(makeRequest(URL, {}));

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toEqual({
      sessionId: 'sess-1',
      reply: 'Where on your body are you thinking?',
      stage: 'chatting',
      turn: 0,
    });
    expect(converseMock).toHaveBeenCalledWith({});
    // No Authorization header on this request: the front door is open, and
    // a signed-out visitor rides the tight per-IP anonymous bucket — never
    // 'generation', and never the looser per-uid 'default'.
    expect(verifyApiAuthMock).not.toHaveBeenCalled();
    expect(rateLimitMock).toHaveBeenCalledWith(expect.anything(), 'converse-anon');
    // Every real turn is recorded as its own budget line item.
    expect(recordConversationTurnSpendMock).toHaveBeenCalledTimes(1);
  });

  it('trims and forwards a continuing turn, surfacing proposal playback', async () => {
    converseMock.mockResolvedValueOnce(
      converseResponse({ stage: 'proposal', playback: 'a sparrow on your forearm', turn: 6 })
    );

    const res = await POST(makeRequest(URL, { sessionId: ' sess-1 ', message: '  a sparrow  ' }));

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.stage).toBe('proposal');
    expect(json.playback).toBe('a sparrow on your forearm');
    expect(converseMock).toHaveBeenCalledWith({ sessionId: 'sess-1', message: 'a sparrow' });
  });

  it('rejects a continuing call without a message with 400 before the service', async () => {
    const res = await POST(makeRequest(URL, { sessionId: 'sess-1' }));

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.code).toBe('INVALID_MESSAGE');
    expect(converseMock).not.toHaveBeenCalled();
    expect(recordConversationTurnSpendMock).not.toHaveBeenCalled();
  });

  it('rejects a blank message and a non-string sessionId with 400', async () => {
    const blank = await POST(makeRequest(URL, { sessionId: 'sess-1', message: '   ' }));
    expect(blank.status).toBe(400);
    expect((await blank.json()).code).toBe('INVALID_MESSAGE');

    const badId = await POST(makeRequest(URL, { sessionId: 42, message: 'hello' }));
    expect(badId.status).toBe(400);
    expect((await badId.json()).code).toBe('INVALID_SESSION_ID');

    expect(converseMock).not.toHaveBeenCalled();
  });

  // A caller who PRESENTED a token and failed verification is a bug or an
  // attack, not an anonymous visitor. Silently downgrading them to anonymous
  // would hide both, so a bad token is still a 401.
  it('returns the auth failure untouched and never reaches the service', async () => {
    const denied = NextResponse.json({ error: 'Authorization header required' }, { status: 401 });
    verifyApiAuthMock.mockResolvedValueOnce({ error: denied });

    const res = await POST(makeAuthedRequest(URL, {}));

    expect(res.status).toBe(401);
    expect(converseMock).not.toHaveBeenCalled();
  });

  // Setup runs inside the try, so a throwing dependency lands on the shared
  // structured envelope instead of escaping as an unstructured Next.js 500.
  it('returns the structured envelope when auth setup throws', async () => {
    verifyApiAuthMock.mockRejectedValueOnce(new Error('Firebase admin not configured'));

    const res = await POST(makeAuthedRequest(URL, {}));

    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ code: 'DESIGN_SESSION_FAILED', retryable: false });
    expect(converseMock).not.toHaveBeenCalled();
  });

  it('returns the rate-limit response when the limiter denies', async () => {
    rateLimitMock.mockResolvedValueOnce({ allowed: false, limit: 60, remaining: 0, reset: 1 });
    rateLimitResponseMock.mockReturnValueOnce(
      NextResponse.json({ error: 'Too Many Requests' }, { status: 429 })
    );

    const res = await POST(makeRequest(URL, {}));

    expect(res.status).toBe(429);
    expect(converseMock).not.toHaveBeenCalled();
  });

  it('maps CONVERSATION_UNAVAILABLE to a 503 with the scripted-intake fallback hint', async () => {
    converseMock.mockRejectedValueOnce(
      Object.assign(new Error('every provider down'), {
        name: 'DesignSessionError',
        code: 'CONVERSATION_UNAVAILABLE',
        status: 503,
      })
    );

    const res = await POST(makeRequest(URL, {}));

    expect(res.status).toBe(503);
    const json = await res.json();
    expect(json.code).toBe('CONVERSATION_UNAVAILABLE');
    expect(json.fallback).toBe('scripted-intake');
    expect(json.error).toMatch(/scripted intake/i);
    // A failed turn is never charged.
    expect(recordConversationTurnSpendMock).not.toHaveBeenCalled();
  });

  it('maps domain errors through the shared mapper (404 / 409)', async () => {
    converseMock.mockRejectedValueOnce(
      Object.assign(new Error('missing'), { code: 'SESSION_NOT_FOUND', status: 404 })
    );
    const notFound = await POST(makeRequest(URL, { sessionId: 'nope', message: 'hi' }));
    expect(notFound.status).toBe(404);

    converseMock.mockRejectedValueOnce(
      Object.assign(new Error('already revealed'), { code: 'INVALID_PHASE', status: 409 })
    );
    const conflict = await POST(makeRequest(URL, { sessionId: 'sess-1', message: 'hi' }));
    expect(conflict.status).toBe(409);
  });

  it('demo mode delegates to the real service and skips rate policy and spend', async () => {
    process.env.NEXT_PUBLIC_DEMO_MODE = 'true';
    converseMock.mockResolvedValueOnce(converseResponse());

    const res = await POST(makeRequest(URL, {}));

    expect(res.status).toBe(200);
    expect(converseMock).toHaveBeenCalledWith({});
    // The engine's demo script is free: no rate bucket, no line item.
    expect(rateLimitMock).not.toHaveBeenCalled();
    expect(recordConversationTurnSpendMock).not.toHaveBeenCalled();
  });

  it('demo mode still validates input with 400 before calling the service', async () => {
    process.env.NEXT_PUBLIC_DEMO_MODE = 'true';

    const res = await POST(makeRequest(URL, { sessionId: 'sess-1' }));

    expect(res.status).toBe(400);
    expect(converseMock).not.toHaveBeenCalled();
  });
  // ---------------------------------------------------------------------
  // The open front door. Requiring a Bearer token here put a sign-in wall
  // in front of the product's primary CTA: /design opened a "Welcome Back"
  // modal before the visitor typed a character, and the first chip tap
  // failed client-side without a request ever leaving the browser. ADR-0041
  // gates GENERATION; a conversation turn is not a generation, and #357
  // already made sessions start unowned for exactly this reason.
  // ---------------------------------------------------------------------

  it('serves a signed-out visitor a full turn, with no token and no auth call', async () => {
    converseMock.mockResolvedValueOnce(converseResponse({ turn: 3, reply: 'Bold or fine?' }));

    const res = await POST(makeRequest(URL, { sessionId: 'sess-1', message: 'a sparrow' }));

    expect(res.status).toBe(200);
    expect((await res.json()).reply).toBe('Bold or fine?');
    expect(verifyApiAuthMock).not.toHaveBeenCalled();
    expect(converseMock).toHaveBeenCalledWith({ sessionId: 'sess-1', message: 'a sparrow' });
    // The turn still costs model money, so it is still a budget line item.
    expect(recordConversationTurnSpendMock).toHaveBeenCalledTimes(1);
  });

  it('keys a signed-in caller on their uid and the ordinary allowance', async () => {
    converseMock.mockResolvedValueOnce(converseResponse());

    const res = await POST(makeAuthedRequest(URL, {}));

    expect(res.status).toBe(200);
    // Per-uid: a signed-in customer is never throttled by a noisy shared IP.
    expect(rateLimitMock).toHaveBeenCalledWith(expect.anything(), 'default', 'uid-1');
  });

  // An open door is not an open bar.
  it('throttles a signed-out visitor on the anonymous tier', async () => {
    rateLimitMock.mockResolvedValueOnce({ allowed: false, limit: 40, remaining: 0, reset: 1 });
    rateLimitResponseMock.mockReturnValueOnce(
      NextResponse.json({ error: 'Too Many Requests' }, { status: 429 })
    );

    const res = await POST(makeRequest(URL, {}));

    expect(res.status).toBe(429);
    expect(rateLimitMock).toHaveBeenCalledWith(expect.anything(), 'converse-anon');
    expect(converseMock).not.toHaveBeenCalled();
  });

  // Opening the route to strangers must not open OWNED sessions to them.
  it('checks a signed-out continuing turn against the anonymous sentinel', async () => {
    converseMock.mockResolvedValueOnce(converseResponse());

    await POST(makeRequest(URL, { sessionId: ' sess-1 ', message: 'hi' }));

    expect(claimSessionOwnershipMock).toHaveBeenCalledWith('sess-1', ANONYMOUS_CALLER, {
      stamp: false,
    });
    // The sentinel can never equal a real Firebase uid, so it stamps nothing.
    expect(ANONYMOUS_CALLER).toContain(':');
  });

  it('checks a signed-in continuing turn against the real uid', async () => {
    converseMock.mockResolvedValueOnce(converseResponse());

    await POST(makeAuthedRequest(URL, { sessionId: 'sess-1', message: 'hi' }));

    expect(claimSessionOwnershipMock).toHaveBeenCalledWith('sess-1', 'uid-1', { stamp: false });
  });

  it('refuses an anonymous caller reaching a session that already has an owner', async () => {
    claimSessionOwnershipMock.mockRejectedValueOnce(
      Object.assign(new Error("No design session 'sess-1'."), {
        code: 'SESSION_NOT_FOUND',
        status: 404,
      })
    );

    const res = await POST(makeRequest(URL, { sessionId: 'sess-1', message: 'hi' }));

    expect(res.status).toBe(404);
    expect(converseMock).not.toHaveBeenCalled();
    expect(recordConversationTurnSpendMock).not.toHaveBeenCalled();
  });

  // The opening call has no session to own yet.
  it('never checks ownership on an opening call', async () => {
    converseMock.mockResolvedValueOnce(converseResponse());

    await POST(makeRequest(URL, {}));

    expect(claimSessionOwnershipMock).not.toHaveBeenCalled();
  });
});
