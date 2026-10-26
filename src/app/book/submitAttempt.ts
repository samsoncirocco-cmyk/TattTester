/**
 * Client side of spec 5: one idempotency key per submit attempt.
 *
 * The same key rides on capture, hold and checkout (the server scopes it per
 * route). It survives only a network failure — the request may have landed
 * and the answer been lost, so a retry must be recognised as the same attempt.
 * Any answer the server actually gave, and any change to what is being sent,
 * starts a new attempt with a new key.
 */

export const IDEMPOTENCY_HEADER_NAME = "Idempotency-Key";

export type SubmitAttempt = { key: string; fingerprint: string };

function newKey(): string {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (c && typeof c.randomUUID === "function") return c.randomUUID();
  return `k-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

/** Re-use the current attempt when nothing being sent has changed; otherwise start one. */
export function attemptFor(
  current: SubmitAttempt | null,
  fingerprint: string,
): SubmitAttempt {
  if (current && current.fingerprint === fingerprint) return current;
  return { key: newKey(), fingerprint };
}

/** A fetch that never reached an answer (offline, DNS, reset) — the only kind that keeps the key. */
export function isNetworkFailure(err: unknown): boolean {
  return err instanceof TypeError;
}

/** The server says the same attempt is still being worked on (409 REQUEST_IN_FLIGHT). */
export function isRequestInFlight(status: number, body: unknown): boolean {
  return (
    status === 409 &&
    typeof body === "object" &&
    body !== null &&
    (body as { code?: unknown }).code === "REQUEST_IN_FLIGHT"
  );
}

export const REQUEST_IN_FLIGHT_COPY = "Still working on that one. Give it a moment.";
