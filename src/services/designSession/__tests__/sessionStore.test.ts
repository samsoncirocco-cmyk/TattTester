/**
 * Session-store tests: backing-store selection (env conventions), the
 * in-memory impl, and the Firestore impl with firebase-admin fully mocked
 * — no live Firestore call is ever made.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const firestoreMocks = vi.hoisted(() => {
  const set = vi.fn();
  const get = vi.fn();
  const doc = vi.fn(() => ({ set, get }));
  const collection = vi.fn(() => ({ doc }));
  const getFirestore = vi.fn(() => ({ collection }));
  return { set, get, doc, collection, getFirestore };
});

vi.mock('firebase-admin/firestore', () => ({ getFirestore: firestoreMocks.getFirestore }));
vi.mock('@/lib/firebase-admin', () => ({ ensureAdminApp: vi.fn(() => false) }));

import {
  resolveSessionStore,
  memorySessionStore,
  firestoreSessionStore,
  clearMemorySessions,
} from '../internal/store';
import type { StoredSession } from '../internal/store';
import { ensureAdminApp } from '@/lib/firebase-admin';

const mockEnsureAdminApp = vi.mocked(ensureAdminApp);

function makeSession(overrides: Partial<StoredSession> = {}): StoredSession {
  return {
    id: 'sess-1',
    phase: 'revealed',
    intake: {
      placement: 'forearm',
      styleTags: ['traditional'],
      meaning: 'anchor for my dad',
      references: [],
      ambiguousAxes: [],
    },
    axisSelection: { mode: 'compositional', axes: [], rationale: 'resolved' },
    provider: 'replicate',
    pinnedModelId: 'sdxl',
    variations: [
      {
        id: 'v1',
        axisPosition: { composition: 'centered emblem' },
        prompt: 'p1',
        // negativePrompt and imageUrl deliberately absent (undefined)
      },
    ],
    createdAt: '2026-07-24T00:00:00.000Z',
    updatedAt: '2026-07-24T00:00:00.000Z',
    ...overrides,
  };
}

let savedDemoMode: string | undefined;

beforeEach(() => {
  vi.clearAllMocks();
  clearMemorySessions();
  savedDemoMode = process.env.NEXT_PUBLIC_DEMO_MODE;
  delete process.env.NEXT_PUBLIC_DEMO_MODE;
});

afterEach(() => {
  if (savedDemoMode === undefined) delete process.env.NEXT_PUBLIC_DEMO_MODE;
  else process.env.NEXT_PUBLIC_DEMO_MODE = savedDemoMode;
});

describe('resolveSessionStore', () => {
  it('uses the in-memory store in demo mode, even with Firebase configured', () => {
    process.env.NEXT_PUBLIC_DEMO_MODE = 'true';
    mockEnsureAdminApp.mockReturnValue('sa-json');
    expect(resolveSessionStore()).toBe(memorySessionStore);
  });

  it('uses Firestore when Firebase Admin credentials are wired', () => {
    mockEnsureAdminApp.mockReturnValue('sa-json');
    expect(resolveSessionStore()).toBe(firestoreSessionStore);
  });

  it('falls back to the in-memory store when Firebase is unconfigured', () => {
    mockEnsureAdminApp.mockReturnValue(false);
    expect(resolveSessionStore()).toBe(memorySessionStore);
  });
});

describe('memorySessionStore', () => {
  it('round-trips a session and returns null for unknown ids', async () => {
    const session = makeSession();
    await memorySessionStore.save(session);
    expect(await memorySessionStore.get('sess-1')).toEqual(session);
    expect(await memorySessionStore.get('unknown')).toBeNull();
  });

  /**
   * Every design-session route is its own Next.js entry point, and each
   * bundles its own instance of ../internal/store. A Map held in module
   * scope is therefore per-route, not per-process: a session written by
   * /converse was invisible to /[id]/confirm, which answered the user's
   * "show me" with "Session not found". Two module instances of the same
   * file reproduce exactly that.
   */
  it('shares sessions across module instances (one per Next route bundle)', async () => {
    const writer = await import('../internal/store');
    await writer.memorySessionStore.save(makeSession({ id: 'cross-route' }));

    vi.resetModules();
    const reader = await import('../internal/store');
    expect(reader.memorySessionStore).not.toBe(writer.memorySessionStore);

    expect(await reader.memorySessionStore.get('cross-route')).not.toBeNull();
  });

  it('stores and returns copies, not live references', async () => {
    const session = makeSession();
    await memorySessionStore.save(session);
    session.phase = 'complete'; // mutate the caller's object after save

    const fetched = await memorySessionStore.get('sess-1');
    expect(fetched?.phase).toBe('revealed');

    fetched!.phase = 'picked'; // mutate the fetched copy
    expect((await memorySessionStore.get('sess-1'))?.phase).toBe('revealed');
  });
});

describe('memorySessionStore — the charged-round claim (ADR-0049)', () => {
  beforeEach(() => clearMemorySessions());

  const claim = (id: string, at = new Date().toISOString()) => ({ id, at });
  const STALE_MS = 10 * 60 * 1000;

  it('claims a free slot, refuses a held one, and frees it on release', async () => {
    await memorySessionStore.save(makeSession());

    const won = await memorySessionStore.claimRound('sess-1', claim('c1'), STALE_MS);
    expect(won.status).toBe('claimed');

    // The loser of the race never gets the slot.
    const lost = await memorySessionStore.claimRound('sess-1', claim('c2'), STALE_MS);
    expect(lost).toMatchObject({ status: 'held', heldBy: { id: 'c1' } });

    await memorySessionStore.releaseRound('sess-1', 'c1');
    const again = await memorySessionStore.claimRound('sess-1', claim('c3'), STALE_MS);
    expect(again.status).toBe('claimed');
  });

  it('evicts a stale claim and hands it back for orphan reconciliation', async () => {
    await memorySessionStore.save(makeSession());
    const stale = {
      id: 'dead',
      reservationId: 'res-orphan',
      at: new Date(Date.now() - STALE_MS - 1000).toISOString(),
    };
    await memorySessionStore.claimRound('sess-1', stale, STALE_MS);

    const won = await memorySessionStore.claimRound('sess-1', claim('c1'), STALE_MS);

    // Claimed over the corpse — and the orphaned reservation id surfaces so
    // the caller can log it for reconciliation.
    expect(won).toMatchObject({
      status: 'claimed',
      evicted: { id: 'dead', reservationId: 'res-orphan' },
    });
  });

  it('release is a no-op for a claim that is no longer the holder', async () => {
    await memorySessionStore.save(makeSession());
    await memorySessionStore.claimRound('sess-1', claim('c1'), STALE_MS);

    await memorySessionStore.releaseRound('sess-1', 'someone-else');

    const still = await memorySessionStore.claimRound('sess-1', claim('c2'), STALE_MS);
    expect(still.status).toBe('held');
  });

  it('reports a missing session instead of inventing a slot', async () => {
    const result = await memorySessionStore.claimRound('nope', claim('c1'), STALE_MS);
    expect(result.status).toBe('missing');
  });
});

describe('firestoreSessionStore', () => {
  it('writes to design_sessions/<id> with undefined fields stripped', async () => {
    const session = makeSession();
    await firestoreSessionStore.save(session);

    expect(firestoreMocks.collection).toHaveBeenCalledWith('design_sessions');
    expect(firestoreMocks.doc).toHaveBeenCalledWith('sess-1');
    const saved = firestoreMocks.set.mock.calls[0][0] as Record<string, unknown>;
    // Firestore rejects undefined-valued fields — absent optionals must be
    // dropped, not written as undefined.
    expect('pickId' in saved).toBe(false);
    const variation = (saved.variations as Record<string, unknown>[])[0];
    expect('negativePrompt' in variation).toBe(false);
    expect('imageUrl' in variation).toBe(false);
    expect(saved.id).toBe('sess-1');
    expect(saved.pinnedModelId).toBe('sdxl');
  });

  it('reads a session back and returns null when the doc is missing', async () => {
    const session = makeSession();
    firestoreMocks.get.mockResolvedValueOnce({ exists: true, data: () => session });
    expect(await firestoreSessionStore.get('sess-1')).toEqual(session);

    firestoreMocks.get.mockResolvedValueOnce({ exists: false, data: () => undefined });
    expect(await firestoreSessionStore.get('gone')).toBeNull();
  });
});

describe('memorySessionStore — the late-bind ownership claim (#338 item 1)', () => {
  beforeEach(() => {
    clearMemorySessions();
  });

  it('stamps an unowned session on a charged claim, then matches the same uid', async () => {
    await memorySessionStore.save(makeSession());

    expect(await memorySessionStore.claimOwnership('sess-1', 'uid-a', true)).toBe('stamped');
    expect(await memorySessionStore.claimOwnership('sess-1', 'uid-a', true)).toBe('match');
    // The stamp persisted onto the stored session itself.
    expect((await memorySessionStore.get('sess-1'))?.ownerUid).toBe('uid-a');
  });

  it('refuses a different uid once owned — stamp or not', async () => {
    await memorySessionStore.save(makeSession({ ownerUid: 'uid-a' }));

    expect(await memorySessionStore.claimOwnership('sess-1', 'uid-b', true)).toBe('mismatch');
    expect(await memorySessionStore.claimOwnership('sess-1', 'uid-b', false)).toBe('mismatch');
    // The refusal never rebinds the session.
    expect((await memorySessionStore.get('sess-1'))?.ownerUid).toBe('uid-a');
  });

  it('leaves an unowned session unbound on a guard-only check', async () => {
    await memorySessionStore.save(makeSession());

    expect(await memorySessionStore.claimOwnership('sess-1', 'uid-a', false)).toBe('unbound');
    expect((await memorySessionStore.get('sess-1'))?.ownerUid).toBeUndefined();
  });

  it('reports a missing session as missing', async () => {
    expect(await memorySessionStore.claimOwnership('gone', 'uid-a', true)).toBe('missing');
  });
});
