/**
 * Versioned intake decision packet.
 *
 * Intake publishes one reading for a transcript fingerprint. A later step
 * in the same process consumes that reading instead of classifying the
 * transcript again. The packet is process-local; it is not a store of
 * customer text.
 */

import { createHash } from 'node:crypto';

export const INTAKE_DECISION_PACKET_VERSION = 1 as const;

export interface IntakeNextQuestion {
  axis: string;
  confidence: number;
}

export interface IntakeDecisionReading {
  placement: string | null;
  styleTags: string[];
  ambiguousAxes: string[];
  /** Null when this call did not ask the readiness Noul. */
  readinessNoul: number | null;
  nextQuestion: IntakeNextQuestion | null;
  /** Fields still open. A later question may only use these. */
  unresolvedFields: string[];
}

export interface IntakeDecisionPacket {
  version: typeof INTAKE_DECISION_PACKET_VERSION;
  fingerprint: string;
  reading: IntakeDecisionReading;
}

const packets = new Map<string, IntakeDecisionPacket>();
const MAX_PACKETS = 32;

export function intakeStateFingerprint(state: string): string {
  return createHash('sha256').update(state).digest('hex');
}

export function publishIntakeDecisionPacket(packet: IntakeDecisionPacket): void {
  if (packet.version !== INTAKE_DECISION_PACKET_VERSION) return;
  if (!packet.fingerprint) return;
  packets.set(packet.fingerprint, packet);
  while (packets.size > MAX_PACKETS) {
    const oldest = packets.keys().next().value;
    if (oldest === undefined) break;
    packets.delete(oldest);
  }
}

/** Remove and return the packet for this transcript, if intake just published one. */
export function takeIntakeDecisionPacket(fingerprint: string): IntakeDecisionPacket | null {
  const packet = packets.get(fingerprint) ?? null;
  if (packet) packets.delete(fingerprint);
  return packet;
}

export function clearIntakeDecisionPackets(): void {
  packets.clear();
}
