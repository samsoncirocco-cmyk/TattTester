import { useAuthStore } from '@/store/useAuthStore';

/**
 * The caller must be signed in and is not. Thrown with the same message the
 * generic Error carried before, so every existing catcher that surfaces
 * `err.message` is unchanged — but a caller that wants to render a sign-in
 * beat instead of a red failure can now tell the two apart.
 */
export class SignInRequiredError extends Error {
  constructor(message = 'Sign in to continue.') {
    super(message);
    this.name = 'SignInRequiredError';
  }
}

/**
 * Auth headers when we have them, nothing when we don't — no sign-in modal,
 * no throw. For routes that are deliberately open to signed-out visitors
 * (SketchBot's conversation) but still want to recognize a signed-in one.
 *
 * ADR-0041 puts ONE gate in front of *generation*. A conversation turn is
 * not a generation, so demanding a token here was a wall in front of the
 * product's front door: /design opened a "Welcome Back" modal before the
 * visitor typed a character, and the first chip tap failed client-side
 * without a request ever leaving the browser. #357 made sessions start
 * unowned for exactly this reason — identity is stamped by the first
 * charged action, not by saying hello.
 */
export async function getOptionalApiAuthHeaders(): Promise<Record<string, string>> {
  const { auth } = await import('./firebase');
  if (auth && !auth.currentUser) {
    await auth.authStateReady();
  }

  const user = auth?.currentUser;
  if (!user) return {};

  // A token that fails to mint must not break a call that never needed one.
  return user
    .getIdToken()
    .then((token) => ({ Authorization: `Bearer ${token}` }))
    .catch(() => ({}));
}

export async function getApiAuthHeaders(): Promise<Record<string, string>> {
  // Lazy import: this helper is called on user actions (API requests), never
  // during render, and its static './firebase' edge was what kept
  // firebase/auth (~34 KB gz) in the First Load JS of every route that
  // renders a component wired to it (/pricing, /bookings, /designs, ...).
  const { auth } = await import('./firebase');
  // currentUser is null until Firebase finishes restoring the session —
  // typing immediately on page load raced that and threw a spurious
  // "Sign in to continue." at signed-in users. Wait for auth to settle
  // before deciding the user actually isn't signed in.
  if (auth && !auth.currentUser) {
    await auth.authStateReady();
  }

  const user = auth?.currentUser;
  if (!user) {
    useAuthStore.getState().promptSignIn();
    throw new SignInRequiredError();
  }

  const token = await user.getIdToken();
  return { Authorization: `Bearer ${token}` };
}
