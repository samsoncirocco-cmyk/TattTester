/**
 * Structured-input mode tests (ADR-0015 / ADR-0012).
 *
 * Structured mode is template-based, so no provider is ever called — every
 * test stubs global fetch and asserts the network stays untouched.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { enhance, enhanceStructured, enhanceRound } from '../index';
import type { IntakeRecord } from '../../intake/types';

/** The front-loaded presentation clause every prompt must carry (ADR-0023). */
const FLASH_ART_LEAD = 'Flash art tattoo design on a pure white background';

const baseRecord: IntakeRecord = {
  placement: 'forearm',
  styleTags: ['neo-traditional'],
  meaning: 'a phoenix for my grandmother, rebirth after loss',
  references: [],
  ambiguousAxes: [],
};

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('enhanceStructured - questionnaire mode (round one, ADR-0049)', () => {
  const record: IntakeRecord = {
    ...baseRecord,
    ambiguousAxes: ['bold-fine', 'color-blackwork'],
  };

  it('returns two variations spread on the ladder\'s first axis', async () => {
    const result = await enhanceStructured(record);

    expect(result.axisSelection.mode).toBe('questionnaire');
    // ADR-0049: round one always spreads bold vs fine-line, one axis only.
    expect(result.axisSelection.axes).toEqual(['bold-fine']);

    expect(result.variations).toHaveLength(2);
    expect(result.variations.map(v => v.axisPosition)).toEqual([
      { 'bold-fine': 'bold' },
      { 'bold-fine': 'fine' },
    ]);
  });

  it('produces divergent prompts per cut reflecting each pole', async () => {
    const result = await enhanceStructured(record);

    const detailedPrompts = result.variations.map(v => v.prompts.detailed);
    expect(new Set(detailedPrompts).size).toBe(2);

    for (const variation of result.variations) {
      const pos = variation.axisPosition as Record<string, string>;
      const prompt = (variation.prompts.detailed || '').toLowerCase();
      if (pos['bold-fine'] === 'bold') expect(prompt).toContain('bold');
      if (pos['bold-fine'] === 'fine') expect(prompt).toContain('fine-line');
    }
  });

  it('pushes the opposite pole into each variation negative prompt', async () => {
    const result = await enhanceStructured(record);

    for (const variation of result.variations) {
      const pos = variation.axisPosition as Record<string, string>;
      const negative = (variation.negativePrompt || '').toLowerCase();
      expect(negative.length).toBeGreaterThan(0);
      if (pos['color-blackwork'] === 'blackwork') {
        expect(negative).toContain('color');
      }
      if (pos['color-blackwork'] === 'color') {
        expect(negative).toContain('monochrome');
      }
    }
  });

  it('carries placement guidance and meaning into the prompts', async () => {
    const result = await enhanceStructured(record);

    for (const variation of result.variations) {
      const ultra = variation.prompts.ultra || '';
      expect(ultra).toContain('phoenix');
      expect(ultra).toContain('neo-traditional');
      // Placement reaches the model as COMPOSITION, never as "a tattoo on the
      // forearm" — naming the body part made Imagen render a photographed
      // limb 12 times out of 12. The forearm guidance itself still lands.
      expect(ultra.toLowerCase()).toContain('vertical');
      expect(ultra).toContain('wraps around limb');
      expect(ultra).not.toContain('tattoo on the forearm');
    }
  });
});

/*
 * These three assertions are the whole fix. Measured against the real
 * `assessBackdrop` guard over Vertex Imagen output, the prompt that violated
 * them scored 0/12 — every render came back a photograph of a tattoo on a
 * forearm — and the prompt that satisfies them scored 12/12. Any one of them
 * regressing puts renders back in front of the guard that it must reject, so
 * they are pinned individually rather than as one opaque string compare.
 */
describe('enhanceStructured - flash-art presentation (ADR-0023)', () => {
  const records: [string, IntakeRecord][] = [
    ['monochrome', { ...baseRecord, styleTags: ['blackwork'], placement: 'left forearm' }],
    ['color', { ...baseRecord, styleTags: ['color'], placement: 'upper arm' }],
    ['unresolved', { ...baseRecord, styleTags: [], placement: 'calf' }],
  ];

  it.each(records)('front-loads the presentation for a %s session', async (_label, record) => {
    const { variations } = await enhanceStructured(record);
    for (const v of variations) {
      for (const prompt of Object.values(v.prompts)) {
        if (!prompt) continue;
        // Within the opening sentence, not trailing after the subject: the
        // trailing version lost to the subject description every time.
        expect(prompt.indexOf(FLASH_ART_LEAD)).toBeLessThan(120);
      }
    }
  });

  it.each(records)('never anchors the design onto a body part (%s)', async (_label, record) => {
    const { variations } = await enhanceStructured(record);
    for (const v of variations) {
      for (const prompt of Object.values(v.prompts)) {
        if (!prompt) continue;
        // "A ... tattoo on the left forearm" is an explicit positive
        // instruction to draw a limb, and it sat ~55 tokens ahead of the
        // correction. Placement reaches the model through the aspect ratio
        // (getAnatomicalAspectRatio) instead.
        expect(prompt).not.toMatch(new RegExp(`tattoo on the ${record.placement}`, 'i'));
        expect(prompt.toLowerCase()).not.toContain('on skin');
        expect(prompt.toLowerCase()).not.toContain('untouched skin');
      }
    }
  });

  it.each(records)('excludes the observed scene failure modes (%s)', async (_label, record) => {
    const { variations } = await enhanceStructured(record);
    for (const v of variations) {
      const negatives = v.negativePrompt || '';
      // On-skin photographs (this prompt's own failure) plus the two modes
      // the 300-render Vertex portfolio corpus fails on: artwork shot as a
      // sheet of paper on a desk, and artwork on a black backdrop.
      for (const token of ['tattooed skin', 'desk', 'sheet of paper', 'black background']) {
        expect(negatives).toContain(token);
      }
    }
  });
});

describe('enhanceStructured - palette (color vs monochrome)', () => {
  const monochrome: IntakeRecord = { ...baseRecord, styleTags: ['blackwork', 'fine-line'] };
  const color: IntakeRecord = { ...baseRecord, styleTags: ['color', 'anime'] };
  const unresolved: IntakeRecord = { ...baseRecord, styleTags: ['illustrative'] };

  it('rides the monochrome command in the opening sentence, behind the flash-art lead', async () => {
    const result = await enhanceStructured(monochrome);

    for (const variation of result.variations) {
      const prompt = variation.prompts.simple || '';
      // The presentation instruction owns the very first tokens (ADR-0023
      // measured 0/12 without it); the palette rides the SAME sentence so it
      // still lands before the subject can front-load color words.
      expect(prompt.startsWith(FLASH_ART_LEAD)).toBe(true);
      const openingSentence = prompt.split('.')[0];
      expect(openingSentence).toContain('black and grey ink only, zero color');
      expect(variation.negativePrompt || '').toContain('color ink, saturated hues');
    }
  });

  it('rides color in the opening sentence but still presents as flash art, never saying monochrome', async () => {
    const result = await enhanceStructured(color);

    for (const variation of result.variations) {
      const prompt = variation.prompts.ultra || variation.prompts.simple || '';
      expect(prompt.startsWith(FLASH_ART_LEAD)).toBe(true);
      expect(prompt.split('.')[0]).toContain('vibrant color');
      // Palette and presentation are separate decisions: color sessions are
      // still flash art on white, so the placement preview can strip the
      // background and composite onto the user's own photo.
      expect(prompt).toContain(FLASH_ART_LEAD);
      expect(prompt.toLowerCase()).not.toContain('monochrome');
      expect((variation.negativePrompt || '').toLowerCase()).not.toContain('monochrome');
    }
  });

  it('presents every palette as flash art so placement preview always works', async () => {
    for (const record of [monochrome, color, unresolved]) {
      const result = await enhanceStructured(record);
      for (const variation of result.variations) {
        expect(variation.prompts.simple || '').toContain(FLASH_ART_LEAD);
      }
    }
  });

  it('leads with the presentation and no palette clause when style resolves neither way', async () => {
    const result = await enhanceStructured(unresolved);

    for (const variation of result.variations) {
      expect((variation.prompts.simple || '').startsWith(FLASH_ART_LEAD)).toBe(true);
    }
  });

  it('pins one presentation across all four variations of a session', async () => {
    for (const record of [monochrome, color, unresolved]) {
      const result = await enhanceStructured({ ...record, ambiguousAxes: ['bold-fine', 'minimal-ornate'] });
      const presentations = result.variations.map(
        v => (v.prompts.simple || '').includes(FLASH_ART_LEAD)
      );
      expect(new Set(presentations).size).toBe(1);
      expect(presentations[0]).toBe(true);
    }
  });

  it('an answered color question settles the axis and rides the answer (ADR-0061)', async () => {
    // The ask-flow's answer is customer voice: the axis is no longer spread
    // even though the ambiguous flag lingers, and every cut carries the
    // answered palette — not the 'fine-line' tag's monochrome reading.
    const result = await enhanceStructured({
      ...baseRecord,
      styleTags: ['fine-line'],
      ambiguousAxes: ['color-blackwork', 'literal-abstract'],
      paletteAnswer: 'color',
    });

    expect(result.axisSelection.axes).not.toContain('color-blackwork');
    for (const variation of result.variations) {
      const prompt = variation.prompts.simple || '';
      expect(prompt.split('.')[0]).toContain('vibrant color');
      expect(prompt).not.toContain('zero color');
    }
  });

  it('drops the multiple-people negative when the subject names a scene', async () => {
    const result = await enhanceStructured({
      ...baseRecord,
      subject: 'Izuku Midoriya (Deku) and Shoto Todoroki from My Hero Academia mid-fight',
    });

    for (const variation of result.variations) {
      expect(variation.negativePrompt || '').not.toContain('multiple people');
    }
  });
});

describe('enhanceStructured - one axis per round, never a padded second', () => {
  it('spreads exactly one axis regardless of how much stayed ambiguous', async () => {
    const result = await enhanceStructured({
      ...baseRecord,
      styleTags: ['blackwork'],
      ambiguousAxes: ['minimal-ornate'],
    });

    // The old padding machinery is gone (ADR-0049): the round asks ONE
    // question, and a blackwork session never gets a color quadrant forced
    // into its opening pair.
    expect(result.axisSelection.axes).toEqual(['bold-fine']);
    expect(result.axisSelection.axes).not.toContain('color-blackwork');
    for (const variation of result.variations) {
      const prompt = (variation.prompts.detailed || '').toLowerCase();
      expect(prompt).not.toContain('vibrant full-color');
    }
  });

  it('does not spread literal-abstract on a named-subject session round one', async () => {
    const result = await enhanceStructured({
      ...baseRecord,
      styleTags: ['color'],
      subject: 'Son Goku from Dragon Ball Z charging a Kamehameha',
      ambiguousAxes: ['minimal-ornate'],
    });

    expect(result.axisSelection.axes).not.toContain('literal-abstract');
    expect(result.axisSelection.axes).not.toContain('color-blackwork');
  });
});

describe('enhanceStructured - named subject (IP rule)', () => {
  it('prompts depict the named subject instead of paraphrasing the meaning', async () => {
    const result = await enhanceStructured({
      ...baseRecord,
      meaning: 'my love of my hero academia and its characters',
      subject: 'Izuku Midoriya (Deku) from My Hero Academia, One For All lightning around his fist',
      ambiguousAxes: ['bold-fine', 'color-blackwork'],
    });

    for (const variation of result.variations) {
      const prompt = variation.prompts.simple || '';
      expect(prompt).toContain('depicting Izuku Midoriya (Deku) from My Hero Academia');
      expect(prompt).not.toContain('expressing');
    }
  });

  it('without a subject the meaning clause is unchanged', async () => {
    const result = await enhanceStructured({
      ...baseRecord,
      meaning: 'strength through hard times',
      ambiguousAxes: ['bold-fine', 'color-blackwork'],
    });

    expect(result.variations[0].prompts.simple).toContain('expressing "strength through hard times"');
  });

  it('the abstract pole no longer excludes figurative depiction', async () => {
    const result = await enhanceStructured({
      ...baseRecord,
      ambiguousAxes: ['literal-abstract', 'bold-fine'],
    });

    for (const variation of result.variations) {
      expect(variation.negativePrompt || '').not.toContain('literal figurative depiction');
    }
  });
});

describe('enhanceStructured - an explicitly requested spread wins round one', () => {
  it('honors the axis the customer asked to SEE ahead of the ladder', async () => {
    // The conversation's axis-request path ("can i see both color and
    // blackwork?") promised this split — round one must deliver it, not
    // bold-fine.
    const result = await enhanceStructured({
      ...baseRecord,
      styleTags: [],
      ambiguousAxes: ['color-blackwork', 'bold-fine'],
      requestedAxis: 'color-blackwork',
    });

    expect(result.axisSelection.mode).toBe('questionnaire');
    expect(result.axisSelection.axes).toEqual(['color-blackwork']);
    expect(result.axisSelection.rationale).toContain('explicitly asked');
    expect(result.variations.map(v => v.axisPosition)).toEqual([
      { 'color-blackwork': 'color' },
      { 'color-blackwork': 'blackwork' },
    ]);
  });

  it('still defers to compositional mode for a named cast', async () => {
    const result = await enhanceStructured({
      ...baseRecord,
      requestedCharacters: ['Sora', 'Riku'],
      subject: 'Sora and Riku sparring',
      ambiguousAxes: ['color-blackwork'],
      requestedAxis: 'color-blackwork',
    });

    // Pre-existing rule: a cast is a composition problem first — the
    // spread request never traded away ensemble staging before ADR-0049
    // either.
    expect(result.axisSelection.mode).toBe('compositional');
  });
});

describe('enhanceStructured - round one skips rungs the brief already settled (ADR-0049)', () => {
  it('a blackwork-resolved brief never opens on color-blackwork', async () => {
    // fine-line settles bold-fine and blackwork settles the palette, so the
    // first OPEN rung is literal-abstract — never a color cut whose prompt
    // contradicts the brief's own "zero color" clause.
    const result = await enhanceStructured({
      ...baseRecord,
      styleTags: ['blackwork', 'fine-line'],
      ambiguousAxes: ['literal-abstract', 'minimal-ornate'],
    });

    expect(result.axisSelection.mode).toBe('questionnaire');
    expect(result.axisSelection.axes).toEqual(['literal-abstract']);
    expect(result.axisSelection.rationale).toContain('already settled');
    for (const variation of result.variations) {
      expect((variation.prompts.detailed || '').toLowerCase()).not.toContain(
        'vibrant full-color'
      );
    }
  });

  it('a full-color-resolved brief skips the palette rung just the same', async () => {
    const result = await enhanceStructured({
      ...baseRecord,
      styleTags: ['color', 'fine-line'],
      ambiguousAxes: ['literal-abstract', 'minimal-ornate'],
    });

    expect(result.axisSelection.axes).toEqual(['literal-abstract']);
  });

  it('an unresolved palette does NOT skip — the question is still worth asking', async () => {
    const result = await enhanceStructured({
      ...baseRecord,
      styleTags: ['illustrative'],
      ambiguousAxes: ['bold-fine', 'color-blackwork', 'literal-abstract', 'minimal-ornate'],
    });

    expect(result.axisSelection.axes).toEqual(['bold-fine']);
  });

  it('an explicitly requested axis wins over a settled skip', async () => {
    // Asking to SEE the split is stronger, later evidence than the tags
    // that settled it — the conversation promised this split.
    const result = await enhanceStructured({
      ...baseRecord,
      styleTags: ['blackwork'],
      ambiguousAxes: ['color-blackwork', 'bold-fine'],
      requestedAxis: 'color-blackwork',
    });

    expect(result.axisSelection.axes).toEqual(['color-blackwork']);
    expect(result.axisSelection.rationale).toContain('explicitly asked');
  });
});

describe('enhanceStructured - the fixed ladder (ADR-0049)', () => {
  it('round one spreads bold-fine no matter how many axes stayed ambiguous', async () => {
    const result = await enhanceStructured({
      ...baseRecord,
      ambiguousAxes: ['minimal-ornate', 'bold-fine', 'literal-abstract', 'color-blackwork'],
    });

    expect(result.axisSelection.mode).toBe('questionnaire');
    expect(result.axisSelection.axes).toEqual(['bold-fine']);
    // The rationale names the ladder — selection is logged, never silent.
    expect(result.axisSelection.rationale).toContain('ladder');
  });
});

describe('enhanceStructured - compositional fallback (empty ambiguousAxes)', () => {
  it('locks style and varies composition across two distinct treatments', async () => {
    const result = await enhanceStructured(baseRecord);

    expect(result.axisSelection.mode).toBe('compositional');
    expect(result.axisSelection.axes).toEqual([]);

    expect(result.variations).toHaveLength(2);
    const compositions = result.variations.map(
      v => (v.axisPosition as { composition: string }).composition
    );
    expect(compositions.every(Boolean)).toBe(true);
    expect(new Set(compositions).size).toBe(2);

    // Style locks: every variation carries the same style spec.
    for (const variation of result.variations) {
      expect(variation.prompts.simple).toContain('neo-traditional');
    }
    const detailedPrompts = result.variations.map(v => v.prompts.detailed);
    expect(new Set(detailedPrompts).size).toBe(2);
  });
});

describe('enhanceRound - later rounds hold every picked pole (ADR-0049)', () => {
  const record: IntakeRecord = {
    ...baseRecord,
    ambiguousAxes: ['bold-fine', 'color-blackwork'],
  };

  it('spreads the round axis while carrying the locked poles in every cut', async () => {
    const result = await enhanceRound(record, {
      roundNumber: 2,
      axis: 'color-blackwork',
      lockedPoles: { 'bold-fine': 'bold' },
    });

    expect(result.axisSelection.mode).toBe('questionnaire');
    expect(result.axisSelection.axes).toEqual(['color-blackwork']);
    expect(result.variations).toHaveLength(2);
    expect(result.variations.map(v => v.axisPosition)).toEqual([
      { 'color-blackwork': 'color', 'bold-fine': 'bold' },
      { 'color-blackwork': 'blackwork', 'bold-fine': 'bold' },
    ]);
    // The locked pole reads in both prompts — the round HOLDS the pick.
    for (const variation of result.variations) {
      expect((variation.prompts.detailed || '').toLowerCase()).toContain('bold');
    }
  });

  it('re-rolls on the locked poles past the ladder', async () => {
    const locked = {
      'bold-fine': 'fine',
      'color-blackwork': 'blackwork',
      'literal-abstract': 'literal',
      'minimal-ornate': 'minimal',
    } as const;
    const result = await enhanceRound(record, {
      roundNumber: 5,
      axis: 'reroll',
      lockedPoles: locked,
    });

    expect(result.variations).toHaveLength(2);
    for (const variation of result.variations) {
      expect(variation.axisPosition).toEqual(locked);
    }
  });

  it('compositional rounds take the next treatment pair from the pool', async () => {
    const round1 = await enhanceRound(baseRecord, {
      roundNumber: 1,
      axis: 'composition',
      lockedPoles: {},
    });
    const round2 = await enhanceRound(baseRecord, {
      roundNumber: 2,
      axis: 'composition',
      lockedPoles: {},
    });

    const compositionsOf = (result: typeof round1) =>
      result.variations.map(v => (v.axisPosition as { composition: string }).composition);
    expect(round1.variations).toHaveLength(2);
    expect(round2.variations).toHaveLength(2);
    // Different pairs — round two does not repeat round one's framings.
    expect(new Set([...compositionsOf(round1), ...compositionsOf(round2)]).size).toBe(4);
  });
});

describe('enhanceStructured - rationale is logged, never silent (ADR-0012)', () => {
  it('always returns a non-empty rationale and emits it via onDiscussionUpdate', async () => {
    for (const ambiguousAxes of [
      [] as IntakeRecord['ambiguousAxes'],
      ['bold-fine', 'color-blackwork'] as IntakeRecord['ambiguousAxes'],
    ]) {
      const onDiscussionUpdate = vi.fn();
      const result = await enhanceStructured(
        { ...baseRecord, ambiguousAxes },
        { onDiscussionUpdate }
      );

      expect(result.axisSelection.rationale.length).toBeGreaterThan(0);
      expect(onDiscussionUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'axis-selection',
          mode: result.axisSelection.mode,
          rationale: result.axisSelection.rationale,
        })
      );
    }
  });

  it('works without a callback (rationale still in the result)', async () => {
    const result = await enhanceStructured(baseRecord);
    expect(result.axisSelection.rationale.length).toBeGreaterThan(0);
  });
});

describe('enhanceStructured - placement is required, never guessed', () => {
  // Regression: an empty placement used to fall back silently to 'forearm',
  // so the brief said "" while the render showed a forearm piece. Both intake
  // lanes now guarantee placement before enhancement (the scripted route
  // 400s without a placementAnswer; the conversation gates its turn-12
  // forced proposal on it), so an empty placement here is a broken caller —
  // fail loudly rather than render a body part nobody asked for.
  it('throws on an empty placement instead of silently rendering a forearm', async () => {
    await expect(
      enhanceStructured({ ...baseRecord, placement: '' })
    ).rejects.toThrow(/placement/i);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('throws on a whitespace-only placement', async () => {
    await expect(
      enhanceStructured({ ...baseRecord, placement: '   ' })
    ).rejects.toThrow(/placement/i);
  });
});

describe('enhanceStructured - offline and non-invasive', () => {
  it('never calls a provider (template-based, no network)', async () => {
    await enhanceStructured({
      ...baseRecord,
      ambiguousAxes: ['literal-abstract', 'minimal-ornate'],
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('leaves the classic enhance() export untouched', () => {
    expect(typeof enhance).toBe('function');
  });
});

describe('enhanceStructured - monochrome sessions strip chromatic anchors', () => {
  const gokuAnchors =
    'Goku with wild spiky black hair (or golden Super Saiyan), orange gi with blue undershirt and belt (Dragon Ball Z), charging a kamehameha';

  it('drops color words from the subject on a blackwork session', async () => {
    const result = await enhanceStructured({
      ...baseRecord,
      styleTags: ['blackwork'],
      subject: gokuAnchors,
      ambiguousAxes: ['minimal-ornate'],
    });

    for (const variation of result.variations) {
      const prompt = (variation.prompts.simple || '').toLowerCase();
      expect(prompt).toContain('goku');
      // The action survives; the hues do not.
      expect(prompt).toContain('kamehameha');
      expect(prompt).not.toContain('orange');
      expect(prompt).not.toContain('blue');
      expect(prompt).not.toContain('golden');
      // Tonal words are what blackwork is made of — they stay.
      expect(prompt).toContain('black');
    }
  });

  it('leaves the subject untouched on a color session', async () => {
    const result = await enhanceStructured({
      ...baseRecord,
      styleTags: ['color'],
      subject: gokuAnchors,
      ambiguousAxes: ['minimal-ornate'],
    });

    for (const variation of result.variations) {
      expect((variation.prompts.simple || '').toLowerCase()).toContain('orange');
    }
  });
});
