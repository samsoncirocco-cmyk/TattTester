/**
 * The astronaut session, 2026-08-26, start to finish.
 *
 * A customer described an astronaut on the moon — cracked visor, gasping,
 * galaxy behind, on their back. The reveal drew two correct astronauts. Seven
 * turns later they had paid for two renders of a woman's back with an eagle on
 * it, both labelled "the bold one", and the sentence they actually wrote had
 * never reached a model.
 *
 * The transcript, in order:
 *   1. the brief; two astronauts land
 *   2. they tap the bold cut — YOUR PICK appears on it
 *   3. "Im thinking more realistic looking and i wanna be able to see the
 *      artists face"
 *   4. "which one am i fixing? tap it, or just say the number"
 *   5. they tap the bold cut again; the client sends "The bold one"; a
 *      black-and-grey eagle on a woman's back comes back
 *   6. "what happened to my astonaught this is a laadys back and an eagle" —
 *      and a SECOND lady's back with an eagle comes back
 *   7. both re-cuts render in the grid labelled "the bold one"
 *
 * Four defects, one turn apart. This file walks the whole thing; the unit
 * coverage for each lives in ./critique.test.ts.
 *
 * Every module boundary is mocked, exactly as in ./critique.test.ts — no live
 * provider call is ever made.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { critique, recordRoundPick } from '../index';
import { memorySessionStore, clearMemorySessions } from '../internal/store';
import type { StoredSession } from '../internal/store';
import { allCuts, cutIdentity } from '../cutIdentity';
import { WHICH_CUT_LINE, fixesLeftLine, wrongRenderLine } from '../internal/critiqueVoice';
import { DEFAULT_STUDIO_FIX_ALLOWANCE } from '@/lib/studio-fix-allowance';
import { generate } from '../../generation';
import {
  copyImageToPath,
  recoverImageAtPath,
  uploadImageToPath,
} from '@/services/storage/imageStorageService';
import { recordSpend } from '@/lib/budget-tracker';
import type { Variation } from '../types';

vi.mock('../../intake', () => ({ extractIntake: vi.fn() }));
// Partial mock: the paid council calls are stubbed, but the module's pure
// exports (PRESENTATION_LEAD, stripChromaticWords) are the real ones —
// designState renders prompts from them, and a prompt assertion against a
// stubbed constant would be asserting the test's own invention.
vi.mock('../../council', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  enhanceStructured: vi.fn(),
  enhanceRound: vi.fn(),
}));
vi.mock('../../generation', () => ({ generate: vi.fn(), routeGeneration: vi.fn() }));
vi.mock('@/lib/firebase-admin', () => ({ ensureAdminApp: vi.fn(() => false) }));
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
const mockRecoverImageAtPath = vi.mocked(recoverImageAtPath);
const mockCopyImageToPath = vi.mocked(copyImageToPath);
const mockUploadImageToPath = vi.mocked(uploadImageToPath);
const mockRecordSpend = vi.mocked(recordSpend);

const durableUrl = (objectPath: string) =>
  `https://storage.googleapis.com/tatt-pro-assets/${objectPath}`;

const SESSION_ID = 'sess-astronaut';

/** The brief, in the customer's own words. */
const MEANING =
  'an astronaut on the moon, his visor cracked, gasping his last breath, ' +
  'galaxy and stars behind him';

/** Step 3 — the critique that was thrown away. */
const REALISM_CRITIQUE =
  'Im thinking more realistic looking and i wanna be able to see the artists face';

/** Step 5 — what the client sent when they answered by tapping. */
const TAP_ANSWER = 'The bold one';

/** Step 6 — a description of the WRONG output, read as a brief. */
const WRONG_RENDER_COMPLAINT =
  'what happened to my astonaught this is a laadys back and an eagle';

/** Step 1: the reveal — two cuts on the bold/fine axis, both correct. */
function revealCuts(): Variation[] {
  return [
    {
      id: 'v1',
      axisPosition: { 'bold-fine': 'bold' },
      prompt: 'a bold astronaut on the moon',
      negativePrompt: 'n1',
      imageUrl: 'https://img/astronaut-bold.png',
    },
    {
      id: 'v2',
      axisPosition: { 'bold-fine': 'fine' },
      prompt: 'a fine-line astronaut on the moon',
      negativePrompt: 'n2',
      imageUrl: 'https://img/astronaut-fine.png',
    },
  ];
}

async function seedReveal(overrides: Partial<StoredSession> = {}): Promise<StoredSession> {
  const session: StoredSession = {
    id: SESSION_ID,
    phase: 'revealed',
    intake: {
      placement: 'back',
      styleTags: ['blackwork'],
      meaning: MEANING,
      references: [],
      ambiguousAxes: [],
    },
    axisSelection: { mode: 'questionnaire', axes: ['bold-fine'], rationale: 'r' },
    provider: 'replicate',
    pinnedModelId: 'black-forest-labs/flux-dev',
    pinnedAspectRatio: '1:1',
    variations: revealCuts(),
    rounds: [{ round: 1, axis: 'bold-fine', variationIds: ['v1', 'v2'] }],
    createdAt: '2026-08-26T00:00:00.000Z',
    updatedAt: '2026-08-26T00:00:00.000Z',
    ...overrides,
  };
  await memorySessionStore.save(session);
  return session;
}

/** The prompt of the Nth paid render, in call order. */
const promptOf = (call: number): string => mockGenerate.mock.calls[call][0].prompt;

/** Every name the grid would put under the session's cuts, in grid order. */
const gridNames = (session: { variations: Variation[]; critiqueCuts?: Variation[] }) =>
  allCuts(session).map((cut, index) => cutIdentity(cut, index).name);

beforeEach(() => {
  vi.clearAllMocks();
  clearMemorySessions();
  delete process.env.NEXT_PUBLIC_STUDIO_FIX_ALLOWANCE;
  delete process.env.STUDIO_FIX_ALLOWANCE;
  delete process.env.NEXT_PUBLIC_DEMO_MODE;
  mockGenerate.mockResolvedValue({ images: ['https://img/recut.png'] } as never);
  mockRecoverImageAtPath.mockResolvedValue(null);
  mockCopyImageToPath.mockImplementation(async (objectPath) => durableUrl(objectPath));
  mockUploadImageToPath.mockImplementation(async (objectPath) => durableUrl(objectPath));
  mockRecordSpend.mockResolvedValue(undefined);
});

describe('the astronaut session, end to end', () => {
  it('runs steps 1-7 without ever losing the astronaut or the critique', async () => {
    await seedReveal();

    // ── Step 2: they tap the bold cut. YOUR PICK lands on it. ──
    const picked = await recordRoundPick(SESSION_ID, { pickedId: 'v1' });
    expect(picked.rounds?.[0].pickedId).toBe('v1');
    // The badge is the round's pick; LOCK IT IN was never pressed.
    expect(picked.pickId).toBeUndefined();

    // ── Step 3: the critique. It used to hit the ambiguous arm. ──
    const third = await critique(SESSION_ID, { message: REALISM_CRITIQUE });

    // No interrogation: the cut they can SEE is picked resolves it (defect 2).
    expect(third.reply).not.toBe(WHICH_CUT_LINE);
    expect(third.generated).toBe(true);
    expect(third.session.critiqueTurns?.[0].targetId).toBe('v1');
    // Their sentence is what got rendered, not the address of a cut.
    expect(promptOf(0).toLowerCase()).toContain('realistic');
    expect(promptOf(0)).not.toContain(`Customer direction: "${TAP_ANSWER}"`);
    // Named with the name the grid shows, so the reply and the grid agree.
    expect(third.reply).toContain('the bold one');
    expect(third.fixesRemaining).toBe(DEFAULT_STUDIO_FIX_ALLOWANCE - 1);

    // ── Steps 4-5 collapse: there is no question left to answer, so the tap
    // that answered it is never sent as a critique and never buys a render.
    expect(mockGenerate).toHaveBeenCalledTimes(1);

    // ── Step 6: the complaint about the wrong render. ──
    const sixth = await critique(SESSION_ID, { message: WRONG_RENDER_COMPLAINT });

    expect(sixth.generated).toBe(true);
    // The re-cut is the one being worked on, and it has a NAME now (defect 3).
    expect(sixth.session.critiqueTurns?.[1].targetId).toBe('v1-fix1');
    expect(sixth.reply).toBe(
      `${wrongRenderLine('the bold one, take 2')} ${fixesLeftLine(
        DEFAULT_STUDIO_FIX_ALLOWANCE - 2
      )}`
    );

    // Their description of OUR mistake never became the brief (defect 4).
    const secondPrompt = promptOf(1);
    for (const word of ['laadys', 'lady', 'eagle', 'what happened']) {
      expect(secondPrompt.toLowerCase()).not.toContain(word);
    }
    // And the design is still the design: the state carried the astronaut and
    // the realism note into the re-render.
    expect(secondPrompt.toLowerCase()).toContain('astronaut');
    expect(secondPrompt.toLowerCase()).toContain('realistic');
    expect(secondPrompt).toContain('back');

    // ── Step 7: three cuts, three names. ──
    const stored = (await memorySessionStore.get(SESSION_ID)) as StoredSession;
    const names = gridNames(stored);
    expect(names).toEqual(['the bold one', 'the fine-line one', 'the bold one, take 2', 'the bold one, take 3']);
    expect(new Set(names).size).toBe(names.length);

    // Two renders, two fixes, both of them actually bought.
    expect(mockGenerate).toHaveBeenCalledTimes(2);
    expect(stored.fixesUsed).toBe(2);
  });

  it('leaves every re-cut reachable by name and by number afterwards', async () => {
    await seedReveal();
    await recordRoundPick(SESSION_ID, { pickedId: 'v1' });
    await critique(SESSION_ID, { message: REALISM_CRITIQUE });
    await critique(SESSION_ID, { message: WRONG_RENDER_COMPLAINT });
    const stored = (await memorySessionStore.get(SESSION_ID)) as StoredSession;

    // By name — the exact string the grid shows.
    const byName = await critique(SESSION_ID, {
      message: 'the bold one, take 2 — crack the visor wider',
    });
    expect(byName.session.critiqueTurns?.at(-1)?.targetId).toBe('v1-fix1');

    // By number — the same number SMS captioned it with ("Cut 3 of 4").
    const third = allCuts(stored)[2];
    const byNumber = await critique(SESSION_ID, { message: 'cut 3, crack the visor wider' });
    expect(byNumber.session.critiqueTurns?.at(-1)?.targetId).toBe(third.id);
  });
});

/**
 * The same session with nothing picked — the path where the lane genuinely has
 * to ask. This is where the held critique earns its keep.
 */
describe('the astronaut session — answering "which one am i fixing?"', () => {
  it('holds the critique and renders IT, not the answer', async () => {
    await seedReveal();

    // Step 3, with no pick to resolve against: we ask, and spend nothing.
    const asked = await critique(SESSION_ID, { message: REALISM_CRITIQUE });
    expect(asked.generated).toBe(false);
    expect(asked.reply).toBe(WHICH_CUT_LINE);
    expect(mockGenerate).not.toHaveBeenCalled();
    expect(mockRecordSpend).not.toHaveBeenCalled();
    expect(asked.fixesRemaining).toBe(DEFAULT_STUDIO_FIX_ALLOWANCE);

    // Step 5: they answer by tapping, and the client sends the cut's name.
    const answered = await critique(SESSION_ID, { message: TAP_ANSWER });

    expect(answered.generated).toBe(true);
    expect(answered.session.critiqueTurns?.at(-1)?.targetId).toBe('v1');
    // The render is of what they SAID, not of what they TAPPED. The defect in
    // one assertion: this prompt used to read
    // `Customer direction: "The bold one"` and nothing else.
    expect(promptOf(0).toLowerCase()).toContain('realistic');
    expect(promptOf(0)).not.toContain(`Customer direction: "${TAP_ANSWER}"`);
    expect(promptOf(0).toLowerCase()).toContain('astronaut');

    // Consumed exactly once — the next turn starts clean.
    const stored = (await memorySessionStore.get(SESSION_ID)) as StoredSession;
    expect(stored.pendingCritique).toBeUndefined();
  });

  it('holds it while the customer takes a second run at naming the cut', async () => {
    await seedReveal();
    await critique(SESSION_ID, { message: REALISM_CRITIQUE });
    // A second sentence, still naming no cut. Asked again, still free — and
    // now holding both, because the customer said both.
    const again = await critique(SESSION_ID, { message: 'also make the crack in the visor wider' });
    expect(again.generated).toBe(false);
    expect(mockGenerate).not.toHaveBeenCalled();
    expect(
      ((await memorySessionStore.get(SESSION_ID)) as StoredSession).pendingCritique?.messages
    ).toHaveLength(2);

    const answered = await critique(SESSION_ID, { message: TAP_ANSWER });
    expect(answered.generated).toBe(true);
    // Both sentences render; neither is the address they tapped.
    expect(promptOf(0).toLowerCase()).toContain('realistic');
    expect(promptOf(0).toLowerCase()).toContain('visor');
    expect(promptOf(0)).not.toContain(`Customer direction: "${TAP_ANSWER}"`);
  });

  it('drops it the moment an unrelated turn lands', async () => {
    await seedReveal();
    await critique(SESSION_ID, { message: REALISM_CRITIQUE });

    // A turn that is not the answer: the sentence is not owed to it.
    const chatter = await critique(SESSION_ID, { message: 'ok' });
    expect(chatter.generated).toBe(false);
    expect(
      ((await memorySessionStore.get(SESSION_ID)) as StoredSession).pendingCritique
    ).toBeUndefined();

    // …and a later fix does not inherit words from a conversation that moved on.
    await critique(SESSION_ID, { message: 'the bold one, less background' });
    expect(promptOf(0).toLowerCase()).not.toContain('realistic');
    expect(promptOf(0)).toContain('less background');
  });

  it('carries the answer’s own request too, when it has one', async () => {
    await seedReveal();
    await critique(SESSION_ID, { message: REALISM_CRITIQUE });
    await critique(SESSION_ID, { message: 'the bold one, and lose the flag' });

    // Both halves are theirs, both survive (ADR-0010).
    expect(promptOf(0).toLowerCase()).toContain('realistic');
    expect(promptOf(0).toLowerCase()).toContain('flag');
  });

  it('never charges for the turn that only asked', async () => {
    await seedReveal();
    const asked = await critique(SESSION_ID, { message: REALISM_CRITIQUE });
    const stored = (await memorySessionStore.get(SESSION_ID)) as StoredSession;

    expect(asked.generated).toBe(false);
    expect(stored.fixesUsed ?? 0).toBe(0);
    expect(stored.critiqueCuts ?? []).toEqual([]);
    expect(mockGenerate).not.toHaveBeenCalled();
    expect(mockRecordSpend).not.toHaveBeenCalled();
    // The sentence is held — that is the only thing the turn produced.
    expect(stored.pendingCritique?.messages).toEqual([REALISM_CRITIQUE]);
  });
});
