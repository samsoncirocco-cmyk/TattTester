/**
 * Adapter handling of inbound MMS reference photos (TAT-50): the in-voice
 * acknowledgment that names what was seen, session attach (including the
 * free opener when no conversation is live), the engine-turn annotation,
 * and the honest budget/unreadable lines. The media pipeline and the
 * design-session service are mocked at their module boundaries.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { executePlacement, handleInbound } from '../index';
import { clearMemoryProfiles, memoryProfileStore } from '../internal/profileStore';
import { REVEAL_ACK } from '../internal/render';
import { analyzeInboundMedia, type MediaIngest } from '../internal/media';
import {
  converse,
  confirmProposal,
  attachReference,
  getSession,
} from '@/services/designSession';
import {
  REFERENCE_BUDGET_TEXT,
  REFERENCE_UNREADABLE_TEXT,
  type ReferenceAnalysis,
} from '@/services/vision';
import { checkBudget } from '@/lib/budget-tracker';

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
  return {
    converse: vi.fn(),
    confirmProposal: vi.fn(),
    attachReference: vi.fn(async () => ({ sessionId: 's1', summary: '', notes: {} })),
    storeReferencePhoto: vi.fn(async () => 'design-sessions/s1/references/ref-1.jpg'),
    getSession: vi.fn(),
    recordPick: vi.fn(),
    refine: vi.fn(),
    critique: vi.fn(),
    attachPlacementPreview: vi.fn(),
    allCuts: pureCritique.allCuts,
    isFixRequest: pureCritique.isFixRequest,
    DesignSessionError,
  };
});

vi.mock('../internal/media', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../internal/media')>();
  return { ...actual, analyzeInboundMedia: vi.fn() };
});

vi.mock('@/lib/budget-tracker', () => ({
  checkBudget: vi.fn(async () => ({ allowed: true, spentCents: 0, remainingCents: 1000 })),
  recordConversationTurnSpend: vi.fn(async () => {}),
}));
vi.mock('@/lib/firebase-admin', () => ({ ensureAdminApp: () => null }));
vi.mock('firebase-admin/auth', () => ({
  getAuth: vi.fn(() => ({
    getUserByPhoneNumber: vi.fn(async () => {
      throw new Error('no user record');
    }),
  })),
}));

const PHONE = '+15551234567';
const MEDIA = [{ url: 'https://api.twilio.com/m/0', contentType: 'image/jpeg' }];

const CHIBI_ANALYSIS: ReferenceAnalysis = {
  summary: 'five chibi anime characters, bold outlines, cel shading, red smoke background',
  subjects: ['group of five characters'],
  characters: [{ name: 'Yusuke Urameshi', series: 'Yu Yu Hakusho' }],
  styleDescriptors: ['chibi', 'anime', 'cel shading'],
  palette: ['red', 'black'],
  composition: 'group shot',
  confidence: 0.9,
};

/** The pixels riding alongside the analysis (ADR-0050). */
const CHIBI_IMAGE = { data: 'cGl4ZWxz', mimeType: 'image/jpeg' };

function ingest(overrides: Partial<MediaIngest> = {}): MediaIngest {
  return {
    analyses: [{ analysis: CHIBI_ANALYSIS, image: CHIBI_IMAGE }],
    unreadable: 0,
    ignored: 0,
    budgetExhausted: false,
    ...overrides,
  };
}

const analyzeMock = vi.mocked(analyzeInboundMedia);
const converseMock = vi.mocked(converse);
const attachMock = vi.mocked(attachReference);

function converseResponse(overrides: Record<string, unknown> = {}) {
  return {
    sessionId: 's1',
    reply: 'Love that direction. Where on your body would it go?',
    stage: 'chatting' as const,
    turn: 1,
    ...overrides,
  };
}

beforeEach(() => {
  clearMemoryProfiles();
  vi.clearAllMocks();
  vi.stubEnv('NEXT_PUBLIC_DEMO_MODE', 'false');
  vi.mocked(checkBudget).mockResolvedValue({ allowed: true, spentCents: 0, remainingCents: 1000 });
  analyzeMock.mockResolvedValue(ingest());
  converseMock.mockResolvedValue(converseResponse());
});

describe('media-only MMS', () => {
  it('opens a session, attaches the reference, and acknowledges what it saw with ONE follow-up', async () => {
    converseMock.mockResolvedValueOnce(
      converseResponse({ sessionId: 's-new', reply: 'opener', turn: 0 })
    );

    const outcome = await handleInbound({ phone: PHONE, body: '', media: MEDIA });

    expect(outcome.kind).toBe('reply');
    if (outcome.kind !== 'reply') throw new Error('unreachable');
    // Names what was seen — never a silent ingest.
    expect(outcome.text).toContain('five chibi anime characters');
    // Characters recognized → the cast-vs-style fork is the one follow-up.
    expect(outcome.text).toContain('Want the characters themselves in the piece');

    // The opener call created the session and the reference attached to it.
    expect(converseMock).toHaveBeenCalledWith({});
    expect(attachMock).toHaveBeenCalledWith('s-new', CHIBI_ANALYSIS, 'sms', 'design-sessions/s1/references/ref-1.jpg');
    const profile = await memoryProfileStore.get(PHONE);
    expect(profile!.activeSessionId).toBe('s-new');
    expect(profile!.sessionIds).toContain('s-new');
  });

  it('says the honest unreadable line when nothing could be read', async () => {
    analyzeMock.mockResolvedValue(ingest({ analyses: [], unreadable: 1 }));

    const outcome = await handleInbound({ phone: PHONE, body: '', media: MEDIA });

    expect(outcome).toEqual({ kind: 'reply', text: REFERENCE_UNREADABLE_TEXT });
    expect(attachMock).not.toHaveBeenCalled();
  });

  it('says the honest capacity line when the vision budget is exhausted', async () => {
    analyzeMock.mockResolvedValue(ingest({ analyses: [], budgetExhausted: true }));

    const outcome = await handleInbound({ phone: PHONE, body: '', media: MEDIA });

    expect(outcome).toEqual({ kind: 'reply', text: REFERENCE_BUDGET_TEXT });
    expect(attachMock).not.toHaveBeenCalled();
  });

  it('acknowledges photos beyond the cap instead of silently dropping them', async () => {
    analyzeMock.mockResolvedValue(ingest({ ignored: 2 }));
    converseMock.mockResolvedValueOnce(
      converseResponse({ sessionId: 's-new', reply: 'opener', turn: 0 })
    );

    const outcome = await handleInbound({ phone: PHONE, body: '', media: MEDIA });

    if (outcome.kind !== 'reply') throw new Error('unreachable');
    expect(outcome.text).toContain('I stuck with the first photo');
  });
});

describe('media + text', () => {
  it('threads the photo into the engine turn as an annotation and prepends the ack', async () => {
    converseMock
      .mockResolvedValueOnce(converseResponse({ sessionId: 's1', reply: 'opener', turn: 0 }))
      .mockResolvedValueOnce(converseResponse());

    const outcome = await handleInbound({
      phone: PHONE,
      body: 'something like this on my forearm',
      media: MEDIA,
    });

    if (outcome.kind !== 'reply') throw new Error('unreachable');
    expect(outcome.text).toMatch(/^Got your photo — I'm seeing five chibi anime characters/);
    expect(outcome.text).toContain('Where on your body would it go?');

    // Second converse call is the real turn, annotated and threaded onto
    // the session the opener created.
    const turnCall = converseMock.mock.calls[1][0];
    expect(turnCall.sessionId).toBe('s1');
    expect(turnCall.message).toContain('something like this on my forearm');
    expect(turnCall.message).toContain('[photo attached — five chibi anime characters');
    expect(attachMock).toHaveBeenCalledWith('s1', CHIBI_ANALYSIS, 'sms', 'design-sessions/s1/references/ref-1.jpg');
  });

  it('continues the text turn after a budget-refused analysis, with the capacity line first', async () => {
    analyzeMock.mockResolvedValue(ingest({ analyses: [], budgetExhausted: true }));

    const outcome = await handleInbound({ phone: PHONE, body: 'a rose', media: MEDIA });

    if (outcome.kind !== 'reply') throw new Error('unreachable');
    expect(outcome.text).toMatch(/^I can't study photos right now/);
    expect(outcome.text).toContain('Where on your body would it go?');
    // No annotation without an analysis.
    expect(converseMock.mock.calls[0][0].message).toBe('a rose');
  });
});

describe('media + confirmation', () => {
  it('attaches the reference before arming the reveal and keeps the ack in the reply', async () => {
    // Walk to proposal first.
    converseMock.mockResolvedValueOnce(
      converseResponse({ stage: 'proposal', playback: 'a chibi group on your forearm' })
    );
    await handleInbound({ phone: PHONE, body: 'chibi crew on my forearm' });

    const outcome = await handleInbound({ phone: PHONE, body: 'yes', media: MEDIA });

    expect(outcome.kind).toBe('reveal');
    if (outcome.kind !== 'reveal') throw new Error('unreachable');
    expect(outcome.text).toContain('five chibi anime characters');
    expect(outcome.text).toContain(REVEAL_ACK);
    expect(attachMock).toHaveBeenCalledWith('s1', CHIBI_ANALYSIS, 'sms', 'design-sessions/s1/references/ref-1.jpg');
  });
});

/*
 * The 'media + post-reveal' suite that lived here is deliberately gone.
 *
 * It asserted that a photo sent after the reveal attaches as a REFERENCE to
 * the session. The placement work below supersedes that: after the reveal a
 * photo is the customer's BODY, to composite the design onto — which is the
 * whole point of `a photo after the reveal is the body, not a reference`.
 *
 * Both behaviours cannot hold. This is a semantic conflict between two
 * commits, not a merge artefact: #299 shipped the reference reading and this
 * change reverses it on purpose.
 */

describe('a photo after the reveal is the body, not a reference', () => {
  const PHOTO = [{ url: 'https://api.twilio.com/media/ME1', contentType: 'image/jpeg' }];

  /** Walk the phone to a delivered reveal. */
  async function driveToRevealed(phone: string) {
    vi.mocked(converse).mockResolvedValueOnce({
      sessionId: 's1',
      reply: 'Ready?',
      stage: 'proposal',
      turn: 1,
    } as unknown as Awaited<ReturnType<typeof converse>>);
    await handleInbound({ phone, body: 'a snake on my forearm' });
    await handleInbound({ phone, body: 'yes' });
    const profile = await memoryProfileStore.get(phone);
    if (profile) {
      profile.lastStage = 'revealed';
      profile.revealArmedAt = null;
      await memoryProfileStore.save(profile);
    }
  }

  // The whole point of the split: intake is over, so a picture is where the
  // tattoo goes — and reading it as inspiration would spend vision budget
  // and put the texter's own arm in the artist's Brief as a reference.
  it('routes it to placement and never to the vision analyzer', async () => {
    const phone = '+15550001111';
    await driveToRevealed(phone);

    const outcome = await handleInbound({ phone, body: 'here', media: PHOTO });

    expect(outcome.kind).toBe('placement');
    if (outcome.kind === 'placement') {
      expect(outcome.mediaUrl).toBe(PHOTO[0].url);
      expect(outcome.message).toBe('here');
      // The superseded-guard token (#304), persisted like its siblings'.
      expect(typeof outcome.armedAt).toBe('string');
      const profile = await memoryProfileStore.get(phone);
      expect(profile?.placementArmedAt).toBe(outcome.armedAt);
    }
    expect(analyzeInboundMedia).not.toHaveBeenCalled();
  });

  it('never delivers a composite the texter moved past (#304)', async () => {
    const phone = '+15550003333';
    await driveToRevealed(phone);
    const outcome = await handleInbound({ phone, body: 'here', media: PHOTO });
    expect(outcome.kind).toBe('placement');
    if (outcome.kind !== 'placement') return;

    // The texter restarts onto a different design before the composite lands.
    const profile = await memoryProfileStore.get(phone);
    profile!.activeSessionId = 's2';
    await memoryProfileStore.save(profile!);

    const delivery = await executePlacement(
      outcome.sessionId,
      phone,
      { url: outcome.mediaUrl, contentType: outcome.contentType },
      outcome.message,
      outcome.armedAt
    );

    expect(delivery).toEqual({ cuts: [], closingText: '' });
    expect(getSession).not.toHaveBeenCalled();
  });

  it('a newer photo supersedes the older in-flight composite (#304)', async () => {
    const phone = '+15550004444';
    await driveToRevealed(phone);
    const first = await handleInbound({ phone, body: 'here', media: PHOTO });
    // Two arms can land in the same millisecond under test — step the clock
    // so the tokens differ the way real photos always do.
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 10 });
    let second;
    try {
      second = await handleInbound({ phone, body: 'a bit smaller', media: PHOTO });
    } finally {
      vi.useRealTimers();
    }
    expect(first.kind).toBe('placement');
    expect(second.kind).toBe('placement');
    if (first.kind !== 'placement' || second.kind !== 'placement') return;

    // The stale token aborts before touching the session…
    const stale = await executePlacement(
      first.sessionId,
      phone,
      { url: first.mediaUrl, contentType: first.contentType },
      first.message,
      first.armedAt
    );
    expect(stale).toEqual({ cuts: [], closingText: '' });
    expect(getSession).not.toHaveBeenCalled();

    // …while the current one passes the guard into real work.
    await executePlacement(
      second.sessionId,
      phone,
      { url: second.mediaUrl, contentType: second.contentType },
      second.message,
      second.armedAt
    );
    expect(getSession).toHaveBeenCalledWith(second.sessionId);
  });

  it('still reads a photo BEFORE the reveal as inspiration', async () => {
    const phone = '+15550002222';
    vi.mocked(analyzeInboundMedia).mockResolvedValueOnce({
      analyses: [],
      ignored: 0,
      unreadable: 1,
      budgetExhausted: false,
    } as unknown as MediaIngest);

    const outcome = await handleInbound({ phone, body: '', media: PHOTO });

    expect(outcome.kind).toBe('reply');
    expect(analyzeInboundMedia).toHaveBeenCalledTimes(1);
  });
});
