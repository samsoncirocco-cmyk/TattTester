/**
 * The post-reveal critique lane (ADR-0039).
 *
 * Two halves: the pure decisions in internal/critique.ts (which cut, is it a
 * fix, what does the prompt become), and the orchestrator turn — allowance,
 * pinned-model reuse, phase gating, and what the route is told to meter on.
 *
 * Every module boundary is mocked (generation, Firebase Admin forced off so
 * persistence runs in memory). No live provider call is ever made.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { critique, recordPick, DesignSessionError } from '../index';
import { memorySessionStore, clearMemorySessions } from '../internal/store';
import type { StoredSession } from '../internal/store';
import {
  MAX_PENDING_CRITIQUES,
  PENDING_CRITIQUE_TTL_MS,
  allCuts,
  classifyCritiqueTurn,
  cutLabel,
  isFixRequest,
  answerAddsRequest,
  readPendingCritique,
  resolveCritiqueTarget,
  stashPendingCritique,
} from '../internal/critique';
import {
  ALLOWANCE_SPENT_LINE,
  CHATTER_LINE,
  NAMED_BUT_NO_CHANGE_LINE,
  NO_SUCH_CUT_LINE,
  REROLL_DOWNGRADED_REFUNDED_NOTE,
  REROLL_NEEDS_ACCOUNT_LINE,
  ROUND_IN_FLIGHT_LINE,
  UNTRANSLATED_LOOK_LINE,
  WHICH_CUT_LINE,
  rerollLandedLine,
} from '../internal/critiqueVoice';
import { DEFAULT_STUDIO_FIX_ALLOWANCE } from '@/lib/studio-fix-allowance';
import { generate } from '../../generation';
import { enhanceRound } from '../../council';
import {
  copyImageToPath,
  recoverImageAtPath,
  uploadImageToPath,
} from '@/services/storage/imageStorageService';
import { recordSpend } from '@/lib/budget-tracker';
import type { Variation } from '../types';

vi.mock('../../intake', () => ({ extractIntake: vi.fn() }));
// Partial mock: the paid council calls are stubbed, but the module's pure
// exports (PRESENTATION_LEAD, stripChromaticWords) stay real — designState
// renders prompts from them, so a stubbed constant would make prompt
// assertions assert the test's own invention.
vi.mock('../../council', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  enhanceStructured: vi.fn(),
  enhanceRound: vi.fn(),
}));
vi.mock('../../generation', () => ({ generate: vi.fn(), routeGeneration: vi.fn() }));
vi.mock('@/lib/firebase-admin', () => ({ ensureAdminApp: vi.fn(() => false) }));
// A re-cut is stored like every other render (TAT-57 durability), so the
// storage seam has to be mocked here too — otherwise the lane's tests reach
// for GCS.
vi.mock('@/services/storage/imageStorageService', () => ({
  recoverImageAtPath: vi.fn(),
  copyImageToPath: vi.fn(),
  uploadImageToPath: vi.fn(),
}));
vi.mock('@/lib/budget-tracker', () => ({
  recordSpend: vi.fn(),
  VERTEX_IMAGEN_COST_CENTS: 4,
}));

const mockGenerate = vi.mocked(generate);
const mockEnhanceRound = vi.mocked(enhanceRound);
const mockRecoverImageAtPath = vi.mocked(recoverImageAtPath);
const mockCopyImageToPath = vi.mocked(copyImageToPath);
const mockUploadImageToPath = vi.mocked(uploadImageToPath);
const mockRecordSpend = vi.mocked(recordSpend);

/** Where a durable copy lands — the shape imageStorageService returns. */
const durableUrl = (objectPath: string) =>
  `https://storage.googleapis.com/tatt-pro-assets/${objectPath}`;

function variations(): Variation[] {
  return [
    { id: 'v1', axisPosition: { 'color-blackwork': 'color', 'bold-fine': 'bold' }, prompt: 'p1', negativePrompt: 'n1', imageUrl: 'https://img/1.png' },
    { id: 'v2', axisPosition: { 'color-blackwork': 'color', 'bold-fine': 'fine' }, prompt: 'p2', negativePrompt: 'n2', imageUrl: 'https://img/2.png' },
    { id: 'v3', axisPosition: { 'color-blackwork': 'blackwork', 'bold-fine': 'bold' }, prompt: 'p3', negativePrompt: 'n3', imageUrl: 'https://img/3.png' },
    { id: 'v4', axisPosition: { 'color-blackwork': 'blackwork', 'bold-fine': 'fine' }, prompt: 'p4', negativePrompt: 'n4', imageUrl: 'https://img/4.png' },
  ];
}

async function seed(overrides: Partial<StoredSession> = {}): Promise<StoredSession> {
  const session: StoredSession = {
    id: 'sess-critique',
    phase: 'revealed',
    intake: {
      placement: 'forearm',
      styleTags: ['anime'],
      meaning: 'kingdom hearts, me and my brother',
      references: [],
      ambiguousAxes: [],
    },
    axisSelection: { mode: 'questionnaire', axes: ['color-blackwork', 'bold-fine'], rationale: 'r' },
    provider: 'vertex-ai',
    pinnedModelId: 'imagen-3.0-generate-002',
    pinnedAspectRatio: '1:1',
    variations: variations(),
    createdAt: '2026-07-31T00:00:00.000Z',
    updatedAt: '2026-07-31T00:00:00.000Z',
    ...overrides,
  };
  await memorySessionStore.save(session);
  return session;
}

/** The cut a resolution landed on, or its non-cut kind — keeps assertions short. */
const resolved = (
  session: Parameters<typeof resolveCritiqueTarget>[0],
  message: string
): string => {
  const result = resolveCritiqueTarget(session, message);
  return result.kind === 'cut' ? result.variation.id : result.kind;
};

/** A compositional round — this is where the designed names live. */
function sleeveCuts(): Variation[] {
  return [
    { id: 'c1', axisPosition: { composition: 'stacked tiers' }, prompt: 'p1' },
    { id: 'c2', axisPosition: { composition: 'connected transitions' }, prompt: 'p2' },
  ];
}

describe('critique — which cut is this about', () => {
  const session = { variations: variations(), critiqueCuts: [] as Variation[], pickId: undefined };

  it('reads an ordinal off the message', () => {
    expect(resolved(session, 'the third one but less color')).toBe('v3');
    expect(resolved(session, '#2 is closer')).toBe('v2');
    expect(resolved(session, 'cut four, keyblades bigger')).toBe('v4');
  });

  it('reads a pole word only when exactly one cut carries it', () => {
    // Two cuts are blackwork — a reference that cannot land, so we ask.
    expect(resolved(session, 'the blackwork one is too busy')).toBe('missed');
    const twoAxis = {
      variations: [
        variations()[0],
        { ...variations()[1], axisPosition: { 'color-blackwork': 'blackwork', 'bold-fine': 'fine' } },
        { ...variations()[2], axisPosition: { 'color-blackwork': 'blackwork', 'bold-fine': 'fine' } },
        { ...variations()[3], axisPosition: { 'color-blackwork': 'blackwork', 'bold-fine': 'fine' } },
      ],
      critiqueCuts: [] as Variation[],
      pickId: undefined,
    };
    expect(resolved(twoAxis, 'the color one, riku is missing')).toBe('v1');
  });

  it('falls back to the newest re-cut, then the pick, then nothing', () => {
    const recut: Variation = { id: 'v2-fix1', axisPosition: {}, prompt: 'p2 fixed' };
    expect(resolved({ ...session, critiqueCuts: [recut] }, "riku's missing")).toBe('v2-fix1');
    expect(resolved({ ...session, pickId: 'v2' }, "riku's missing")).toBe('v2');
    expect(resolved(session, "riku's missing")).toBe('none');
  });
});

/**
 * The failure this fix exists for. The customer read "the totem" under a cut,
 * typed "the totem", and the resolver — which had never seen that name — fell
 * through to its default and re-cut a different design, announcing it by name.
 */
describe('critique — the designed name the grid showed', () => {
  const sleeve = { variations: sleeveCuts(), critiqueCuts: [] as Variation[], pickId: undefined };

  it('resolves the name the customer was actually shown', () => {
    expect(resolved(sleeve, 'the totem but bigger')).toBe('c1');
    expect(resolved(sleeve, 'the run is too busy')).toBe('c2');
  });

  it('accepts the name without its article', () => {
    expect(resolved(sleeve, 'totem, but make the top character bigger')).toBe('c1');
  });

  it('NEVER matches a name inside a longer word', () => {
    // "the running man" is not "the run". Substring matching here is how a
    // near-miss becomes a paid render on the wrong design.
    expect(resolved(sleeve, 'make it look like the running man poster')).toBe('none');
  });

  it('ASKS rather than guessing when the name is from another round', () => {
    // The regression: "the totem" against a round with no stacked-tiers cut
    // used to fall through and re-cut whatever was most recent.
    const noTotem = { variations: [sleeveCuts()[1]], critiqueCuts: [] as Variation[], pickId: undefined };
    expect(resolved(noTotem, 'the totem but bigger')).toBe('missed');
  });

  it('ASKS even when there is a re-cut or a pick to fall back on', () => {
    // The exact shape of the 0f6234e9 failure: context existed, so the old
    // resolver had something to return, and returned it confidently.
    const recut: Variation = { id: 'c2-fix1', axisPosition: {}, prompt: 'p2 fixed' };
    const noTotem = {
      variations: [sleeveCuts()[1]],
      critiqueCuts: [recut],
      pickId: 'c2',
    };
    expect(resolved(noTotem, 'the totem but bigger')).toBe('missed');
  });

  it('ASKS when two cuts answer to the same name', () => {
    const twins = {
      variations: [
        { id: 'c1', axisPosition: { composition: 'centered emblem' }, prompt: 'p1' },
        { id: 'c2', axisPosition: { composition: 'ensemble emblem' }, prompt: 'p2' },
      ],
      critiqueCuts: [] as Variation[],
      pickId: undefined,
    };
    expect(resolved(twins, 'the emblem, but bigger')).toBe('missed');
  });

  it('ASKS when the ordinal runs past the end of the round', () => {
    // Two-cut rounds (ADR-0049) make "the fourth one" reachable and wrong.
    expect(resolved(sleeve, 'the fourth one is closest')).toBe('missed');
  });

  it('does NOT interrogate a pole word nothing carries', () => {
    // "too colorful" on a blackwork round is a complaint about the piece, not
    // a reference to a cut nobody rendered. Treating every pole word as a
    // reference would make the lane ask questions instead of doing work.
    const recut: Variation = { id: 'c2-fix1', axisPosition: {}, prompt: 'p2 fixed' };
    expect(resolved({ ...sleeve, critiqueCuts: [recut] }, 'too colorful')).toBe('c2-fix1');
  });
});

/**
 * The other half of the two dead sessions. "Give me 4 new samples not any
 * particular number" and "more like an unreal engine 5 look" both drew
 * "which one am i fixing?" — the first three times running, the second twice
 * before the customer gave up. Neither was ever about one cut.
 */
describe('critique — what kind of turn is this (ADR-0056)', () => {
  const session = { variations: variations(), critiqueCuts: [] as Variation[], pickId: undefined };

  it('routes the exact messages that deadlocked session 0f6234e9', () => {
    for (const message of [
      'Redo it again and give me 4 new ones',
      'Give me 4 new samples not any particular number',
      'start over',
      'can i get some different options',
    ]) {
      expect(classifyCritiqueTurn(session, message).kind).toBe('reroll-set');
    }
  });

  it('routes a direction for the whole piece, and carries their words', () => {
    const intent = classifyCritiqueTurn(session, 'more like an unreal engine 5 look');

    expect(intent.kind).toBe('reroll-set');
    expect(intent.kind === 'reroll-set' && intent.styleHint).toBe(
      'more like an unreal engine 5 look'
    );
  });

  it('carries the hint on a re-roll that also asks for a direction', () => {
    // Fable's ordering: the destructive reading wins on explicit signal, and
    // the direction rides along rather than being lost.
    const intent = classifyCritiqueTurn(session, 'new ones, more cinematic feel');

    expect(intent.kind).toBe('reroll-set');
    expect(intent.kind === 'reroll-set' && intent.styleHint).toBe('new ones, more cinematic feel');
  });

  it('leaves the hint empty on a bare re-roll', () => {
    const intent = classifyCritiqueTurn(session, 'redo it');

    expect(intent.kind === 'reroll-set' && intent.styleHint).toBe('');
  });

  it('A NAMED CUT OUTRANKS a whole-piece phrase', () => {
    // "the third one, more like an unreal engine 5 look" is a fix to cut
    // three. Only a cut reached by CONTEXT can be re-read as being about the
    // piece — which is what `via` exists to tell us.
    const intent = classifyCritiqueTurn(
      session,
      'the third one, more like an unreal engine 5 look'
    );

    expect(intent.kind).toBe('iterate-cut');
    expect(intent.kind === 'iterate-cut' && intent.target.id).toBe('v3');
  });

  it('A NAMED CUT OUTRANKS a re-roll phrase too', () => {
    // Found in review of this PR. "another version" matches the re-roll
    // pattern, and the re-roll branch used to short-circuit before any
    // reference check — so this spent a credit discarding BOTH cuts,
    // including the one the customer had just named to keep.
    const intent = classifyCritiqueTurn(session, 'the third one, give me another version');

    expect(intent.kind).toBe('iterate-cut');
    expect(intent.kind === 'iterate-cut' && intent.target.id).toBe('v3');
  });

  it('a named cut outranks a re-roll asked by designed name, not just by ordinal', () => {
    const sleeve = { variations: sleeveCuts(), critiqueCuts: [] as Variation[], pickId: undefined };
    const intent = classifyCritiqueTurn(sleeve, 'redo the totem');

    expect(intent.kind).toBe('iterate-cut');
    expect(intent.kind === 'iterate-cut' && intent.target.id).toBe('c1');
  });

  it('an unplaceable name is never upgraded to a re-roll', () => {
    // The destructive arm must not fire on a reference we could not resolve
    // any more than it fires on one we could.
    const sleeve = {
      variations: [{ id: 'c2', axisPosition: { composition: 'connected transitions' }, prompt: 'p' }],
      critiqueCuts: [] as Variation[],
      pickId: undefined,
    };
    const intent = classifyCritiqueTurn(sleeve, 'the totem, give me another version');

    expect(intent).toEqual({ kind: 'ambiguous', because: 'unplaceable-name' });
  });

  it('still re-rolls when a working cut is only reached by CONTEXT', () => {
    // The guard is about being NAMED, not about a target existing. A re-cut in
    // progress must not block "start over".
    const withRecut = {
      ...session,
      critiqueCuts: [{ id: 'v1-fix1', axisPosition: {}, prompt: 'p' } as Variation],
    };
    expect(classifyCritiqueTurn(withRecut, 'start over').kind).toBe('reroll-set');
  });

  it('does not re-read an unplaceable NAME as a whole-piece request', () => {
    // "the totem" on a round without one, plus a style word. The name failed;
    // that must surface as a question, not get quietly upgraded to a re-roll
    // that throws away the set.
    const sleeve = {
      variations: [{ id: 'c2', axisPosition: { composition: 'connected transitions' }, prompt: 'p' }],
      critiqueCuts: [] as Variation[],
      pickId: undefined,
    };
    const intent = classifyCritiqueTurn(sleeve, 'the totem, but a more cinematic look');

    expect(intent.kind).toBe('ambiguous');
    expect(intent.kind === 'ambiguous' && intent.because).toBe('unplaceable-name');
  });

  it('still routes a plain per-cut fix to the cut', () => {
    expect(classifyCritiqueTurn(session, 'the third one but less color').kind).toBe('iterate-cut');
  });

  it('keeps chatter out of every other arm', () => {
    expect(classifyCritiqueTurn(session, 'love it').kind).toBe('commentary');
  });

  it('distinguishes its two ambiguous reasons', () => {
    expect(
      classifyCritiqueTurn(session, "riku's missing")
    ).toEqual({ kind: 'ambiguous', because: 'no-cut-named' });
    // A two-cut round (ADR-0049) makes "the fourth one" reachable and wrong.
    const round = { variations: sleeveCuts(), critiqueCuts: [] as Variation[], pickId: undefined };
    expect(
      classifyCritiqueTurn(round, 'the fourth one is closest')
    ).toEqual({ kind: 'ambiguous', because: 'unplaceable-name' });
  });
});

/**
 * Found by review on #340: checking pole words one at a time made being more
 * specific give a worse answer than being vaguer.
 */
describe('critique — more pole words can only narrow', () => {
  // Three cuts share a locked 'fine' pole; only one is also blackwork.
  const locked = {
    variations: [
      { id: 'a', axisPosition: { 'bold-fine': 'fine', 'color-blackwork': 'color' }, prompt: 'p' },
      { id: 'b', axisPosition: { 'bold-fine': 'fine', 'color-blackwork': 'color' }, prompt: 'p' },
      { id: 'c', axisPosition: { 'bold-fine': 'fine', 'color-blackwork': 'blackwork' }, prompt: 'p' },
    ],
    critiqueCuts: [] as Variation[],
    pickId: undefined,
  };

  it('resolves the maximally specific reference', () => {
    // 'fine' alone matches three. Checked first and alone, it used to give up
    // here — while the vaguer 'the blackwork one' resolved fine.
    expect(resolved(locked, 'the fine blackwork one, riku is missing')).toBe('c');
  });

  it('still asks when the words together match more than one', () => {
    expect(resolved(locked, 'the fine color one')).toBe('missed');
  });

  it('asks when they described a pairing this round never drew', () => {
    expect(resolved(locked, 'the bold blackwork one')).toBe('missed');
  });
});

describe('critique — is it a fix request', () => {
  it('treats real criticism as a fix, including the founder’s own examples', () => {
    for (const message of [
      "riku's missing",
      'too busy',
      'make the keyblades bigger',
      'the third one but less color',
      'why is his hand like that',
    ]) {
      expect(isFixRequest(message)).toBe(true);
    }
  });

  it('treats a bare affirmation or thanks as chatter', () => {
    for (const message of ['ok', 'thanks!', 'love it', 'sick', 'yeah', '']) {
      expect(isFixRequest(message)).toBe(false);
    }
  });
});

// The old `describe('critique — the re-cut prompt')` block lived here. It
// pinned `adjustPromptForCritique` — "${target.prompt} Requested change: ..."
// — which ADR-0060 replaces outright, so the block went with the function.
// Its guarantees did not: the customer's words surviving verbatim (ADR-0010)
// and the cue table translating "too busy" into negative space are both
// re-pinned in designState.test.ts against the object that now owns them.

describe('critique — the orchestrator turn', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearMemorySessions();
    delete process.env.NEXT_PUBLIC_STUDIO_FIX_ALLOWANCE;
    delete process.env.STUDIO_FIX_ALLOWANCE;
    delete process.env.NEXT_PUBLIC_DEMO_MODE;
    mockGenerate.mockResolvedValue({ images: ['https://img/recut.png'] } as never);
    // Nothing staged from a previous attempt; a copy lands at its own path.
    mockRecoverImageAtPath.mockResolvedValue(null);
    mockCopyImageToPath.mockImplementation(async objectPath => durableUrl(objectPath));
    mockUploadImageToPath.mockImplementation(async objectPath => durableUrl(objectPath));
    mockRecordSpend.mockResolvedValue(undefined);
  });

  afterEach(() => {
    delete process.env.NEXT_PUBLIC_STUDIO_FIX_ALLOWANCE;
    delete process.env.STUDIO_FIX_ALLOWANCE;
    delete process.env.NEXT_PUBLIC_DEMO_MODE;
  });

  it('re-cuts the named variation on the PINNED model, never re-routing (ADR-0016)', async () => {
    await seed();
    const result = await critique('sess-critique', { message: 'the third one but less color' });

    expect(result.generated).toBe(true);
    expect(mockGenerate).toHaveBeenCalledTimes(1);
    expect(mockGenerate).toHaveBeenCalledWith(
      expect.objectContaining({
        modelId: 'imagen-3.0-generate-002',
        aspectRatio: '1:1',
        numImages: 1,
        allowProviderFallback: false,
        // The target's own negative prompt travels with the re-cut.
        negativePrompt: 'n3',
      })
    );
    // ADR-0060: the re-cut renders from the STATE, not from the target's
    // prompt with the critique appended — so 'p3' is deliberately absent and
    // the critique shows up as a field instead.
    const recutPrompt = mockGenerate.mock.calls[0][0].prompt;
    expect(recutPrompt).not.toContain('p3');
    expect(recutPrompt).toContain('less saturation');
    // Our copy, not the provider's. A re-cut is the image the customer asked
    // for by name, so it is the last one allowed to expire in an hour.
    expect(result.cut?.imageUrl).not.toBe('https://img/recut.png');
    expect(result.cut?.imageUrl).toMatch(
      /^https:\/\/storage\.googleapis\.com\/.*design-sessions\/sess-critique\//
    );
    // The reveal stays the four cuts the pick signal is read against.
    expect(result.session.variations).toHaveLength(4);
    expect(result.session.critiqueCuts).toHaveLength(1);
  });

  it('persists the turn and the new cut on the session', async () => {
    await seed();
    await critique('sess-critique', { message: 'the first one, too busy' });

    const stored = await memorySessionStore.get('sess-critique');
    expect(stored?.fixesUsed).toBe(1);
    expect(stored?.critiqueCuts).toHaveLength(1);
    expect(stored?.critiqueTurns?.[0]).toMatchObject({
      message: 'the first one, too busy',
      targetId: 'v1',
      cutId: 'v1-fix1',
    });
  });

  it('decrements the allowance and blocks at zero without spending', async () => {
    process.env.STUDIO_FIX_ALLOWANCE = '2';
    await seed();

    const first = await critique('sess-critique', { message: 'the first one, too busy' });
    expect(first.fixesRemaining).toBe(1);
    expect(first.exhausted).toBe(false);

    const second = await critique('sess-critique', { message: 'still too busy' });
    expect(second.fixesRemaining).toBe(0);
    expect(second.exhausted).toBe(true);
    expect(mockGenerate).toHaveBeenCalledTimes(2);

    const third = await critique('sess-critique', { message: 'one more, less color' });
    // Refused before any paid call, and spoken — never a silent no-op.
    expect(third.generated).toBe(false);
    expect(third.reply).toBe(ALLOWANCE_SPENT_LINE);
    expect(mockGenerate).toHaveBeenCalledTimes(2);
    expect(third.session.critiqueCuts).toHaveLength(2);
  });

  it('defaults the allowance to the Studio’s knob (ADR-0038)', async () => {
    await seed();
    const result = await critique('sess-critique', { message: 'cut one, too busy' });
    // Tracks the shared constant, not a literal: this asserts the lane reads
    // the Studio's knob, which is the actual claim. Pinning the number meant
    // retuning the allowance broke a test that was never about the number.
    expect(result.fixesRemaining).toBe(DEFAULT_STUDIO_FIX_ALLOWANCE - 1);
  });

  it('spends nothing on chatter', async () => {
    await seed();
    const result = await critique('sess-critique', { message: 'love it' });

    expect(result.generated).toBe(false);
    expect(result.reply).toBe(CHATTER_LINE);
    expect(mockGenerate).not.toHaveBeenCalled();
    // A turn that spent nothing still leaves the allowance whole.
    expect(result.fixesRemaining).toBe(DEFAULT_STUDIO_FIX_ALLOWANCE);
  });

  it('asks which cut rather than guessing, and spends nothing', async () => {
    await seed();
    const result = await critique('sess-critique', { message: "riku's missing" });

    expect(result.generated).toBe(false);
    expect(result.reply).toBe(WHICH_CUT_LINE);
    expect(mockGenerate).not.toHaveBeenCalled();
  });

  it('SPENDS NOTHING on a cut name it cannot place, even with a pick to fall back on', async () => {
    // The money path of the 0f6234e9 failure. A pick exists, so the old
    // resolver had a target to return and returned it — a paid render on a
    // design the customer never referred to, announced by name as if correct.
    await seed({ phase: 'picked', pickId: 'v2', mostNotYouId: 'v4' });
    const result = await critique('sess-critique', { message: 'the totem, but bigger' });

    expect(result.generated).toBe(false);
    expect(result.reply).toBe(NO_SUCH_CUT_LINE);
    expect(mockGenerate).not.toHaveBeenCalled();
    expect(mockRecordSpend).not.toHaveBeenCalled();
    // Nothing was fixed, so nothing came off the allowance.
    expect(result.fixesRemaining).toBe(DEFAULT_STUDIO_FIX_ALLOWANCE);
  });

  it('names the cut back with the name the grid showed', async () => {
    // What we say and what we resolve come from one table now — the reply
    // that announced the wrong cut is the same string the resolver matched on.
    await seed({ variations: sleeveCuts() });
    const result = await critique('sess-critique', { message: 'the totem, but bigger' });

    expect(result.generated).toBe(true);
    expect(result.reply).toContain('the totem');
  });

  it('applies a bare critique to the pick once one exists', async () => {
    await seed({ phase: 'picked', pickId: 'v2', mostNotYouId: 'v4' });
    const result = await critique('sess-critique', { message: "riku's missing" });

    expect(result.generated).toBe(true);
    expect(result.cut?.id).toBe('v2-fix1');
    // The target is proven by the cut id above. The prompt is now the state's,
    // and the critique that resolved to no field rides as a directive with the
    // customer's own words intact (ADR-0010).
    const recutPrompt = mockGenerate.mock.calls[0][0].prompt;
    expect(recutPrompt).not.toContain('p2');
    expect(recutPrompt).toContain(`Customer direction: "riku's missing`);
  });

  it('derives a state for a session revealed before ADR-0060 existed', async () => {
    // Old sessions have no `state`. They get one from their intake rather than
    // being stranded on the behavior this ADR replaced.
    const session = await seed({ phase: 'picked', pickId: 'v2', mostNotYouId: 'v4' });
    expect(session.state).toBeUndefined();

    const result = await critique('sess-critique', { message: 'his jacket is the wrong one' });
    expect(result.generated).toBe(true);
    expect(result.session.state?.medium).toBe('tattoo on the forearm');
  });

  it('is closed once the Brief exists (ADR-0013 hard stop)', async () => {
    await seed({ phase: 'complete' });
    await expect(critique('sess-critique', { message: 'too busy' })).rejects.toThrow(
      DesignSessionError
    );
    await expect(critique('sess-critique', { message: 'too busy' })).rejects.toMatchObject({
      code: 'INVALID_PHASE',
    });
    expect(mockGenerate).not.toHaveBeenCalled();
  });

  it('is closed before anything is revealed', async () => {
    await seed({ phase: 'intake' });
    await expect(critique('sess-critique', { message: 'too busy' })).rejects.toMatchObject({
      code: 'INVALID_PHASE',
    });
  });

  it('renders a free stock re-cut in demo mode', async () => {
    process.env.NEXT_PUBLIC_DEMO_MODE = 'true';
    await seed();
    const result = await critique('sess-critique', { message: 'cut one, too busy' });

    expect(mockGenerate).not.toHaveBeenCalled();
    expect(result.generated).toBe(true);
    expect(result.cut?.imageUrl).toBeTruthy();
    // The allowance still counts down — demo mode changes cost, not policy.
    expect(result.fixesRemaining).toBe(DEFAULT_STUDIO_FIX_ALLOWANCE - 1);
  });

  it('leaves a re-cut pickable, so the loop closes where it started', async () => {
    await seed();
    const result = await critique('sess-critique', { message: 'the first one, too busy' });
    const cutId = result.cut!.id;

    const picked = await recordPick('sess-critique', { pickId: cutId, mostNotYouId: 'v4' });
    expect(picked.phase).toBe('picked');
    expect(picked.pickId).toBe(cutId);
  });
});

describe('critique — the reroll-set arm, wired (sprint fix #2)', () => {
  /** Round one over the seeded four cuts — what a modern session carries. */
  const roundOne = () => [
    { round: 1, axis: 'bold-fine', variationIds: ['v1', 'v2', 'v3', 'v4'] },
  ];

  /** What the council hands the re-roll: two fresh takes on the same axis. */
  const rerollEnhance = {
    axisSelection: {
      mode: 'questionnaire' as const,
      axes: ['bold-fine' as const],
      rationale: 'reroll re-asks the rejected axis',
    },
    variations: [
      { axisPosition: { 'bold-fine': 'bold' }, prompts: { detailed: 'rd1' }, negativePrompt: 'rn1' },
      { axisPosition: { 'bold-fine': 'fine' }, prompts: { detailed: 'rd2' }, negativePrompt: 'rn2' },
    ],
  };

  /** The channel's half of the arm — reserve/release spies, all-happy. */
  const creditPort = () => ({
    reserve: vi.fn(async () => ({ id: 'res-critique-1' })),
    release: vi.fn(async () => true),
  });

  beforeEach(() => {
    vi.clearAllMocks();
    clearMemorySessions();
    delete process.env.NEXT_PUBLIC_STUDIO_FIX_ALLOWANCE;
    delete process.env.STUDIO_FIX_ALLOWANCE;
    delete process.env.NEXT_PUBLIC_DEMO_MODE;
    mockGenerate.mockResolvedValue({ images: ['https://img/fresh.png'] } as never);
    mockEnhanceRound.mockResolvedValue(rerollEnhance as never);
    mockRecoverImageAtPath.mockResolvedValue(null);
    mockCopyImageToPath.mockImplementation(async objectPath => durableUrl(objectPath));
    mockUploadImageToPath.mockImplementation(async objectPath => durableUrl(objectPath));
    mockRecordSpend.mockResolvedValue(undefined);
  });

  afterEach(() => {
    delete process.env.STUDIO_FIX_ALLOWANCE;
    delete process.env.NEXT_PUBLIC_DEMO_MODE;
  });

  it('draws a fresh round on the rejected axis for the deadlock message — one credit, no pick required', async () => {
    await seed({ rounds: roundOne() });
    const port = creditPort();
    const result = await critique(
      'sess-critique',
      { message: 'Give me 4 new samples not any particular number' },
      { roundCredit: port }
    );

    // Delivered: a NEW two-cut round on the SAME axis, presented for both
    // channels, with the ladder copy from the round machinery.
    expect(result.generated).toBe(true);
    expect(result.round).toMatchObject({ round: 2, axis: 'bold-fine', variationIds: ['v5', 'v6'] });
    expect(result.cuts?.map(cut => cut.id)).toEqual(['v5', 'v6']);
    expect(result.reply).toBe(rerollLandedLine('bold vs fine-line', true));
    // One credit exactly, through the port, kept (no downgrade).
    expect(port.reserve).toHaveBeenCalledTimes(1);
    expect(port.release).not.toHaveBeenCalled();
    expect(mockGenerate).toHaveBeenCalledTimes(2);

    // The turn and the round persisted TOGETHER — the settle must not
    // clobber the round the executor just saved.
    const stored = (await memorySessionStore.get('sess-critique')) as StoredSession;
    expect(stored.rounds).toHaveLength(2);
    expect(stored.variations.map(v => v.id)).toEqual(['v1', 'v2', 'v3', 'v4', 'v5', 'v6']);
    expect(stored.critiqueTurns).toHaveLength(1);
    // No pick recorded on the rejected round — absence IS the signal — and
    // the fix allowance is untouched: a re-roll is a round, not a fix.
    expect(stored.rounds?.[0].pickedId).toBeUndefined();
    expect(stored.fixesUsed ?? 0).toBe(0);
  });

  it('ASKS instead of faking a look it cannot translate, before reserving a credit', async () => {
    // ADR-0060: an untranslated style word is a field the system failed to
    // fill. A whole-piece look names no cut, so it routes to a fresh ROUND —
    // a generation credit. Refusing before the reservation is the difference
    // between a free question and a paid guess.
    await seed({ rounds: roundOne() });
    const port = creditPort();
    const result = await critique(
      'sess-critique',
      { message: 'more like a vaporwave brutalist look' },
      { roundCredit: port }
    );

    expect(result.generated).toBe(false);
    expect(result.reply).toBe(UNTRANSLATED_LOOK_LINE);
    expect(port.reserve).not.toHaveBeenCalled();
    expect(mockGenerate).not.toHaveBeenCalled();
    expect(mockRecordSpend).not.toHaveBeenCalled();
    // A question is not a fix; the allowance is untouched.
    expect(result.fixesRemaining).toBe(DEFAULT_STUDIO_FIX_ALLOWANCE);
  });

  it('sends a look it CAN translate as concrete controls, not as the style word', async () => {
    // "an unreal engine 5 look" asked three times and never landed, because
    // three words at the tail of the Council's prompt weigh nothing. It now
    // arrives as the controls it means.
    await seed({ rounds: roundOne() });
    await critique(
      'sess-critique',
      { message: 'i was thinking more like an unreal engine 5 look' },
      { roundCredit: creditPort() }
    );

    const prompts = mockGenerate.mock.calls.map(call => call[0].prompt);
    expect(prompts.length).toBeGreaterThan(0);
    for (const prompt of prompts) {
      expect(prompt).toContain('physically based materials');
      expect(prompt).toContain('flat cel-shaded outlines');
      expect(prompt).toContain('unreal engine 5 look');  // their words survive
    }
  });

  it('carries the state forward, so a later re-cut still has the earlier change', async () => {
    // The heart of ADR-0060. Turn one sets the look through the re-roll arm;
    // turn two is a per-cut fix that says nothing about the look — and its
    // render must STILL carry it, because it builds from the whole state and
    // not from the last prompt.
    await seed({ rounds: roundOne() });

    await critique(
      'sess-critique',
      { message: 'more like an unreal engine 5 look' },
      { roundCredit: creditPort() }
    );
    mockGenerate.mockClear();

    await critique('sess-critique', { message: 'cut two, his jacket is the wrong one' });
    const second = mockGenerate.mock.calls[0][0].prompt;
    expect(second).toContain('physically based materials');
    expect(second).toContain('Customer direction: "cut two, his jacket is the wrong one".');
  });

  it('threads the customer direction into both fresh prompts, additively', async () => {
    await seed({ rounds: roundOne() });
    await critique(
      'sess-critique',
      { message: 'new ones, more cinematic feel' },
      { roundCredit: creditPort() }
    );

    const prompts = mockGenerate.mock.calls.map(([request]) => (request as { prompt: string }).prompt);
    // ADR-0060: their words survive verbatim AND carry the translation, so a
    // style word arrives as controls the lane can actually weight.
    expect(prompts).toEqual([
      'rd1 Customer direction: "new ones, more cinematic feel — rendered with cinematic framing and dramatic key lighting with deep shadow falloff".',
      'rd2 Customer direction: "new ones, more cinematic feel — rendered with cinematic framing and dramatic key lighting with deep shadow falloff".',
    ]);
  });

  it('does NOT refuse a re-roll out of the fix allowance', async () => {
    // A fresh set is a generation round (one credit, ADR-0049), not a fix.
    // Spending the fix allowance must not close the re-roll door.
    process.env.STUDIO_FIX_ALLOWANCE = '0';
    await seed({ rounds: roundOne() });
    const result = await critique(
      'sess-critique',
      { message: 'start over' },
      { roundCredit: creditPort() }
    );

    expect(result.generated).toBe(true);
    expect(result.reply).not.toBe(ALLOWANCE_SPENT_LINE);
    expect(result.round?.round).toBe(2);
  });

  it("settles the meter's own line when generation credits are exhausted, spending nothing", async () => {
    await seed({ rounds: roundOne() });
    const port = creditPort();
    port.reserve.mockRejectedValueOnce(
      Object.assign(new Error('You have used your free generations. Buy 25 more cuts to keep designing.'), {
        code: 'GENERATION_CREDITS_EXHAUSTED',
      })
    );

    const result = await critique('sess-critique', { message: 'new ones' }, { roundCredit: port });

    expect(result.generated).toBe(false);
    expect(result.reply).toBe(
      'You have used your free generations. Buy 25 more cuts to keep designing.'
    );
    expect(mockGenerate).not.toHaveBeenCalled();
    expect(port.release).not.toHaveBeenCalled();
  });

  it('maps a round already in flight to honest copy and hands the credit back', async () => {
    const session = await seed({ rounds: roundOne() });
    // A live claim — the web double-click / web+SMS interleaving.
    session.roundInFlight = { id: 'claim-live', at: new Date().toISOString() };
    await memorySessionStore.save(session);
    const port = creditPort();

    const result = await critique('sess-critique', { message: 'new ones' }, { roundCredit: port });

    expect(result.generated).toBe(false);
    expect(result.reply).toBe(ROUND_IN_FLIGHT_LINE);
    expect(port.reserve).toHaveBeenCalledTimes(1);
    expect(port.release).toHaveBeenCalledTimes(1);
    expect(mockGenerate).not.toHaveBeenCalled();
  });

  it('releases the credit on an ADR-0048 downgrade and says so — loud, refunded, delivered', async () => {
    await seed({ rounds: roundOne() });
    mockGenerate.mockResolvedValue({
      images: ['https://img/fresh.png'],
      metadata: { fallbackUsed: true, fallbackReason: 'REPLICATE_ERROR' },
    } as never);
    const port = creditPort();

    const result = await critique('sess-critique', { message: 'new ones' }, { roundCredit: port });

    expect(result.generated).toBe(true);
    expect(port.release).toHaveBeenCalledTimes(1);
    // The landed line does not claim a credit that went back, and the note
    // claims the refund only because the release actually landed.
    expect(result.reply).toBe(
      `${rerollLandedLine('bold vs fine-line', false)} ${REROLL_DOWNGRADED_REFUNDED_NOTE}`
    );
  });

  it('releases the credit and rethrows when the round dies — nothing persisted', async () => {
    await seed({ rounds: roundOne() });
    mockGenerate.mockRejectedValue(new Error('provider blew up'));
    const port = creditPort();

    await expect(
      critique('sess-critique', { message: 'new ones' }, { roundCredit: port })
    ).rejects.toThrow('provider blew up');

    expect(port.release).toHaveBeenCalledTimes(1);
    const stored = (await memorySessionStore.get('sess-critique')) as StoredSession;
    expect(stored.rounds).toHaveLength(1);
    expect(stored.critiqueTurns ?? []).toEqual([]);
    expect(stored.roundInFlight).toBeUndefined();
  });

  it('refuses in voice when no channel meter stands behind the turn', async () => {
    // Today: an unlinked texter. The refusal points at the path that works —
    // never the "which one am i fixing?" deadlock this arm exists to end.
    await seed({ rounds: roundOne() });
    const result = await critique('sess-critique', { message: 'new ones' });

    expect(result.generated).toBe(false);
    expect(result.reply).toBe(REROLL_NEEDS_ACCOUNT_LINE);
    expect(mockGenerate).not.toHaveBeenCalled();
  });

  it('draws a free fresh pair in demo mode, and does not claim a credit was spent', async () => {
    process.env.NEXT_PUBLIC_DEMO_MODE = 'true';
    await seed({ rounds: roundOne() });

    const result = await critique('sess-critique', { message: 'new ones' });

    expect(result.generated).toBe(true);
    expect(mockGenerate).not.toHaveBeenCalled();
    expect(result.cuts).toHaveLength(2);
    expect(result.reply).toBe(rerollLandedLine('bold vs fine-line', false));
  });
});

/**
 * The astronaut session, 2026-08-26. Four defects, one turn apart; the unit
 * coverage for each is below and the whole transcript runs end to end in
 * ./astronautSession.test.ts.
 */
describe('critique — the cut wearing YOUR PICK resolves (astronaut defect 2)', () => {
  const roundOne = (pickedId?: string) => [
    { round: 1, axis: 'bold-fine', variationIds: ['v1', 'v2'], ...(pickedId ? { pickedId } : {}) },
  ];
  const twoCuts = () => variations().slice(0, 2);

  it('reads the live round’s pick, not just the locked-in one', () => {
    // A tap records the ROUND's pick and paints YOUR PICK on the cut;
    // `session.pickId` is only written by LOCK IT IN. Consulting the locked-in
    // pick alone is why a customer who had visibly picked was still asked
    // "which one am i fixing?".
    const session = {
      variations: twoCuts(),
      critiqueCuts: [] as Variation[],
      pickId: undefined,
      rounds: roundOne('v2'),
    };
    expect(resolved(session, "riku's missing")).toBe('v2');
    expect(resolveCritiqueTarget(session, "riku's missing")).toMatchObject({ via: 'context' });
  });

  it('still asks when nothing is picked and nothing is named', () => {
    const session = {
      variations: twoCuts(),
      critiqueCuts: [] as Variation[],
      pickId: undefined,
      rounds: roundOne(),
    };
    expect(resolved(session, "riku's missing")).toBe('none');
  });

  it('ranks after the newest re-cut and ahead of the locked-in pick', () => {
    const recut: Variation = { id: 'v1-fix1', axisPosition: {}, prompt: 'p', revisionOf: 'v1', revision: 2 };
    // Round pick beats the older locked-in pick — a later tap is the fresher
    // signal.
    expect(
      resolved(
        { variations: twoCuts(), critiqueCuts: [], pickId: 'v1', rounds: roundOne('v2') },
        'too busy'
      )
    ).toBe('v2');
    // A fix in progress is closer context still.
    expect(
      resolved(
        { variations: twoCuts(), critiqueCuts: [recut], pickId: 'v1', rounds: roundOne('v2') },
        'too busy'
      )
    ).toBe('v1-fix1');
  });

  it('reads the LIVE round only — a stale earlier pick is not context', () => {
    const session = {
      variations: variations(),
      critiqueCuts: [] as Variation[],
      pickId: undefined,
      rounds: [
        { round: 1, axis: 'bold-fine', variationIds: ['v1', 'v2'], pickedId: 'v1', frozen: true },
        { round: 2, axis: 'color-blackwork', variationIds: ['v3', 'v4'], pickedId: 'v4' },
      ],
    };
    expect(resolved(session, 'too busy')).toBe('v4');
  });
});

describe('critique — re-cuts are addressable (astronaut defect 3)', () => {
  /** The bold cut, its first re-cut, and the re-cut of that. */
  const line = () => {
    // One axis, so the names are the short ones the astronaut session used.
    const bold: Variation = { id: 'v1', axisPosition: { 'bold-fine': 'bold' }, prompt: 'p1' };
    const fine: Variation = { id: 'v2', axisPosition: { 'bold-fine': 'fine' }, prompt: 'p2' };
    const take2: Variation = { ...bold, id: 'v1-fix1', revisionOf: 'v1', revision: 2 };
    const take3: Variation = { ...bold, id: 'v1-fix1-fix2', revisionOf: 'v1', revision: 3 };
    return {
      variations: [bold, fine],
      critiqueCuts: [take2, take3],
      pickId: undefined,
      rounds: undefined,
    };
  };

  it('ORDINALS count over allCuts — the order both channels print', () => {
    // SMS captions every image "Cut N of M" from allCuts (cutCaption in
    // sketchbotSms/internal/render.ts) and the web grid numbers its re-cuts
    // from variations.length up. A texter told "Cut 3 of 4" and answering
    // "cut 3" used to be told that cut did not exist.
    const session = line();
    const cuts = allCuts(session);
    cuts.forEach((cut, index) => {
      expect(resolved(session, `cut ${index + 1}, make it bigger`)).toBe(cut.id);
    });
    // Past the end is still a reference, so it asks rather than guessing.
    expect(resolved(session, `cut ${cuts.length + 1}, make it bigger`)).toBe('missed');
  });

  it('resolves a re-cut by the take name the grid shows', () => {
    expect(resolved(line(), 'the bold one, take 2 — less color')).toBe('v1-fix1');
    expect(resolved(line(), 'the bold one, take 3 is closer')).toBe('v1-fix1-fix2');
  });

  it('leaves the original reachable by its own name', () => {
    // The take name is longer, so it cannot be matched by "the bold one" —
    // which is what stops three cuts collapsing into one ambiguous name.
    expect(resolved(line(), 'the bold one but less color')).toBe('v1');
  });

  it('speaks the same name it resolves', () => {
    const session = line();
    expect(cutLabel(session, session.critiqueCuts[0])).toBe('the bold one, take 2');
    expect(cutLabel(session, session.variations[0])).toBe('the bold one');
    // Only a cut that is genuinely not in the session has no name to speak.
    expect(cutLabel(session, { id: 'nowhere', axisPosition: {}, prompt: 'p' })).toBe(
      'that last one'
    );
  });
});

describe('critique — a report of the wrong render is not a brief (astronaut defect 4)', () => {
  const session = () => ({
    variations: variations().slice(0, 2),
    critiqueCuts: [{ id: 'v1-fix1', axisPosition: { 'bold-fine': 'bold' }, prompt: 'p', revision: 2 }] as Variation[],
    pickId: undefined,
    rounds: undefined,
  });

  it('reads the astronaut complaint as regenerate-from-state', () => {
    const intent = classifyCritiqueTurn(
      session(),
      'what happened to my astonaught this is a laadys back and an eagle'
    );
    expect(intent).toMatchObject({ kind: 'iterate-cut', reading: 'regenerate' });
    expect(intent.kind === 'iterate-cut' && intent.target.id).toBe('v1-fix1');
  });

  it('reads the other shapes of the same report', () => {
    for (const message of [
      "that's not what i asked for",
      'where did my astronaut go',
      "this isn't my design",
      'wrong subject entirely',
    ]) {
      expect(classifyCritiqueTurn(session(), message)).toMatchObject({ reading: 'regenerate' });
    }
  });

  it('leaves an ordinary direction alone', () => {
    for (const message of [
      'this is too busy',
      'make the visor crack wider',
      'add more stars behind him',
    ]) {
      expect(classifyCritiqueTurn(session(), message)).toMatchObject({ reading: 'apply' });
    }
  });

  it('never lets a wrong-render report throw the set away', () => {
    // The destructive readings must not get at this sentence: a customer
    // saying the picture came back wrong has not asked for a different design.
    const intent = classifyCritiqueTurn(
      session(),
      "what happened to my astronaut, that's not the look i wanted"
    );
    expect(intent.kind).toBe('iterate-cut');
  });
});

describe('critique — an address is not a brief (astronaut defect 1, money)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearMemorySessions();
    delete process.env.STUDIO_FIX_ALLOWANCE;
    delete process.env.NEXT_PUBLIC_DEMO_MODE;
    mockGenerate.mockResolvedValue({ images: ['https://img/recut.png'] } as never);
    mockRecoverImageAtPath.mockResolvedValue(null);
    mockCopyImageToPath.mockImplementation(async objectPath => durableUrl(objectPath));
    mockUploadImageToPath.mockImplementation(async objectPath => durableUrl(objectPath));
    mockRecordSpend.mockResolvedValue(undefined);
  });

  it('buys nothing for a turn that only points at a cut', async () => {
    // The bottom of the astronaut money hole: "The bold one" resolved a cut,
    // moved no field, and fell through to a paid render whose whole Customer
    // direction was the name of a cut.
    await seed();
    const result = await critique('sess-critique', { message: 'the third one' });

    expect(result.generated).toBe(false);
    expect(result.reply).toBe(NAMED_BUT_NO_CHANGE_LINE);
    expect(mockGenerate).not.toHaveBeenCalled();
    expect(mockRecordSpend).not.toHaveBeenCalled();
    expect(result.fixesRemaining).toBe(DEFAULT_STUDIO_FIX_ALLOWANCE);
    // It still records which cut they pointed at — the next sentence lands on
    // it by context.
    expect(result.session.critiqueTurns?.[0]).toMatchObject({ targetId: 'v3' });
  });

  it('still renders the moment the same turn asks for something', async () => {
    await seed();
    const result = await critique('sess-critique', { message: 'the third one, too busy' });
    expect(result.generated).toBe(true);
  });
});

describe('critique — a held critique (astronaut defect 1)', () => {
  const askedAt = '2026-08-26T12:00:00.000Z';
  const now = Date.parse(askedAt) + 1000;
  const turn = (message: string) => ({ message, reply: 'r', at: askedAt });

  it('applies only to the turn it was bound to', () => {
    const held = { messages: ['more realistic, and show his face'], turnIndex: 1, askedAt };
    expect(
      readPendingCritique({ critiqueTurns: [turn('a')], pendingCritique: held }, now)
    ).toEqual(['more realistic, and show his face']);
    // One turn later this is a different conversation.
    expect(
      readPendingCritique({ critiqueTurns: [turn('a'), turn('b')], pendingCritique: held }, now)
    ).toEqual([]);
  });

  it('goes cold rather than waiting forever', () => {
    // An SMS turn superseded mid-flight records no turn at all, so the index
    // alone would hold a sentence on the session indefinitely.
    const held = { messages: ['more realistic'], turnIndex: 1, askedAt };
    expect(
      readPendingCritique(
        { critiqueTurns: [turn('a')], pendingCritique: held },
        Date.parse(askedAt) + PENDING_CRITIQUE_TTL_MS + 1
      )
    ).toEqual([]);
  });

  it('is absent on sessions stored before it existed', () => {
    expect(readPendingCritique({ critiqueTurns: [turn('a')] }, now)).toEqual([]);
  });

  it('holds every sentence said before a cut was named, oldest first', () => {
    const stashed = stashPendingCritique(
      ["riku's missing", 'and make it bigger', "riku's missing"],
      2,
      askedAt
    );
    // Deduped, ordered, and capped so an unanswered question cannot silt up a
    // prompt.
    expect(stashed.messages).toEqual(["riku's missing", 'and make it bigger']);
    expect(
      stashPendingCritique(['one', 'two', 'three', 'four'], 1, askedAt).messages
    ).toHaveLength(MAX_PENDING_CRITIQUES);
  });

  it('treats a bare address as an address, not as a critique', () => {
    // The whole defect: "The bold one" is where to put the fix, not the fix.
    expect(answerAddsRequest('The bold one', 'the bold one')).toBe(false);
    expect(answerAddsRequest('the third one')).toBe(false);
    expect(answerAddsRequest('cut 2')).toBe(false);
    expect(answerAddsRequest('ok, that one')).toBe(false);
  });

  it('recognizes an answer that asks for something of its own', () => {
    expect(answerAddsRequest('the bold one, and lose the background', 'the bold one')).toBe(true);
    expect(answerAddsRequest('cut 2, but bigger')).toBe(true);
  });
});
