// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import type { Variation } from '@/services/designSession/types';
import { RevealGrid } from '../components/RevealGrid';

/**
 * The expand path (TAT-58). Everything here goes through RevealGrid rather
 * than mounting CutLightbox directly, because the part that was actually at
 * risk is the collision: the tile's tap is the round's pick signal, and the
 * expand control has to live beside it without ever firing it — including
 * in 'locked' mode, where the pick target is disabled but the artwork still
 * has to be inspectable.
 */
const variations: Variation[] = [
  { id: 'v1', axisPosition: { 'bold-fine': 'bold' }, prompt: 'p1', imageUrl: 'https://img.test/1.png' },
  { id: 'v2', axisPosition: { 'bold-fine': 'fine' }, prompt: 'p2', imageUrl: 'https://img.test/2.png' },
];

const openControls = () => screen.getAllByRole('button', { name: /^See design \d+ full size/ });

describe('RevealGrid — expand to full view', () => {
  it('every cut carries its own expand control, named for the design it opens', () => {
    render(<RevealGrid variations={variations} mode="pick" />);

    const controls = openControls();
    expect(controls).toHaveLength(2);
    // The designed name rides along with the number so a screen reader
    // never announces two bare "See design" targets.
    expect(controls[0].getAttribute('aria-label')).toContain('the bold one');
    expect(controls[0].getAttribute('aria-haspopup')).toBe('dialog');
  });

  it('opens a labelled modal dialog holding the full, uncropped cut', () => {
    render(<RevealGrid variations={variations} mode="pick" />);
    expect(screen.queryByRole('dialog')).toBeNull();

    fireEvent.click(openControls()[1]);

    const dialog = screen.getByRole('dialog');
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    // Labelled by the cut's designed name, and captioned with its line.
    expect(dialog.textContent).toContain('the fine-line one');
    const labelledBy = dialog.getAttribute('aria-labelledby');
    expect(labelledBy).toBeTruthy();
    expect(document.getElementById(labelledBy!)?.textContent).toBe('the fine-line one');

    // The image is contained, never cropped — that is the whole feature.
    const full = dialog.querySelector('img') as HTMLImageElement;
    expect(full.getAttribute('src')).toBe('https://img.test/2.png');
    expect(full.className).toContain('object-contain');
    expect(full.className).not.toContain('object-cover');
  });

  it('does not fire the round pick when the expand control is tapped', () => {
    const onSelect = vi.fn();
    render(<RevealGrid variations={variations} mode="pick" onSelect={onSelect} />);

    fireEvent.click(openControls()[0]);

    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('keeps the pick tap working — the two controls are separate targets', () => {
    const onSelect = vi.fn();
    render(<RevealGrid variations={variations} mode="pick" onSelect={onSelect} />);

    fireEvent.click(screen.getByRole('button', { name: /^Pick design 2 / }));

    expect(onSelect).toHaveBeenCalledWith('v2');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('locked cuts are still expandable — the critique lane renders locked', () => {
    render(<RevealGrid variations={variations} mode="locked" pickId="v1" />);

    // The pick targets are out of play…
    for (const pick of screen.getAllByRole('button', { name: /^Pick design \d+ / })) {
      expect((pick as HTMLButtonElement).disabled).toBe(true);
    }
    // …but the artwork can still be read at full size.
    const controls = openControls();
    expect(controls).toHaveLength(2);
    expect((controls[0] as HTMLButtonElement).disabled).toBe(false);

    fireEvent.click(controls[0]);
    expect(screen.getByRole('dialog')).toBeTruthy();
  });

  it('moves focus into the dialog on open and returns it to the trigger on Escape', () => {
    render(<RevealGrid variations={variations} mode="pick" />);
    const trigger = openControls()[0];

    fireEvent.click(trigger);
    const dialog = screen.getByRole('dialog');
    // Focus lands on the way out, inside the dialog.
    expect(dialog.contains(document.activeElement)).toBe(true);
    expect((document.activeElement as HTMLElement).getAttribute('aria-label')).toBe('Close full view');

    fireEvent.keyDown(document, { key: 'Escape' });

    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it('closes on the ✕ control and on a backdrop click, returning focus each time', () => {
    render(<RevealGrid variations={variations} mode="pick" />);
    const trigger = openControls()[1];

    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole('button', { name: 'Close full view' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(trigger);

    fireEvent.click(trigger);
    // The backdrop is the dialog element itself; clicking the card inside
    // it must NOT close the view.
    const dialog = screen.getByRole('dialog');
    fireEvent.click(dialog.firstElementChild as HTMLElement);
    expect(screen.queryByRole('dialog')).toBeTruthy();

    fireEvent.click(dialog);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it('steps between the round\'s cuts with the arrow keys', () => {
    render(<RevealGrid variations={variations} mode="pick" />);
    fireEvent.click(openControls()[0]);

    const image = () => screen.getByRole('dialog').querySelector('img')!.getAttribute('src');
    expect(image()).toBe('https://img.test/1.png');

    // Nothing before the first cut.
    fireEvent.keyDown(document, { key: 'ArrowLeft' });
    expect(image()).toBe('https://img.test/1.png');

    fireEvent.keyDown(document, { key: 'ArrowRight' });
    expect(image()).toBe('https://img.test/2.png');
    // Focus comes back to the cut being looked at, not the one opened.
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(document.activeElement).toBe(openControls()[1]);
  });

  it('locks background scroll while open and restores it on close', () => {
    render(<RevealGrid variations={variations} mode="pick" />);

    fireEvent.click(openControls()[0]);
    expect(document.body.style.overflow).toBe('hidden');

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(document.body.style.overflow).toBe('');
  });

  it('offers no expand control for a cut that never rendered', () => {
    render(
      <RevealGrid
        variations={[variations[0], { id: 'v3', axisPosition: {}, prompt: 'p3' }]}
        mode="pick"
      />
    );

    expect(openControls()).toHaveLength(1);
  });

  it('gives both tiles one shared frame, contained so nothing is cropped', () => {
    const { container } = render(<RevealGrid variations={variations} mode="pick" />);

    const images = container.querySelectorAll('img');
    expect(images).toHaveLength(2);
    for (const image of images) {
      // The crop bug was object-cover in a forced square.
      expect(image.className).toContain('object-contain');
      expect(image.className).not.toContain('object-cover');
      // The frame is the parent, shared by both tiles so the pair stays
      // aligned; jsdom decodes nothing, so it holds the square default.
      const frame = image.parentElement as HTMLElement;
      expect(frame.style.aspectRatio).toBe('1');
      // Bone mat, so letterboxing reads as the flash art's own paper.
      expect(frame.className).toContain('bg-bone');
    }
  });
});
