/**
 * Browser-side client for swipe decisions (spec 13).
 *
 * The deck must stay instant: a swipe updates local state first and the POST
 * rides behind it. Failures are retried quietly (3 tries, 1/3/9 s backoff);
 * only after that does the UI get told "not saved yet", and the queue keeps
 * trying on a slow cadence rather than giving up. On `pagehide` whatever is
 * still queued is flushed with `keepalive` so the last swipe survives a tab
 * close. The queue is in memory only and bounded; a closed tab with a dead
 * network loses it, accepted (spec 13 §5.6).
 *
 * The legacy `tattester_swipes` localStorage key (hardcoded 'user-123') is
 * ignored and removed after the first successful hydrate.
 */
import { getApiAuthHeaders, SignInRequiredError } from "@/lib/client-api-auth";

export type Decision = "pin" | "pass";

export interface StoredDecision {
  artistId: string;
  decision: Decision;
  dsId: string | null;
  updatedAt: number;
}

export interface DecisionsStatus {
  /** True once a decision has failed all fast retries and is still queued. */
  unsaved: boolean;
}

type QueueItem =
  | { kind: "record"; artistId: string; decision: Decision; dsId: string | null; attempts: number }
  | { kind: "remove"; artistId: string; attempts: number };

export const LEGACY_SWIPES_KEY = "tattester_swipes";
export const RETRY_DELAYS_MS = [1000, 3000, 9000];
export const SLOW_RETRY_MS = 30_000;
export const QUEUE_CAP = 200;

interface Deps {
  fetch: typeof fetch;
  authHeaders: () => Promise<Record<string, string>>;
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
  storage: Pick<Storage, "removeItem"> | null;
}

export class DecisionsClient {
  private queue: QueueItem[] = [];
  private flushing = false;
  private timer: unknown = null;
  private listeners = new Set<(s: DecisionsStatus) => void>();
  private status: DecisionsStatus = { unsaved: false };
  private pagehideBound = false;

  constructor(private deps: Deps) {}

  subscribe(listener: (s: DecisionsStatus) => void): () => void {
    this.listeners.add(listener);
    listener(this.status);
    return () => this.listeners.delete(listener);
  }

  /** Optimistic: returns at once; the write happens in the background. */
  record(artistId: string, decision: Decision, dsId: string | null = null): void {
    this.enqueue({ kind: "record", artistId, decision, dsId, attempts: 0 });
  }

  remove(artistId: string): void {
    this.enqueue({ kind: "remove", artistId, attempts: 0 });
  }

  /** Decisions for the caller; throws SignInRequiredError when signed out. */
  async fetchDecisions(dsId: string | null = null): Promise<StoredDecision[]> {
    const headers = await this.deps.authHeaders();
    const url = dsId
      ? `/api/v1/match/decisions?ds=${encodeURIComponent(dsId)}`
      : "/api/v1/match/decisions";
    const res = await this.deps.fetch(url, { headers });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = (await res.json()) as { decisions?: StoredDecision[] };
    // Hydrated from the server once: the 'user-123' key has nothing to add.
    try {
      this.deps.storage?.removeItem(LEGACY_SWIPES_KEY);
    } catch {
      /* storage unavailable — nothing to clean */
    }
    return Array.isArray(data.decisions) ? data.decisions : [];
  }

  /** Flush what is left with keepalive — the tab is going away. */
  flushOnPagehide(): void {
    const items = this.queue.splice(0, this.queue.length);
    if (items.length === 0) return;
    void this.deps
      .authHeaders()
      .then((headers) => {
        for (const item of items) {
          void this.send(item, headers, true).catch(() => {});
        }
      })
      .catch(() => {});
  }

  pendingCount(): number {
    return this.queue.length;
  }

  private enqueue(item: QueueItem): void {
    // A newer decision on the same artist supersedes the queued one — the
    // server document is last-write-wins anyway, so sending both is waste.
    this.queue = this.queue.filter((q) => q.artistId !== item.artistId);
    if (this.queue.length >= QUEUE_CAP) this.queue.shift();
    this.queue.push(item);
    this.bindPagehide();
    void this.flush();
  }

  private bindPagehide(): void {
    if (this.pagehideBound || typeof window === "undefined") return;
    this.pagehideBound = true;
    window.addEventListener("pagehide", () => this.flushOnPagehide());
  }

  private setStatus(next: DecisionsStatus): void {
    if (next.unsaved === this.status.unsaved) return;
    this.status = next;
    this.listeners.forEach((l) => l(this.status));
  }

  private async send(
    item: QueueItem,
    headers: Record<string, string>,
    keepalive = false,
  ): Promise<void> {
    const init: RequestInit = { headers: { ...headers }, keepalive };
    let res: Response;
    if (item.kind === "record") {
      res = await this.deps.fetch("/api/v1/match/decision", {
        ...init,
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
        body: JSON.stringify({
          artistId: item.artistId,
          decision: item.decision,
          ...(item.dsId ? { dsId: item.dsId } : {}),
        }),
      });
    } else {
      res = await this.deps.fetch(
        `/api/v1/match/decision?artistId=${encodeURIComponent(item.artistId)}`,
        { ...init, method: "DELETE" },
      );
    }
    // A 4xx is the caller's bug, not the network's — retrying cannot fix it.
    if (!res.ok && res.status >= 500) throw new Error(`HTTP ${res.status}`);
  }

  private async flush(): Promise<void> {
    if (this.flushing) return;
    this.flushing = true;
    try {
      while (this.queue.length > 0) {
        const item = this.queue[0];
        let headers: Record<string, string>;
        try {
          headers = await this.deps.authHeaders();
        } catch (err) {
          if (err instanceof SignInRequiredError) {
            // Signed out mid-deck: nothing can be written for anyone.
            this.queue = [];
            return;
          }
          throw err;
        }
        try {
          await this.send(item, headers);
          this.queue.shift();
          if (this.queue.length === 0) this.setStatus({ unsaved: false });
        } catch {
          item.attempts += 1;
          const delay =
            RETRY_DELAYS_MS[item.attempts - 1] ?? SLOW_RETRY_MS;
          if (item.attempts >= RETRY_DELAYS_MS.length) {
            this.setStatus({ unsaved: true });
          }
          this.scheduleRetry(delay);
          return;
        }
      }
    } finally {
      this.flushing = false;
    }
  }

  private scheduleRetry(ms: number): void {
    if (this.timer !== null) this.deps.clearTimeout(this.timer);
    this.timer = this.deps.setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, ms);
  }
}

export function createDecisionsClient(overrides: Partial<Deps> = {}): DecisionsClient {
  return new DecisionsClient({
    fetch: (...args) => fetch(...args),
    authHeaders: getApiAuthHeaders,
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
    storage: typeof window !== "undefined" ? window.localStorage : null,
    ...overrides,
  });
}

export const decisionsClient = createDecisionsClient();
