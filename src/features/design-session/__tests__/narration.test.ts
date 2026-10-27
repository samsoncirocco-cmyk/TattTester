/**
 * Spec 10's narration lines, as pure functions: the "because you said"
 * clause, the between-rounds "kept / now splitting" line, the interim line,
 * and the critique lane's "changed:" lines.
 */
import { describe, it, expect } from 'vitest';
import { revealNarration, trimAtWord } from '../services/revealNarration';
import { interimLine } from '../services/interimLine';
import { roundChangeLine } from '@/services/designSession/roundPlan';
import { changedLine, rerollChangedLine } from '@/services/designSession/internal/critiqueVoice';
import type { AxisSelection } from '@/services/intake/types';

const twoAxes: AxisSelection = {
  mode: 'questionnaire',
  axes: ['bold-fine', 'minimal-ornate'],
  rationale: 'INTERNAL: intake left bold-fine unresolved',
};

describe('revealNarration — because you said', () => {
  it('names a verified character and the placement', () => {
    expect(
      revealNarration(twoAxes, {
        placement: 'Forearm',
        characterIdentities: [{ name: 'Deku', series: 'My Hero Academia' }],
      })
    ).toBe(
      'You asked for Deku on your forearm, so I split these two on line weight and how much detail they carry — your pick tells me which way to lean.'
    );
  });

  it('two characters are named, three or more are a cast', () => {
    const cast = (names: string[]) =>
      revealNarration(twoAxes, {
        placement: 'back',
        characterIdentities: names.map((name) => ({ name, series: 's' })),
      });
    expect(cast(['Deku', 'Bakugo'])).toMatch(/^You asked for Deku and Bakugo on your back, so /);
    expect(cast(['A', 'B', 'C'])).toMatch(/^You asked for your cast of 3 on your back, so /);
  });

  it('with no verified character it says the placement only, never the freeform subject or meaning', () => {
    const line = revealNarration(twoAxes, {
      placement: 'ribs',
      characterIdentities: [],
      // Not part of the projection the clause reads, but present on a real
      // intake: neither may ever surface.
      ...({ meaning: 'for my late grandmother Rose', subject: 'Rose, my grandmother' } as object),
    });
    expect(line).toBe(
      'For your ribs, I split these two on line weight and how much detail they carry — your pick tells me which way to lean.'
    );
    expect(line).not.toContain('Rose');
    expect(line).not.toContain('INTERNAL');
  });

  it('without an intake it is exactly the old sentence', () => {
    expect(revealNarration(twoAxes)).toBe(
      'I split these two on line weight and how much detail they carry — your pick tells me which way to lean.'
    );
  });

  it('the compositional variant is unchanged', () => {
    expect(
      revealNarration({ mode: 'compositional', axes: [], rationale: 'r' }, { placement: 'ribs' })
    ).toBe('Style is locked in, so these two play with pose, framing, and negative space.');
  });

  it('trims long parts to 40 characters at a word boundary', () => {
    const long = 'outer left forearm wrapping round toward the elbow crease';
    const trimmed = trimAtWord(long);
    expect(trimmed.length).toBeLessThanOrEqual(41);
    expect(trimmed.endsWith('…')).toBe(true);
    expect(long.startsWith(trimmed.slice(0, -1))).toBe(true);
  });
});

describe('roundChangeLine', () => {
  it('kept pole, then the next ladder axis', () => {
    expect(roundChangeLine({ picked: true, keptPole: 'fine', axis: 'color-blackwork' })).toBe(
      'kept: fine-line. now splitting: full-color vs blackwork.'
    );
  });

  it('a re-roll after a rejected set says it is a new set', () => {
    expect(roundChangeLine({ picked: false, axis: 'bold-fine' })).toBe(
      'changed: new set on the same direction. now splitting: bold vs fine-line.'
    );
  });

  it('off the ladder: kept your pick, and the plain description', () => {
    expect(roundChangeLine({ picked: true, axis: 'reroll' })).toBe(
      'kept: your pick. now: a fresh re-roll on everything you locked.'
    );
  });
});

describe('interimLine', () => {
  const notes = { cast: [], ipHeadsUp: false, sufficient: true };

  it('echoes what the notepad already shows', () => {
    expect(
      interimLine({ ...notes, cast: ['Deku (My Hero Academia)'], placement: 'forearm', style: 'fine line' })
    ).toBe('drawing your Deku (My Hero Academia), forearm, fine line.');
  });

  it('falls back to "your design" without a cast, and says nothing with nothing known', () => {
    expect(interimLine({ ...notes, placement: 'ribs' })).toBe('drawing your design, ribs.');
    expect(interimLine(notes)).toBeNull();
    expect(interimLine(undefined)).toBeNull();
  });

  it('never carries the vibe (the meaning, in their words)', () => {
    expect(interimLine({ ...notes, placement: 'ribs', vibe: 'for my late dad' })).not.toContain('dad');
  });
});

describe('the critique lane says what changed', () => {
  it('quotes their words, trimmed to 60 characters', () => {
    expect(changedLine(['too heavy'])).toBe('changed: per ‘too heavy’.');
    const long = changedLine(['make the outline much thinner and take the background stars out completely please']);
    expect(long!.length).toBeLessThan('changed: per ‘’.'.length + 62);
    expect(long).toMatch(/…’\.$/);
    expect(changedLine(['  '])).toBeNull();
  });

  it('a fresh set says the hint back, or that it is a new set', () => {
    expect(rerollChangedLine('more cinematic')).toBe('changed: new set, per ‘more cinematic’.');
    expect(rerollChangedLine('')).toBe('changed: new set on the same direction.');
  });
});
