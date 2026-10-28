import { describe, expect, it } from 'vitest';
import {
  MODERATION_THRESHOLDS,
  moderationUserMessage,
  routeModeration,
} from './contentModeration';

const low = { real_person: 0.04, trademark: 0.02 };

describe('routeModeration', () => {
  it('blocks high-confidence high-severity', () => {
    expect(routeModeration({
      nouls: { ...low, trademark: 0.91 },
      severity: 2.4,
      confidence: 0.88,
    })).toBe('block');
  });

  it('blocks when a hazard Noul is at the action line and severity is serious', () => {
    expect(routeModeration({
      nouls: { trademark: MODERATION_THRESHOLDS.highConfidence },
      severity: MODERATION_THRESHOLDS.highSeverity,
      confidence: 0,
    })).toBe('block');
  });

  it('sends the mid band to review', () => {
    expect(routeModeration({
      nouls: { real_person: 0.55, trademark: 0.1 },
      severity: 1.2,
      confidence: 0.5,
    })).toBe('review');
  });

  it('reviews a severe score the model is not confident enough to block on', () => {
    expect(routeModeration({
      nouls: low,
      severity: 2.6,
      confidence: 0.2,
    })).toBe('review');
  });

  it('reviews a confident hazard that is not high severity', () => {
    expect(routeModeration({
      nouls: { trademark: 0.8 },
      severity: 1.2,
      confidence: 0.9,
    })).toBe('review');
  });

  it('passes a low severity read', () => {
    expect(routeModeration({
      nouls: low,
      severity: 0.2,
      confidence: 0.93,
    })).toBe('pass');
  });

  it('passes just under the review lines', () => {
    expect(routeModeration({
      nouls: { real_person: 0.34, trademark: 0.1 },
      severity: 0.9,
      confidence: 0.34,
    })).toBe('pass');
  });

  it('does not block a legal claim unless severity is also high', () => {
    expect(routeModeration({
      nouls: { legal_claim: 0.96, real_person: 0.1, trademark: 0.1 },
      severity: 1.4,
      confidence: 0.9,
    })).toBe('review');
  });
});

describe('moderationUserMessage', () => {
  it('promises review on a design prompt only with a durable, correlated receipt', () => {
    expect(moderationUserMessage('design_prompt', 'review')).toBe('This was not saved for review.');
    expect(moderationUserMessage('design_prompt', 'review', { correlationId: 'mod_1', durable: false })).toBe(
      'This was not saved for review.',
    );
    expect(moderationUserMessage('design_prompt', 'review', { correlationId: 'mod_1', durable: true })).toMatch(
      /saved for review\. reference mod_1/i,
    );
    expect(moderationUserMessage('design_prompt', 'block')).not.toMatch(/can't generate/i);
  });

  it('tells a takedown requester that nothing was removed and a person will review', () => {
    const block = moderationUserMessage('takedown', 'block');
    expect(block).toMatch(/nothing has been removed/i);
    expect(block).toMatch(/review/i);
    expect(block).toMatch(/not resolve/i);
  });

  it('tells an appellant that nothing was restored', () => {
    expect(moderationUserMessage('appeal', 'block')).toMatch(/nothing has been restored/i);
    expect(moderationUserMessage('appeal', 'review')).toMatch(/review/i);
  });
});
