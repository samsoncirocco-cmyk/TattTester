// Spec 16: policies, FAQ and travel dates through GET/PATCH /api/v1/artist/profile.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const { verifyFirebaseTokenMock, getArtistByClaimedUidMock, runMock, readExtrasMock, writeExtrasMock } =
  vi.hoisted(() => ({
    verifyFirebaseTokenMock: vi.fn(),
    getArtistByClaimedUidMock: vi.fn(),
    runMock: vi.fn(),
    readExtrasMock: vi.fn(),
    writeExtrasMock: vi.fn(),
  }));

vi.mock('@/lib/api-auth', () => ({ verifyApiAuth: vi.fn().mockResolvedValue(null) }));
vi.mock('@/lib/auth-dal', () => ({ verifyFirebaseToken: verifyFirebaseTokenMock }));
vi.mock('@/lib/artist-stripe', () => ({ getArtistByClaimedUid: getArtistByClaimedUidMock }));
vi.mock('@/lib/artist-profile-extras-store', () => ({
  readArtistExtras: readExtrasMock,
  writeArtistExtras: writeExtrasMock,
}));
vi.mock('neo4j-driver', () => ({ default: { int: (value: number) => value } }));
vi.mock('@/lib/neo4j', () => ({
  NEO4J_DATABASE: null,
  NEO4J_QUERY_TIMEOUT: 5000,
  getNeo4jDriver: () => ({
    session: () => ({
      executeRead: (work: (tx: unknown) => unknown) => work({ run: runMock }),
      executeWrite: (work: (tx: unknown) => unknown) => work({ run: runMock }),
      close: vi.fn(),
    }),
  }),
}));

import { GET, PATCH } from './route';

const EXTRAS = {
  policies: { deposit: 'Comes off the final price.' },
  faqs: [{ q: 'Cover-ups?', a: 'Sometimes.' }],
  travelDates: [{ city: 'Austin', startsOn: '2099-03-04', endsOn: '2099-03-09', kind: 'guest_spot' }],
};

function req(method: 'GET' | 'PATCH', body?: Record<string, unknown>) {
  return new NextRequest('http://localhost/api/v1/artist/profile', {
    method,
    headers: { Authorization: 'Bearer test', 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  verifyFirebaseTokenMock.mockResolvedValue({ uid: 'uid_1' });
  getArtistByClaimedUidMock.mockResolvedValue({ id: 'artist_1', claimedByUid: 'uid_1', claimVerified: true });
  runMock.mockResolvedValue({ records: [{ toObject: () => ({ id: 'artist_1', name: 'Nadia' }) }] });
  readExtrasMock.mockResolvedValue(EXTRAS);
  writeExtrasMock.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({ ...EXTRAS, ...patch }));
});

describe('/api/v1/artist/profile extras (spec 16)', () => {
  it('GET returns the three groups alongside the profile', async () => {
    const body = await (await GET(req('GET'))).json();
    expect(body.extras).toEqual(EXTRAS);
    expect(readExtrasMock).toHaveBeenCalledWith('artist_1');
  });

  it('GET still returns the profile when the extras store fails', async () => {
    readExtrasMock.mockRejectedValue(new Error('firestore down'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const res = await GET(req('GET'));
    expect(res.status).toBe(200);
    expect((await res.json()).extras).toBeNull();
    warn.mockRestore();
  });

  it('PATCH with only extras checks ownership in the graph, records the fields, then writes the store', async () => {
    const res = await PATCH(req('PATCH', { policies: EXTRAS.policies, faqs: EXTRAS.faqs }));
    expect(res.status).toBe(200);
    const [query, params] = runMock.mock.calls[0];
    expect(query).toContain("claimVerificationStatus: 'verified'");
    expect(query).not.toContain('a.policies');
    expect(params).toMatchObject({ artistId: 'artist_1', uid: 'uid_1', managedFields: ['policies', 'faqs'] });
    expect(writeExtrasMock).toHaveBeenCalledWith(
      'artist_1',
      { policies: EXTRAS.policies, faqs: EXTRAS.faqs },
      'uid_1',
    );
    expect((await res.json()).extras).toBeTruthy();
  });

  it('PATCH with scalar fields and extras writes both', async () => {
    const res = await PATCH(req('PATCH', { bio: 'New bio', travelDates: EXTRAS.travelDates }));
    expect(res.status).toBe(200);
    const [query, params] = runMock.mock.calls[0];
    expect(query).toContain('a.bio = $bio');
    expect(params.managedFields).toEqual(['bio', 'travelDates']);
    expect(writeExtrasMock).toHaveBeenCalledTimes(1);
  });

  it('a revoked claim saves nothing to the store', async () => {
    runMock.mockResolvedValue({ records: [] });
    const res = await PATCH(req('PATCH', { faqs: EXTRAS.faqs }));
    expect(res.status).toBe(409);
    expect(writeExtrasMock).not.toHaveBeenCalled();
  });

  it.each([
    ['too many FAQs', { faqs: Array.from({ length: 9 }, () => ({ q: 'q', a: 'a' })) }],
    ['13 travel dates', { travelDates: Array.from({ length: 13 }, () => EXTRAS.travelDates[0]) }],
    ['reversed range', { travelDates: [{ ...EXTRAS.travelDates[0], startsOn: '2099-03-10' }] }],
    ['an email in text', { policies: { deposit: 'write to me@nadia.ink' } }],
    ['an unknown key next to extras', { faqs: [], instagram: '@attacker' }],
  ])('rejects %s without touching the graph or store', async (_label, body) => {
    const res = await PATCH(req('PATCH', body));
    expect(res.status).toBe(400);
    expect(runMock).not.toHaveBeenCalled();
    expect(writeExtrasMock).not.toHaveBeenCalled();
  });

  it('identity still comes only from the verified uid', async () => {
    getArtistByClaimedUidMock.mockResolvedValue(null);
    const res = await PATCH(req('PATCH', { faqs: EXTRAS.faqs, artistId: 'artist_2' } as Record<string, unknown>));
    expect(res.status).toBe(403);
    expect(writeExtrasMock).not.toHaveBeenCalled();
  });

  it('a store failure after the graph write is a 503, not a silent success', async () => {
    writeExtrasMock.mockRejectedValue(new Error('firestore down'));
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const res = await PATCH(req('PATCH', { faqs: EXTRAS.faqs }));
    expect(res.status).toBe(503);
    error.mockRestore();
  });
});
