// Seam tests for POST /api/v1/design-session/converse: the designSession
// service is mocked at its public entry point; these tests pin the route's
// policy (auth gate, rate limiting, ConverseRequest validation, turn-spend
// recording, 503 unavailable mapping, demo mode) and the response envelope.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextResponse } from 'next/server';
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
} = vi.hoisted(() => ({
  converseMock: vi.fn(),
  recordConversationTurnSpendMock: vi.fn(),
  recordSpendMock: vi.fn(),
  checkBudgetMock: vi.fn(),
  rateLimitMock: vi.fn(),
  rateLimitResponseMock: vi.fn(),
  verifyApiAuthMock: vi.fn(),
}));

vi.mock('@/services/designSession', () => ({
  converse: converseMock,
  claimSessionOwnership: vi.fn(),
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
    // Rate policy: the cheap 'default' bucket, not 'generation'.
    expect(rateLimitMock).toHaveBeenCalledWith(expect.anything(), 'default');
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

  it('returns the auth failure untouched and never reaches the service', async () => {
    const denied = NextResponse.json({ error: 'Authorization header required' }, { status: 401 });
    verifyApiAuthMock.mockResolvedValueOnce({ error: denied });

    const res = await POST(makeRequest(URL, {}));

    expect(res.status).toBe(401);
    expect(converseMock).not.toHaveBeenCalled();
  });

  // Setup runs inside the try, so a throwing dependency lands on the shared
  // structured envelope instead of escaping as an unstructured Next.js 500.
  it('returns the structured envelope when auth setup throws', async () => {
    verifyApiAuthMock.mockRejectedValueOnce(new Error('Firebase admin not configured'));

    const res = await POST(makeRequest(URL, {}));

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
});
