import { getOptionalApiAuthHeaders } from '@/lib/client-api-auth';
import type { DesignSessionResume } from '@/services/designSession/types';

const STORAGE_KEY = 'tatt.design.sessionId';

export function readRememberedDesignSession(): string | null {
  if (typeof window === 'undefined') return null;
  try {
    const value = window.sessionStorage.getItem(STORAGE_KEY);
    return value && value.trim() ? value.trim() : null;
  } catch {
    return null;
  }
}

export function rememberDesignSession(sessionId: string): void {
  try {
    window.sessionStorage.setItem(STORAGE_KEY, sessionId);
  } catch {
    // Private mode. The account pointer still covers a signed-in reload
    // after the first charged action.
  }
}

export function forgetRememberedDesignSession(): void {
  try {
    window.sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    // Ignore.
  }
}

/** Null when there is nothing to resume, including a forbidden id. */
export async function fetchDesignResume(): Promise<DesignSessionResume | null> {
  const hinted = readRememberedDesignSession();
  const headers = await getOptionalApiAuthHeaders();
  if (!hinted && !headers.Authorization) return null;

  const params = hinted ? `?sessionId=${encodeURIComponent(hinted)}` : '';
  const res = await fetch(`/api/v1/design-session/resume${params}`, {
    method: 'GET',
    headers,
    cache: 'no-store',
  });
  if (!res.ok) return null;
  const body = (await res.json()) as { resume?: DesignSessionResume | null };
  return body.resume ?? null;
}

export async function dismissDesignResume(sessionId: string): Promise<void> {
  const headers = await getOptionalApiAuthHeaders();
  await fetch('/api/v1/design-session/resume', {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId }),
  }).catch(() => undefined);
}
