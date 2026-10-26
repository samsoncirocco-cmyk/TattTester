import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  clearMemorySessions,
  memorySessionStore,
  type StoredSession,
} from '../internal/store';
import { dismissDesignResume, resolveDesignResume } from '../internal/resume';

function session(overrides: Partial<StoredSession> = {}): StoredSession {
  return {
    id: 'sess-1',
    phase: 'intake',
    intake: { placement: '', styleTags: [], meaning: '', references: [], ambiguousAxes: [] },
    axisSelection: { mode: 'questionnaire', axes: [], rationale: 'pending' },
    provider: '',
    pinnedModelId: '',
    variations: [],
    createdAt: '2026-08-27T00:00:00.000Z',
    updatedAt: '2026-08-27T00:00:00.000Z',
    conversation: {
      transcript: [
        { role: 'bot', text: 'where on your body?' },
        { role: 'user', text: 'a koi' },
      ],
      turnCount: 1,
      record: { placement: '', meaning: 'a koi' },
      turnLogs: [
        { turn: 1, confidence: 0.4, missingFields: ['placement'], firedRule: 'none', model: 'm' },
      ],
      stage: 'chatting',
    },
    ...overrides,
  };
}

let savedDemoMode: string | undefined;

beforeEach(() => {
  // This environment has Firebase Admin credentials, so the store seam would
  // otherwise talk to Firestore. Demo mode is the in-memory path.
  savedDemoMode = process.env.NEXT_PUBLIC_DEMO_MODE;
  process.env.NEXT_PUBLIC_DEMO_MODE = 'true';
  clearMemorySessions();
});

afterEach(() => {
  if (savedDemoMode === undefined) delete process.env.NEXT_PUBLIC_DEMO_MODE;
  else process.env.NEXT_PUBLIC_DEMO_MODE = savedDemoMode;
});

describe('resolveDesignResume (#394)', () => {
  it('returns the hinted unbound transcript and hides turn logs', async () => {
    await memorySessionStore.save(session());

    const resume = await resolveDesignResume({ uid: null, hintedSessionId: 'sess-1' });

    expect(resume?.sessionId).toBe('sess-1');
    expect(resume?.transcript.map((message) => message.text)).toEqual([
      'where on your body?',
      'a koi',
    ]);
    expect(resume?.notes?.vibe).toContain('koi');
    const serialized = JSON.stringify(resume);
    expect(serialized).not.toContain('turnLogs');
    expect(serialized).not.toContain('confidence');
    expect(serialized).not.toContain('firedRule');
  });

  it('refuses a hinted session owned by someone else', async () => {
    await memorySessionStore.save(session({ ownerUid: 'uid-a' }));

    expect(
      await resolveDesignResume({ uid: 'uid-b', hintedSessionId: 'sess-1' })
    ).toBeNull();
    expect(await resolveDesignResume({ uid: null, hintedSessionId: 'sess-1' })).toBeNull();
  });

  it('resumes the account pointer when the browser has no id', async () => {
    await memorySessionStore.save(
      session({
        id: 'sess-owned',
        ownerUid: 'uid-a',
        phase: 'picked',
        updatedAt: '2026-08-27T02:00:00.000Z',
      })
    );

    const resume = await resolveDesignResume({ uid: 'uid-a', hintedSessionId: null });

    expect(resume?.sessionId).toBe('sess-owned');
    expect(resume?.phase).toBe('picked');
  });

  it('picks the newer of the hint and the account pointer', async () => {
    await memorySessionStore.save(
      session({
        id: 'older',
        ownerUid: 'uid-a',
        updatedAt: '2026-08-27T01:00:00.000Z',
      })
    );
    await memorySessionStore.save(
      session({ id: 'newer', updatedAt: '2026-08-27T03:00:00.000Z' })
    );

    const resume = await resolveDesignResume({ uid: 'uid-a', hintedSessionId: 'newer' });
    expect(resume?.sessionId).toBe('newer');
  });

  it('skips a completed session and a dismissed one', async () => {
    await memorySessionStore.save(session({ phase: 'complete', ownerUid: 'uid-a' }));
    expect(await resolveDesignResume({ uid: 'uid-a', hintedSessionId: 'sess-1' })).toBeNull();

    await memorySessionStore.save(session({ id: 'live', ownerUid: 'uid-a' }));
    await dismissDesignResume({ uid: 'uid-a', sessionId: 'live' });
    expect(await resolveDesignResume({ uid: 'uid-a', hintedSessionId: 'live' })).toBeNull();
    expect(await memorySessionStore.getOwnerPointer('uid-a')).toBeNull();
  });

  it('does not let a stranger dismiss an owned session', async () => {
    await memorySessionStore.save(session({ ownerUid: 'uid-a' }));
    await dismissDesignResume({ uid: null, sessionId: 'sess-1' });
    expect((await memorySessionStore.get('sess-1'))?.resumeDismissed).toBeUndefined();
  });
});
