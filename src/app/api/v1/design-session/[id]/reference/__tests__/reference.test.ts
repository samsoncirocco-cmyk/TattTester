// Seam tests for POST /api/v1/design-session/[id]/reference (TAT-50): the
// vision service and designSession are mocked at their public entries;
// these pin the route's policy (auth, rate bucket, input validation, the
// in-voice fail-soft contract) and the { attached, reference, notes, reply }
// shape the chat UI consumes.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { makeRequest, routeParams } from '../../../__tests__/helpers';

const {
  attachReferenceMock,
  analyzeMock,
  rateLimitMock,
  rateLimitResponseMock,
  verifyApiAuthMock,
  loggerErrorMock,
} = vi.hoisted(() => ({
  attachReferenceMock: vi.fn(),
  analyzeMock: vi.fn(),
  rateLimitMock: vi.fn(),
  rateLimitResponseMock: vi.fn(),
  verifyApiAuthMock: vi.fn(),
  loggerErrorMock: vi.fn(),
}));

vi.mock('@/services/designSession', () => ({
  attachReference: attachReferenceMock,
  claimSessionOwnership: vi.fn(),
  storeReferencePhoto: vi.fn(async () => 'design-sessions/sess-1/references/ref-1.png'),
}));

vi.mock('@/services/vision', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/vision')>();
  return { ...actual, analyzeReferenceImage: analyzeMock };
});

vi.mock('@/lib/api-auth', () => ({ verifyApiAuthWithUser: verifyApiAuthMock }));
vi.mock('@/lib/rate-limit', () => ({
  rateLimit: rateLimitMock,
  rateLimitResponse: rateLimitResponseMock,
}));
vi.mock('@/lib/logger', () => ({
  createRequestLogger: () => ({
    start: vi.fn(),
    complete: vi.fn(),
    error: loggerErrorMock,
  }),
}));

import { POST } from '../route';
import { REFERENCE_BUDGET_TEXT, REFERENCE_UNREADABLE_TEXT } from '@/services/vision';

const URL = 'http://localhost/api/v1/design-session/sess-1/reference';
const IMAGE_BODY = { imageBase64: 'aGVsbG8=', mimeType: 'image/png' };

const ANALYSIS = {
  summary: 'five chibi anime characters, bold outlines, red smoke background',
  subjects: ['group of five characters'],
  characters: [{ name: 'Hiei', series: 'Yu Yu Hakusho' }],
  styleDescriptors: ['chibi', 'anime'],
  palette: ['red', 'black'],
  composition: 'group shot',
  confidence: 0.9,
};

describe('POST /api/v1/design-session/[id]/reference', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    verifyApiAuthMock.mockResolvedValue({ error: null, user: { uid: 'uid-1' } });
    rateLimitMock.mockResolvedValue({ allowed: true });
    analyzeMock.mockResolvedValue({ status: 'analyzed', analysis: ANALYSIS });
    attachReferenceMock.mockResolvedValue({
      sessionId: 'sess-1',
      summary: ANALYSIS.summary,
      notes: { cast: ['Hiei (Yu Yu Hakusho)'], ipHeadsUp: true, sufficient: false, references: [ANALYSIS.summary] },
    });
    delete process.env.NEXT_PUBLIC_DEMO_MODE;
  });

  it('analyzes, attaches, and replies in voice with the reference row', async () => {
    const res = await POST(makeRequest(URL, IMAGE_BODY), routeParams('sess-1'));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.attached).toBe(true);
    expect(body.reference.summary).toContain('five chibi anime characters');
    expect(body.notes.references).toHaveLength(1);
    expect(body.notes.ipHeadsUp).toBe(true);
    // Names what was seen + the one follow-up (characters → cast-vs-style).
    expect(body.reply).toContain("I'm seeing five chibi anime characters");
    expect(body.reply).toContain('Want the characters themselves in the piece');

    expect(analyzeMock).toHaveBeenCalledWith({ data: 'aGVsbG8=', mimeType: 'image/png' });
    expect(attachReferenceMock).toHaveBeenCalledWith(
      'sess-1',
      ANALYSIS,
      'web',
      'design-sessions/sess-1/references/ref-1.png'
    );
  });

  it('speaks the honest unreadable line on a failed analysis — 200, not an error', async () => {
    analyzeMock.mockResolvedValue({ status: 'failed' });
    const res = await POST(makeRequest(URL, IMAGE_BODY), routeParams('sess-1'));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({
      attached: false,
      code: 'UNREADABLE_IMAGE',
      reply: REFERENCE_UNREADABLE_TEXT,
    });
    expect(attachReferenceMock).not.toHaveBeenCalled();
  });

  it('speaks the honest capacity line when the vision budget is exhausted', async () => {
    analyzeMock.mockResolvedValue({ status: 'budget_exhausted' });
    const res = await POST(makeRequest(URL, IMAGE_BODY), routeParams('sess-1'));
    const body = await res.json();

    expect(body).toEqual({
      attached: false,
      code: 'BUDGET_EXHAUSTED',
      reply: REFERENCE_BUDGET_TEXT,
    });
  });

  it('rejects missing/invalid images before any vision spend', async () => {
    let res = await POST(makeRequest(URL, { mimeType: 'image/png' }), routeParams('sess-1'));
    expect(res.status).toBe(400);

    res = await POST(
      makeRequest(URL, { imageBase64: 'aGVsbG8=', mimeType: 'application/pdf' }),
      routeParams('sess-1')
    );
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('INVALID_IMAGE_TYPE');
    expect(analyzeMock).not.toHaveBeenCalled();
  });

  it('maps domain errors through the shared envelope (wrong phase → 409)', async () => {
    attachReferenceMock.mockRejectedValue(
      Object.assign(new Error('phase'), { code: 'INVALID_PHASE', status: 409 })
    );
    const res = await POST(makeRequest(URL, IMAGE_BODY), routeParams('sess-1'));
    expect(res.status).toBe(409);
  });

  it('honors the auth gate and rate bucket', async () => {
    const denied = new Response(null, { status: 401 });
    verifyApiAuthMock.mockResolvedValue({ error: denied });
    const res = await POST(makeRequest(URL, IMAGE_BODY), routeParams('sess-1'));
    expect(res.status).toBe(401);
    expect(analyzeMock).not.toHaveBeenCalled();

    verifyApiAuthMock.mockResolvedValue({ error: null, user: { uid: 'uid-1' } });
    rateLimitMock.mockResolvedValue({ allowed: false });
    rateLimitResponseMock.mockReturnValue(new Response(null, { status: 429 }));
    const limited = await POST(makeRequest(URL, IMAGE_BODY), routeParams('sess-1'));
    expect(limited.status).toBe(429);
  });
});
