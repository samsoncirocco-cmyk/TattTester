// The same-booking re-hold at the persistence layer (REA gap #1).
//
// `requestHold` (pure) already lets a booking re-take its own slot. This pins
// the half that lives in Firestore: `placeHold` must RELEASE the booking's
// earlier hold document in the same transaction it writes the new one, or a
// reload would leave two active holds for one booking and the first would
// keep blocking the slot after the customer has moved on.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Doc = Record<string, unknown>;
const docStore = new Map<string, Doc>();

function matches(doc: Doc, filters: Array<[string, unknown]>) {
  return filters.every(([field, value]) => doc[field] === value);
}

function makeQuery(filters: Array<[string, unknown]>) {
  return {
    where(field: string, _op: string, value: unknown) {
      return makeQuery([...filters, [field, value]]);
    },
    async get() {
      const docs = [...docStore.entries()]
        .filter(([, d]) => matches(d, filters))
        .map(([id, d]) => ({
          id,
          ref: { id },
          data: () => d,
        }));
      return { docs };
    },
  };
}

const fakeDb = {
  collection: () => ({
    ...makeQuery([]),
    doc: (id: string) => ({
      id,
      async get() {
        if (id === "hold_boom") throw new Error("firestore down");
        const d = docStore.get(id);
        return { exists: d !== undefined, data: () => d };
      },
      async set(data: Doc) {
        docStore.set(id, data);
      },
    }),
  }),
  async runTransaction<T>(fn: (tx: unknown) => Promise<T>): Promise<T> {
    const tx = {
      get: (q: { get: () => Promise<unknown> }) => q.get(),
      update: (ref: { id: string }, patch: Doc) => {
        docStore.set(ref.id, { ...(docStore.get(ref.id) ?? {}), ...patch });
      },
      set: (ref: { id: string }, data: Doc) => {
        docStore.set(ref.id, data);
      },
    };
    return fn(tx);
  },
};

vi.mock("firebase-admin/firestore", () => ({
  getFirestore: () => fakeDb,
}));
vi.mock("./firebase-admin", () => ({
  ensureAdminApp: () => "sa-json",
}));

import { placeHold, releaseHoldById, getHold } from "./booking-holds-persistence";

const TZ = "America/Phoenix";
const NOW = Date.parse("2026-08-03T17:00:00.000Z");
const SLOT = { date: "2026-08-06", startTime: "14:00", endTime: "16:00", timezone: TZ };

describe("placeHold — same-booking refresh", () => {
  beforeEach(() => docStore.clear());

  it("re-holding the same slot for the same booking releases the earlier hold doc", async () => {
    const first = await placeHold({ artistId: "artist_a", bookingId: "BK-AAA", slot: SLOT, nowMs: NOW });
    expect(first.ok).toBe(true);
    const firstId = first.ok ? first.hold.holdId : "";

    // The customer reloads and re-holds ten minutes later.
    const second = await placeHold({
      artistId: "artist_a",
      bookingId: "BK-AAA",
      slot: SLOT,
      nowMs: NOW + 10 * 60_000,
    });
    expect(second.ok).toBe(true);
    const secondId = second.ok ? second.hold.holdId : "";
    expect(secondId).not.toBe(firstId);

    expect(docStore.get(firstId)!.status).toBe("released");
    expect(docStore.get(secondId)!.status).toBe("active");

    // Exactly one active hold for this booking.
    const active = [...docStore.values()].filter(
      (d) => d.bookingId === "BK-AAA" && d.status === "active",
    );
    expect(active).toHaveLength(1);
  });

  it("still refuses a DIFFERENT booking the slot the first one holds", async () => {
    await placeHold({ artistId: "artist_a", bookingId: "BK-AAA", slot: SLOT, nowMs: NOW });
    const other = await placeHold({ artistId: "artist_a", bookingId: "BK-BBB", slot: SLOT, nowMs: NOW });
    expect(other).toEqual({ ok: false, reason: "slot_held" });
  });

  it("releaseHoldById marks the doc released and reports false for an unknown id", async () => {
    const placed = await placeHold({ artistId: "artist_a", bookingId: "BK-AAA", slot: SLOT, nowMs: NOW });
    const id = placed.ok ? placed.hold.holdId : "";
    expect(await releaseHoldById(id)).toBe(true);
    expect((await getHold(id))!.status).toBe("released");
    expect(await releaseHoldById("hold_missing")).toBe(false);
  });
});

describe("log hygiene — ids never ride inside the format string", () => {
  // CodeQL (js/tainted-format-string): `holdId` reaches releaseHoldById from
  // the client-facing DELETE route, so it must be a structured argument.
  afterEach(() => vi.restoreAllMocks());

  it("release failure logs the holdId as a separate argument", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await releaseHoldById("hold_boom")).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
    const [format, ctx] = warn.mock.calls[0];
    expect(String(format)).not.toContain("hold_boom");
    expect(ctx).toEqual({ holdId: "hold_boom" });
  });
});
