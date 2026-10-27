/**
 * Moderation on a takedown must not become a deletion. Block and review still
 * record a pending request and still email a person.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const { notifyMock, recordMock, screenMock } = vi.hoisted(() => ({
  notifyMock: vi.fn(),
  recordMock: vi.fn(),
  screenMock: vi.fn(),
}));

vi.mock('@/lib/notify', () => ({ notifyOpsOfTakedownRequest: notifyMock }));
vi.mock('@/lib/takedown-graph', () => ({ recordTakedownRequest: recordMock }));
vi.mock('@/lib/typesafeModeration', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/typesafeModeration')>();
  return { ...actual, screenContent: screenMock };
});

import { POST } from './route';

const GOOD_BODY = {
  artistId: 'artist_tattoosbyging',
  contactEmail: 'ging@example.com',
  relationship: 'artist',
  scope: 'all',
  message: 'These photographs are my copyright. Remove them.',
};

function makeRequest() {
  return new NextRequest('http://localhost/api/v1/artists/takedown', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-forwarded-for': '203.0.113.50' },
    body: JSON.stringify(GOOD_BODY),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  notifyMock.mockResolvedValue({ delivered: true });
  recordMock.mockResolvedValue(true);
});

describe('takedown moderation', () => {
  it('still records and does not remove anything when the call blocks', async () => {
    screenMock.mockResolvedValueOnce({
      action: 'block',
      userMessage: 'We received your request. Nothing has been removed, and we will not resolve it automatically. A person will review it.',
      skipped: false,
      severity: 2.8,
      confidence: 0.9,
      hazards: ['legal_claim'],
    });

    const response = await POST(makeRequest());
    const data = await response.json();

    expect(response.status).toBe(202);
    expect(data.received).toBe(true);
    expect(data.removed).toBe(false);
    expect(data.moderation).toBe('block');
    expect(data.status).toMatch(/nothing has been removed/i);
    expect(data.status).toMatch(/review/i);
    expect(recordMock).toHaveBeenCalledTimes(1);
    expect(notifyMock).toHaveBeenCalledTimes(1);
    const notice = notifyMock.mock.calls[0][2];
    expect(notice.action).toBe('block');
    expect(notice.summary).toMatch(/do not delete/i);
    expect(notice.summary).toMatch(/do not resolve/i);
  });

  it('still records when the call asks for review', async () => {
    screenMock.mockResolvedValueOnce({
      action: 'review',
      userMessage: 'We received your request. Nothing has been removed. A person will review it before anything changes.',
      skipped: false,
      severity: 1.4,
      confidence: 0.5,
      hazards: ['real_person'],
    });

    const response = await POST(makeRequest());
    const data = await response.json();

    expect(response.status).toBe(202);
    expect(data.removed).toBe(false);
    expect(data.moderation).toBe('review');
    expect(recordMock).toHaveBeenCalledTimes(1);
  });

  it('keeps the current response when the call is down', async () => {
    screenMock.mockResolvedValueOnce({
      action: 'pass',
      userMessage: null,
      skipped: true,
      reason: 'timeout',
      hazards: [],
    });

    const response = await POST(makeRequest());
    const data = await response.json();

    expect(response.status).toBe(202);
    expect(data.removed).toBe(false);
    expect(data.moderation).toBeUndefined();
    expect(data.status).toBe('Received and awaiting review by a person.');
    expect(recordMock).toHaveBeenCalledTimes(1);
    expect(notifyMock.mock.calls[0][2]).toBeNull();
  });
});
