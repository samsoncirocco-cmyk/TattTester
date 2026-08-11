import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { clearMemorySessions } from '@/services/designSession/internal/store';
import { POST as conversePost } from '../converse/route';
import { POST as confirmPost } from '../[id]/confirm/route';
import { routeParams } from './helpers';

vi.mock('@/lib/api-auth', () => ({
  verifyApiAuth: vi.fn(async () => null),
  verifyApiAuthWithUser: vi.fn(async () => ({ error: null, user: { uid: 'demo-user' } })),
}));

vi.mock('@/lib/auth-dal', () => ({
  verifyFirebaseToken: vi.fn(async () => ({ uid: 'demo-user' })),
}));

vi.mock('@/lib/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
  createRequestLogger: () => ({
    start: vi.fn(),
    complete: vi.fn(),
    error: vi.fn(),
  }),
}));

function request(url: string, body: Record<string, unknown>) {
  return new NextRequest(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function converse(body: Record<string, unknown>) {
  const response = await conversePost(
    request('http://localhost/api/v1/design-session/converse', body)
  );
  if (response.status !== 200) {
    throw new Error(
      `Expected demo converse 200, received ${response.status}: ${await response
        .clone()
        .text()}`
    );
  }
  return response.json();
}

describe('demo design session — proposal to one confirm reveal', () => {
  beforeEach(() => {
    clearMemorySessions();
    vi.stubEnv('NEXT_PUBLIC_DEMO_MODE', 'true');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('reaches proposal, confirms exactly once, and reveals without an error response', async () => {
    const opened = await converse({});
    expect(opened.stage).toBe('chatting');

    const first = await converse({
      sessionId: opened.sessionId,
      message: 'left forearm',
    });
    expect(first.stage).toBe('chatting');

    const second = await converse({
      sessionId: opened.sessionId,
      message: 'a hummingbird for my grandmother',
    });
    expect(second.stage).toBe('chatting');

    const proposal = await converse({
      sessionId: opened.sessionId,
      message: 'fine line, delicate and mostly black ink',
    });
    expect(proposal).toMatchObject({
      stage: 'proposal',
      sessionId: opened.sessionId,
      playback: expect.any(String),
    });

    const confirmResponse = await confirmPost(
      request(
        `http://localhost/api/v1/design-session/${opened.sessionId}/confirm`,
        {}
      ),
      routeParams(opened.sessionId)
    );
    expect(confirmResponse.status).toBe(200);
    const confirmed = await confirmResponse.json();
    expect(confirmed).toMatchObject({
      success: true,
      session: {
        id: opened.sessionId,
        phase: 'revealed',
        variations: expect.any(Array),
      },
    });
    expect(confirmed.session.variations).toHaveLength(2);
    expect(confirmed).not.toHaveProperty('error');

    // A repeated confirmation cannot fire generation again.
    const duplicateResponse = await confirmPost(
      request(
        `http://localhost/api/v1/design-session/${opened.sessionId}/confirm`,
        {}
      ),
      routeParams(opened.sessionId)
    );
    expect(duplicateResponse.status).toBe(409);
    await expect(duplicateResponse.json()).resolves.toMatchObject({
      code: 'INVALID_PHASE',
    });
  }, 10_000);
});
