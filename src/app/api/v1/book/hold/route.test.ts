// DELETE /api/v1/book/hold — the release route (REA gap #1).
//
// A hold is an exclusive claim on an artist's time, so releasing one is a way
// to steal a slot. These tests pin the ownership check (the hold's booking
// must be the caller's), the 404 on an unknown id, the refusal to release a
// paid-for hold, and the booking record walking back from `held` to `pending`.
import { beforeEach, describe, expect, it, vi } from 'vitest';

// ── firebase-admin/firestore fake ───────────────────────────────────────────
const DELETE_SENTINEL = Symbol('delete');
const docStore = new Map<string, Record<string, unknown>>();

function makeRef(id: string) {
  return {
    id,
    async get() {
      const data = docStore.get(id);
      return { exists: data !== undefined, data: () => data };
    },
    async set(patch: Record<string, unknown>, options?: { merge?: boolean }) {
      const prev = options?.merge ? docStore.get(id) ?? {} : {};
      const next: Record<string, unknown> = { ...prev };
      for (const [k, v] of Object.entries(patch)) {
        if (v === DELETE_SENTINEL) delete next[k];
        else next[k] = v;
      }
      docStore.set(id, next);
    },
  };
}

vi.mock('firebase-admin/firestore', () => ({
  getFirestore: () => ({
    collection: () => ({ doc: (id: string) => makeRef(id) }),
  }),
  FieldValue: { delete: () => DELETE_SENTINEL },
}));

vi.mock('@/lib/firebase-admin', () => ({
  ensureAdminApp: () => 'sa-json',
}));

vi.mock('@/lib/api-auth', () => ({
  verifyApiAuth: vi.fn().mockResolvedValue(null),
}));

const { callerRef } = vi.hoisted(() => ({
  callerRef: { uid: 'uid-owner' as string | null },
}));
vi.mock('@/lib/auth-dal', () => ({
  verifyFirebaseToken: vi.fn(async () => (callerRef.uid ? { uid: callerRef.uid } : null)),
}));

// The offer is only consulted by POST; stub it so the module loads.
vi.mock('@/lib/booking-offer', () => ({
  getBookingOffer: vi.fn(),
}));

import { DELETE } from './route';

const ACTIVE_HOLD = {
  holdId: 'hold_1',
  artistId: 'artist_a',
  bookingId: 'BK-AAAAAAAA',
  date: '2099-01-10',
  startTime: '14:00',
  endTime: '16:00',
  timezone: 'America/Phoenix',
  createdAt: '2099-01-01T00:00:00.000Z',
  expiresAt: '2099-01-01T00:35:00.000Z',
  status: 'active',
};

function del(holdId?: string, body?: unknown) {
  const url = holdId
    ? `http://localhost/api/v1/book/hold?holdId=${encodeURIComponent(holdId)}`
    : 'http://localhost/api/v1/book/hold';
  return new Request(url, {
    method: 'DELETE',
    headers: { authorization: 'Bearer fake', 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as any;
}

describe('DELETE /api/v1/book/hold', () => {
  beforeEach(() => {
    docStore.clear();
    callerRef.uid = 'uid-owner';
    docStore.set('hold_1', { ...ACTIVE_HOLD });
    docStore.set('BK-AAAAAAAA', {
      bookingId: 'BK-AAAAAAAA',
      uid: 'uid-owner',
      status: 'held',
      holdId: 'hold_1',
      heldSlot: { date: '2099-01-10' },
    });
  });

  it('400s without a holdId', async () => {
    const res = await DELETE(del());
    expect(res.status).toBe(400);
  });

  it('404s an unknown hold id', async () => {
    const res = await DELETE(del('hold_nope'));
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.code).toBe('HOLD_NOT_FOUND');
  });

  it("403s when the hold's booking belongs to someone else, and leaves it active", async () => {
    callerRef.uid = 'uid-intruder';
    const res = await DELETE(del('hold_1'));
    expect(res.status).toBe(403);
    expect(docStore.get('hold_1')!.status).toBe('active');
    expect(docStore.get('BK-AAAAAAAA')!.status).toBe('held');
  });

  it('releases an owned hold and walks the booking back to pending', async () => {
    const res = await DELETE(del('hold_1'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ released: true, holdId: 'hold_1' });

    expect(docStore.get('hold_1')!.status).toBe('released');
    const booking = docStore.get('BK-AAAAAAAA')!;
    expect(booking.status).toBe('pending');
    expect(booking.holdId).toBeUndefined();
    expect(booking.heldSlot).toBeUndefined();
    expect(typeof booking.holdReleasedAt).toBe('string');
  });

  it('accepts the holdId in the JSON body too', async () => {
    const res = await DELETE(del(undefined, { holdId: 'hold_1' }));
    expect(res.status).toBe(200);
    expect(docStore.get('hold_1')!.status).toBe('released');
  });

  it('does not clobber a booking that has moved on to a newer hold', async () => {
    docStore.set('BK-AAAAAAAA', { ...docStore.get('BK-AAAAAAAA')!, holdId: 'hold_2' });
    const res = await DELETE(del('hold_1'));
    expect(res.status).toBe(200);
    expect(docStore.get('hold_1')!.status).toBe('released');
    // Still held — by hold_2, which this release has nothing to do with.
    expect(docStore.get('BK-AAAAAAAA')!.status).toBe('held');
    expect(docStore.get('BK-AAAAAAAA')!.holdId).toBe('hold_2');
  });

  it('is idempotent: releasing an already-released hold is a 200', async () => {
    docStore.set('hold_1', { ...ACTIVE_HOLD, status: 'released' });
    const res = await DELETE(del('hold_1'));
    expect(res.status).toBe(200);
    expect((await res.json()).alreadyReleased).toBe(true);
  });

  it('refuses to release a hold that has been paid for', async () => {
    docStore.set('hold_1', { ...ACTIVE_HOLD, status: 'converted' });
    const res = await DELETE(del('hold_1'));
    expect(res.status).toBe(409);
    expect(docStore.get('hold_1')!.status).toBe('converted');
  });

  it('lets an ownerless (anonymous-capture) booking release its hold', async () => {
    docStore.set('BK-AAAAAAAA', { ...docStore.get('BK-AAAAAAAA')!, uid: null });
    callerRef.uid = null;
    const res = await DELETE(del('hold_1'));
    expect(res.status).toBe(200);
  });
});
