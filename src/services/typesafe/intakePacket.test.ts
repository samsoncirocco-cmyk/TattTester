import { describe, expect, it } from 'vitest';
import {
  INTAKE_DECISION_PACKET_VERSION,
  clearIntakeDecisionPackets,
  intakeStateFingerprint,
  publishIntakeDecisionPacket,
  takeIntakeDecisionPacket,
  type IntakeDecisionPacket,
} from './intakePacket';

function packet(state: string, placement: string | null): IntakeDecisionPacket {
  return {
    version: INTAKE_DECISION_PACKET_VERSION,
    fingerprint: intakeStateFingerprint(state),
    reading: {
      placement,
      styleTags: ['fine-line', 'dotwork'],
      ambiguousAxes: ['color-blackwork'],
      readinessNoul: 0.2,
      nextQuestion: { axis: 'subject', confidence: 0.8 },
      unresolvedFields: ['subject'],
    },
  };
}

describe('intake decision packet', () => {
  it('returns the reading for the same transcript and no other', () => {
    clearIntakeDecisionPackets();
    const state = 'user: rose on the right calf';
    publishIntakeDecisionPacket(packet(state, 'right calf'));
    expect(takeIntakeDecisionPacket(intakeStateFingerprint('other'))).toBeNull();
    const taken = takeIntakeDecisionPacket(intakeStateFingerprint(state));
    expect(taken?.reading.placement).toBe('right calf');
    expect(taken?.reading.styleTags).toEqual(['fine-line', 'dotwork']);
    expect(takeIntakeDecisionPacket(intakeStateFingerprint(state))).toBeNull();
  });
});
