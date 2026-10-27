/**
 * Reinstatement — the one door through the takedown wall. See docs/adr/0026.
 *
 * These tests exist because this is the single path that can undo a protection
 * built for people who asked not to be here. Most of them assert a REFUSAL. If
 * a change makes one of these pass more easily, that change is wrong.
 */
import { describe, expect, it } from 'vitest';
import {
  VERIFICATION_CODE_TTL_MS,
  decideReinstatement,
  formatVerificationCode,
  isVerificationCodeExpired,
  normalizeInstagramHandle,
  tombstoneKeyForHandle,
  reinstatementModerationText,
  validateReinstatementRequest,
  type ReinstatementFacts,
} from '@/lib/reinstatement';

const NOW = 1_800_000_000_000;

/** A request that should sail through, so each test can spoil exactly one thing. */
function facts(over: Partial<ReinstatementFacts> = {}): ReinstatementFacts {
  return {
    handle: 'tattoosbyging',
    tombstone: { key: 'instagram:tattoosbyging', artistId: 'artist_ging', reinstatedAt: null },
    artist: { id: 'artist_ging', removedAt: NOW - 1000, claimedByUid: null },
    request: { id: 'RI-ABC123', uid: 'uid_ging', issuedAtEpochMs: NOW - 1000 },
    handleVerifiedByOperator: true,
    ...over,
  };
}

describe('validateReinstatementRequest', () => {
  const good = { instagram: '@tattoosbyging', contactEmail: 'ging@example.com' };

  it('accepts a well-formed request and normalizes the handle', () => {
    const r = validateReinstatementRequest(good, 'uid_1');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.instagram).toBe('tattoosbyging');
      expect(r.value.uid).toBe('uid_1');
    }
  });

  it('takes the uid from the caller, never from the body', () => {
    // The body is attacker-controlled; the uid comes from a verified token.
    const r = validateReinstatementRequest({ ...good, uid: 'uid_attacker' }, 'uid_real');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.uid).toBe('uid_real');
  });

  it('REFUSES without a signed-in account', () => {
    // Deliberately asymmetric with takedown, which requires no account at all.
    const r = validateReinstatementRequest(good, '');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/signed-in account/i);
  });

  it.each([
    ['missing instagram', { contactEmail: 'a@b.co' }, /instagram/i],
    ['malformed instagram', { ...good, instagram: 'not a handle!' }, /instagram/i],
    ['missing email', { instagram: 'ging' }, /contactEmail/i],
    ['malformed email', { ...good, contactEmail: 'nope' }, /contactEmail/i],
    ['non-string message', { ...good, message: 42 }, /message/i],
    ['not an object', 'hello', /JSON object/i],
  ])('rejects %s', (_label, body, pattern) => {
    const r = validateReinstatementRequest(body, 'uid_1');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(pattern);
  });

  it('accepts handles containing dots and underscores', () => {
    // Instagram allows both, and 15.5% of the dataset's handles use them.
    const r = validateReinstatementRequest({ ...good, instagram: 'ink.by_aliza' }, 'uid_1');
    expect(r.ok).toBe(true);
  });
});

describe('verification codes', () => {
  it('formats a publishable, quotable code', () => {
    expect(formatVerificationCode('a1b2c3d4e5f6')).toBe('TATT-A1B2C3D4');
  });

  it('treats a code older than the TTL as expired', () => {
    expect(isVerificationCodeExpired(NOW - VERIFICATION_CODE_TTL_MS - 1, NOW)).toBe(true);
    expect(isVerificationCodeExpired(NOW - 1000, NOW)).toBe(false);
  });

  it('treats a missing or nonsense issue time as expired', () => {
    expect(isVerificationCodeExpired(NaN, NOW)).toBe(true);
  });
});

describe('tombstoneKeyForHandle', () => {
  it('matches the key the takedown executor writes', () => {
    expect(tombstoneKeyForHandle(normalizeInstagramHandle('@TattoosByGing')!)).toBe(
      'instagram:tattoosbyging',
    );
  });
});

describe('decideReinstatement', () => {
  it('allows a verified request against a tombstoned, unclaimed husk', () => {
    expect(decideReinstatement(facts(), NOW)).toEqual({ ok: true });
  });

  describe('refusals', () => {
    function blockersFor(over: Partial<ReinstatementFacts>): string[] {
      const d = decideReinstatement(facts(over), NOW);
      expect(d.ok).toBe(false);
      return d.ok ? [] : d.blockers;
    }

    it('REFUSES when the operator has not confirmed handle control', () => {
      // This is the whole identity check. Nothing else in the flow performs one.
      expect(blockersFor({ handleVerifiedByOperator: false }).join(' ')).toMatch(
        /handle control has not been confirmed/i,
      );
    });

    it('REFUSES when there is no tombstone for the handle', () => {
      expect(blockersFor({ tombstone: null }).join(' ')).toMatch(/nothing to reinstate/i);
    });

    it('REFUSES when there is no request from the artist', () => {
      // Reinstatement is only ever actioned against something the artist did.
      // This is what stops an admin convenience path existing at all.
      expect(blockersFor({ request: null }).join(' ')).toMatch(/no pending reinstatement request/i);
    });

    it('REFUSES an expired verification code', () => {
      const stale = { id: 'RI-1', uid: 'uid_ging', issuedAtEpochMs: NOW - VERIFICATION_CODE_TTL_MS - 1 };
      expect(blockersFor({ request: stale }).join(' ')).toMatch(/expired/i);
    });

    it('REFUSES when the husk is claimed by a different account (issue #192)', () => {
      // The husk keeps stripeAccountId by design, so re-pointing ownership here
      // could hand one person's connected account to another.
      const joined = blockersFor({
        artist: { id: 'artist_ging', removedAt: NOW - 1000, claimedByUid: 'uid_someone_else' },
      }).join(' ');
      expect(joined).toMatch(/already claimed by a DIFFERENT account/i);
      expect(joined).toMatch(/#192/);
    });

    it('ALLOWS when the existing claim is the requester themselves', () => {
      expect(
        decideReinstatement(
          facts({ artist: { id: 'artist_ging', removedAt: NOW - 1000, claimedByUid: 'uid_ging' } }),
          NOW,
        ),
      ).toEqual({ ok: true });
    });

    it('REFUSES when the tombstone points at a different node than the one resolved', () => {
      expect(
        blockersFor({
          tombstone: { key: 'instagram:tattoosbyging', artistId: 'artist_other', reinstatedAt: null },
        }).join(' '),
      ).toMatch(/would unsuppress someone who did not ask/i);
    });

    it('REFUSES a second reinstatement of the same handle', () => {
      expect(
        blockersFor({
          tombstone: {
            key: 'instagram:tattoosbyging',
            artistId: 'artist_ging',
            reinstatedAt: NOW - 5000,
          },
        }).join(' '),
      ).toMatch(/already reinstated/i);
    });

    it('REFUSES when the node is gone entirely', () => {
      expect(blockersFor({ artist: null }).join(' ')).toMatch(/nothing to unsuppress/i);
    });

    it('reports every blocker at once rather than one at a time', () => {
      // The operator should see the whole picture from a single dry run.
      const d = decideReinstatement(
        facts({ tombstone: null, request: null, handleVerifiedByOperator: false, artist: null }),
        NOW,
      );
      expect(d.ok).toBe(false);
      if (!d.ok) expect(d.blockers.length).toBeGreaterThanOrEqual(4);
    });

    it('REFUSES an empty facts object rather than defaulting to allow', () => {
      // Fail closed: an unpopulated read must never read as "all clear".
      const d = decideReinstatement(
        {
          handle: 'x',
          tombstone: null,
          artist: null,
          request: null,
          handleVerifiedByOperator: false,
        },
        NOW,
      );
      expect(d.ok).toBe(false);
    });
  });
});

describe('reinstatementModerationText', () => {
  it('is the appeal message only — handle, uid, and email stay out', () => {
    const text = reinstatementModerationText({
      instagram: 'tattoosbyging',
      uid: 'uid_1',
      contactEmail: 'ging@example.com',
      message: 'I am appealing the removal. This is my copyrighted work.',
    });
    expect(text).toBe('I am appealing the removal. This is my copyrighted work.');
    expect(text).not.toContain('uid_1');
    expect(text).not.toContain('ging@example.com');
  });

  it('is empty when the appeal has no message', () => {
    expect(reinstatementModerationText({
      instagram: 'tattoosbyging',
      uid: 'uid_1',
      contactEmail: 'ging@example.com',
      message: null,
    })).toBe('');
  });
});
