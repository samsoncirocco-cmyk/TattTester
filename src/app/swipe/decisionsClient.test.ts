// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SignInRequiredError } from "@/lib/client-api-auth";
import {
  createDecisionsClient,
  LEGACY_SWIPES_KEY,
  QUEUE_CAP,
  RETRY_DELAYS_MS,
} from "./decisionsClient";

vi.mock("@/lib/client-api-auth", async (orig) => {
  const mod = await orig<typeof import("@/lib/client-api-auth")>();
  return { ...mod, getApiAuthHeaders: vi.fn() };
});

const ok = () => ({ ok: true, status: 204, json: async () => ({}) }) as Response;
const fail = () => ({ ok: false, status: 503, json: async () => ({}) }) as Response;

function makeClient(fetchImpl: (...args: unknown[]) => Promise<Response>) {
  const timers: Array<{ fn: () => void; ms: number }> = [];
  const fetchMock = vi.fn(fetchImpl);
  const client = createDecisionsClient({
    fetch: fetchMock as unknown as typeof fetch,
    authHeaders: async () => ({ Authorization: "Bearer t" }),
    setTimeout: (fn, ms) => {
      timers.push({ fn, ms });
      return timers.length;
    },
    clearTimeout: () => {},
    storage: localStorage,
  });
  const runTimers = async () => {
    const due = timers.splice(0, timers.length);
    for (const t of due) t.fn();
    await flushMicrotasks();
  };
  return { client, fetchMock, timers, runTimers };
}

async function flushMicrotasks() {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
}

beforeEach(() => localStorage.clear());

describe("DecisionsClient.record", () => {
  it("returns before the POST resolves and sends uid-free JSON", async () => {
    let resolveFetch!: (r: Response) => void;
    const { client, fetchMock } = makeClient(
      () => new Promise<Response>((res) => (resolveFetch = res)),
    );
    client.record("a1", "pin", "ds-1");
    expect(client.pendingCount()).toBe(1);
    await flushMicrotasks();
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/v1/match/decision",
      expect.objectContaining({ method: "POST" }),
    );
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body).toEqual({ artistId: "a1", decision: "pin", dsId: "ds-1" });
    resolveFetch(ok());
    await flushMicrotasks();
    expect(client.pendingCount()).toBe(0);
  });

  it("retries with 1/3/9 s backoff and reports unsaved after the third failure", async () => {
    const { client, fetchMock, timers, runTimers } = makeClient(async () => fail());
    const statuses: boolean[] = [];
    client.subscribe((s) => statuses.push(s.unsaved));
    client.record("a1", "pass");
    await flushMicrotasks();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(timers.at(-1)?.ms).toBe(RETRY_DELAYS_MS[0]);
    await runTimers();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(timers.at(-1)?.ms).toBe(RETRY_DELAYS_MS[1]);
    expect(statuses.at(-1)).toBe(false);
    await runTimers();
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(timers.at(-1)?.ms).toBe(RETRY_DELAYS_MS[2]);
    expect(statuses.at(-1)).toBe(true);
    // Still queued: it keeps trying rather than dropping the decision.
    expect(client.pendingCount()).toBe(1);
  });

  it("clears unsaved once the queue drains", async () => {
    let calls = 0;
    const { client, runTimers } = makeClient(async () => (calls++ < 3 ? fail() : ok()));
    const statuses: boolean[] = [];
    client.subscribe((s) => statuses.push(s.unsaved));
    client.record("a1", "pass");
    await flushMicrotasks();
    await runTimers();
    await runTimers();
    expect(statuses.at(-1)).toBe(true);
    await runTimers();
    expect(statuses.at(-1)).toBe(false);
    expect(client.pendingCount()).toBe(0);
  });

  it("does not retry a 4xx — that is the caller's bug", async () => {
    const { client, fetchMock, timers } = makeClient(
      async () => ({ ok: false, status: 400, json: async () => ({}) }) as Response,
    );
    client.record("a1", "pass");
    await flushMicrotasks();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(timers).toHaveLength(0);
    expect(client.pendingCount()).toBe(0);
  });

  it("supersedes a queued decision on the same artist and caps the queue", async () => {
    const { client } = makeClient(() => new Promise<Response>(() => {}));
    for (let i = 0; i < QUEUE_CAP + 5; i += 1) client.record(`a${i}`, "pass");
    expect(client.pendingCount()).toBe(QUEUE_CAP);
    client.record("a7", "pin");
    expect(client.pendingCount()).toBe(QUEUE_CAP);
  });

  it("drops the queue when the caller is signed out", async () => {
    const fetchMock = vi.fn(async () => ok());
    const client = createDecisionsClient({
      fetch: fetchMock as unknown as typeof fetch,
      authHeaders: async () => {
        throw new SignInRequiredError();
      },
      setTimeout: () => 0,
      clearTimeout: () => {},
      storage: null,
    });
    client.record("a1", "pin");
    await flushMicrotasks();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(client.pendingCount()).toBe(0);
  });
});

describe("DecisionsClient.remove", () => {
  it("sends DELETE with the artist id", async () => {
    const { client, fetchMock } = makeClient(async () => ok());
    client.remove("a 1");
    await flushMicrotasks();
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/v1/match/decision?artistId=a%201",
      expect.objectContaining({ method: "DELETE" }),
    );
  });
});

describe("DecisionsClient.flushOnPagehide", () => {
  it("sends what is still queued with keepalive", async () => {
    const { client, fetchMock } = makeClient(() => new Promise<Response>(() => {}));
    client.record("a1", "pin");
    client.record("a2", "pass");
    await flushMicrotasks();
    fetchMock.mockImplementation(async () => ok());
    client.flushOnPagehide();
    await flushMicrotasks();
    const keepalive = fetchMock.mock.calls.filter(
      ([, init]) => (init as RequestInit).keepalive === true,
    );
    expect(keepalive.length).toBeGreaterThanOrEqual(1);
    expect(client.pendingCount()).toBe(0);
  });
});

describe("DecisionsClient.fetchDecisions", () => {
  it("reads the caller's decisions and removes the legacy localStorage key", async () => {
    localStorage.setItem(LEGACY_SWIPES_KEY, '{"user-123":{}}');
    const { client, fetchMock } = makeClient(
      async () =>
        ({
          ok: true,
          status: 200,
          json: async () => ({ decisions: [{ artistId: "a1", decision: "pin", dsId: null, updatedAt: 1 }] }),
        }) as Response,
    );
    const rows = await client.fetchDecisions("ds-1");
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/v1/match/decisions?ds=ds-1",
      expect.objectContaining({ headers: { Authorization: "Bearer t" } }),
    );
    expect(rows).toHaveLength(1);
    expect(localStorage.getItem(LEGACY_SWIPES_KEY)).toBeNull();
  });

  it("surfaces a failed read as an error, leaving the legacy key alone", async () => {
    localStorage.setItem(LEGACY_SWIPES_KEY, "{}");
    const { client } = makeClient(async () => fail());
    await expect(client.fetchDecisions()).rejects.toThrow("HTTP 503");
    expect(localStorage.getItem(LEGACY_SWIPES_KEY)).toBe("{}");
  });
});
