// Spec 5: the idempotency wrapper used by capture, hold and checkout.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextResponse } from 'next/server';
import {
  REPLAY_UNTIL_HEADER,
  STALE_IN_PROGRESS_MS,
  createMemoryStore,
  setIdempotencyStoreForTests,
  stripeCheckoutIdempotencyKey,
  withIdempotency,
  type IdempotencyStore,
} from './idempotency';

function req(body: unknown, key: string | null = 'key-1', ip = '10.0.0.1') {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'x-forwarded-for': ip,
  };
  if (key) headers['idempotency-key'] = key;
  return new Request('http://localhost/api/x', {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
}

let store: ReturnType<typeof createMemoryStore>;
beforeEach(() => {
  store = createMemoryStore();
  setIdempotencyStoreForTests(store);
});
afterEach(() => setIdempotencyStoreForTests(undefined));

describe('withIdempotency', () => {
  it('first writer runs the handler; a completed key replays the stored response', async () => {
    const handler = vi.fn(async () => NextResponse.json({ bookingId: 'BK-1' }));
    const first = await withIdempotency(req({ a: 1 }), 'capture', 'u1', handler);
    const second = await withIdempotency(req({ a: 1 }), 'capture', 'u1', handler);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(await first.json()).toEqual({ bookingId: 'BK-1' });
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual({ bookingId: 'BK-1' });
    expect(second.headers.get('idempotent-replayed')).toBe('true');
  });

  it('a concurrent same-key request gets 409 REQUEST_IN_FLIGHT', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const handler = vi.fn(async () => {
      await gate;
      return NextResponse.json({ ok: true });
    });
    const first = withIdempotency(req({ a: 1 }), 'hold', 'u1', handler);
    // Let the first request record its in_progress marker.
    await new Promise((r) => setTimeout(r, 0));
    const second = await withIdempotency(req({ a: 1 }), 'hold', 'u1', handler);
    expect(second.status).toBe(409);
    expect((await second.json()).code).toBe('REQUEST_IN_FLIGHT');
    release();
    expect((await first).status).toBe(200);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('the same key with a different body is 422 IDEMPOTENCY_KEY_REUSED', async () => {
    const handler = vi.fn(async () => NextResponse.json({ ok: true }));
    await withIdempotency(req({ a: 1 }), 'capture', 'u1', handler);
    const res = await withIdempotency(req({ a: 2 }), 'capture', 'u1', handler);
    expect(res.status).toBe(422);
    expect((await res.json()).code).toBe('IDEMPOTENCY_KEY_REUSED');
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('a stale in_progress record (timed-out function) is taken over', async () => {
    let now = 1_000_000;
    const never = vi.fn(() => new Promise<Response>(() => undefined));
    void withIdempotency(req({ a: 1 }), 'capture', 'u1', never, { nowMs: () => now });
    await new Promise((r) => setTimeout(r, 0));
    now += STALE_IN_PROGRESS_MS + 1;
    const handler = vi.fn(async () => NextResponse.json({ ok: true }));
    const res = await withIdempotency(req({ a: 1 }), 'capture', 'u1', handler, { nowMs: () => now });
    expect(res.status).toBe(200);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('a refusal (429) is not stored, so a later retry runs fresh', async () => {
    const handler = vi
      .fn()
      .mockResolvedValueOnce(NextResponse.json({ error: 'slow down' }, { status: 429 }))
      .mockResolvedValueOnce(NextResponse.json({ ok: true }));
    const a = await withIdempotency(req({ a: 1 }), 'capture', 'u1', handler);
    const b = await withIdempotency(req({ a: 1 }), 'capture', 'u1', handler);
    expect(a.status).toBe(429);
    expect(b.status).toBe(200);
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it('keys are scoped by route and caller', async () => {
    const handler = vi.fn(async () => NextResponse.json({ ok: true }));
    await withIdempotency(req({ a: 1 }), 'capture', 'u1', handler);
    await withIdempotency(req({ a: 1 }), 'hold', 'u1', handler);
    await withIdempotency(req({ a: 1 }), 'capture', 'u2', handler);
    expect(handler).toHaveBeenCalledTimes(3);
  });

  it('a replay never outlives the handler-declared window', async () => {
    let now = 5_000;
    const handler = vi.fn(async () =>
      NextResponse.json({ sessionUrl: 'https://x' }, { headers: { [REPLAY_UNTIL_HEADER]: String(now + 100) } }),
    );
    const first = await withIdempotency(req({ a: 1 }), 'checkout', 'u1', handler, { nowMs: () => now });
    // The internal header never reaches the client.
    expect(first.headers.get(REPLAY_UNTIL_HEADER)).toBeNull();
    now += 101;
    await withIdempotency(req({ a: 1 }), 'checkout', 'u1', handler, { nowMs: () => now });
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it('without the header the wrapper does nothing', async () => {
    const handler = vi.fn(async () => NextResponse.json({ ok: true }));
    await withIdempotency(req({ a: 1 }, null), 'capture', 'u1', handler);
    await withIdempotency(req({ a: 1 }, null), 'capture', 'u1', handler);
    expect(handler).toHaveBeenCalledTimes(2);
    expect(store.records.size).toBe(0);
  });

  it('fails open when the store is unreachable', async () => {
    const broken: IdempotencyStore = {
      begin: vi.fn(async () => {
        throw new Error('firestore down');
      }),
      complete: vi.fn(),
      abandon: vi.fn(),
    };
    setIdempotencyStoreForTests(broken);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const handler = vi.fn(async () => NextResponse.json({ ok: true }));
    const res = await withIdempotency(req({ a: 1 }), 'capture', 'u1', handler);
    expect(res.status).toBe(200);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(broken.complete).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('fails open when no store is configured', async () => {
    setIdempotencyStoreForTests(null);
    const handler = vi.fn(async () => NextResponse.json({ ok: true }));
    await withIdempotency(req({ a: 1 }), 'capture', 'u1', handler);
    await withIdempotency(req({ a: 1 }), 'capture', 'u1', handler);
    expect(handler).toHaveBeenCalledTimes(2);
  });
});

describe('stripeCheckoutIdempotencyKey', () => {
  it('follows the spec shape and changes when the params change', () => {
    const a = stripeCheckoutIdempotencyKey({ bookingId: 'BK-1', holdId: 'hold_1', amountCents: 16500, params: { x: 1 } });
    const b = stripeCheckoutIdempotencyKey({ bookingId: 'BK-1', holdId: 'hold_1', amountCents: 16500, params: { x: 1 } });
    const c = stripeCheckoutIdempotencyKey({ bookingId: 'BK-1', holdId: 'hold_1', amountCents: 16500, params: { x: 2 } });
    expect(a).toMatch(/^checkout:BK-1:hold_1:16500:[0-9a-f]{16}$/);
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(stripeCheckoutIdempotencyKey({ amountCents: 1, params: {} })).toMatch(/^checkout:nobooking:nohold:1:/);
  });
});
