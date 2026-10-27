// @vitest-environment jsdom
/** Spec 12 on screen: the lane that drew a cut, and its seed behind details. */
import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { RevealGrid } from '../components/RevealGrid';
import { CutLightbox } from '../components/CutLightbox';
import { drawnOnLine, laneLabel, seedLine } from '../services/laneLabel';
import type { Variation } from '@/services/designSession/types';

const cut = (extra: Partial<Variation>): Variation => ({
  id: 'v1',
  axisPosition: { 'bold-fine': 'bold' },
  prompt: 'p',
  imageUrl: 'https://img.test/1.png',
  ...extra,
});

describe('lane labels', () => {
  it('names the lanes the code serves and never prints a raw id', () => {
    expect(laneLabel('flux-dev')).toBe('Flux Dev');
    expect(laneLabel('flux-schnell')).toBe('Flux Schnell');
    expect(laneLabel('krea2')).toBe('Krea 2');
    expect(laneLabel('nano-banana-2')).toBe('Nano Banana 2');
    expect(laneLabel('some-new-model')).toBeNull();
    expect(drawnOnLine('some-new-model')).toBeNull();
  });

  it('says the seed, or that the lane takes none, or nothing', () => {
    expect(seedLine('flux-dev', 482910)).toBe('seed 482910');
    expect(seedLine('nano-banana-2', undefined)).toBe('seed: not used on this lane');
    expect(seedLine(undefined, undefined)).toBeNull();
    expect(seedLine('flux-dev', undefined)).toBeNull();
  });
});

describe('the full view shows provenance', () => {
  it('opened from the grid: drawn on the lane, seed inside details', () => {
    render(<RevealGrid variations={[cut({ lane: 'flux-dev', seed: 482910 })]} mode="pick" />);
    fireEvent.click(screen.getByRole('button', { name: /see design 1 full size/i }));

    expect(screen.getByText('drawn on Flux Dev')).toBeTruthy();
    expect(screen.getByText('details')).toBeTruthy();
    expect(screen.getByText('seed 482910')).toBeTruthy();
  });

  it('a nano cut says the seed is not used', () => {
    render(
      <CutLightbox imageUrl="https://img.test/1.png" alt="Design 1" name="the bold one" lane="nano-banana-2" onClose={() => {}} />
    );
    expect(screen.getByText('drawn on Nano Banana 2')).toBeTruthy();
    expect(screen.getByText('seed: not used on this lane')).toBeTruthy();
  });

  it('an old cut with no provenance shows nothing extra', () => {
    render(<CutLightbox imageUrl="https://img.test/1.png" alt="Design 1" name="the bold one" onClose={() => {}} />);
    expect(screen.queryByText(/drawn on/)).toBeNull();
    expect(screen.queryByText('details')).toBeNull();
  });
});
