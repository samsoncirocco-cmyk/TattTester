import { describe, it, expect } from 'vitest';
import type { Variation } from '@/services/designSession/types';
import { cutIdentity, nextTake } from '../cutIdentity';

const variation = (axisPosition: Record<string, string>): Variation => ({
  id: 'v1',
  axisPosition,
  prompt: 'a prompt',
});

/** Raw internals that must never surface in a cut's name or caption (TAT-47 defect 8). */
const RAW_TELEMETRY = [
  'bold-fine',
  'color-blackwork',
  'literal-abstract',
  'minimal-ornate',
  'axisPosition',
  'axis',
  'questionnaire',
  'compositional',
];

function expectDesignedOnly({ name, caption }: { name: string; caption: string }) {
  for (const raw of RAW_TELEMETRY) {
    expect(name.toLowerCase()).not.toContain(raw.toLowerCase());
    expect(caption.toLowerCase()).not.toContain(raw.toLowerCase());
  }
}

describe('cutIdentity', () => {
  it('names a two-axis quadrant cut from both poles', () => {
    const cut = cutIdentity(
      variation({ 'bold-fine': 'bold', 'color-blackwork': 'color' }),
      0
    );
    expect(cut.name).toBe('the bold, full-color one');
    expect(cut.caption).toBe('heavy lines, built to last — ink with a pulse');
  });

  it('names a single-axis cut', () => {
    expect(cutIdentity(variation({ 'bold-fine': 'fine' }), 0).name).toBe('the fine-line one');
    expect(cutIdentity(variation({ 'color-blackwork': 'blackwork' }), 0).name).toBe(
      'the blackwork one'
    );
  });

  it('gives every pole a designed name and caption — never raw axis telemetry', () => {
    const poles = ['bold', 'fine', 'color', 'blackwork', 'literal', 'abstract', 'minimal', 'ornate'];
    const axes = ['bold-fine', 'color-blackwork', 'literal-abstract', 'minimal-ornate'];
    for (const pole of poles) {
      const axis = axes.find((a) => a.includes(pole)) ?? 'bold-fine';
      const cut = cutIdentity(variation({ [axis]: pole }), 0);
      expect(cut.name).toMatch(/^the .+ one$/);
      expect(cut.caption.length).toBeGreaterThan(0);
      expectDesignedOnly(cut);
    }
  });

  it('names every compositional treatment', () => {
    const expected: Record<string, string> = {
      'centered emblem': 'the emblem',
      'dynamic flow': 'the mover',
      'negative space': 'the breather',
      'close crop': 'the close-up',
      'ensemble emblem': 'the emblem',
      'battle scene': 'the clash',
      'stacked tiers': 'the totem',
      'flowing procession': 'the procession',
      'vertical story': 'the story',
      'connected transitions': 'the run',
      'focal hierarchy': 'the anchor',
    };
    for (const [composition, name] of Object.entries(expected)) {
      const cut = cutIdentity(variation({ composition }), 0);
      expect(cut.name).toBe(name);
      expect(cut.caption.length).toBeGreaterThan(0);
      expectDesignedOnly(cut);
    }
  });

  it('falls back to a plain cut number on unknown poles — never the raw value', () => {
    const cut = cutIdentity(variation({ 'bold-fine': 'bold', 'new-axis': 'zigzag' }), 1);
    expect(cut).toEqual({ name: 'cut two', caption: '' });
    expect(cut.name).not.toContain('zigzag');
  });

  it('falls back on unknown compositional treatments and empty positions', () => {
    expect(cutIdentity(variation({ composition: 'brand new treatment' }), 2)).toEqual({
      name: 'cut three',
      caption: '',
    });
    expect(cutIdentity(variation({}), 3)).toEqual({ name: 'cut four', caption: '' });
  });
});

/**
 * Takes (astronaut session, 2026-08-26).
 *
 * A re-cut copied its target's axis position, so the grid put "the bold one"
 * under two different cuts and the resolver — which treats a shared name as a
 * miss — could reach neither by name. The re-cut is now a numbered take of the
 * design it revises.
 */
describe('cutIdentity — takes', () => {
  const recut = (revision: number): Variation => ({
    ...variation({ 'bold-fine': 'bold' }),
    id: 'v1-fix1',
    revisionOf: 'v1',
    revision,
  });

  it('names a re-cut as a take of the design it revises', () => {
    expect(cutIdentity(recut(2), 2).name).toBe('the bold one, take 2');
    expect(cutIdentity(recut(3), 3).name).toBe('the bold one, take 3');
  });

  it('gives a take the same caption — same treatment, one take later', () => {
    expect(cutIdentity(recut(2), 2).caption).toBe(
      cutIdentity(variation({ 'bold-fine': 'bold' }), 0).caption
    );
  });

  it('never collides with the cut it revises', () => {
    expect(cutIdentity(recut(2), 2).name).not.toBe(
      cutIdentity(variation({ 'bold-fine': 'bold' }), 0).name
    );
  });

  it('leaks no raw axis value into a take name (ADR-0012 / TAT-47)', () => {
    expectDesignedOnly(cutIdentity(recut(2), 2));
  });

  it('falls back to a plain cut number when the base has no designed name', () => {
    // "cut five, take 2" would wrap designed copy around undesigned copy. The
    // grid number is already unique, so it stands alone.
    const unnamed: Variation = { id: 'x', axisPosition: { 'new-axis': 'zigzag' }, prompt: 'p', revision: 2 };
    expect(cutIdentity(unnamed, 4)).toEqual({ name: 'cut 5', caption: '' });
  });

  it('names a composition re-cut as a take too', () => {
    const totemTake: Variation = {
      id: 'c1-fix1',
      axisPosition: { composition: 'stacked tiers' },
      prompt: 'p',
      revisionOf: 'c1',
      revision: 2,
    };
    expect(cutIdentity(totemTake, 2).name).toBe('the totem, take 2');
  });
});

describe('cutIdentity — nextTake', () => {
  const bold: Variation = { id: 'v1', axisPosition: { 'bold-fine': 'bold' }, prompt: 'p' };
  const fine: Variation = { id: 'v2', axisPosition: { 'bold-fine': 'fine' }, prompt: 'p' };

  it('starts a design at take 2 and counts up the line', () => {
    const take2: Variation = { ...bold, id: 'v1-fix1', revisionOf: 'v1', revision: 2 };
    expect(nextTake({ variations: [bold, fine], critiqueCuts: [] }, bold)).toBe(2);
    expect(nextTake({ variations: [bold, fine], critiqueCuts: [take2] }, take2)).toBe(3);
  });

  it('steps past a take number already in play', () => {
    // Two rounds CAN spread the same axis, so two cuts can share a base name —
    // and a colliding take would put us straight back into two-cuts-one-name.
    const otherBold: Variation = { id: 'v3', axisPosition: { 'bold-fine': 'bold' }, prompt: 'p' };
    const take2: Variation = { ...otherBold, id: 'v3-fix1', revisionOf: 'v3', revision: 2 };
    expect(
      nextTake({ variations: [bold, fine, otherBold], critiqueCuts: [take2] }, bold)
    ).toBe(3);
  });
});
