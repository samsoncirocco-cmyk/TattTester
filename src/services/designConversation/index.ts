// Public entry point of the design-conversation module (ADR-0019–0022).
// Everything under internal/ is implementation detail — import only from here.
//
// The conversation engine turns the design bot's intake into a genuine
// LLM-driven conversation: each turn does double duty (conversational reply
// + incremental structured extraction into Partial<IntakeRecord>), while
// deterministic code — never model judgment — decides the cadence
// (ADR-0021: aim to propose by ~turn 6, force the proposal at turn 12, warm
// handoff at turn 20; caps are never surfaced as limits). The engine is
// stateless: the caller owns persistence, per-session model pinning (pass
// back TurnLog.model as pinnedModel), and the ConverseRequest/Response
// mapping. When every provider is exhausted, runTurn throws
// ConversationUnavailableError and the caller downgrades to the v1 scripted
// intake flow (ADR-0019).
import { runConversationTurn, type RunTurnRequest } from './internal/engine';
export { GUESS_FIRST_ACCEPTED_EVENT, GUESS_FIRST_EDITED_EVENT } from './events';
import { OPENER } from './internal/persona';
import type { ConversationTurnResult } from './types';

export { ConversationUnavailableError } from './internal/providers';
export type {
  ConversationMessage,
  ConversationStage,
  TurnLog,
  ConversationTurnResult,
  ConverseRequest,
  ConverseResponse,
  ConfirmRequest,
  SessionNotes,
  GateState,
  BlockingField,
} from './types';
export { STALLED_FIELD_TURNS } from './internal/gate';
export type { RunTurnRequest };

/**
 * Where the turn-20 warm handoff CTA points (ADR-0021). The engine's result
 * carries only the stage; the integration layer sets
 * ConverseResponse.handoffUrl to this when stage is 'handoff'.
 */
export const HANDOFF_URL = '/smart-match';

/**
 * The bot's fixed opening message — leads with placement and meaning
 * (ADR-0019). Deterministic; no model call.
 */
export function opener(): string {
  return OPENER;
}

/**
 * Run one conversation turn: one model call doing double duty (reply +
 * extraction), then deterministic cadence. Always returns a TurnLog (also
 * logged, ADR-0022). In demo mode (NEXT_PUBLIC_DEMO_MODE) a short
 * deterministic script runs instead — no LLM ever. Throws
 * ConversationUnavailableError when every provider is exhausted.
 */
export async function runTurn(request: RunTurnRequest): Promise<ConversationTurnResult> {
  return runConversationTurn(request);
}
