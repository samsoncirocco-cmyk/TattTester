// Seam tests for POST /api/v1/design-session/[id]/placement-preview:
// designSession service and GCS mocked; pins input validation (data-URL
// shape, size cap), the GCS-vs-data-URL storage split, the 502 on a failed
// upload, and domain-error mapping.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeBrief, makeRequest, makeSession, routeParams } from './helpers';

const { attachMock, uploadMock, ensureAdminAppMock, verifyApiAuthMock } = vi.hoisted(() => ({
  attachMock: vi.fn(),
  uploadMock: vi.fn(),
  ensureAdminAppMock: vi.fn(),
  verifyApiAuthMock: vi.fn()
}));

vi.mock('@/services/designSession', () => ({
  attachPlacementPreview: attachMock,
  claimSessionOwnership: vi.fn()
}));

vi.mock('@/services/gcs-service', () => ({
  uploadToGCS: uploadMock
}));

vi.mock('@/lib/firebase-admin', () => ({
  ensureAdminApp: ensureAdminAppMock
}));

vi.mock('@/lib/api-auth', () => ({
  verifyApiAuthWithUser: verifyApiAuthMock
}));

vi.mock('@/lib/logger', () => ({
  createRequestLogger: () => ({
    start: vi.fn(),
    complete: vi.fn(),
    error: vi.fn()
  })
}));

import { POST } from '../[id]/placement-preview/route';
import { DesignSessionError } from '@/services/designSession/internal/orchestrator';

const URL = 'http://localhost/api/v1/design-session/sess-1/placement-preview';
const PNG_DATA_URL = `data:image/png;base64,${Buffer.from('fake-png').toString('base64')}`;

function completedSession() {
  const brief = { ...makeBrief(), placementPreviewUrl: 'https://storage/preview.png' };
  return makeSession({ phase: 'complete', brief });
}

beforeEach(() => {
  vi.clearAllMocks();
  verifyApiAuthMock.mockResolvedValue({ error: null, user: { uid: 'uid-1' } });
  ensureAdminAppMock.mockReturnValue(false);
  attachMock.mockResolvedValue(completedSession());
});

afterEach(() => {
  delete process.env.NEXT_PUBLIC_DEMO_MODE;
});

describe('POST /api/v1/design-session/[id]/placement-preview', () => {
  it('rejects a missing imageData', async () => {
    const res = await POST(makeRequest(URL, {}), routeParams('sess-1'));
    expect(res.status).toBe(400);
    expect(attachMock).not.toHaveBeenCalled();
  });

  it('rejects a non-data-URL payload', async () => {
    const res = await POST(makeRequest(URL, { imageData: 'https://img/x.png' }), routeParams('sess-1'));
    expect(res.status).toBe(400);
    expect(attachMock).not.toHaveBeenCalled();
  });

  it('rejects an oversized payload', async () => {
    const huge = `data:image/png;base64,${'A'.repeat(8 * 1024 * 1024 + 1)}`;
    const res = await POST(makeRequest(URL, { imageData: huge }), routeParams('sess-1'));
    expect(res.status).toBe(400);
    expect(attachMock).not.toHaveBeenCalled();
  });

  it('stores the raw data URL when Firebase Admin (and thus GCS) is not wired', async () => {
    const res = await POST(makeRequest(URL, { imageData: PNG_DATA_URL }), routeParams('sess-1'));
    expect(res.status).toBe(200);
    expect(uploadMock).not.toHaveBeenCalled();
    expect(attachMock).toHaveBeenCalledWith('sess-1', PNG_DATA_URL);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.placementPreviewUrl).toBe('https://storage/preview.png');
  });

  it('uploads to GCS and attaches the returned URL when admin creds are wired', async () => {
    ensureAdminAppMock.mockReturnValue(true);
    uploadMock.mockResolvedValue({ url: 'https://signed/preview.png' });

    const res = await POST(makeRequest(URL, { imageData: PNG_DATA_URL }), routeParams('sess-1'));
    expect(res.status).toBe(200);
    expect(uploadMock).toHaveBeenCalledWith(
      expect.any(Buffer),
      'design-sessions/sess-1/placement-preview.png',
      { contentType: 'image/png' }
    );
    expect(attachMock).toHaveBeenCalledWith('sess-1', 'https://signed/preview.png');
  });

  it('skips GCS in demo mode even with admin creds wired', async () => {
    process.env.NEXT_PUBLIC_DEMO_MODE = 'true';
    ensureAdminAppMock.mockReturnValue(true);

    const res = await POST(makeRequest(URL, { imageData: PNG_DATA_URL }), routeParams('sess-1'));
    expect(res.status).toBe(200);
    expect(uploadMock).not.toHaveBeenCalled();
    expect(attachMock).toHaveBeenCalledWith('sess-1', PNG_DATA_URL);
  });

  it('maps a failed GCS upload to 502 and never persists the raw payload', async () => {
    ensureAdminAppMock.mockReturnValue(true);
    uploadMock.mockRejectedValue(new Error('bucket unreachable'));

    const res = await POST(makeRequest(URL, { imageData: PNG_DATA_URL }), routeParams('sess-1'));
    expect(res.status).toBe(502);
    expect(attachMock).not.toHaveBeenCalled();
  });

  it('maps INVALID_PHASE from the service to 409', async () => {
    attachMock.mockRejectedValue(
      new DesignSessionError('INVALID_PHASE', 'not complete yet')
    );
    const res = await POST(makeRequest(URL, { imageData: PNG_DATA_URL }), routeParams('sess-1'));
    expect(res.status).toBe(409);
  });

  it('maps SESSION_NOT_FOUND from the service to 404', async () => {
    attachMock.mockRejectedValue(
      new DesignSessionError('SESSION_NOT_FOUND', 'no such session')
    );
    const res = await POST(makeRequest(URL, { imageData: PNG_DATA_URL }), routeParams('sess-1'));
    expect(res.status).toBe(404);
  });

  it('returns 401 when auth fails', async () => {
    const { NextResponse } = await import('next/server');
    verifyApiAuthMock.mockResolvedValue({
      error: NextResponse.json({ error: 'Authorization header required' }, { status: 401 }),
    });
    const res = await POST(makeRequest(URL, { imageData: PNG_DATA_URL }), routeParams('sess-1'));
    expect(res.status).toBe(401);
    expect(attachMock).not.toHaveBeenCalled();
  });

  // Setup runs inside the try, so a throwing dependency lands on the shared
  // structured envelope instead of escaping as an unstructured Next.js 500.
  it('returns the structured envelope when auth setup throws', async () => {
    verifyApiAuthMock.mockRejectedValue(new Error('Firebase admin not configured'));

    const res = await POST(makeRequest(URL, { imageData: PNG_DATA_URL }), routeParams('sess-1'));

    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ code: 'DESIGN_SESSION_FAILED', retryable: false });
    expect(attachMock).not.toHaveBeenCalled();
  });
});
