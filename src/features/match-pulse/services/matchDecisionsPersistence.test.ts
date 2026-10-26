// @vitest-environment node
// Exercises the Firestore persistence against a tiny in-memory fake: enough
// of the admin query surface (where / orderBy / limit / count / batch) for
// the upsert, cap-eviction and scoped-read behaviour to be checked without a
// live project.
import { beforeEach, describe, expect, it, vi } from "vitest";

type Doc = Record<string, unknown>;
const store = new Map<string, Doc>();

class FakeQuery {
  constructor(
    private filters: Array<(d: Doc) => boolean> = [],
    private order: { field: string; dir: "asc" | "desc" } | null = null,
    private max: number | null = null,
  ) {}
  where(field: string, op: string, value: unknown) {
    const f = (d: Doc) => {
      const v = d[field] as number;
      if (op === "==") return d[field] === value;
      if (op === ">=") return v >= (value as number);
      throw new Error(`unsupported op ${op}`);
    };
    return new FakeQuery([...this.filters, f], this.order, this.max);
  }
  orderBy(field: string, dir: "asc" | "desc" = "asc") {
    return new FakeQuery(this.filters, { field, dir }, this.max);
  }
  limit(n: number) {
    return new FakeQuery(this.filters, this.order, n);
  }
  private rows() {
    let rows = [...store.entries()].filter(([, d]) => this.filters.every((f) => f(d)));
    if (this.order) {
      const { field, dir } = this.order;
      rows.sort(([, a], [, b]) =>
        dir === "asc"
          ? (a[field] as number) - (b[field] as number)
          : (b[field] as number) - (a[field] as number),
      );
    }
    if (this.max !== null) rows = rows.slice(0, this.max);
    return rows;
  }
  count() {
    return { get: async () => ({ data: () => ({ count: this.rows().length }) }) };
  }
  async get() {
    return {
      docs: this.rows().map(([id, d]) => ({ id, ref: { id }, data: () => d })),
    };
  }
}

const fakeDb = {
  collection: () =>
    Object.assign(new FakeQuery(), {
      doc: (id: string) => ({
        id,
        get: async () => ({ exists: store.has(id), data: () => store.get(id) }),
        set: async (d: Doc) => void store.set(id, d),
        delete: async () => void store.delete(id),
      }),
    }),
  batch: () => {
    const ops: string[] = [];
    return {
      delete: (ref: { id: string }) => ops.push(ref.id),
      commit: async () => ops.forEach((id) => store.delete(id)),
    };
  },
};

vi.mock("@/lib/firebase-admin", () => ({ ensureAdminApp: () => "sa-json" }));
vi.mock("firebase-admin/firestore", () => ({ getFirestore: () => fakeDb }));

import {
  recordDecision,
  removeDecision,
  listDecisions,
  decisionDocId,
  MAX_DECISIONS_PER_UID,
  DECISION_TTL_MS,
} from "./matchDecisionsPersistence";

beforeEach(() => store.clear());

describe("recordDecision", () => {
  it("upserts one document per (uid, artistId); a pass overwrites a pin", async () => {
    await recordDecision({ uid: "u", artistId: "a1", decision: "pin", nowMs: 10 });
    await recordDecision({ uid: "u", artistId: "a1", decision: "pass", nowMs: 20 });
    expect(store.size).toBe(1);
    const doc = store.get(decisionDocId("u", "a1"))!;
    expect(doc.decision).toBe("pass");
    // First-decision time survives; updatedAt moves.
    expect(doc.decidedAt).toBe(10);
    expect(doc.updatedAt).toBe(20);
    expect(doc.source).toBe("swipe");
  });

  it("keeps a prior dsId when a later write omits it", async () => {
    await recordDecision({ uid: "u", artistId: "a1", decision: "pin", dsId: "ds-1", nowMs: 1 });
    await recordDecision({ uid: "u", artistId: "a1", decision: "pass", nowMs: 2 });
    expect(store.get(decisionDocId("u", "a1"))!.dsId).toBe("ds-1");
  });

  it("evicts the oldest decisions beyond the per-uid cap", async () => {
    for (let i = 0; i < MAX_DECISIONS_PER_UID; i += 1) {
      store.set(decisionDocId("u", `a${i}`), {
        uid: "u", artistId: `a${i}`, decision: "pass", dsId: null,
        source: "swipe", decidedAt: i, updatedAt: i,
      });
    }
    await recordDecision({ uid: "u", artistId: "fresh", decision: "pin", nowMs: 10_000 });
    expect(store.size).toBe(MAX_DECISIONS_PER_UID);
    expect(store.has(decisionDocId("u", "a0"))).toBe(false);
    expect(store.has(decisionDocId("u", "fresh"))).toBe(true);
  });
});

describe("removeDecision / listDecisions", () => {
  it("removes one decision and lists the rest newest first, for that uid only", async () => {
    await recordDecision({ uid: "u", artistId: "a1", decision: "pin", nowMs: 1 });
    await recordDecision({ uid: "u", artistId: "a2", decision: "pass", nowMs: 2 });
    await recordDecision({ uid: "other", artistId: "a3", decision: "pin", nowMs: 3 });
    await removeDecision("u", "a1");
    const rows = await listDecisions("u", { nowMs: 10 });
    expect(rows).toEqual([{ artistId: "a2", decision: "pass", dsId: null, updatedAt: 2 }]);
  });

  it("scopes to a design session when dsId is given", async () => {
    await recordDecision({ uid: "u", artistId: "a1", decision: "pin", dsId: "ds-1", nowMs: 1 });
    await recordDecision({ uid: "u", artistId: "a2", decision: "pin", dsId: "ds-2", nowMs: 2 });
    const rows = await listDecisions("u", { dsId: "ds-2", nowMs: 10 });
    expect(rows.map((r) => r.artistId)).toEqual(["a2"]);
  });

  it("drops decisions older than the 30-day window from the unscoped read", async () => {
    const now = DECISION_TTL_MS * 2;
    await recordDecision({ uid: "u", artistId: "old", decision: "pass", nowMs: 1 });
    await recordDecision({ uid: "u", artistId: "new", decision: "pass", nowMs: now - 1 });
    const rows = await listDecisions("u", { nowMs: now });
    expect(rows.map((r) => r.artistId)).toEqual(["new"]);
  });
});
