// /design?ds= plumbing (spec 7): the session id in the address bar, the
// per-session resume key a signed-out browser proves itself with, and the
// read that hydrates a reload.

import { useEffect, useRef } from 'react';
import { getOptionalApiAuthHeaders } from '@/lib/client-api-auth';
import type { DesignSession } from '@/services/designSession/types';
import {
  DESIGN_SESSION_KEY_HEADER,
  type SessionResumeView,
} from '@/services/designSession/resumeContract';

export const RESUME_LINE = 'picking up where you left off.';
export const STILL_DRAWING_LINE = 'still drawing — this is the same round, not a new one.';
export const NOT_FOUND_LINE = 'couldn’t find that sketch — starting fresh.';
export const LOST_RENDER_LINE = 'that one got lost on my end — run it again?';
export const RENDER_DID_NOT_LAND_LINE = 'that one didn’t land — run it again?';
export const NEW_SKETCH_LABEL = 'start a new sketch';

export const SESSION_QUERY_PARAM = 'ds';
const KEY_PREFIX = 'tattester:design-session-key:';

/** Keep the resume key this browser was handed for a new session. */
export function rememberResumeKey(sessionId: string, key: string): void {
  try {
    window.localStorage.setItem(KEY_PREFIX + sessionId, key);
  } catch {
    // Private mode or blocked storage: resume then needs a signed-in owner.
  }
}

export function readResumeKey(sessionId: string): string | null {
  try {
    return window.localStorage.getItem(KEY_PREFIX + sessionId);
  } catch {
    return null;
  }
}

/**
 * Put the session in the address bar without a navigation: a reload or a
 * copied link lands back here. `?prompt=` is dropped, since `ds` wins.
 */
export function writeSessionIdToUrl(sessionId: string): void {
  try {
    const url = new URL(window.location.href);
    if (url.searchParams.get(SESSION_QUERY_PARAM) === sessionId) return;
    url.searchParams.set(SESSION_QUERY_PARAM, sessionId);
    url.searchParams.delete('prompt');
    window.history.replaceState(window.history.state, '', url.toString());
  } catch {
    // The session still works; only reload-resume is lost.
  }
}

export function clearSessionIdFromUrl(): void {
  try {
    const url = new URL(window.location.href);
    if (!url.searchParams.has(SESSION_QUERY_PARAM)) return;
    url.searchParams.delete(SESSION_QUERY_PARAM);
    window.history.replaceState(window.history.state, '', url.toString());
  } catch {
    // Nothing to undo.
  }
}

export type ResumeFetchResult =
  | { status: 'found'; session: DesignSession; resume?: SessionResumeView }
  | { status: 'missing' }
  | { status: 'error' };

/**
 * GET /api/v1/design-session/{id} with whatever identity this browser has:
 * the signed-in token when there is one, the session's resume key when it
 * holds one. 401/403/404 all read as "missing": a stranger's session and a
 * deleted one look the same from here.
 */
export async function fetchSessionForResume(sessionId: string): Promise<ResumeFetchResult> {
  try {
    const headers: Record<string, string> = { ...(await getOptionalApiAuthHeaders()) };
    const key = readResumeKey(sessionId);
    if (key) headers[DESIGN_SESSION_KEY_HEADER] = key;
    const res = await fetch(`/api/v1/design-session/${encodeURIComponent(sessionId)}`, {
      method: 'GET',
      headers,
      cache: 'no-store',
    });
    if (res.status === 401 || res.status === 403 || res.status === 404) return { status: 'missing' };
    if (!res.ok) return { status: 'error' };
    const data = (await res.json()) as { session?: DesignSession; resume?: SessionResumeView };
    if (!data?.session) return { status: 'error' };
    return { status: 'found', session: data.session, ...(data.resume ? { resume: data.resume } : {}) };
  } catch {
    return { status: 'error' };
  }
}

/** How often a resumed page re-reads a render that is still running. */
export const RESUME_POLL_MS = 3000;

/**
 * Re-read the session every `intervalMs` while `active`, one request at a
 * time, handing each result to `onResult`. Stops the moment `active` goes
 * false or the component unmounts.
 */
export function useSessionPoll(
  sessionId: string | undefined,
  active: boolean,
  onResult: (result: ResumeFetchResult) => void,
  intervalMs: number = RESUME_POLL_MS
): void {
  const callback = useRef(onResult);
  useEffect(() => {
    callback.current = onResult;
  });

  useEffect(() => {
    if (!active || !sessionId) return;
    let cancelled = false;
    let inFlight = false;
    const timer = setInterval(() => {
      if (inFlight) return;
      inFlight = true;
      fetchSessionForResume(sessionId)
        .then((result) => {
          if (!cancelled) callback.current(result);
        })
        .finally(() => {
          inFlight = false;
        });
    }, intervalMs);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [sessionId, active, intervalMs]);
}
