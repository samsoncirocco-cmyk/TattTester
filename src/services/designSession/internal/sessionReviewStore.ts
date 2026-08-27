/**
 * Where a review run goes after it finishes.
 *
 * The review cron (`/api/cron/session-review`) originally did two things with
 * its findings: `console.log` a summary line, and return JSON. Both evaporate.
 * Vercel's scheduler discards a cron's response body entirely, and the runtime
 * logs it writes to are retained for roughly an hour — so a job that runs once
 * a day writes its only output into a window that has closed long before
 * anybody looks. A review loop whose output disappears is worse than no review
 * loop, because the schedule reads as coverage.
 *
 * So a run persists. The document is the artifact; the log line and the
 * response body are conveniences on top of it.
 *
 * Two properties this deliberately has:
 *
 *  - **Runs accumulate, they do not overwrite.** Each sweep writes its own
 *    document keyed by the instant it ran. A later sweep can diff against the
 *    previous one and answer "is this finding new, or the same one I reported
 *    yesterday?" — which is the question that turns a report into a signal
 *    instead of a daily wall of the same text.
 *  - **A persist failure never fails the sweep.** The reviewing is the valuable
 *    part and it has already happened by the time this is called. The caller
 *    records that the write failed and moves on, rather than throwing away a
 *    completed review because storage was unavailable.
 *
 * Mirrors `store.ts`: an interface, an in-memory implementation for demo mode
 * and tests, a Firestore implementation, and a resolver that picks between
 * them the same way. It does not reuse `SessionStore` because these are a
 * different collection with a different lifetime — sessions are the product's
 * data, review runs are our observations about it, and conflating the two
 * would put our bookkeeping inside the customer's document.
 */
import { ensureAdminApp } from '@/lib/firebase-admin';
import type { SessionReviewReport, SessionReviewSummary } from './sessionReview';

/** The Firestore collection review runs are written to. */
const COLLECTION = 'design_session_reviews';

/** One completed sweep, exactly as the cron saw it. */
export interface SessionReviewRun {
  /** ISO-8601 instant the sweep ran — also the document id. */
  ranAt: string;
  /** The lower bound of the window swept, and the caps that bounded it. */
  window: { sinceIso: string; hours: number; limit: number };
  /** Documents the store handed back. */
  scanned: number;
  /** Documents that survived review without throwing. */
  reviewed: number;
  /** Reviewed sessions carrying at least one finding. */
  flagged: number;
  counts: SessionReviewSummary;
  /**
   * Only the sessions with something to say. A clean session is already
   * counted in `reviewed`; storing every green document would make the
   * findings harder to find, which is the failure this whole job exists to
   * avoid.
   */
  sessions: SessionReviewReport[];
}

export interface SessionReviewStore {
  /** Persist one completed sweep. Keyed by `ranAt`, so runs accumulate. */
  save(run: SessionReviewRun): Promise<void>;
  /** Previous runs, newest first, capped — for diffing one sweep against the last. */
  listRecent(limit: number): Promise<SessionReviewRun[]>;
}

/*
 * Demo mode and tests. Lives on globalThis for the same reason the session
 * store does: Next dev-server module reloading gives module scope a fresh copy
 * per reload, which silently empties the store mid-session.
 */
const globalKey = '__tattSessionReviewRuns';
type ReviewGlobal = typeof globalThis & { [globalKey]?: Map<string, SessionReviewRun> };
const runs: Map<string, SessionReviewRun> =
  (globalThis as ReviewGlobal)[globalKey] ??
  ((globalThis as ReviewGlobal)[globalKey] = new Map<string, SessionReviewRun>());

export const memoryReviewStore: SessionReviewStore = {
  async save(run) {
    runs.set(run.ranAt, structuredClone(run));
  },
  async listRecent(limit) {
    return Array.from(runs.values())
      .sort((a, b) => (a.ranAt < b.ranAt ? 1 : a.ranAt > b.ranAt ? -1 : 0))
      .slice(0, Math.max(0, limit))
      .map((run) => structuredClone(run));
  },
};

/** Test hook: reset the in-memory review runs between cases. */
export function clearMemoryReviewRuns(): void {
  runs.clear();
}

export const firestoreReviewStore: SessionReviewStore = {
  async save(run) {
    const { getFirestore } = await import('firebase-admin/firestore');
    // Same round-trip the session store uses on write: Firestore rejects
    // `undefined`, and a report built from optional fields is full of it.
    const doc = JSON.parse(JSON.stringify(run)) as SessionReviewRun;
    await getFirestore().collection(COLLECTION).doc(run.ranAt).set(doc);
  },
  async listRecent(limit) {
    const { getFirestore } = await import('firebase-admin/firestore');
    // `ranAt` is an ISO-8601 UTC string, which sorts lexically the same way it
    // sorts chronologically — so ordering by the document id needs no extra
    // field and no composite index.
    const snap = await getFirestore()
      .collection(COLLECTION)
      .orderBy('ranAt', 'desc')
      .limit(Math.max(0, limit))
      .get();
    return snap.docs.map((d) => d.data() as SessionReviewRun);
  },
};

export function resolveReviewStore(): SessionReviewStore {
  if (process.env.NEXT_PUBLIC_DEMO_MODE === 'true') return memoryReviewStore;
  if (ensureAdminApp()) return firestoreReviewStore;
  return memoryReviewStore;
}
