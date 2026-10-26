import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const { verifyFirebaseTokenMock, getArtistByClaimedUidMock, runMock } = vi.hoisted(() => ({
  verifyFirebaseTokenMock: vi.fn(),
  getArtistByClaimedUidMock: vi.fn(),
  runMock: vi.fn(),
}));

vi.mock('@/lib/api-auth', () => ({ verifyApiAuth: vi.fn().mockResolvedValue(null) }));
vi.mock('@/lib/auth-dal', () => ({ verifyFirebaseToken: verifyFirebaseTokenMock }));
vi.mock('@/lib/artist-stripe', () => ({ getArtistByClaimedUid: getArtistByClaimedUidMock }));
// Spec 16 extras live in Firestore; keep this file's tests off the network.
vi.mock('@/lib/artist-profile-extras-store', () => ({
  readArtistExtras: vi.fn(async () => ({ policies: {}, faqs: [], travelDates: [] })),
  writeArtistExtras: vi.fn(),
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

const owner = {
  id: 'artist_1',
  name: 'Nadia',
  claimedByUid: 'uid_1',
  claimVerified: true,
  email: null,
  stripeAccountId: null,
  chargesEnabled: false,
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
  getArtistByClaimedUidMock.mockResolvedValue(owner);
  runMock.mockResolvedValue({
    records: [
      {
        toObject: () => ({
          id: 'artist_1',
          name: 'Nadia',
          shopName: null,
          bio: 'Blackwork',
          bookingUrl: null,
          city: 'Phoenix',
          state: 'AZ',
          instagram: '@nadia',
          artistManagedFields: ['bio'],
          profileManagedAtEpochMs: 123,
        }),
      },
    ],
  });
});
describe('/api/v1/artist/profile', () => {
  it('refuses profile access until the claim is human-verified', async () => {
    getArtistByClaimedUidMock.mockResolvedValue(null);
    const response = await PATCH(req('PATCH', { bio: 'Attacker edit' }));
    expect(response.status).toBe(403);
    expect(runMock).not.toHaveBeenCalled();
  });

  it('resolves the profile from the verified uid, never a client artist id', async () => {
    const response = await GET(req('GET'));
    expect(response.status).toBe(200);
    const [query, params] = runMock.mock.calls[0];
    expect(query).toContain("claimVerificationStatus: 'verified'");
    expect(params).toEqual({ artistId: 'artist_1', uid: 'uid_1' });
  });

  it('writes only approved fields and records artist ownership of those fields', async () => {
    const response = await PATCH(
      req('PATCH', { bio: 'Artist-written bio', bookingUrl: 'https://nadia.example/book' }),
    );
    expect(response.status).toBe(200);
    const [query, params] = runMock.mock.calls[0];
    expect(query).toContain('a.bio = $bio');
    expect(query).toContain('a.bookingUrl = $bookingUrl');
    expect(query).toContain('a.artistManagedFields');
    expect(query).toContain('a.profileManagedAtEpochMs');
    expect(params.managedFields).toEqual(['bio', 'bookingUrl']);
  });

  it('rejects identity-anchor and portfolio edits', async () => {
    const response = await PATCH(req('PATCH', { instagram: '@attacker' }));
    expect(response.status).toBe(400);
    expect(runMock).not.toHaveBeenCalled();
  });
});
