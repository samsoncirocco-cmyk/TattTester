/**
 * Multi-Model Routing Tests
 *
 * Validates model selection and fallback behavior.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  selectOptimalModel,
  getModelCapabilities,
  selectModelWithFallback,
  clearModelCache
} from '../src/utils/styleModelMapping.js';

describe('modelRouting', () => {
  beforeEach(() => {
    clearModelCache();
  });

  it('selects a model for a known style', () => {
    const result = selectOptimalModel('traditional', 'moderate', 'forearm');
    expect(result.modelId).toBeTruthy();
    expect(result.modelName).toBeTruthy();
  });

  it('returns capabilities for a known model', () => {
    const capabilities = getModelCapabilities('imagen3');
    expect(capabilities).toBeTruthy();
    expect(capabilities.id).toBe('imagen3');
    expect(Array.isArray(capabilities.strengths)).toBe(true);
  });

  it('selects a fallback model when needed', async () => {
    const result = await selectModelWithFallback('anime', 'Goku and Vegeta fighting', 'back');
    expect(result.modelId).toBeTruthy();
    expect(result.isFallback).toBeDefined();
    expect(result.source).toBe('rules');
  });

  it('uses a TypeSafe image-model choice when that model is configured', async () => {
    const result = await selectModelWithFallback('traditional', 'a dragon', 'forearm', {
      preferredModelId: 'krea_2',
      reasoning: 'TypeSafe judge selected krea_2 (confidence 0.91)',
      choiceConfidence: 0.91,
    });
    expect(result.modelId).toBe('krea_2');
    expect(result.source).toBe('typesafe');
    expect(result.isFallback).toBe(false);
    expect(result.choiceConfidence).toBe(0.91);
  });

  it('keeps the rules table when the TypeSafe choice is not a configured model', async () => {
    const result = await selectModelWithFallback('traditional', 'a dragon', 'forearm', {
      preferredModelId: 'not-a-real-model',
    });
    expect(result.modelId).toBe('flux_dev');
    expect(result.source).toBe('rules');
    expect(result.typesafeChoiceIgnored).toBe(true);
  });
});
