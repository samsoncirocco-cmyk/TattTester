// The two auth helpers behind every design-session call. The difference
// between them is the difference between a wall and a front door, so it is
// pinned here rather than inferred from callers.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { promptSignInMock, authRef } = vi.hoisted(() => ({
  promptSignInMock: vi.fn(),
  authRef: { current: null as unknown },
}));

vi.mock('@/store/useAuthStore', () => ({
  useAuthStore: { getState: () => ({ promptSignIn: promptSignInMock }) },
}));

// Lazily imported by the helpers (it is what keeps firebase/auth out of the
// First Load JS), so the mock must be a module factory, not a value.
vi.mock('./firebase', () => ({
  get auth() {
    return authRef.current;
  },
}));

import {
  getApiAuthHeaders,
  getOptionalApiAuthHeaders,
  SignInRequiredError,
} from './client-api-auth';

/** Firebase with a settled session for `uid`, or settled-and-signed-out. */
function firebaseAuth(user: { getIdToken: () => Promise<string> } | null) {
  return { currentUser: user, authStateReady: vi.fn().mockResolvedValue(undefined) };
}

const signedIn = { getIdToken: vi.fn().mockResolvedValue('tok-1') };

beforeEach(() => {
  vi.clearAllMocks();
  signedIn.getIdToken.mockResolvedValue('tok-1');
  authRef.current = null;
});

describe('getApiAuthHeaders — the charged path, fails closed', () => {
  it('returns a bearer header for a signed-in user', async () => {
    authRef.current = firebaseAuth(signedIn);

    expect(await getApiAuthHeaders()).toEqual({ Authorization: 'Bearer tok-1' });
    expect(promptSignInMock).not.toHaveBeenCalled();
  });

  it('opens the sign-in modal and throws a typed error when signed out', async () => {
    authRef.current = firebaseAuth(null);

    await expect(getApiAuthHeaders()).rejects.toBeInstanceOf(SignInRequiredError);
    expect(promptSignInMock).toHaveBeenCalledTimes(1);
  });

  // The message is unchanged from the generic Error it replaced, so every
  // existing catcher that surfaces err.message still reads the same.
  it('keeps the original message', async () => {
    authRef.current = firebaseAuth(null);

    await expect(getApiAuthHeaders()).rejects.toThrow('Sign in to continue.');
  });
});

describe('getOptionalApiAuthHeaders — the open path, never blocks', () => {
  it('returns nothing and opens no modal when signed out', async () => {
    authRef.current = firebaseAuth(null);

    expect(await getOptionalApiAuthHeaders()).toEqual({});
    expect(promptSignInMock).not.toHaveBeenCalled();
  });

  it('still identifies a signed-in user', async () => {
    authRef.current = firebaseAuth(signedIn);

    expect(await getOptionalApiAuthHeaders()).toEqual({ Authorization: 'Bearer tok-1' });
  });

  // A token that fails to mint must not break a call that never needed one.
  it('degrades to anonymous when the token cannot be minted', async () => {
    signedIn.getIdToken.mockRejectedValueOnce(new Error('network'));
    authRef.current = firebaseAuth(signedIn);

    expect(await getOptionalApiAuthHeaders()).toEqual({});
    expect(promptSignInMock).not.toHaveBeenCalled();
  });

  // Firebase restores the session asynchronously; deciding before it settles
  // is what once threw a spurious "Sign in to continue." at signed-in users.
  it('waits for auth to settle before concluding nobody is signed in', async () => {
    const auth = firebaseAuth(null);
    authRef.current = auth;

    await getOptionalApiAuthHeaders();

    expect(auth.authStateReady).toHaveBeenCalledTimes(1);
  });

  it('returns nothing when firebase is not configured at all', async () => {
    authRef.current = null;

    expect(await getOptionalApiAuthHeaders()).toEqual({});
  });
});
