/**
 * Spec 7 resume rules: who may read a session's resume view, what it
 * carries, and that the render claim's ids never leave the server. Every
 * paid boundary is mocked and persistence runs on the in-memory store.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../designConversation', () => ({
  runTurn: vi.fn(),
  opener: () => 'Where does it go, and what should it mean?',
  HANDOFF_URL: '/smart-match',
  ConversationUnavailableError: class extends Error {},
}));
vi.mock('../../intake', () => ({ extractIntake: vi.fn() }));
vi.mock('../../generation', () => ({ generate: vi.fn(), routeGeneration: vi.fn() }));
vi.mock('@/lib/firebase-admin', () => ({ ensureAdminApp: vi.fn(() => false) }));
vi.mock('@/lib/budget-tracker', () => ({ recordSpend: vi.fn(), VERTEX_IMAGEN_COST_CENTS: 4 }));
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  createRequestLogger: vi.fn(),
}));

import { converse, getSessionForResume } from '../index';
import { clearMemorySessions, memorySessionStore, ROUND_CLAIM_STALE_MS } from '../internal/store';
import { hashResumeKey, mayResume, renderingFromClaim, toResumeView } from '../internal/resume';

beforeEach(() => {
  clearMemorySessions();
});

async function openSession() {
  const opened = await converse({});
  const stored = await memorySessionStore.get(opened.sessionId);
  return { opened, stored: stored! };
}

describe('resume key', () => {
  it('is returned once on the opening call and only its hash is stored', async () => {
    const { opened, stored } = await openSession();

    expect(opened.resumeKey).toEqual(expect.any(String));
    expect(opened.resumeKey!.length).toBeGreaterThanOrEqual(24);
    expect(stored.resumeKeyHash).toBe(hashResumeKey(opened.resumeKey!));
    expect(JSON.stringify(stored)).not.toContain(opened.resumeKey!);
  });

  it('lets the creating browser read the transcript of an unowned session', async () => {
    const { opened } = await openSession();

    const found = await getSessionForResume(opened.sessionId, {
      uid: null,
      resumeKey: opened.resumeKey,
    });

    expect(found.resume?.transcript).toEqual([{ role: 'bot', text: opened.reply }]);
    expect(found.resume?.stage).toBe('chatting');
    // The public projection is unchanged: no transcript, no key hash.
    expect(found.session).not.toHaveProperty('conversation');
    expect(found.session).not.toHaveProperty('resumeKeyHash');
  });

  it('gives no resume view for a wrong key, a missing key, or another signed-in user', async () => {
    const { opened } = await openSession();

    for (const caller of [
      { uid: null, resumeKey: 'not-the-key' },
      { uid: null },
      { uid: 'someone-else' },
    ]) {
      const found = await getSessionForResume(opened.sessionId, caller);
      expect(found.resume).toBeUndefined();
    }
  });
});

describe('owned sessions', () => {
  it('resume only for the owner; the creating browser key no longer suffices', async () => {
    const { opened, stored } = await openSession();
    stored.ownerUid = 'owner-1';

    expect(mayResume(stored, { uid: 'owner-1' })).toBe(true);
    expect(mayResume(stored, { uid: null, resumeKey: opened.resumeKey })).toBe(false);
    expect(mayResume(stored, { uid: 'other', resumeKey: opened.resumeKey })).toBe(false);
  });
});

describe('render state', () => {
  it('reports a live reveal claim without its claim or reservation id', async () => {
    const { stored } = await openSession();
    const at = new Date(Date.now() - 20_000).toISOString();
    stored.roundInFlight = { id: 'claim-secret', reservationId: 'resv-secret', at };

    const view = toResumeView(stored);

    expect(view.rendering).toEqual({ kind: 'reveal', since: at, stale: false });
    expect(JSON.stringify(view)).not.toContain('claim-secret');
    expect(JSON.stringify(view)).not.toContain('resv-secret');
  });

  it('marks a claim older than the stale window as stale, and a round once revealed', async () => {
    const { stored } = await openSession();
    stored.phase = 'revealed';
    const now = Date.now();
    stored.roundInFlight = { id: 'c', at: new Date(now - ROUND_CLAIM_STALE_MS - 1).toISOString() };

    expect(renderingFromClaim(stored, now)).toMatchObject({ kind: 'round', stale: true });
  });

  it('says nothing about rendering when no claim is held', async () => {
    const { stored } = await openSession();
    expect(toResumeView(stored).rendering).toBeUndefined();
  });
});
