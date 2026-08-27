/**
 * Channel adapter (TAT-49) — conversation round trips, the reveal flow, and
 * every REQUIRED spend guardrail. All mock-based: the design-session
 * service, budget tracker, spend recorder, share store, and Firebase auth
 * are mocked; profiles run on the in-memory store (ensureAdminApp → null).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  handleInbound,
  executeReveal,
  executeCritique,
  executeRefine,
  executeRefineRound,
  recordOptOut,
  isOptedOut,
} from '../index';
import {
  clearMemoryProfiles,
  memoryProfileStore,
} from '../internal/profileStore';
import {
  REVEAL_ACK,
  ROUND_ACK,
  ROUND_LOCKED_TEXT,
  ROUND_FAILED_TEXT,
  BUDGET_EXHAUSTED_TEXT,
  REVEAL_FAILED_TEXT,
  CRITIQUE_FAILED_TEXT,
  REFINE_FAILED_TEXT,
} from '../internal/render';
import {
  converse,
  confirmProposal,
  getSession,
  recordPick,
  recordRoundPick,
  refineRound,
  refine,
  critique,
  claimSessionOwnership,
  DesignSessionError,
} from '@/services/designSession';
import {
  reserveGenerationCredit,
  releaseGenerationCredit,
  GenerationCreditsExhaustedError,
} from '@/lib/generation-credits';
import { checkBudget, recordConversationTurnSpend } from '@/lib/budget-tracker';
import { resolveSharedDesignStore } from '@/lib/shared-design-store';
import { getAuth } from 'firebase-admin/auth';

vi.mock('@/services/designSession', async () => {
  const pureCritique = await import('@/services/designSession/internal/critique');
  class DesignSessionError extends Error {
    readonly code: string;
    readonly status: number;
    constructor(code: string, message = code) {
      super(message);
      this.name = 'DesignSessionError';
      this.code = code;
      this.status = 500;
    }
  }
  const roundPlan = await import('@/services/designSession/roundPlan');
  return {
    converse: vi.fn(),
    claimSessionOwnership: vi.fn(),
    confirmProposal: vi.fn(),
    attachReference: vi.fn(),
    getSession: vi.fn(),
    recordPick: vi.fn(),
    recordRoundPick: vi.fn(),
    refineRound: vi.fn(),
    refine: vi.fn(),
    critique: vi.fn(),
    // The REAL pure helpers. They decide whether a message is a fix request
    // or chatter, which is precisely the routing under test — a stubbed copy
    // would drift from the web's behaviour and hide that drift. Safe to
    // import: internal/critique has no I/O, only type imports.
    allCuts: pureCritique.allCuts,
    isFixRequest: pureCritique.isFixRequest,
    // The real round plan (ADR-0049) — pure, and the pole labels under test
    // ARE the labels the copy computes from.
    isLadderAxis: roundPlan.isLadderAxis,
    ROUND_POLE_LABEL: roundPlan.ROUND_POLE_LABEL,
    DesignSessionError,
  };
});

// The round credit primitive (ADR-0041/0049): mocked so no Firestore runs;
// the exhausted error class stays REAL so instanceof catches keep working.
vi.mock('@/lib/generation-credits', async () => {
  const actual = await vi.importActual<typeof import('@/lib/generation-credits')>(
    '@/lib/generation-credits'
  );
  return {
    GenerationCreditsExhaustedError: actual.GenerationCreditsExhaustedError,
    reserveGenerationCredit: vi.fn(async () => ({
      id: 'res-1',
      source: 'free' as const,
      freeRemaining: 24,
      paidRemaining: 0,
    })),
    releaseGenerationCredit: vi.fn(async () => {}),
  };
});

vi.mock('@/lib/budget-tracker', () => ({
  checkBudget: vi.fn(async () => ({ allowed: true, spentCents: 0, remainingCents: 1000 })),
  recordConversationTurnSpend: vi.fn(async () => {}),
}));

const shareSave = vi.fn(async () => {});
vi.mock('@/lib/shared-design-store', () => ({
  resolveSharedDesignStore: vi.fn(() => ({ save: shareSave })),
}));

// Memory stores everywhere: profile store resolves on ensureAdminApp.
vi.mock('@/lib/firebase-admin', () => ({ ensureAdminApp: () => null }));

// Unlinked by default — individual tests flip this to simulate an account
// whose verified phone matches the texter.
vi.mock('firebase-admin/auth', () => ({
  getAuth: vi.fn(() => ({
    getUserByPhoneNumber: vi.fn(async () => {
      throw new Error('no user record');
    }),
  })),
}));

const PHONE = '+15551234567';

function mockLinked(uid: string | null) {
  vi.mocked(getAuth).mockImplementation(
    () =>
      ({
        getUserByPhoneNumber: async () => {
          if (!uid) throw new Error('no user record');
          return { uid };
        },
      }) as unknown as ReturnType<typeof getAuth>
  );
}

function turn(
  stage: 'chatting' | 'proposal' | 'handoff',
  overrides: Record<string, unknown> = {}
) {
  return {
    sessionId: 's1',
    reply: 'Love that. What style are you drawn to?',
    stage,
    turn: 1,
    ...overrides,
  };
}

function revealedSession() {
  return {
    id: 's1',
    phase: 'revealed',
    provider: 'vertex',
    intake: {
      placement: 'forearm',
      styleTags: ['Traditional'],
      meaning: 'resilience',
      subject: 'snake and dagger',
      references: [],
      ambiguousAxes: [],
    },
    axisSelection: { mode: 'questionnaire', axes: ['bold-fine'], rationale: '' },
    variations: [1, 2].map((n) => ({
      id: `v${n}`,
      axisPosition: { 'bold-fine': n === 1 ? 'bold' : 'fine' },
      prompt: `prompt ${n}`,
      imageUrl: `https://storage.example/cut-${n}.png`,
    })),
    rounds: [
      { round: 1, axis: 'bold-fine', variationIds: ['v1', 'v2'] },
    ] as import('@/services/designSession').RefineRound[],
    createdAt: '2026-07-29T00:00:00.000Z',
    updatedAt: '2026-07-29T00:00:00.000Z',
  };
}

/** Walk the profile to 'proposal' so a yes can arm the reveal. */
async function driveToProposal(phone = PHONE) {
  vi.mocked(converse).mockResolvedValueOnce(
    turn('proposal', { playback: 'a traditional snake and dagger on your forearm' })
  );
  await handleInbound({ phone, body: 'a snake and dagger on my forearm' });
}

/** The arm token the deferred execute* callbacks must carry. */
async function currentArmedAt(phone = PHONE): Promise<string> {
  const profile = await memoryProfileStore.get(phone);
  if (!profile?.revealArmedAt) throw new Error('expected an armed render');
  return profile.revealArmedAt;
}

/**
 * Start a SECOND design after a reveal already landed. SMS has no "back to
 * /design" navigation, so the channel needs the explicit restart the web
 * gets for free — without it the message reads as a critique of the cuts
 * already on the texter's phone.
 */
async function restartAndDriveToProposal(phone = PHONE) {
  vi.mocked(converse).mockResolvedValueOnce(turn('chatting'));
  await handleInbound({ phone, body: 'start over' });
  await driveToProposal(phone);
}

beforeEach(() => {
  clearMemoryProfiles();
  vi.clearAllMocks();
  mockLinked(null);
  vi.stubEnv('NEXT_PUBLIC_DEMO_MODE', 'false');
  vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://tatttester.com');
  vi.mocked(checkBudget).mockResolvedValue({
    allowed: true,
    spentCents: 0,
    remainingCents: 1000,
  });
  vi.mocked(resolveSharedDesignStore).mockReturnValue({
    save: shareSave,
  } as unknown as ReturnType<typeof resolveSharedDesignStore>);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('conversation round trip', () => {
  it('routes a text through the engine and returns an SMS-shaped reply', async () => {
    vi.mocked(converse).mockResolvedValueOnce(
      turn('chatting', { reply: '**Love it.** A snake has _real_ movement. Where would it go?' })
    );

    const outcome = await handleInbound({ phone: PHONE, body: 'thinking about a snake' });

    expect(outcome).toEqual({
      kind: 'reply',
      text: 'Love it. A snake has real movement. Where would it go?',
    });
    expect(converse).toHaveBeenCalledWith({ message: 'thinking about a snake' });
    // Same per-turn budget line item as the web converse route.
    expect(recordConversationTurnSpend).toHaveBeenCalledTimes(1);
  });

  it('threads the next text onto the same session', async () => {
    vi.mocked(converse).mockResolvedValueOnce(turn('chatting'));
    await handleInbound({ phone: PHONE, body: 'a snake' });

    vi.mocked(converse).mockResolvedValueOnce(turn('chatting', { turn: 2 }));
    await handleInbound({ phone: PHONE, body: 'on my forearm' });

    expect(converse).toHaveBeenLastCalledWith({ sessionId: 's1', message: 'on my forearm' });
  });

  it('records every session on the profile — the ADR-0022 taste trail', async () => {
    vi.mocked(converse).mockResolvedValueOnce(turn('chatting'));
    await handleInbound({ phone: PHONE, body: 'a snake' });

    const profile = await memoryProfileStore.get(PHONE);
    expect(profile?.sessionIds).toEqual(['s1']);
    expect(profile?.activeSessionId).toBe('s1');
    expect(profile?.lastStage).toBe('chatting');
  });

  it('answers honestly when every conversation provider is down', async () => {
    vi.mocked(converse).mockRejectedValueOnce(
      new DesignSessionError('CONVERSATION_UNAVAILABLE')
    );
    const outcome = await handleInbound({ phone: PHONE, body: 'a snake' });
    expect(outcome.kind).toBe('reply');
    if (outcome.kind === 'reply') {
      expect(outcome.text).toContain('https://tatttester.com/design');
    }
  });

  it('starts fresh when the stored session is stale, keeping the message', async () => {
    vi.mocked(converse).mockResolvedValueOnce(turn('chatting'));
    await handleInbound({ phone: PHONE, body: 'a snake' });

    vi.mocked(converse)
      .mockRejectedValueOnce(new DesignSessionError('SESSION_NOT_FOUND'))
      .mockResolvedValueOnce(turn('chatting', { sessionId: 's2' }));
    const outcome = await handleInbound({ phone: PHONE, body: 'still here?' });

    expect(outcome.kind).toBe('reply');
    expect(converse).toHaveBeenLastCalledWith({ message: 'still here?' });
    const profile = await memoryProfileStore.get(PHONE);
    expect(profile?.activeSessionId).toBe('s2');
    expect(profile?.sessionIds).toEqual(['s1', 's2']);
  });

  it('closes the thread on handoff and appends the smart-match link', async () => {
    vi.mocked(converse).mockResolvedValueOnce(
      turn('handoff', { handoffUrl: '/smart-match' })
    );
    const outcome = await handleInbound({ phone: PHONE, body: 'hmm not sure' });

    if (outcome.kind !== 'reply') throw new Error('expected reply');
    expect(outcome.text).toContain('https://tatttester.com/smart-match');
    const profile = await memoryProfileStore.get(PHONE);
    expect(profile?.activeSessionId).toBeNull();
  });
});

describe('reveal flow', () => {
  it('arms the reveal on a yes at the proposal', async () => {
    await driveToProposal();
    const outcome = await handleInbound({ phone: PHONE, body: 'yes' });
    const armedAt = await currentArmedAt();

    expect(outcome).toEqual({
      kind: 'reveal',
      text: REVEAL_ACK,
      sessionId: 's1',
      phone: PHONE,
      armedAt,
    });
    // Generation is NOT fired synchronously — the route defers it.
    expect(confirmProposal).not.toHaveBeenCalled();
  });

  it('treats a correction at the proposal as another conversation turn', async () => {
    await driveToProposal();
    vi.mocked(converse).mockResolvedValueOnce(turn('proposal', { turn: 2 }));

    const outcome = await handleInbound({
      phone: PHONE,
      body: 'actually make it a dagger only',
    });
    expect(outcome.kind).toBe('reply');
    expect(confirmProposal).not.toHaveBeenCalled();
  });

  it('delivers two pole-captioned cuts and the A/B ask, and records the spend', async () => {
    await driveToProposal();
    await handleInbound({ phone: PHONE, body: 'yes' });
    vi.mocked(confirmProposal).mockResolvedValueOnce(
      revealedSession() as unknown as Awaited<ReturnType<typeof confirmProposal>>
    );

    const delivery = await executeReveal('s1', PHONE, await currentArmedAt());

    expect(delivery.cuts).toHaveLength(2);
    expect(delivery.cuts[0]).toEqual({
      caption: 'Cut A — bold',
      mediaUrl: 'https://storage.example/cut-1.png',
    });
    expect(delivery.cuts[1].caption).toBe('Cut B — fine-line');
    // The decided ADR-0049 SMS copy: poles computed from the round's axis.
    expect(delivery.closingText).toContain(
      'Two cuts this round: A is bold, B is fine-line. Reply A or B.'
    );
    expect(delivery.closingText).toMatch(/https:\/\/tatttester\.com\/share\/[a-z0-9-]+/i);
    // The share carries both cuts and the intake context.
    expect(shareSave).toHaveBeenCalledTimes(1);
    const share = shareSave.mock.calls[0][0] as Record<string, unknown>;
    expect(share.imageUrls).toHaveLength(2);
    expect(share.bodyPart).toBe('forearm');

    const profile = await memoryProfileStore.get(PHONE);
    expect(profile?.lastStage).toBe('revealed');
  });

  it('waits patiently while a reveal is in flight — no double fire', async () => {
    await driveToProposal();
    await handleInbound({ phone: PHONE, body: 'yes' });

    const again = await handleInbound({ phone: PHONE, body: 'yes' });
    expect(again.kind).toBe('reply');
    if (again.kind === 'reply') expect(again.text).toContain('Still sketching');
    expect(converse).toHaveBeenCalledTimes(1); // only the proposal turn
  });

  it('refunds the slot, tells the truth, and allows a retry when generation fails', async () => {
    await driveToProposal();
    await handleInbound({ phone: PHONE, body: 'yes' });
    vi.mocked(confirmProposal).mockRejectedValueOnce(new Error('provider blew up'));

    const delivery = await executeReveal('s1', PHONE, await currentArmedAt());
    expect(delivery.cuts).toHaveLength(0);
    expect(delivery.closingText).toBe(REVEAL_FAILED_TEXT);

    // The failed reveal did not count: the cap slot is back and the
    // proposal is re-armed for another yes.
    const profile = await memoryProfileStore.get(PHONE);
    expect(profile?.dailyReveals.count).toBe(0);
    expect(profile?.totalReveals).toBe(0);
    expect(profile?.lastStage).toBe('proposal');

    const retry = await handleInbound({ phone: PHONE, body: 'yes' });
    expect(retry.kind).toBe('reveal');
  });

  it('falls back to the design surface when no durable share store exists', async () => {
    vi.mocked(resolveSharedDesignStore).mockReturnValue(null);
    await driveToProposal();
    await handleInbound({ phone: PHONE, body: 'yes' });
    vi.mocked(confirmProposal).mockResolvedValueOnce(
      revealedSession() as unknown as Awaited<ReturnType<typeof confirmProposal>>
    );

    const delivery = await executeReveal('s1', PHONE, await currentArmedAt());
    expect(delivery.closingText).toContain('https://tatttester.com/design');
  });
});

describe('parity with the web after the reveal', () => {
  /** Walk a phone to delivered cuts, with the session readable. */
  async function driveToRevealed(phone = PHONE) {
    await driveToProposal(phone);
    await handleInbound({ phone, body: 'yes' });
    vi.mocked(confirmProposal).mockResolvedValueOnce(
      revealedSession() as unknown as Awaited<ReturnType<typeof confirmProposal>>
    );
    await executeReveal('s1', phone, await currentArmedAt(phone));
    vi.mocked(getSession).mockResolvedValue(
      revealedSession() as unknown as Awaited<ReturnType<typeof getSession>>
    );
  }

  describe('the post-reveal session load (#360)', () => {
    it('restarts on a genuine not-found — the session expired out from under the profile', async () => {
      await driveToRevealed();
      vi.mocked(getSession).mockRejectedValueOnce(
        new DesignSessionError('SESSION_NOT_FOUND', 'No design session')
      );
      vi.mocked(converse).mockResolvedValueOnce(turn('chatting', { sessionId: 's2' }));

      const outcome = await handleInbound({ phone: PHONE, body: 'make 2 bolder' });

      // Same recovery as before: never a dead-end — the message opens a
      // fresh conversation instead.
      expect(outcome.kind).toBe('reply');
      const profile = await memoryProfileStore.get(PHONE);
      expect(profile?.activeSessionId).toBe('s2');
      expect(profile?.pendingPickId).toBeNull();
    });

    it('propagates a transient store error instead of silently discarding the session', async () => {
      await driveToRevealed();
      vi.mocked(getSession).mockRejectedValueOnce(new Error('firestore hiccup'));

      await expect(handleInbound({ phone: PHONE, body: 'make 2 bolder' })).rejects.toThrow(
        'firestore hiccup'
      );

      // The texter's in-progress session survives — only a genuine
      // SESSION_NOT_FOUND may unlink it.
      expect(critique).not.toHaveBeenCalled();
      const profile = await memoryProfileStore.get(PHONE);
      expect(profile?.activeSessionId).toBe('s1');
      expect(profile?.lastStage).toBe('revealed');
    });
  });

  describe('critique', () => {
    it('treats an instruction as a fix and defers the re-cut', async () => {
      await driveToRevealed();

      const outcome = await handleInbound({ phone: PHONE, body: 'make 2 bolder' });

      expect(outcome.kind).toBe('critique');
      if (outcome.kind === 'critique') expect(outcome.message).toBe('make 2 bolder');
      const profile = await memoryProfileStore.get(PHONE);
      expect(profile?.lastStage).toBe('critique-running');
    });

    it('delivers the new cut numbered after the round pair', async () => {
      await driveToRevealed();
      await handleInbound({ phone: PHONE, body: 'riku is missing' });
      vi.mocked(critique).mockResolvedValueOnce({
        session: {
          ...revealedSession(),
          critiqueCuts: [{ id: 'c1', axisPosition: {}, prompt: 'p', imageUrl: 'https://s/c1.png' }],
        },
        reply: 'Added Riku — here it is.',
        cut: { id: 'c1', axisPosition: {}, prompt: 'p', imageUrl: 'https://s/c1.png' },
        fixesRemaining: 24,
        exhausted: false,
        generated: true,
      } as unknown as Awaited<ReturnType<typeof critique>>);

      const delivery = await executeCritique(
        's1',
        PHONE,
        'riku is missing',
        await currentArmedAt()
      );

      // Three cuts exist now, so the new one is "Cut 3 of 3" — the same
      // position the web shows it in.
      expect(delivery.cuts).toEqual([
        { caption: 'Cut 3 of 3', mediaUrl: 'https://s/c1.png' },
      ]);
      expect(delivery.closingText).toContain('Added Riku');
      const profile = await memoryProfileStore.get(PHONE);
      expect(profile?.lastStage).toBe('revealed');
    });

    it('delivers a reroll pair with round-order captions, port wired to the linked meter', async () => {
      // "new ones" through the same seam: the service classifies and draws
      // the fresh round; this channel stands the credit port and sends BOTH
      // cuts, numbered from allCuts — the order the web shows.
      await driveToRevealed();
      await handleInbound({ phone: PHONE, body: 'new ones' });
      const armed = await memoryProfileStore.get(PHONE);
      armed!.uid = 'user-1';
      await memoryProfileStore.save(armed!);

      const freshCuts = [3, 4].map((n) => ({
        id: `v${n}`,
        axisPosition: { 'bold-fine': n === 3 ? 'bold' : 'fine' },
        prompt: `fresh ${n}`,
        imageUrl: `https://storage.example/cut-${n}.png`,
      }));
      const session = {
        ...revealedSession(),
        variations: [...revealedSession().variations, ...freshCuts],
        rounds: [
          { round: 1, axis: 'bold-fine', variationIds: ['v1', 'v2'] },
          { round: 2, axis: 'bold-fine', variationIds: ['v3', 'v4'] },
        ],
      };
      vi.mocked(critique).mockResolvedValueOnce({
        session,
        reply: 'fresh pair’s up — that was one credit.',
        cuts: freshCuts,
        round: session.rounds[1],
        fixesRemaining: 24,
        exhausted: false,
        generated: true,
      } as unknown as Awaited<ReturnType<typeof critique>>);

      const delivery = await executeCritique('s1', PHONE, 'new ones', await currentArmedAt());

      expect(delivery.cuts).toEqual([
        { caption: 'Cut 3 of 4', mediaUrl: 'https://storage.example/cut-3.png' },
        { caption: 'Cut 4 of 4', mediaUrl: 'https://storage.example/cut-4.png' },
      ]);
      expect(delivery.closingText).toContain('fresh pair');

      // The port rides the call, wired to THIS texter's meter.
      const call = vi.mocked(critique).mock.calls.at(-1)!;
      const opts = call[2] as { roundCredit: { reserve: () => Promise<{ id: string }> } };
      expect(opts?.roundCredit).toBeDefined();
      await opts.roundCredit.reserve();
      expect(reserveGenerationCredit).toHaveBeenCalledWith('user-1');
    });

    it('stands NO credit port behind an unlinked texter — the service refuses in voice', async () => {
      await driveToRevealed();
      await handleInbound({ phone: PHONE, body: 'new ones' });
      vi.mocked(critique).mockResolvedValueOnce({
        session: revealedSession(),
        reply: 'a fresh set is a full round on your credits…',
        fixesRemaining: 24,
        exhausted: false,
        generated: false,
      } as unknown as Awaited<ReturnType<typeof critique>>);

      await executeCritique('s1', PHONE, 'new ones', await currentArmedAt());

      const call = vi.mocked(critique).mock.calls.at(-1)!;
      expect(call[2]).toBeUndefined();
      expect(reserveGenerationCredit).not.toHaveBeenCalled();
    });

    it('passes a turn that spent nothing straight through', async () => {
      await driveToRevealed();
      await handleInbound({ phone: PHONE, body: 'again but bolder' });
      vi.mocked(critique).mockResolvedValueOnce({
        session: revealedSession(),
        reply: "You're out of fixes on this one — let's get it in front of an artist.",
        fixesRemaining: 0,
        exhausted: true,
        generated: false,
      } as unknown as Awaited<ReturnType<typeof critique>>);

      const delivery = await executeCritique(
        's1',
        PHONE,
        'again but bolder',
        await currentArmedAt()
      );

      expect(delivery.cuts).toHaveLength(0);
      expect(delivery.closingText).toContain('out of fixes');
    });

    it('re-arms for another try when the re-cut fails', async () => {
      await driveToRevealed();
      await handleInbound({ phone: PHONE, body: 'bolder' });
      vi.mocked(critique).mockRejectedValueOnce(new Error('provider blew up'));

      const delivery = await executeCritique(
        's1',
        PHONE,
        'bolder',
        await currentArmedAt()
      );

      expect(delivery.closingText).toBe(CRITIQUE_FAILED_TEXT);
      const profile = await memoryProfileStore.get(PHONE);
      expect(profile?.lastStage).toBe('revealed');
    });

    it('never double-fires on an impatient second text', async () => {
      await driveToRevealed();
      await handleInbound({ phone: PHONE, body: 'make it bolder' });

      const again = await handleInbound({ phone: PHONE, body: 'bolder!!' });

      expect(again.kind).toBe('reply');
      if (again.kind === 'reply') expect(again.text).toContain('new cut lands here');
    });

    // The chatter list is deliberately tight (ADR-0039): only messages that
    // are ENTIRELY praise cost nothing. "these are sick" is a fix request on
    // the web too, because a classifier that shrugs at "riku's missing" is
    // the failure that lane exists to end — SMS matches it exactly.
    it('answers pure praise without spending anything', async () => {
      await driveToRevealed();

      const outcome = await handleInbound({ phone: PHONE, body: 'love these' });

      expect(outcome.kind).toBe('reply');
      if (outcome.kind === 'reply') expect(outcome.text).toContain('Reply A or B');
      expect(critique).not.toHaveBeenCalled();
    });
  });

  describe('the pick', () => {
    // The discrimination that keeps a choice from spending a render.
    it('reads a bare number as a choice, not a fix', async () => {
      await driveToRevealed();

      const outcome = await handleInbound({ phone: PHONE, body: '2' });

      expect(outcome.kind).toBe('reply');
      if (outcome.kind === 'reply') expect(outcome.text).toContain('least you');
      expect(critique).not.toHaveBeenCalled();
      const profile = await memoryProfileStore.get(PHONE);
      expect(profile?.pendingPickId).toBe('v2');
      expect(profile?.lastStage).toBe('pick-pending');
    });

    // Preference phrasing still names one cut — must not fall through to
    // isFixRequest and spend a paid critique.
    it('reads preference phrasing as a choice, not a fix', async () => {
      await driveToRevealed();

      const outcome = await handleInbound({ phone: PHONE, body: 'I like 2 the most' });

      expect(outcome.kind).toBe('reply');
      if (outcome.kind === 'reply') expect(outcome.text).toContain('least you');
      expect(critique).not.toHaveBeenCalled();
      const profile = await memoryProfileStore.get(PHONE);
      expect(profile?.pendingPickId).toBe('v2');
      expect(profile?.lastStage).toBe('pick-pending');
    });

    it('records the pair on the second tap and asks the refinement question', async () => {
      await driveToRevealed();
      await handleInbound({ phone: PHONE, body: 'the second one' });
      vi.mocked(recordPick).mockResolvedValueOnce({
        ...revealedSession(),
        phase: 'picked',
        refinementQuestion: 'Bolder, or keep it fine?',
      } as unknown as Awaited<ReturnType<typeof recordPick>>);

      const outcome = await handleInbound({ phone: PHONE, body: '1' });

      expect(recordPick).toHaveBeenCalledWith('s1', { pickId: 'v2', mostNotYouId: 'v1' });
      if (outcome.kind === 'reply') expect(outcome.text).toBe('Bolder, or keep it fine?');
      const profile = await memoryProfileStore.get(PHONE);
      expect(profile?.lastStage).toBe('refine-pending');
    });

    it('refuses a most-not-you that names the kept cut', async () => {
      await driveToRevealed();
      await handleInbound({ phone: PHONE, body: '2' });

      const outcome = await handleInbound({ phone: PHONE, body: '2' });

      expect(recordPick).not.toHaveBeenCalled();
      if (outcome.kind === 'reply') expect(outcome.text).toContain('different number');
    });

    // Same bare-choice split as the first tap: leftover words are a fix, not
    // a dislike. Recording "make 2 bolder" as most-not-you would pollute the Brief.
    it('does not treat a fix request as the most-not-you pick', async () => {
      await driveToRevealed();
      await handleInbound({ phone: PHONE, body: '2' });

      const outcome = await handleInbound({ phone: PHONE, body: 'make 2 bolder' });

      expect(recordPick).not.toHaveBeenCalled();
      expect(outcome.kind).toBe('reply');
      if (outcome.kind === 'reply') expect(outcome.text).toContain('Just the number');
      const profile = await memoryProfileStore.get(PHONE);
      expect(profile?.lastStage).toBe('pick-pending');
      expect(profile?.pendingPickId).toBe('v2');
    });

    // Critique cuts are pickable on the web (ADR-0039), so a number over SMS
    // has to reach them too.
    it('can pick a cut that critique produced', async () => {
      await driveToRevealed();
      vi.mocked(getSession).mockResolvedValue({
        ...revealedSession(),
        critiqueCuts: [{ id: 'c1', axisPosition: {}, prompt: 'p', imageUrl: 'https://s/c1.png' }],
      } as unknown as Awaited<ReturnType<typeof getSession>>);

      await handleInbound({ phone: PHONE, body: '3' });

      const profile = await memoryProfileStore.get(PHONE);
      expect(profile?.pendingPickId).toBe('c1');
    });
  });

  describe('the refinement round', () => {
    async function driveToRefinePending(phone = PHONE) {
      await driveToRevealed(phone);
      await handleInbound({ phone, body: '2' });
      vi.mocked(recordPick).mockResolvedValueOnce({
        ...revealedSession(),
        phase: 'picked',
        refinementQuestion: 'Bolder, or keep it fine?',
      } as unknown as Awaited<ReturnType<typeof recordPick>>);
      await handleInbound({ phone, body: '1' });
    }

    it('treats the whole answer as free text and defers the render', async () => {
      await driveToRefinePending();

      const outcome = await handleInbound({ phone: PHONE, body: 'bolder, heavier lines' });

      expect(outcome.kind).toBe('refine');
      if (outcome.kind === 'refine') expect(outcome.answer).toBe('bolder, heavier lines');
    });

    it('delivers the regen and a handoff link carrying the session id', async () => {
      await driveToRefinePending();
      await handleInbound({ phone: PHONE, body: 'bolder' });
      vi.mocked(refine).mockResolvedValueOnce({
        ...revealedSession(),
        phase: 'complete',
        refinedVariation: { id: 'v3-refined', axisPosition: {}, prompt: 'p', imageUrl: 'https://s/r.png' },
        brief: { placement: 'forearm', styleTags: [], meaning: 'x' },
      } as unknown as Awaited<ReturnType<typeof refine>>);

      const delivery = await executeRefine('s1', PHONE, 'bolder', await currentArmedAt());

      expect(delivery.cuts[0].mediaUrl).toBe('https://s/r.png');
      // The whole point of reaching 'complete': /smart-match can load the
      // brief, and the id threads onward into the booking.
      expect(delivery.closingText).toContain('https://tatttester.com/smart-match?ds=s1');
      const profile = await memoryProfileStore.get(PHONE);
      expect(profile?.lastStage).toBe('complete');
    });

    // The two-deliverable payoff: the texter approved a render, the artist
    // needs line art, and both travel together.
    it('sends the stencil alongside the design when one was derived', async () => {
      await driveToRefinePending();
      await handleInbound({ phone: PHONE, body: 'bolder' });
      vi.mocked(refine).mockResolvedValueOnce({
        ...revealedSession(),
        phase: 'complete',
        refinedVariation: { id: 'r', axisPosition: {}, prompt: 'p', imageUrl: 'https://s/r.png' },
        brief: {
          placement: 'forearm',
          styleTags: [],
          meaning: 'x',
          stencilUrl: 'https://storage.googleapis.com/tatt/stencil.png',
        },
      } as unknown as Awaited<ReturnType<typeof refine>>);

      const delivery = await executeRefine('s1', PHONE, 'bolder', await currentArmedAt());

      expect(delivery.cuts).toHaveLength(2);
      expect(delivery.cuts[1].mediaUrl).toBe('https://storage.googleapis.com/tatt/stencil.png');
      expect(delivery.cuts[1].caption).toMatch(/stencil/i);
      expect(delivery.closingText).toMatch(/two files/i);
    });

    // Derivation is off by default and can fail. Promising two files when
    // one arrived reads as a broken send.
    it('never promises a stencil that was not derived', async () => {
      await driveToRefinePending();
      await handleInbound({ phone: PHONE, body: 'bolder' });
      vi.mocked(refine).mockResolvedValueOnce({
        ...revealedSession(),
        phase: 'complete',
        refinedVariation: { id: 'r', axisPosition: {}, prompt: 'p', imageUrl: 'https://s/r.png' },
      } as unknown as Awaited<ReturnType<typeof refine>>);

      const delivery = await executeRefine('s1', PHONE, 'bolder', await currentArmedAt());

      expect(delivery.cuts).toHaveLength(1);
      expect(delivery.closingText).not.toMatch(/two files/i);
    });

    it('re-arms for another answer when the regen fails', async () => {
      await driveToRefinePending();
      await handleInbound({ phone: PHONE, body: 'bolder' });
      vi.mocked(refine).mockRejectedValueOnce(new Error('provider blew up'));

      const delivery = await executeRefine('s1', PHONE, 'bolder', await currentArmedAt());

      expect(delivery.closingText).toBe(REFINE_FAILED_TEXT);
      const profile = await memoryProfileStore.get(PHONE);
      expect(profile?.lastStage).toBe('refine-pending');
    });

    it('refuses the render when the global budget is gone', async () => {
      await driveToRefinePending();
      vi.mocked(checkBudget).mockResolvedValueOnce({
        allowed: false,
        spentCents: 50000,
        remainingCents: 0,
      });

      const outcome = await handleInbound({ phone: PHONE, body: 'bolder' });

      if (outcome.kind === 'reply') expect(outcome.text).toBe(BUDGET_EXHAUSTED_TEXT);
      expect(refine).not.toHaveBeenCalled();
    });

    // The reveal closing copy invites "start over"; that escape must work
    // here too, or the phrase arms a paid refine of a design they abandoned.
    it('starts fresh on restart intent instead of arming refine', async () => {
      await driveToRefinePending();
      vi.mocked(converse).mockResolvedValueOnce(turn('chatting'));

      const outcome = await handleInbound({ phone: PHONE, body: 'start over' });

      expect(outcome.kind).toBe('reply');
      expect(refine).not.toHaveBeenCalled();
      expect(converse).toHaveBeenCalledWith({ message: 'start over' });
      const profile = await memoryProfileStore.get(PHONE);
      expect(profile?.lastStage).toBe('chatting');
      expect(profile?.activeSessionId).toBe('s1');
    });

    // Refinement is free text — substring matches like "something else" inside
    // real feedback must arm refine, not abandon the design.
    it('arms refine for feedback that only mentions restart-like words mid-sentence', async () => {
      await driveToRefinePending();
      vi.mocked(converse).mockClear();

      const outcome = await handleInbound({
        phone: PHONE,
        body: 'add something else around the dagger',
      });

      expect(outcome.kind).toBe('refine');
      if (outcome.kind === 'refine') {
        expect(outcome.answer).toBe('add something else around the dagger');
      }
      expect(converse).not.toHaveBeenCalled();
      const profile = await memoryProfileStore.get(PHONE);
      expect(profile?.lastStage).toBe('refine-running');
      expect(profile?.activeSessionId).toBe('s1');
    });
  });

  describe('stale in-flight recovery', () => {
    it('does not let a superseded critique callback spend after recovery', async () => {
      await driveToRevealed();
      await handleInbound({ phone: PHONE, body: 'make it bolder' });
      const staleArmedAt = await currentArmedAt();

      // Stale recovery (or a newer arm) clears/replaces the token — the
      // deferred after() job from the first arm must not call critique().
      const profile = await memoryProfileStore.get(PHONE);
      profile!.lastStage = 'revealed';
      profile!.revealArmedAt = null;
      await memoryProfileStore.save(profile!);

      const delivery = await executeCritique(
        's1',
        PHONE,
        'make it bolder',
        staleArmedAt
      );
      expect(delivery).toEqual({ cuts: [], closingText: '' });
      expect(critique).not.toHaveBeenCalled();
    });

    // Entry stillArmed abort must refund the reserved slot — otherwise a
    // texter loses a daily cap without ever receiving cuts.
    it('refunds the reveal slot when a stale-superseded callback never generates', async () => {
      await driveToProposal();
      await handleInbound({ phone: PHONE, body: 'yes' });
      const staleArmedAt = await currentArmedAt();

      const profile = await memoryProfileStore.get(PHONE);
      expect(profile?.dailyReveals.count).toBe(1);
      profile!.lastStage = 'proposal';
      profile!.revealArmedAt = null;
      await memoryProfileStore.save(profile!);

      const delivery = await executeReveal('s1', PHONE, staleArmedAt);

      expect(delivery).toEqual({ cuts: [], closingText: '' });
      expect(confirmProposal).not.toHaveBeenCalled();
      const after = await memoryProfileStore.get(PHONE);
      expect(after?.dailyReveals.count).toBe(0);
      expect(after?.totalReveals).toBe(0);
    });

    // A late/duplicate after() for an arm that already delivered must not
    // releaseReveal — that would refund a slot the texter already used.
    it('does not refund the reveal slot after a successful delivery', async () => {
      await driveToProposal();
      await handleInbound({ phone: PHONE, body: 'yes' });
      const armedAt = await currentArmedAt();
      vi.mocked(confirmProposal).mockResolvedValueOnce(
        revealedSession() as unknown as Awaited<ReturnType<typeof confirmProposal>>
      );
      await executeReveal('s1', PHONE, armedAt);

      const mid = await memoryProfileStore.get(PHONE);
      expect(mid?.lastStage).toBe('revealed');
      expect(mid?.dailyReveals.count).toBe(1);

      const delivery = await executeReveal('s1', PHONE, armedAt);

      expect(delivery).toEqual({ cuts: [], closingText: '' });
      const after = await memoryProfileStore.get(PHONE);
      expect(after?.dailyReveals.count).toBe(1);
      expect(after?.totalReveals).toBe(1);
    });

    // Once confirmProposal has spent, a token cleared mid-render must not
    // drop the MMS — the user already paid for those cuts.
    it('still delivers a reveal that finished after stale recovery cleared the token', async () => {
      await driveToProposal();
      await handleInbound({ phone: PHONE, body: 'yes' });
      const armedAt = await currentArmedAt();

      vi.mocked(confirmProposal).mockImplementationOnce(async () => {
        const profile = await memoryProfileStore.get(PHONE);
        profile!.lastStage = 'proposal';
        profile!.revealArmedAt = null;
        await memoryProfileStore.save(profile!);
        return revealedSession() as unknown as Awaited<ReturnType<typeof confirmProposal>>;
      });

      const delivery = await executeReveal('s1', PHONE, armedAt);

      expect(delivery.cuts).toHaveLength(2);
      expect(delivery.closingText).toMatch(/share|design/i);
      const after = await memoryProfileStore.get(PHONE);
      expect(after?.lastStage).toBe('revealed');
      expect(after?.dailyReveals.count).toBe(1);
    });

    it('still delivers a critique that finished after the token was cleared', async () => {
      await driveToRevealed();
      await handleInbound({ phone: PHONE, body: 'make it bolder' });
      const armedAt = await currentArmedAt();

      vi.mocked(critique).mockImplementationOnce(async () => {
        const profile = await memoryProfileStore.get(PHONE);
        profile!.lastStage = 'revealed';
        profile!.revealArmedAt = null;
        await memoryProfileStore.save(profile!);
        return {
          session: {
            ...revealedSession(),
            critiqueCuts: [
              { id: 'c1', axisPosition: {}, prompt: 'p', imageUrl: 'https://s/c1.png' },
            ],
          },
          reply: 'Bolder — here it is.',
          cut: { id: 'c1', axisPosition: {}, prompt: 'p', imageUrl: 'https://s/c1.png' },
          fixesRemaining: 24,
          exhausted: false,
          generated: true,
        } as unknown as Awaited<ReturnType<typeof critique>>;
      });

      const delivery = await executeCritique('s1', PHONE, 'make it bolder', armedAt);

      expect(delivery.cuts).toEqual([
        { caption: 'Cut 3 of 3', mediaUrl: 'https://s/c1.png' },
      ]);
      expect(delivery.closingText).toContain('Bolder');
    });
  });
});

describe('the two-cut rounds (ADR-0049)', () => {
  /** Walk a phone to delivered cuts, with the session readable. */
  async function driveToRevealed(phone = PHONE) {
    await driveToProposal(phone);
    await handleInbound({ phone, body: 'yes' });
    vi.mocked(confirmProposal).mockResolvedValueOnce(
      revealedSession() as unknown as Awaited<ReturnType<typeof confirmProposal>>
    );
    await executeReveal('s1', phone, await currentArmedAt(phone));
    vi.mocked(getSession).mockResolvedValue(
      revealedSession() as unknown as Awaited<ReturnType<typeof getSession>>
    );
  }

  function pickedRoundSession() {
    const session = revealedSession();
    session.rounds = [
      {
        round: 1,
        axis: 'bold-fine',
        variationIds: ['v1', 'v2'],
        pickedId: 'v2',
        pickedAt: '2026-07-29T00:01:00.000Z',
      },
    ];
    return session;
  }

  describe('the A/B pick', () => {
    it('records the pick on a bare A, free, and stays repickable', async () => {
      await driveToRevealed();
      vi.mocked(recordRoundPick).mockResolvedValue(
        pickedRoundSession() as unknown as Awaited<ReturnType<typeof recordRoundPick>>
      );

      const outcome = await handleInbound({ phone: PHONE, body: 'A' });

      expect(recordRoundPick).toHaveBeenCalledWith('s1', { pickedId: 'v1' });
      expect(outcome).toEqual({ kind: 'reply', text: ROUND_LOCKED_TEXT });
      // Nothing charged, nothing armed — the pick is the free signal.
      expect(reserveGenerationCredit).not.toHaveBeenCalled();
      const profile = await memoryProfileStore.get(PHONE);
      expect(profile?.lastStage).toBe('revealed');

      // A second letter re-picks — changeable until the round is charged.
      const again = await handleInbound({ phone: PHONE, body: 'b' });
      expect(recordRoundPick).toHaveBeenLastCalledWith('s1', { pickedId: 'v2' });
      expect(again).toEqual({ kind: 'reply', text: ROUND_LOCKED_TEXT });
    });

    it('tells a texter when the round is already frozen', async () => {
      await driveToRevealed();
      vi.mocked(recordRoundPick).mockRejectedValueOnce(
        new DesignSessionError('ROUND_PICK_FROZEN')
      );

      const outcome = await handleInbound({ phone: PHONE, body: 'B' });

      expect(outcome.kind).toBe('reply');
      if (outcome.kind === 'reply') expect(outcome.text).toContain('REFINE');
      expect(critique).not.toHaveBeenCalled();
    });

    it('waits out a rendering round without dropping the session (#338)', async () => {
      await driveToRevealed();
      vi.mocked(recordRoundPick).mockRejectedValueOnce(
        new DesignSessionError('ROUND_IN_FLIGHT')
      );

      const outcome = await handleInbound({ phone: PHONE, body: 'A' });

      expect(outcome.kind).toBe('reply');
      if (outcome.kind === 'reply') expect(outcome.text).toContain('rendering');
      // Transient collision, not a broken session — the texter stays linked.
      const profile = await memoryProfileStore.get(PHONE);
      expect(profile?.activeSessionId).toBe('s1');
    });

    it('never reads A/B inside an instruction as a pick', async () => {
      await driveToRevealed();

      const outcome = await handleInbound({ phone: PHONE, body: 'make a bolder version' });

      expect(recordRoundPick).not.toHaveBeenCalled();
      expect(outcome.kind).toBe('critique');
    });
  });

  describe('REFINE — the charged round', () => {
    async function driveToPicked(phone = PHONE) {
      await driveToRevealed(phone);
      vi.mocked(getSession).mockResolvedValue(
        pickedRoundSession() as unknown as Awaited<ReturnType<typeof getSession>>
      );
    }

    it('asks for a pick first when the round has none', async () => {
      await driveToRevealed();

      const outcome = await handleInbound({ phone: PHONE, body: 'REFINE' });

      expect(outcome.kind).toBe('reply');
      if (outcome.kind === 'reply') expect(outcome.text).toContain('A or B');
      expect(reserveGenerationCredit).not.toHaveBeenCalled();
    });

    it('gates an unlinked number behind an account — a credit needs an owner', async () => {
      await driveToPicked();

      const outcome = await handleInbound({ phone: PHONE, body: 'refine' });

      expect(outcome.kind).toBe('reply');
      if (outcome.kind === 'reply') {
        expect(outcome.text).toContain('https://tatttester.com/signup');
      }
      expect(reserveGenerationCredit).not.toHaveBeenCalled();
      expect(refineRound).not.toHaveBeenCalled();
    });

    it('reserves ONE credit at arm time and defers the renders', async () => {
      mockLinked('user-1');
      await driveToPicked();

      const outcome = await handleInbound({ phone: PHONE, body: 'REFINE' });

      expect(reserveGenerationCredit).toHaveBeenCalledWith('user-1');
      expect(outcome).toMatchObject({
        kind: 'refine-round',
        text: ROUND_ACK,
        sessionId: 's1',
        phone: PHONE,
        uid: 'user-1',
        credit: expect.objectContaining({ id: 'res-1' }),
      });
      // Renders are deferred — nothing fired synchronously.
      expect(refineRound).not.toHaveBeenCalled();
      const profile = await memoryProfileStore.get(PHONE);
      expect(profile?.lastStage).toBe('round-running');
      // Persisted at reserve time, not only in the deferred closure: a
      // crash before delivery leaves a reconcilable reservation id.
      expect(profile?.pendingCreditReservationId).toBe('res-1');
    });

    it('restarts the design when the session belongs to another account — refused pre-charge (#338 item 1)', async () => {
      mockLinked('user-1');
      await driveToPicked();
      vi.mocked(claimSessionOwnership).mockRejectedValueOnce(
        new DesignSessionError('SESSION_NOT_FOUND', 'No design session')
      );
      vi.mocked(converse).mockResolvedValueOnce(turn('chatting', { sessionId: 's2' }));

      const outcome = await handleInbound({ phone: PHONE, body: 'REFINE' });

      // Same recovery as an expired session: never a charge, never a dead-end —
      // the message opens a fresh conversation instead.
      expect(reserveGenerationCredit).not.toHaveBeenCalled();
      expect(outcome.kind).toBe('reply');
      const profile = await memoryProfileStore.get(PHONE);
      expect(profile?.activeSessionId).toBe('s2');
    });

    it('propagates a transient store error instead of silently discarding the session', async () => {
      mockLinked('user-1');
      await driveToPicked();
      vi.mocked(claimSessionOwnership).mockRejectedValueOnce(new Error('firestore hiccup'));

      await expect(handleInbound({ phone: PHONE, body: 'REFINE' })).rejects.toThrow(
        'firestore hiccup'
      );

      // The texter's in-progress session survives — only a genuine
      // SESSION_NOT_FOUND may unlink it.
      expect(reserveGenerationCredit).not.toHaveBeenCalled();
      const profile = await memoryProfileStore.get(PHONE);
      expect(profile?.activeSessionId).toBe('s1');
    });

    it('reads a contentless tail as REFINE, not a fix-allowance critique (#338)', async () => {
      mockLinked('user-1');
      await driveToPicked();

      const outcome = await handleInbound({ phone: PHONE, body: 'refine it please' });

      expect(outcome.kind).toBe('refine-round');
      expect(reserveGenerationCredit).toHaveBeenCalledWith('user-1');
    });

    it('speaks the empty meter instead of arming a round it cannot charge', async () => {
      mockLinked('user-1');
      await driveToPicked();
      vi.mocked(reserveGenerationCredit).mockRejectedValueOnce(
        new GenerationCreditsExhaustedError()
      );

      const outcome = await handleInbound({ phone: PHONE, body: 'REFINE' });

      expect(outcome.kind).toBe('reply');
      if (outcome.kind === 'reply') expect(outcome.text).toContain('free generations');
      expect(refineRound).not.toHaveBeenCalled();
    });

    it('delivers the next pair with the A/B ask and keeps the credit', async () => {
      mockLinked('user-1');
      await driveToPicked();
      await handleInbound({ phone: PHONE, body: 'REFINE' });

      const roundTwo = pickedRoundSession();
      roundTwo.rounds![0].frozen = true;
      roundTwo.variations = [
        ...roundTwo.variations,
        {
          id: 'v3',
          axisPosition: { 'color-blackwork': 'color', 'bold-fine': 'fine' },
          prompt: 'p3',
          imageUrl: 'https://storage.example/cut-3.png',
        },
        {
          id: 'v4',
          axisPosition: { 'color-blackwork': 'blackwork', 'bold-fine': 'fine' },
          prompt: 'p4',
          imageUrl: 'https://storage.example/cut-4.png',
        },
      ];
      const newRound = { round: 2, axis: 'color-blackwork', variationIds: ['v3', 'v4'] };
      roundTwo.rounds = [...roundTwo.rounds!, newRound];
      vi.mocked(refineRound).mockResolvedValueOnce({
        session: roundTwo,
        round: newRound,
        downgraded: false,
      } as unknown as Awaited<ReturnType<typeof refineRound>>);

      const delivery = await executeRefineRound(
        's1',
        PHONE,
        'user-1',
        { id: 'res-1', source: 'free', freeRemaining: 24, paidRemaining: 0 },
        await currentArmedAt()
      );

      expect(delivery.cuts).toEqual([
        { caption: 'Cut A — full-color', mediaUrl: 'https://storage.example/cut-3.png' },
        { caption: 'Cut B — blackwork', mediaUrl: 'https://storage.example/cut-4.png' },
      ]);
      expect(delivery.closingText).toContain(
        'Two cuts this round: A is full-color, B is blackwork. Reply A or B.'
      );
      // A delivered round keeps its credit.
      expect(releaseGenerationCredit).not.toHaveBeenCalled();
      const profile = await memoryProfileStore.get(PHONE);
      expect(profile?.lastStage).toBe('revealed');
    });

    it('releases the credit and speaks the decided copy when the round dies', async () => {
      mockLinked('user-1');
      await driveToPicked();
      await handleInbound({ phone: PHONE, body: 'REFINE' });
      vi.mocked(refineRound).mockRejectedValueOnce(new Error('provider blew up'));

      const credit = { id: 'res-1', source: 'free' as const, freeRemaining: 24, paidRemaining: 0 };
      const delivery = await executeRefineRound(
        's1',
        PHONE,
        'user-1',
        credit,
        await currentArmedAt()
      );

      expect(delivery.cuts).toHaveLength(0);
      expect(delivery.closingText).toBe(ROUND_FAILED_TEXT);
      expect(releaseGenerationCredit).toHaveBeenCalledWith('user-1', credit);
      // Re-armed for another REFINE, exactly as the copy promises — and the
      // refunded reservation is no longer pending reconciliation.
      const profile = await memoryProfileStore.get(PHONE);
      expect(profile?.lastStage).toBe('revealed');
      expect(profile?.pendingCreditReservationId).toBeNull();
    });

    it('never claims the refund when the release itself failed', async () => {
      mockLinked('user-1');
      await driveToPicked();
      await handleInbound({ phone: PHONE, body: 'REFINE' });
      vi.mocked(refineRound).mockRejectedValueOnce(new Error('provider blew up'));
      vi.mocked(releaseGenerationCredit).mockRejectedValueOnce(new Error('firestore down'));

      const credit = { id: 'res-1', source: 'free' as const, freeRemaining: 24, paidRemaining: 0 };
      const delivery = await executeRefineRound(
        's1',
        PHONE,
        'user-1',
        credit,
        await currentArmedAt()
      );

      // Honest copy: no "your credit is back" for a refund that did not land
      // — and the reservation stays on the profile for reconciliation.
      expect(delivery.closingText).toBe("That round didn't take. Reply REFINE to try again.");
      const profile = await memoryProfileStore.get(PHONE);
      expect(profile?.pendingCreditReservationId).toBe('res-1');
    });

    it('releases the credit on an ADR-0048 downgrade and says so', async () => {
      mockLinked('user-1');
      await driveToPicked();
      await handleInbound({ phone: PHONE, body: 'REFINE' });

      const roundTwo = pickedRoundSession();
      const newRound = {
        round: 2,
        axis: 'color-blackwork',
        variationIds: ['v3', 'v4'],
        downgraded: true,
        downgradeReason: 'REPLICATE_ERROR',
      };
      roundTwo.variations = [
        ...roundTwo.variations,
        { id: 'v3', axisPosition: { 'color-blackwork': 'color' }, prompt: 'p3', imageUrl: 'https://storage.example/cut-3.png' },
        { id: 'v4', axisPosition: { 'color-blackwork': 'blackwork' }, prompt: 'p4', imageUrl: 'https://storage.example/cut-4.png' },
      ];
      roundTwo.rounds = [...roundTwo.rounds!, newRound];
      vi.mocked(refineRound).mockResolvedValueOnce({
        session: roundTwo,
        round: newRound,
        downgraded: true,
        downgradeReason: 'REPLICATE_ERROR',
      } as unknown as Awaited<ReturnType<typeof refineRound>>);

      const credit = { id: 'res-1', source: 'free' as const, freeRemaining: 24, paidRemaining: 0 };
      const delivery = await executeRefineRound(
        's1',
        PHONE,
        'user-1',
        credit,
        await currentArmedAt()
      );

      // Delivered AND refunded AND said — the loud downgrade, never silent.
      expect(delivery.cuts).toHaveLength(2);
      expect(delivery.closingText).toContain('credit is back');
      expect(releaseGenerationCredit).toHaveBeenCalledWith('user-1', credit);
    });

    it('never double-fires a round on an impatient second REFINE', async () => {
      mockLinked('user-1');
      await driveToPicked();
      await handleInbound({ phone: PHONE, body: 'REFINE' });

      const again = await handleInbound({ phone: PHONE, body: 'REFINE' });

      expect(again.kind).toBe('reply');
      if (again.kind === 'reply') expect(again.text).toContain('Still cutting');
      expect(reserveGenerationCredit).toHaveBeenCalledTimes(1);
    });

    it('refuses the round when the global budget is gone, before the credit', async () => {
      mockLinked('user-1');
      await driveToPicked();
      vi.mocked(checkBudget).mockResolvedValueOnce({
        allowed: false,
        spentCents: 50_000,
        remainingCents: 0,
      });

      const outcome = await handleInbound({ phone: PHONE, body: 'REFINE' });

      if (outcome.kind === 'reply') expect(outcome.text).toBe(BUDGET_EXHAUSTED_TEXT);
      expect(reserveGenerationCredit).not.toHaveBeenCalled();
    });
  });

  describe('BOOK', () => {
    it('hands off to smart-match carrying the session id', async () => {
      await driveToRevealed();

      const outcome = await handleInbound({ phone: PHONE, body: 'BOOK' });

      expect(outcome.kind).toBe('reply');
      if (outcome.kind === 'reply') {
        expect(outcome.text).toContain('https://tatttester.com/smart-match?ds=s1');
      }
    });

    it('reads a contentless tail as the keyword, not a paid critique (#338)', async () => {
      await driveToRevealed();

      for (const body of ['book it', 'Book it!', 'yes book this one', "let's book it now."]) {
        const outcome = await handleInbound({ phone: PHONE, body });

        expect(outcome.kind).toBe('reply');
        if (outcome.kind === 'reply') {
          expect(outcome.text).toContain('https://tatttester.com/smart-match?ds=s1');
        }
      }
      expect(reserveGenerationCredit).not.toHaveBeenCalled();
    });

    it('still reads a real instruction as the critique lane, not BOOK or REFINE', async () => {
      await driveToRevealed();

      const outcome = await handleInbound({
        phone: PHONE,
        body: 'refine the lines on A',
      });

      expect(outcome.kind).not.toBe('reply');
      expect(outcome.kind).not.toBe('refine-round');
    });
  });
});

describe('spend guardrails', () => {
  async function completeReveal(sessionId = 's1') {
    vi.mocked(confirmProposal).mockResolvedValueOnce(
      revealedSession() as unknown as Awaited<ReturnType<typeof confirmProposal>>
    );
    await executeReveal(sessionId, PHONE, await currentArmedAt());
  }

  it('refuses the third reveal of the day in-voice (default cap 2)', async () => {
    mockLinked('user-1'); // linked, so the daily cap is the binding guardrail

    for (let i = 0; i < 2; i++) {
      if (i > 0) await restartAndDriveToProposal();
      else await driveToProposal();
      const armed = await handleInbound({ phone: PHONE, body: 'yes' });
      expect(armed.kind).toBe('reveal');
      await completeReveal();
    }

    await restartAndDriveToProposal();
    const third = await handleInbound({ phone: PHONE, body: 'yes' });
    expect(third.kind).toBe('reply');
    if (third.kind === 'reply') {
      expect(third.text).toContain("I've put a lot in front of you today");
      expect(third.text).toContain('https://tatttester.com/design');
    }
    expect(confirmProposal).toHaveBeenCalledTimes(2); // never a third render
  });

  it('honors an env-tuned cap', async () => {
    vi.stubEnv('SKETCHBOT_SMS_REVEALS_PER_DAY', '1');
    mockLinked('user-1');

    await driveToProposal();
    expect((await handleInbound({ phone: PHONE, body: 'yes' })).kind).toBe('reveal');
    await completeReveal();

    await restartAndDriveToProposal();
    expect((await handleInbound({ phone: PHONE, body: 'yes' })).kind).toBe('reply');
  });

  it('gates the third lifetime reveal behind an account for unlinked numbers', async () => {
    vi.stubEnv('SKETCHBOT_SMS_REVEALS_PER_DAY', '10'); // daily cap out of the way

    for (let i = 0; i < 2; i++) {
      if (i > 0) await restartAndDriveToProposal();
      else await driveToProposal();
      expect((await handleInbound({ phone: PHONE, body: 'yes' })).kind).toBe('reveal');
      await completeReveal();
    }

    await restartAndDriveToProposal();
    const gated = await handleInbound({ phone: PHONE, body: 'yes' });
    expect(gated.kind).toBe('reply');
    if (gated.kind === 'reply') {
      expect(gated.text).toContain('https://tatttester.com/signup');
    }
  });

  it('upgrades a guest to their account mid-conversation and lifts the gate', async () => {
    vi.stubEnv('SKETCHBOT_SMS_REVEALS_PER_DAY', '10');

    for (let i = 0; i < 2; i++) {
      if (i > 0) await restartAndDriveToProposal();
      else await driveToProposal();
      await handleInbound({ phone: PHONE, body: 'yes' });
      await completeReveal();
    }

    // The texter signs up with this verified phone; the next yes re-checks
    // and links the guest profile in place — history intact, gate lifted.
    mockLinked('user-42');
    await restartAndDriveToProposal();
    const outcome = await handleInbound({ phone: PHONE, body: 'yes' });

    expect(outcome.kind).toBe('reveal');
    const profile = await memoryProfileStore.get(PHONE);
    expect(profile?.uid).toBe('user-42');
    expect(profile?.totalReveals).toBe(3);
    expect(profile?.sessionIds.length).toBeGreaterThan(0);
  });

  it('answers the budget-exhausted day honestly and refunds the slot', async () => {
    await driveToProposal();
    vi.mocked(checkBudget).mockResolvedValueOnce({
      allowed: false,
      spentCents: 50_000,
      remainingCents: 0,
    });

    const outcome = await handleInbound({ phone: PHONE, body: 'yes' });
    expect(outcome).toEqual({ kind: 'reply', text: BUDGET_EXHAUSTED_TEXT });

    // The refused reveal consumed nothing.
    const profile = await memoryProfileStore.get(PHONE);
    expect(profile?.dailyReveals.count).toBe(0);
    expect(profile?.totalReveals).toBe(0);
    // And the proposal is still live: budget back → the yes works.
    const retry = await handleInbound({ phone: PHONE, body: 'yes' });
    expect(retry.kind).toBe('reveal');
  });
});

describe('opt-out', () => {
  it('goes silent for a number that texted STOP, and re-opens on START', async () => {
    await recordOptOut(PHONE, 'STOP');
    expect(await isOptedOut(PHONE)).toBe(true);

    const outcome = await handleInbound({ phone: PHONE, body: 'hello?' });
    expect(outcome).toEqual({ kind: 'silent' });
    expect(converse).not.toHaveBeenCalled();

    await recordOptOut(PHONE, 'START');
    expect(await isOptedOut(PHONE)).toBe(false);
    vi.mocked(converse).mockResolvedValueOnce(turn('chatting'));
    expect((await handleInbound({ phone: PHONE, body: 'back' })).kind).toBe('reply');
  });

  it('asks for words on a media-only MMS', async () => {
    const outcome = await handleInbound({ phone: PHONE, body: '   ' });
    expect(outcome.kind).toBe('reply');
    expect(converse).not.toHaveBeenCalled();
  });
});
