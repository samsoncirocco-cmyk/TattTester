// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Variation } from '@/services/designSession/types';
import { RevealGrid } from '../components/RevealGrid';

// The reveal's four quadrant cuts: bold-fine × color-blackwork.
const variations: Variation[] = [
  { id: 'v1', axisPosition: { 'bold-fine': 'bold', 'color-blackwork': 'color' }, prompt: 'p1', imageUrl: 'https://img.test/1.png' },
  { id: 'v2', axisPosition: { 'bold-fine': 'bold', 'color-blackwork': 'blackwork' }, prompt: 'p2', imageUrl: 'https://img.test/2.png' },
  { id: 'v3', axisPosition: { 'bold-fine': 'fine', 'color-blackwork': 'color' }, prompt: 'p3', imageUrl: 'https://img.test/3.png' },
  { id: 'v4', axisPosition: { 'bold-fine': 'fine', 'color-blackwork': 'blackwork' }, prompt: 'p4', imageUrl: 'https://img.test/4.png' },
];

describe('RevealGrid', () => {
  it('staggers all four cuts in, one beat apart', () => {
    const { container } = render(<RevealGrid variations={variations} mode="pick" />);

    // All four render (the stagger is entrance-only — nothing is withheld).
    expect(screen.getAllByAltText(/^Design \d$/)).toHaveLength(4);
    // Each cut carries its own beat of the reveal stagger.
    for (const n of [1, 2, 3, 4]) {
      expect(container.querySelectorAll(`.reveal-cut.reveal-cut-${n}`)).toHaveLength(1);
    }
  });

  it('respects prefers-reduced-motion — the cut-in is disabled at the CSS layer', () => {
    // The stagger is pure CSS (design-system snap animation), so the
    // reduced-motion path lives in globals.css: the media query must kill
    // the .reveal-cut animation, leaving all four cuts rendered in place.
    const css = readFileSync(resolve(process.cwd(), 'src/app/globals.css'), 'utf8');
    const reduced = css.split('@media (prefers-reduced-motion: reduce)')[1];
    expect(reduced).toBeTruthy();
    expect(reduced).toContain('.reveal-cut');
    expect(reduced).toContain('animation: none');
  });

  it('gives each cut a human name and caption — never raw axis telemetry', () => {
    const { container } = render(<RevealGrid variations={variations} mode="pick" />);

    expect(screen.getByText('the bold, full-color one')).toBeTruthy();
    expect(screen.getByText('the bold, blackwork one')).toBeTruthy();
    expect(screen.getByText('the fine-line, full-color one')).toBeTruthy();
    expect(screen.getByText('the fine-line, blackwork one')).toBeTruthy();

    // The internal axis ids stay internal (TAT-47 defect 8).
    const text = container.textContent ?? '';
    for (const raw of ['bold-fine', 'color-blackwork', 'literal-abstract', 'minimal-ornate', 'axisPosition']) {
      expect(text).not.toContain(raw);
    }
  });

  it('pick mode: tapping a cut reports its id', () => {
    const onSelect = vi.fn();
    render(<RevealGrid variations={variations} mode="pick" onSelect={onSelect} />);

    fireEvent.click(screen.getByRole('button', { name: /^Pick design 3 /}));
    expect(onSelect).toHaveBeenCalledWith('v3');
  });

  it('pick confirm: the chosen cut wears the tape-corner tag', () => {
    render(<RevealGrid variations={variations} mode="not-you" pickId="v2" />);

    const tag = screen.getByText('Your pick');
    expect(tag.className).toContain('reveal-cut'); // snaps in on cue
    expect(tag.className).toContain('bg-pink');
  });

  it('most-not-you: pick is locked out, the other three carry the affordance', () => {
    const onSelect = vi.fn();
    render(<RevealGrid variations={variations} mode="not-you" pickId="v2" onSelect={onSelect} />);

    // The pick can't be tapped as most-not-you.
    const pickButton = screen.getByRole('button', { name: /^Pick design 2 / });
    expect((pickButton as HTMLButtonElement).disabled).toBe(true);

    // The remaining three are labeled for the negative signal, with the
    // in-voice chip making the affordance visible.
    const candidates = screen.getAllByRole('button', { name: /feels most not me/ });
    expect(candidates).toHaveLength(3);
    expect(screen.getAllByText('not you?')).toHaveLength(3);

    fireEvent.click(screen.getByRole('button', { name: /^Design 4 feels most not me / }));
    expect(onSelect).toHaveBeenCalledWith('v4');
  });

  it('locked mode: no cut can be picked', () => {
    render(<RevealGrid variations={variations} mode="locked" pickId="v2" />);
    // Scoped to the pick targets: since TAT-58 each tile also carries an
    // expand control, which stays live in locked mode on purpose (the
    // critique lane's re-cuts render locked and still need reading at full
    // size). See CutLightbox.test.tsx.
    const picks = screen.getAllByRole('button', { name: /^Pick design \d+ / });
    expect(picks).toHaveLength(4);
    for (const button of picks) {
      expect((button as HTMLButtonElement).disabled).toBe(true);
    }
  });
});
