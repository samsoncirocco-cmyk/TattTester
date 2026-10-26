import { describe, expect, it } from 'vitest';
import { pinnedImageInputs } from '../capabilities';

describe('pinnedImageInputs — what a pinned model will honor', () => {
  it.each([
    ['nano-banana-2', { referenceImages: true, sourceImage: false }],
    ['flux-dev', { referenceImages: false, sourceImage: true }],
    ['flux-schnell', { referenceImages: false, sourceImage: false }],
    ['krea2', { referenceImages: false, sourceImage: false }],
    // A Vertex pin takes neither, even though the Replicate table would map
    // an unknown id to flux-dev — the answer follows the serving provider.
    ['imagen3', { referenceImages: false, sourceImage: false }],
  ])('%s', (modelId, expected) => {
    expect(pinnedImageInputs(modelId)).toEqual(expected);
  });
});
