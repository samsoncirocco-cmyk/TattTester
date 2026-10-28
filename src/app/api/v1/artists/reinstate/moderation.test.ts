/**
 * Moderation on an appeal must not restore a profile or resolve the request.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const { verifyApiAuthMock, verifyFirebaseTokenMock, recordMock, notifyMock, screenMock } = vi.hoisted(() => ({
  verifyApiAuthMock: vi.fn(),
  verifyFirebaseTokenMock: vi.fn(),
  recordMock: vi.fn(),
  notifyMock: vi.fn(),
  screenMock: vi.fn(),
}));

vi.mock('@/lib/api-auth', () => ({ verifyApiAuth: verifyApiAuthMock }));
vi.mock('@/lib/auth-dal', () => ({ verifyFirebaseToken: verifyFirebaseTokenMock }));
vi.mock('@/lib/reinstatement-graph', () => ({ recordReinstatementRequest: recordMock }));
vi.mock('@/lib/notify', () => ({ notifyOpsOfReinstatementRequest: notifyMock }));
vi.mock('@/lib/typesafeModeration', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/typesafeModeration')>();
  return { ...actual, screenContent: screenMock };
});

import { POST } from './route';

function makeRequest() {
  return new NextRequest('http://localhost/api/v1/artists/reinstate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-token' },
    body: JSON.stringify({
      instagram: '@tattoosbyging',
      contactEmail: 'ging@example.com',
      message: 'I am appealing the removal of my copyrighted photographs.',
    }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  verifyApiAuthMock.mockResolvedValue(null);
  verifyFirebaseTokenMock.mockResolvedValue({ uid: 'uid_appeal_moderation' });
  recordMock.mockResolvedValue(true);
  notifyMock.mockResolvedValue({ delivered: true });
});

describe('reinstatement moderation', () => {
  it('still records a pending appeal when the call blocks, and restores nothing', async () => {
    screenMock.mockResolvedValueOnce({
      action: 'block',
      userMessage: 'We received your request. Nothing has been restored, and we will not resolve it automatically. A person will review it.',
      skipped: false,
      severity: 2.5,
      confidence: 0.91,
      hazards: ['legal_claim'],
    });

    const response = await POST(makeRequest());
    const data = await response.json();

    expect(response.status).toBe(202);
    expect(data.received).toBe(true);
    expect(data.reinstated).toBe(false);
    expect(data.moderation).toBe('block');
    expect(data.status).toMatch(/nothing has been restored/i);
    expect(recordMock).toHaveBeenCalledTimes(1);
    const notice = notifyMock.mock.calls[0][3];
    expect(notice.action).toBe('block');
    expect(notice.summary).toMatch(/do not resolve/i);
  });

  it('keeps the current response when the call is down', async () => {
    screenMock.mockResolvedValueOnce({
      action: 'pass',
      userMessage: null,
      skipped: true,
      reason: 'error',
      hazards: [],
    });

    const response = await POST(makeRequest());
    const data = await response.json();

    expect(response.status).toBe(202);
    expect(data.reinstated).toBe(false);
    expect(data.moderation).toBeUndefined();
    expect(data.status).toBe('Received and awaiting review by a person.');
    expect(recordMock).toHaveBeenCalledTimes(1);
  });
});
