/**
 * Cron: review recent design sessions and report what went wrong.
 *
 * TatT is pre-launch, so every session in the corpus is a test session — and
 * test sessions currently evaporate. Somebody drives one, notices something
 * felt off, and the observation never becomes a fact anybody can act on. This
 * route turns the ones that CAN be settled mechanically into evidence, on a
 * schedule, with no human in the loop and no spend:
 *
 *  1. PROMPT CONTRACT — the rendered prompt is persisted verbatim on every
 *     cut, and the DesignState is persisted beside it, so ADR-0060's question
 *     ("does the prompt still say what the state says?") can be re-asked after
 *     the fact for free. See src/services/designSession/internal/sessionReview.ts
 *     for exactly how much of that check survives post-hoc — the prompt body
 *     is persisted, the request wrapper (reference images, the text guard,
 *     the model id) is NOT, and sessions with no state cannot be checked at
 *     all and are reported as unchecked rather than as clean.
 *  2. ZERO-RENDER STALL (issue #376) — sessions that took conversation turns
 *     and produced no image at all. No image review could ever catch this,
 *     because there is no image; it is a query over what the document does
 *     not contain.
 *
 * DELIBERATELY NOT HERE: any model call. No LLM, no vision judge, no re-render.
 * A review that bills against BUDGET_MAX_SPEND_CENTS every night is a review
 * that gets switched off, and the checks above need no judgment to answer. The
 * judgment layer is separate, later work.
 *
 * Invoked by the Vercel cron scheduler (see vercel.json) and guarded by a
 * shared secret rather than user auth: it must present
 * `Authorization: Bearer <CRON_SECRET>`. Vercel cron issues GET requests, so we
 * accept both GET and POST. Fails closed — if CRON_SECRET is unset or the
 * header doesn't match (constant-time), we return 401.
 */
import { NextRequest, NextResponse } from 'next/server';
import { timingSafeEqual } from 'crypto';
import { resolveSessionStore } from '@/services/designSession/internal/store';
import {
  reviewSession,
  summarizeReviews,
} from '@/services/designSession/internal/sessionReview';
import {
  resolveReviewStore,
  type SessionReviewRun,
} from '@/services/designSession/internal/sessionReviewStore';
import type { SessionReviewReport } from '@/services/designSession/internal/sessionReview';

export const runtime = 'nodejs';

/**
 * How far back a sweep looks by default. One day plus an hour of slack, so a
 * daily schedule that drifts or retries never leaves a gap between windows —
 * re-reviewing a session is free and idempotent, missing one is not.
 */
const DEFAULT_LOOKBACK_HOURS = 25;

/**
 * Hard cap on sessions per sweep. The window is the intended limiter; this is
 * the backstop that keeps one busy day from turning a cron run into an
 * unbounded Firestore scan. Raise it when the corpus outgrows it, on purpose.
 */
const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 1000;

/** Constant-time bearer-token check against CRON_SECRET. */
function isAuthorized(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;

  const header = req.headers.get('authorization') ?? '';
  const expected = `Bearer ${secret}`;

  const a = Buffer.from(header);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Read a positive numeric query param, falling back to `fallback` on anything
 * absent, unparseable or non-positive. An operator re-running a sweep by hand
 * ("?hours=168") is the intended caller; a typo must widen nothing.
 */
function positiveParam(req: NextRequest, name: string, fallback: number, max: number): number {
  const raw = new URL(req.url).searchParams.get(name);
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return Math.min(Math.floor(value), max);
}

async function handle(req: NextRequest) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const hours = positiveParam(req, 'hours', DEFAULT_LOOKBACK_HOURS, 24 * 90);
  const limit = positiveParam(req, 'limit', DEFAULT_LIMIT, MAX_LIMIT);
  // One clock reading for the whole sweep, passed down rather than re-read per
  // session, so every session in a run is judged against the same instant.
  const now = Date.now();
  const sinceIso = new Date(now - hours * 60 * 60 * 1000).toISOString();

  const store = resolveSessionStore();
  const sessions = await store.listRecentlyUpdated(sinceIso, limit);

  const reports: SessionReviewReport[] = [];
  for (const session of sessions) {
    try {
      reports.push(reviewSession(session, { now }));
    } catch (err) {
      // One malformed document must not abandon the sweep — the whole point of
      // this job is the sessions it manages to review, not a clean exit.
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[cron/session-review] review failed for session ${session?.id}:`, message);
    }
  }

  const flagged = reports.filter((report) => report.findings.length > 0);
  const counts = summarizeReviews(reports);

  const run: SessionReviewRun = {
    ranAt: new Date(now).toISOString(),
    window: { sinceIso, hours, limit },
    scanned: sessions.length,
    reviewed: reports.length,
    flagged: flagged.length,
    counts,
    sessions: flagged,
  };

  // Persist before logging, because the log line is the copy that expires.
  // Vercel discards a cron's response body and retains runtime logs for about
  // an hour, so a daily job that only logs has written its findings into a
  // window that closed long before anyone reads it. A failure here is recorded
  // and swallowed: the review already happened, and throwing it away because
  // storage was unavailable would be strictly worse than keeping it in the log.
  let persisted = false;
  try {
    await resolveReviewStore().save(run);
    persisted = true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[cron/session-review] failed to persist the review run:', message);
  }

  console.log(
    `[cron/session-review] reviewed ${reports.length} session(s) since ${sinceIso}: ` +
      `${flagged.length} flagged — ${counts.promptContract} contract, ` +
      `${counts.promptContractAdvisory} advisory, ${counts.zeroRenderStall} zero-render, ` +
      `${counts.contractNotCheckable} uncheckable.` +
      (persisted ? '' : ' NOT PERSISTED — this log line is the only copy.')
  );

  return NextResponse.json({
    window: { sinceIso, hours, limit },
    scanned: sessions.length,
    reviewed: reports.length,
    flagged: flagged.length,
    counts,
    /**
     * Whether the run survived past this response. False means the findings
     * exist only in the log line above, which expires — worth saying out loud
     * rather than letting a 200 imply the report was kept.
     */
    persisted,
    // Only the sessions with something to say. A green session's counts are
    // already folded into `reviewed`; echoing every clean document back would
    // bury the findings this job exists to surface.
    sessions: flagged,
  });
}

export async function POST(req: NextRequest) {
  return handle(req);
}

export async function GET(req: NextRequest) {
  return handle(req);
}
