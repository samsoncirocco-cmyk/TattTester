/**
 * The settled-axis derivation (ADR-0049): which ladder rungs the brief has
 * already committed one pole of, so no round — round one or a charged
 * refine — ever spreads them. Deliberately conservative: explicit evidence
 * only, and an axis the intake listed as ambiguous is never settled.
 */
import { describe, it, expect } from 'vitest';
import type { IntakeRecord } from '../types';
import { resolvePalette, sessionPalette, settledAxes } from '../settledAxes';

const record = (overrides: Partial<IntakeRecord>): IntakeRecord => ({
  placement: 'forearm',
  styleTags: [],
  meaning: 'strength after a rough year',
  references: [],
  ambiguousAxes: [],
  ...overrides,
});

describe('settledAxes — the palette rung (the live-bug axis)', () => {
  it('a blackwork-resolved brief settles color-blackwork', () => {
    expect(settledAxes(record({ styleTags: ['blackwork'] }))).toContain('color-blackwork');
    expect(settledAxes(record({ styleTags: ['black-and-grey'] }))).toContain(
      'color-blackwork'
    );
  });

  it('a full-color-resolved brief settles color-blackwork just the same', () => {
    expect(settledAxes(record({ styleTags: ['color'] }))).toContain('color-blackwork');
    expect(settledAxes(record({ styleTags: ['watercolor'] }))).toContain('color-blackwork');
  });

  it('an unresolved palette settles nothing — the question stays askable', () => {
    expect(resolvePalette(['illustrative'])).toBe('unresolved');
    expect(settledAxes(record({ styleTags: ['illustrative'] }))).toEqual([]);
  });

  it('never settles an axis the intake explicitly listed as ambiguous', () => {
    // Line-style shorthand: 'fine-line' reads monochrome to resolvePalette,
    // but the intake left the palette question open — so the rung stays
    // spreadable. Skipping it would silently remove a refinement the
    // customer never answered.
    const shorthand = record({
      styleTags: ['fine-line'],
      ambiguousAxes: ['bold-fine', 'color-blackwork'],
    });
    expect(settledAxes(shorthand)).toEqual([]);
  });

  it('respects a deliberately reopened axis (the customer asked to SEE the split)', () => {
    // applyAxisSpread reopens the axis by listing it ambiguous again; the
    // lingering tag evidence must not re-close it.
    const reopened = record({
      styleTags: ['fine-line'],
      ambiguousAxes: ['bold-fine'],
      requestedAxis: 'bold-fine',
    });
    expect(settledAxes(reopened)).not.toContain('bold-fine');
  });
});

describe('sessionPalette — one precedence, written once (ADR-0061, #382)', () => {
  it('a customer answer outranks the ambiguous flag', () => {
    // Intake flagged the axis before the ask-flow got its answer; the
    // answer is customer voice and wins over the stale flag.
    expect(
      sessionPalette(
        record({ ambiguousAxes: ['color-blackwork'], paletteAnswer: 'color' })
      )
    ).toBe('color');
    expect(
      sessionPalette(
        record({ ambiguousAxes: ['color-blackwork'], paletteAnswer: 'monochrome' })
      )
    ).toBe('monochrome');
  });

  it('a customer answer outranks anything the tags imply', () => {
    // 'blackwork' reads monochrome to resolvePalette; the customer said
    // color out loud, and what they said wins.
    expect(
      sessionPalette(record({ styleTags: ['blackwork'], paletteAnswer: 'color' }))
    ).toBe('color');
  });

  it('an OPEN question (flagged, unanswered) outranks the tags', () => {
    // The line-style-shorthand case: 'fine-line' reads monochrome, but the
    // color question is live in front of the customer — nothing answers it
    // on their behalf.
    expect(
      sessionPalette(record({ styleTags: ['fine-line'], ambiguousAxes: ['color-blackwork'] }))
    ).toBe('unresolved');
  });

  it('with no answer and no open flag, the tags decide via resolvePalette', () => {
    expect(sessionPalette(record({ styleTags: ['blackwork'] }))).toBe('monochrome');
    expect(sessionPalette(record({ styleTags: ['watercolor'] }))).toBe('color');
    expect(sessionPalette(record({ styleTags: ['illustrative'] }))).toBe('unresolved');
  });

  it('an ANSWERED axis is settled even while the ambiguous flag lingers', () => {
    // The answer settles color-blackwork (ADR-0061: it must survive to the
    // reveal like any settled axis); other axes keep the ambiguous filter.
    const answered = record({
      styleTags: ['fine-line'],
      ambiguousAxes: ['color-blackwork', 'bold-fine'],
      paletteAnswer: 'monochrome',
    });
    expect(settledAxes(answered)).toContain('color-blackwork');
    expect(settledAxes(answered)).not.toContain('bold-fine');
  });
});

describe('settledAxes — the other rungs, explicit commitments only', () => {
  it('fine-line settles bold-fine', () => {
    expect(settledAxes(record({ styleTags: ['fine-line'] }))).toContain('bold-fine');
  });

  it('a named subject settles literal-abstract (IP rule: recognizable is the point)', () => {
    expect(
      settledAxes(record({ subject: 'Son Goku from Dragon Ball Z' }))
    ).toContain('literal-abstract');
    expect(settledAxes(record({ subject: '   ' }))).not.toContain('literal-abstract');
  });

  it('realism/portrait and abstract/surrealism settle literal-abstract', () => {
    expect(settledAxes(record({ styleTags: ['realism'] }))).toContain('literal-abstract');
    expect(settledAxes(record({ styleTags: ['abstract'] }))).toContain('literal-abstract');
  });

  it('minimalist and ornamental settle minimal-ornate', () => {
    expect(settledAxes(record({ styleTags: ['minimalist'] }))).toContain('minimal-ornate');
    expect(settledAxes(record({ styleTags: ['ornamental'] }))).toContain('minimal-ornate');
  });

  it('an empty brief settles nothing', () => {
    expect(settledAxes(record({}))).toEqual([]);
  });
});
