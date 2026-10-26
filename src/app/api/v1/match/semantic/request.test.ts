import { describe, expect, it } from 'vitest';
import { parseSemanticMatchRequest } from './request';

describe('parseSemanticMatchRequest (#363)', () => {
  it('resolves aliases to canonical styles and drops unknowns in a mixed list', () => {
    const parsed = parseSemanticMatchRequest({
      query: 'a dagger',
      style_preferences: ['fine-line', 'Japanese (Irezumi)', 'Vaporwave', 'fine-line'],
      max_results: 20,
    });

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.styles).toEqual(['Fine Line', 'Japanese']);
    expect(parsed.value.maxResults).toBe(20);
    expect(parsed.value.distance).toBe(25);
  });

  it('refuses a style list that resolves to nothing, instead of searching unfiltered', () => {
    const parsed = parseSemanticMatchRequest({
      query: 'a dagger',
      style_preferences: ['Script', 'Vaporwave'],
    });

    expect(parsed).toMatchObject({ ok: false, code: 'UNKNOWN_STYLES' });
  });

  it('rejects a style list that is not an array of strings', () => {
    expect(parseSemanticMatchRequest({ query: 'a dagger', style_preferences: 'Traditional' })).toMatchObject({
      ok: false,
      code: 'INVALID_STYLES',
    });
    expect(parseSemanticMatchRequest({ query: 'a dagger', style_preferences: [1, 2] })).toMatchObject({
      ok: false,
      code: 'INVALID_STYLES',
    });
  });

  it('rejects out-of-range query, budget, radius, and max_results', () => {
    expect(parseSemanticMatchRequest({ query: '   ' })).toMatchObject({ code: 'INVALID_QUERY' });
    expect(parseSemanticMatchRequest({ query: 'a dagger', budget: -5 })).toMatchObject({ code: 'INVALID_BUDGET' });
    expect(parseSemanticMatchRequest({ query: 'a dagger', radius: 0 })).toMatchObject({ code: 'INVALID_RADIUS' });
    expect(parseSemanticMatchRequest({ query: 'a dagger', radius: 501 })).toMatchObject({ code: 'INVALID_RADIUS' });
    expect(parseSemanticMatchRequest({ query: 'a dagger', max_results: 51 })).toMatchObject({
      code: 'INVALID_MAX_RESULTS',
    });
    expect(parseSemanticMatchRequest([])).toMatchObject({ code: 'INVALID_BODY' });
  });

  it('accepts the smart-match client shape', () => {
    const parsed = parseSemanticMatchRequest({
      query: 'forearm resilience Fine Line',
      style_preferences: ['Fine Line', 'Blackwork'],
      location: null,
      max_results: 20,
    });

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value).toMatchObject({
      location: null,
      styles: ['Fine Line', 'Blackwork'],
      budget: null,
      hasPortfolio: false,
      maxResults: 20,
    });
  });
});
