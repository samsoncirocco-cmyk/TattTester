/**
 * The golden-journey regression fence (#377).
 *
 * ## Why this file exists
 *
 * The suite had 3144 passing tests and caught none of the six defects found on
 * 2026-08-26, because every test in this service is pinned to one shape of
 * request: `designState.test.ts` runs on `smashIntake`, a four-character IP
 * brief where `subject`, `requestedCharacters` and `characterIdentities` all
 * say the same thing. When three fields agree, a renderer that reads only one
 * of them looks correct. And each lane is only ever asserted against its own
 * expectations — nothing in the repo compares what the REVEAL prompt says
 * about a design to what the RE-CUT prompt says about the same design, so the
 * two drifting apart is invisible.
 *
 * This walks the request that has zero coverage anywhere in the repo: a
 * PLAIN-SUBJECT brief. `requestedCharacters: []`, `characterIdentities: []`,
 * and a real subject in the customer's own language — an astronaut on a
 * crescent moon. Nobody named an IP character, so the roster is empty, and
 * every place that treats "the roster" as "what the design is of" has nothing
 * to say. The fence asserts the one thing that must be true at every step of
 * the journey: the thing the customer asked for is still named in the prompt
 * we are about to pay to render.
 *
 * ## it.fails() — read this before touching the file
 *
 * Several assertions below describe CORRECT behaviour that is BROKEN on main
 * today, and are written as `it.fails(...)`. That form passes while the defect
 * exists and fails loudly the moment it is fixed. It is not a suppression: it
 * is a tripwire that forces whoever lands the fix to flip the test to `it()`
 * and thereby adopt the assertion, instead of the fix landing with no test
 * behind it. Each one carries a comment naming the defect it encodes.
 *
 * ## The reveal lane is NOT the reference — read this before unifying on it
 *
 * An earlier draft of this file was built on the premise "the reveal prompt is
 * right, the re-cut drifts from it", and asserted the drift without ever
 * asserting the reference. It is not right. On this same fixture the reveal
 * lane produces a color-vs-blackwork spread in which BOTH cuts open with
 * "Monochrome, black and grey ink only, zero color." — including the cut whose
 * whole job is to be the colour pole, which then goes on to say "Rendered with
 * vibrant full-color palette". `structuredMode` builds
 * `paletteClause(ctx.palette) + PRESENTATION_LEAD`, and `ctx.palette` is
 * `resolvePalette(record.styleTags)` with no `ambiguousAxes` guard, so
 * 'fine-line' flips it to monochrome — the SAME defect this file flags in
 * `deriveDesignState`, in the lane that was supposed to be the fix's target.
 *
 * That is asserted below, as `it.fails`, in the reveal section. Anyone
 * flipping the re-cut tripwires to `it()` and unifying the two lanes must fix
 * the reveal lane too or they will propagate a self-contradicting paid prompt.
 * `structuredMode.ts` is owned by a concurrent workstream, so this file
 * documents the defect rather than fixing it.
 *
 * Every render path here is either a pure function or the demo/mocked lane —
 * no provider is ever called, so this fence costs nothing against
 * BUDGET_MAX_SPEND_CENTS.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { critique } from '../index';
import { memorySessionStore, clearMemorySessions } from '../internal/store';
import type { StoredSession } from '../internal/store';
import {
  deriveDesignState,
  renderStatePrompt,
  rosterOmissions,
} from '../internal/designState';
import { enhanceStructured } from '../../council';
import { generate } from '../../generation';
import {
  copyImageToPath,
  recoverImageAtPath,
  uploadImageToPath,
} from '@/services/storage/imageStorageService';
import { recordSpend } from '@/lib/budget-tracker';
import type { IntakeRecord } from '../../intake/types';
import type { Variation } from '../types';

vi.mock('../../intake', () => ({ extractIntake: vi.fn() }));
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

/**
 * The astronaut brief.
 *
 * Deliberately the opposite of `smashIntake` on every axis that matters: no
 * requested characters, no verified identities, and a subject that exists
 * ONLY as prose. The words "astronaut" and "crescent moon" appear in exactly
 * one field, so any lane that drops `subject` drops the design itself — there
 * is no roster standing behind it to make the loss look survivable.
 *
 * `ambiguousAxes` carries 'color-blackwork' because this customer never
 * committed a palette: 'fine-line' is how they described the LINE WEIGHT they
 * want, and the intake correctly recorded the color question as still open.
 */
function astronautIntake(overrides: Partial<IntakeRecord> = {}): IntakeRecord {
  return {
    placement: 'forearm',
    styleTags: ['fine-line'],
    meaning: 'the year i moved across the country by myself',
    subject: 'an astronaut sitting on a crescent moon casting a fishing line into a field of stars',
    requestedCharacters: [],
    characterIdentities: [],
    references: [],
    ambiguousAxes: ['color-blackwork'],
    ...overrides,
  };
}

/* ── Step 1: the state the session starts from ───────────────────────────── */

describe('golden journey — deriveDesignState on a plain-subject brief', () => {
  it('produces an empty roster, because nobody named a character', () => {
    // Not a defect on its own — the roster is for named characters and there
    // are none. It is the PRECONDITION for everything below: from here on,
    // roster-shaped machinery has nothing to work with.
    const state = deriveDesignState(astronautIntake());
    expect(state.roster).toEqual([]);
    expect(state.identities).toEqual([]);
  });

  it('keeps the placement as the medium', () => {
    expect(deriveDesignState(astronautIntake()).medium).toBe('tattoo on the forearm');
  });

  // ── DEFECT (#377): the subject is dropped on the floor. ──────────────────
  // `deriveDesignState` reads placement, meaning, styleTags, requestedCharacters
  // and characterIdentities — and never reads `intake.subject`. On an IP brief
  // the roster carries the design, so the omission is invisible. On this brief
  // the state object comes out describing "a tattoo on the forearm" of nothing
  // at all, and since ADR-0060 makes every re-cut a pure function of the state,
  // the astronaut cannot come back.
  // FLIP THIS TO it() WHEN THE SIX-DEFECT FIX LANDS.
  it.fails('carries the customer stated subject somewhere in the state', () => {
    const state = deriveDesignState(astronautIntake());
    expect(JSON.stringify(state)).toContain('astronaut');
  });

  // ── DEFECT (#377): a line-weight tag silently decides the palette. ───────
  // designState's own MONOCHROME_TAGS lists 'fine-line' and 'fineline', so a
  // customer who asked for fine linework and left color open has their session
  // committed to "blackwork, no color" — a decision they never made, made
  // permanent because renderStatePrompt emits it as a positive clause on every
  // re-cut. `settledAxes.resolvePalette` has the same quirk but is guarded by
  // `ambiguousAxes`; this derivation has no such guard and cannot see that the
  // intake left the color question open.
  // FLIP THIS TO it() WHEN THE SIX-DEFECT FIX LANDS.
  it.fails('does not flip a fine-line request to blackwork', () => {
    const state = deriveDesignState(astronautIntake());
    expect(state.palette).not.toBe('blackwork, no color');
  });
});

/* ── Step 2: the reveal prompt (the Council's lane) ───────────────────────── */

describe('golden journey — the reveal prompt keeps the subject', () => {
  it('names the astronaut in both reveal cuts', async () => {
    const { variations } = await enhanceStructured(astronautIntake());
    expect(variations).toHaveLength(2);
    for (const structured of variations) {
      const prompt = structured.prompts.detailed ?? structured.prompts.simple ?? '';
      expect(prompt).toContain('astronaut');
      expect(prompt).toContain('crescent moon');
    }
  });

  it('carries flash-art-on-white and never opens on a body part (ADR-0023)', async () => {
    const { variations } = await enhanceStructured(astronautIntake());
    for (const structured of variations) {
      const prompt = structured.prompts.detailed ?? structured.prompts.simple ?? '';
      expect(prompt).toContain('Flash art tattoo design on a pure white background');
      expect(prompt).not.toMatch(/^A tattoo on the /);
    }
  });

  // ── DEFECT (#377): the presentation lead is not actually front-loaded. ───
  // The title above deliberately says "carries", because containment is all
  // that assertion checks and a containment check cannot see a POSITIONAL
  // regression — move PRESENTATION_LEAD to the tail of the prompt, which is
  // the precise ADR-0023 0/12 failure mode, and it stays green. This is the
  // positional assertion, and it fails today: the palette clause is emitted
  // ahead of PRESENTATION_LEAD (structuredMode builds
  // `paletteClause(ctx.palette) + PRESENTATION_LEAD`), so the prompt opens on
  // a palette command instead of on the presentation instruction.
  // FLIP THIS TO it() WHEN THE PRESENTATION LEAD IS PUT FIRST.
  it.fails('OPENS with the flash-art lead, where the lane weights it', async () => {
    const { variations } = await enhanceStructured(astronautIntake());
    for (const structured of variations) {
      const prompt = structured.prompts.detailed ?? structured.prompts.simple ?? '';
      expect(prompt).toMatch(/^Flash art tattoo design on a pure white background/);
    }
  });

  // ── DEFECT (#377): the color cut of a color spread is commanded mono. ────
  // `axisSelection` is {mode:'questionnaire', axes:['color-blackwork']}: these
  // two cuts ARE the customer's colour question, and cut 1 is the colour pole.
  // It opens "Monochrome, black and grey ink only, zero color." and then says
  // "Rendered with vibrant full-color palette" — a prompt arguing with itself
  // at token 1, where the lane weights it hardest. structuredMode's own
  // comment says a brief "must never open on a color-blackwork spread whose
  // color cut contradicts its own palette clause"; this fixture does exactly
  // that, because ctx.palette is resolvePalette(styleTags) with no
  // ambiguousAxes guard and 'fine-line' is in MONOCHROME_TAGS.
  // FLIP THIS TO it() WHEN THE PALETTE CLAUSE RESPECTS ambiguousAxes.
  it.fails('does not command monochrome on the colour pole of a colour spread', async () => {
    const { variations, axisSelection } = await enhanceStructured(astronautIntake());
    expect(axisSelection.axes).toContain('color-blackwork');
    const colorCut = variations.find(
      (cut) => (cut.axisPosition as Record<string, string>)['color-blackwork'] === 'color'
    );
    const prompt = colorCut?.prompts.detailed ?? colorCut?.prompts.simple ?? '';
    expect(prompt).not.toContain('zero color');
  });

  // ── DEFECT (#377): the two poles of the spread are not distinguishable. ──
  // If the palette clause is hard-coded monochrome for both, the customer's
  // round-one choice is between two prompts that open identically — the choice
  // is fake, and it is fake at the most heavily weighted position. Asserting
  // the two cuts DIFFER in their opening clause is the cheapest way to notice.
  // FLIP THIS TO it() WHEN THE PALETTE CLAUSE RESPECTS ambiguousAxes.
  it.fails('gives the two poles different opening clauses', async () => {
    const { variations } = await enhanceStructured(astronautIntake());
    const opening = (index: number) => {
      const cut = variations[index];
      return (cut.prompts.detailed ?? cut.prompts.simple ?? '').split('.')[0];
    };
    expect(opening(0)).not.toBe(opening(1));
  });
});

/* ── Step 3: the re-cut prompt (the state object's lane) ──────────────────── */

describe('golden journey — the re-cut prompt must say the same thing', () => {
  // ── DEFECT (#377): the re-cut renders a design with no subject. ──────────
  // This is the whole point of the file. The reveal prompt above says
  // "astronaut"; the re-cut prompt for the SAME session says "A tattoo on the
  // forearm." and then boilerplate. No test in the repo compared the two,
  // because every fixture had a roster that happened to fill the gap.
  // FLIP THIS TO it() WHEN THE SIX-DEFECT FIX LANDS.
  it.fails('names the astronaut in the state-rendered prompt', () => {
    const prompt = renderStatePrompt(deriveDesignState(astronautIntake()));
    expect(prompt).toContain('astronaut');
  });

  // ── DEFECT (#377): the re-cut prompt opens with an on-skin instruction. ──
  // ADR-0023 documents this exact failure mode and its measurement: the
  // subject sentence opening "A ... tattoo on the left forearm" is an explicit
  // positive instruction to draw a limb at roughly token 10, and it measured
  // 0/12 against the backdrop guard. structuredMode front-loads
  // PRESENTATION_LEAD to beat it; renderStatePrompt opens with the medium
  // clause instead and carries no presentation clause at all, so every re-cut
  // is asking for a photograph of an arm. The placement preview cannot strip a
  // backdrop that was never rendered.
  // FLIP THIS TO it() WHEN THE SIX-DEFECT FIX LANDS.
  it.fails('does not open the prompt with on-skin phrasing', () => {
    const prompt = renderStatePrompt(deriveDesignState(astronautIntake()));
    expect(prompt).not.toMatch(/^A tattoo on the /);
  });

  // ── DEFECT (#377): the fine-line palette flip reaches the rendered text. ─
  // The state-level flip above is a field; this is the money shot — the
  // positive clause "Palette: blackwork, no color." in a prompt the customer
  // pays for, on a session where they asked for color to stay open.
  // FLIP THIS TO it() WHEN THE SIX-DEFECT FIX LANDS.
  it.fails('does not assert blackwork in a prompt for an open-palette session', () => {
    const prompt = renderStatePrompt(deriveDesignState(astronautIntake()));
    expect(prompt).not.toContain('Palette: blackwork, no color.');
  });

  it('is not protected by the roster contradiction guard', () => {
    // ADR-0060's pre-spend guard (`rosterOmissions`, enforced in the
    // orchestrator) is the thing that would normally refuse to buy a render
    // whose prompt contradicts the state. On an empty roster it passes
    // vacuously, which is precisely why a plain-subject brief could lose its
    // subject and still be rendered. Documenting the hole is the point of this
    // assertion; it is expected to keep passing after the fix, because the
    // guard is roster-shaped by design.
    const state = deriveDesignState(astronautIntake());
    expect(rosterOmissions(state, renderStatePrompt(state))).toEqual([]);
  });
});

/* ── Step 4: end to end through the critique lane ─────────────────────────── */

describe('golden journey — the orchestrator turn', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    clearMemorySessions();
    delete process.env.NEXT_PUBLIC_DEMO_MODE;
    mockGenerate.mockResolvedValue({ images: ['https://img/recut.png'] } as never);
    mockRecoverImageAtPath.mockResolvedValue(null);
    mockCopyImageToPath.mockImplementation(async (objectPath: string) => durableUrl(objectPath));
    mockUploadImageToPath.mockImplementation(async (objectPath: string) => durableUrl(objectPath));
    mockRecordSpend.mockResolvedValue(undefined);
    await seedAstronautSession();
  });

  afterEach(() => {
    delete process.env.NEXT_PUBLIC_DEMO_MODE;
  });

  /**
   * A revealed session whose two cuts carry the REAL reveal prompts, so the
   * before/after comparison is against text the Council actually produced
   * rather than a stub. No `state` on the document: that is the honest shape
   * of a session revealed before ADR-0060, and the orchestrator derives one.
   */
  async function seedAstronautSession(): Promise<void> {
    const intake = astronautIntake();
    const { variations: structured, axisSelection } = await enhanceStructured(intake);
    const variations: Variation[] = structured.map((cut, index) => ({
      id: `v${index + 1}`,
      axisPosition: cut.axisPosition as Record<string, string>,
      prompt: cut.prompts.detailed ?? cut.prompts.simple ?? '',
      negativePrompt: cut.negativePrompt,
      imageUrl: `https://img/${index + 1}.png`,
    }));
    await memorySessionStore.save({
      id: 'sess-astronaut',
      phase: 'revealed',
      intake,
      axisSelection,
      provider: 'vertex-ai',
      pinnedModelId: 'imagen-3.0-generate-002',
      pinnedAspectRatio: '1:1',
      variations,
      createdAt: '2026-08-26T00:00:00.000Z',
      updatedAt: '2026-08-26T00:00:00.000Z',
    } as StoredSession);
  }

  it('renders a re-cut at all, on the pinned model', async () => {
    const result = await critique('sess-astronaut', {
      message: 'the first one, make it bigger',
    });
    expect(result.generated).toBe(true);
    expect(mockGenerate).toHaveBeenCalledTimes(1);
  });

  it("keeps the customer own words on the turn (ADR-0010)", async () => {
    await critique('sess-astronaut', { message: 'the first one, make it bigger' });
    expect(mockGenerate).toHaveBeenCalledTimes(1);
    const [request] = mockGenerate.mock.calls[0];
    expect(request.prompt).toContain('make it bigger');
  });

  // ── DEFECT (#377): the paid re-cut render has no subject in its prompt. ──
  // Every step above in one assertion, at the point where money is spent: the
  // session was revealed from a prompt naming an astronaut, the customer asked
  // for that cut bigger, and the string handed to the provider does not
  // mention an astronaut anywhere. This is the assertion to keep if only one
  // survives.
  // FLIP THIS TO it() WHEN THE SIX-DEFECT FIX LANDS.
  it.fails('names the astronaut in the prompt it pays to render', async () => {
    await critique('sess-astronaut', { message: 'the first one, make it bigger' });
    // Read the call FIRST, with an explicit assertion that it happened.
    // Without this line the test dereferences calls[0][0] and, if the turn
    // never reached the provider at all, passes on a TypeError instead of on
    // the assertion it documents — "the prompt lacks the astronaut" and "the
    // turn crashed before spending" would be indistinguishable, which is the
    // whole disease this file is about.
    expect(mockGenerate).toHaveBeenCalledTimes(1);
    const [request] = mockGenerate.mock.calls[0];
    expect(request.prompt).toContain('astronaut');
  });

  // ── DEFECT (#377): the re-cut abandons flash-art-on-white. ───────────────
  // Same turn, the other half of the drift: the reveal prompt front-loads the
  // ADR-0023 presentation clause and the re-cut prompt does not carry it,
  // which is what breaks the placement preview downstream.
  // FLIP THIS TO it() WHEN THE SIX-DEFECT FIX LANDS.
  it.fails('keeps flash-art-on-white on the re-cut (ADR-0023)', async () => {
    await critique('sess-astronaut', { message: 'the first one, make it bigger' });
    expect(mockGenerate).toHaveBeenCalledTimes(1);
    const [request] = mockGenerate.mock.calls[0];
    expect(request.prompt).toContain('Flash art tattoo design on a pure white background');
  });
});
