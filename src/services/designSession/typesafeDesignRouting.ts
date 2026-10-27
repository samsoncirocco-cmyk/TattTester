/**
 * TypeSafe design routing — one System One call per turn.
 *
 * Fan-out (https://docs.typesafe.ai/patterns/fan-out): the same POST asks
 * both questions, and code decides which answer matters.
 *   - Noul `enough_to_generate` — ready to draw?
 *   - Choice `next_question` — which axis to ask if not
 *
 * Choice options go in `criteria`. `options` is rejected with 422.
 * Docs: https://docs.typesafe.ai/primitives/noul
 *       https://docs.typesafe.ai/primitives/choice
 *       https://docs.typesafe.ai/confidence
 *
 * The request shape matches the other TypeSafe call sites (council judge,
 * intake extraction): POST /v1/systemone, Bearer TYPESAFE_API_KEY, model
 * TYPESAFE_MODEL (jev-latest), abort after TYPESAFE_TIMEOUT_MS. The API
 * key is never written to a log.
 *
 * A Noul has no separate confidence. The unsure band between the no-line
 * and the yes-line keeps the current generate decision. A Choice below
 * TYPESAFE_DESIGN_CHOICE_CONFIDENCE keeps the current question. Flag off,
 * demo mode, a missing key, a budget denial, a non-2xx, a timeout, or an
 * unparseable body all keep the current path.
 *
 * `color` covers the color-versus-blackwork axis. Listing that variation
 * again would split probability with `color`.
 */

import { envBool, envFloat, envInt, envString } from '@/config/envSchema';
import { checkBudget, recordSpend } from '@/lib/budget-tracker';
import { logger } from '@/lib/logger';
import type { IntakeRecord } from '@/services/intake/types';
import type {
  BlockingField,
  ConversationMessage,
  ConversationStage,
  ConversationTurnResult,
  GateState,
  TurnLog,
} from '@/services/designConversation/types';

export const TYPESAFE_SYSTEMONE_URL = 'https://api.typesafe.ai/v1/systemone';

const DEFAULT_MODEL = 'jev-latest';
const DEFAULT_TIMEOUT_MS = 8_000;

/**
 * Flat cents recorded against the global spend cap after a 2xx. Jev's list
 * price is about $0.042 per million input tokens, so a routing call is a
 * fraction of a cent. One cent is the same deliberate over-estimate vision
 * analysis uses. Timeouts and transport errors are not metered.
 */
export const DESIGN_ROUTING_COST_CENTS = 1;

/**
 * Defaults. TypeSafe's starting Noul cutoffs are 0.7 yes and 0.3 no.
 * Choice confidence 0.5 is the line where one axis is actually ahead of
 * the others; below that the existing question stays.
 */
export const DESIGN_ROUTING_THRESHOLDS = {
  noulYes: 0.7,
  noulNo: 0.3,
  choiceConfidence: 0.5,
} as const;

export const DESIGN_QUESTION_AXES = [
  'placement',
  'size',
  'style',
  'subject',
  'color',
  'bold-fine',
  'literal-abstract',
  'minimal-ornate',
  'other',
] as const;

export type DesignQuestionAxis = (typeof DESIGN_QUESTION_AXES)[number];

/**
 * Spoken asks. Placement, style, subject, and color reuse the engine's
 * own lines so a short answer on the next turn still settles the field
 * the way a stalled ask does. The lead sentence of a promotion is the
 * engine's proposal lead, so a later turn knows the announce already fired.
 */
const AXIS_QUESTION: Record<DesignQuestionAxis, string> = {
  placement: 'where on your body do you want this?',
  size: 'how big are you thinking — a coin, a palm, or something that wraps?',
  style: 'one style call and i can draw — fine line, blackwork, color, traditional?',
  subject: 'what should it actually show? the picture in your head, however rough.',
  color: 'blackwork and clean lines, or full color?',
  'bold-fine': 'bold heavy lines, or fine and delicate?',
  'literal-abstract': 'should it read as the thing itself, or more abstract?',
  'minimal-ornate': 'keep it minimal, or let it get ornate?',
  other: '',
};

const PROPOSAL_LEAD = "here's what i'm hearing:";
const PROPOSAL_AFFORDANCE = 'want to see two cuts on this, or did i miss something?';

const GATE_LINE: Record<BlockingField, string> = {
  placement: 'I still need a placement before I can draw.',
  meaning: 'I still need to know what it shows before I can draw.',
  styleTags: 'I still need a style call before I can draw.',
};

const STEERABLE_RULES = new Set<TurnLog['firedRule']>(['none', 'judgment']);

export type DesignRoutingKeepReason =
  | 'flag_off'
  | 'demo'
  | 'missing_key'
  | 'budget'
  | 'http'
  | 'timeout'
  | 'parse'
  | 'low_confidence'
  | 'not_steerable';

export type DesignRoutingDecision =
  | {
      action: 'keep';
      reason: DesignRoutingKeepReason;
      noul?: number;
      choice?: DesignQuestionAxis;
      choiceConfidence?: number;
    }
  | {
      action: 'generate';
      noul: number;
      choice: DesignQuestionAxis;
      choiceConfidence: number;
    }
  | {
      action: 'ask';
      axis: DesignQuestionAxis;
      question: string;
      noul: number;
      choiceConfidence: number;
      /** Confident "not enough". The fast-lane readiness flag drops. */
      withholdGenerate: boolean;
    };

export interface DesignRoutingInput {
  channel: 'design-session' | 'sms-placement';
  sessionId?: string;
  transcript: readonly ConversationMessage[];
  record: Partial<IntakeRecord>;
  stage: ConversationStage;
  firedRule: TurnLog['firedRule'];
}

export function questionForAxis(axis: DesignQuestionAxis): string {
  return AXIS_QUESTION[axis];
}

export function isDesignRoutingEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return envBool('TYPESAFE_DESIGN_ROUTING', env);
}

export function designRoutingThresholds(env: NodeJS.ProcessEnv = process.env): {
  noulYes: number;
  noulNo: number;
  choiceConfidence: number;
} {
  const noulYes = unitOr(envFloat('TYPESAFE_DESIGN_NOUL_YES', env), DESIGN_ROUTING_THRESHOLDS.noulYes);
  const noulNo = unitOr(envFloat('TYPESAFE_DESIGN_NOUL_NO', env), DESIGN_ROUTING_THRESHOLDS.noulNo);
  const choiceConfidence = unitOr(
    envFloat('TYPESAFE_DESIGN_CHOICE_CONFIDENCE', env),
    DESIGN_ROUTING_THRESHOLDS.choiceConfidence
  );
  if (noulNo >= noulYes) return { ...DESIGN_ROUTING_THRESHOLDS };
  return { noulYes, noulNo, choiceConfidence };
}

export function buildDesignRoutingQuestions(): Record<string, unknown> {
  return {
    enough_to_generate: {
      type: 'noul',
      instructions: 'Does this design session have enough information to generate tattoo designs now?',
      criteria: {
        true: 'Where the tattoo goes and what it should show (a subject or a meaning) are known well enough to draw. Open style, size, or color details can be chosen while drawing.',
        false: 'Where it goes or what it shows is still missing, or the customer is still figuring the idea out.',
      },
    },
    next_question: {
      type: 'choice',
      instructions:
        'If one more question would most improve this brief before generating, which axis should it ask about?',
      criteria: {
        placement: 'Where on the body the tattoo goes is missing or too vague to draw.',
        size: 'How large the tattoo should be is the open question.',
        style: 'The line, school, or overall style is unresolved.',
        subject: 'What the tattoo depicts is missing or too vague.',
        color: 'Full color versus black ink or blackwork is unresolved.',
        'bold-fine': 'Bold heavy lines versus fine delicate linework is the most useful open variation.',
        'literal-abstract': 'A recognizable depiction versus an abstract treatment is the most useful open variation.',
        'minimal-ornate': 'A minimal design versus an ornate one is the most useful open variation.',
        other: 'None of the axes above is the right next question.',
      },
    },
  };
}

function hasRequiredFields(record: Partial<IntakeRecord>): boolean {
  const placement = (record.placement ?? '').trim();
  const meaning = (record.meaning ?? '').trim();
  const subject = (record.subject ?? '').trim();
  return Boolean(placement && (meaning || subject));
}

function isSteerable(input: DesignRoutingInput): boolean {
  if (input.stage === 'handoff') return false;
  return STEERABLE_RULES.has(input.firedRule);
}

function isActionable(axis: DesignQuestionAxis): boolean {
  return axis !== 'other' && AXIS_QUESTION[axis].length > 0;
}

function knownAxis(value: string): DesignQuestionAxis | undefined {
  return (DESIGN_QUESTION_AXES as readonly string[]).includes(value)
    ? (value as DesignQuestionAxis)
    : undefined;
}

/**
 * Read a successful System One body. Throws RoutingCallError('parse') when
 * either answer is missing or out of range — a half answer is not acted on.
 */
export function interpretDesignRouting(
  payload: unknown,
  input: DesignRoutingInput,
  thresholds = designRoutingThresholds()
): DesignRoutingDecision {
  if (!isRecord(payload) || !isRecord(payload.answers)) {
    throw routingError('parse', 'parse');
  }
  const answers = payload.answers;
  const noul = readUnit(answers.enough_to_generate, 'noul');
  const choiceAnswer = readChoice(answers.next_question);
  const choice = knownAxis(choiceAnswer.choice);
  if (!choice) throw routingError('parse', 'parse');
  const choiceConfidence = choiceAnswer.confidence;
  const parsed = { noul, choice, choiceConfidence };

  if (noul >= thresholds.noulYes && hasRequiredFields(input.record)) {
    return { action: 'generate', ...parsed };
  }

  const choiceActs = choiceConfidence >= thresholds.choiceConfidence && isActionable(choice);
  if (!choiceActs) return { action: 'keep', reason: 'low_confidence', ...parsed };

  if (noul <= thresholds.noulNo) {
    return {
      action: 'ask',
      axis: choice,
      question: AXIS_QUESTION[choice],
      noul,
      choiceConfidence,
      withholdGenerate: true,
    };
  }

  // Unsure, or a confident yes the record cannot generate yet. Steer the
  // question only while this turn is still chatting — an unsure Noul does
  // not pull a proposal back.
  if (input.stage === 'chatting') {
    return {
      action: 'ask',
      axis: choice,
      question: AXIS_QUESTION[choice],
      noul,
      choiceConfidence,
      withholdGenerate: false,
    };
  }

  return { action: 'keep', reason: 'low_confidence', ...parsed };
}

/**
 * Apply a routing decision to an engine turn.
 *
 * Hard cadence rules (handoff, turn-12, an explicit draw or axis request,
 * a stalled-field ask, the evocation question) are not steerable: the
 * engine's reply stands. A confident yes promotes a chatting turn to the
 * proposal beat. A confident no replaces the reply with the chosen axis.
 */
export function steerConversationTurn(
  result: ConversationTurnResult,
  decision: DesignRoutingDecision
): ConversationTurnResult {
  if (decision.action === 'keep') return result;
  if (result.stage === 'handoff' || !STEERABLE_RULES.has(result.turnLog.firedRule)) {
    return result;
  }

  if (decision.action === 'generate') {
    if (result.stage === 'proposal') return result;
    if (!hasRequiredFields(result.record)) return result;
    const playback = playbackFor(result.record);
    const turnLog: TurnLog = { ...result.turnLog, firedRule: 'judgment' };
    delete turnLog.blockingField;
    return {
      ...result,
      reply: `${PROPOSAL_LEAD} ${playback}. ${PROPOSAL_AFFORDANCE}`,
      stage: 'proposal',
      playback,
      gate: undefined,
      notes: { ...result.notes, sufficient: true },
      turnLog,
    };
  }

  const gate = gateFor(decision.axis);
  const turnLog: TurnLog = {
    ...result.turnLog,
    firedRule: decision.withholdGenerate ? 'none' : result.turnLog.firedRule,
  };
  if (gate) turnLog.blockingField = gate.blocking;
  else delete turnLog.blockingField;
  return {
    ...result,
    reply: decision.question,
    stage: 'chatting',
    playback: undefined,
    gate,
    notes: decision.withholdGenerate
      ? { ...result.notes, sufficient: false }
      : result.notes,
    turnLog,
  };
}

export async function routeDesignTurn(
  input: DesignRoutingInput,
  env: NodeJS.ProcessEnv = process.env
): Promise<DesignRoutingDecision> {
  if (!isDesignRoutingEnabled(env)) return { action: 'keep', reason: 'flag_off' };
  if (env.NEXT_PUBLIC_DEMO_MODE === 'true') return { action: 'keep', reason: 'demo' };
  if (!isSteerable(input)) return { action: 'keep', reason: 'not_steerable' };

  const key = typesafeApiKey(env);
  if (!key) {
    logRouting({ channel: input.channel, sessionId: input.sessionId, action: 'keep', reason: 'missing_key' }, 'warn');
    return { action: 'keep', reason: 'missing_key' };
  }

  try {
    const budget = await checkBudget();
    if (budget.allowed === false) {
      logRouting({
        channel: input.channel,
        sessionId: input.sessionId,
        action: 'keep',
        reason: 'budget',
        spentCents: budget.spentCents,
      }, 'warn');
      return { action: 'keep', reason: 'budget' };
    }
  } catch (error) {
    logRouting({
      channel: input.channel,
      sessionId: input.sessionId,
      action: 'keep',
      reason: 'budget',
      error: redact(errorText(error), key),
    }, 'warn');
    return { action: 'keep', reason: 'budget' };
  }

  const started = Date.now();
  try {
    const response = await fetch(TYPESAFE_SYSTEMONE_URL, {
      method: 'POST',
      signal: AbortSignal.timeout(typesafeTimeoutMs(env)),
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: typesafeModel(env),
        state: routingState(input),
        questions: buildDesignRoutingQuestions(),
      }),
    });
    if (!response.ok) {
      // Drain the body so the status is the only thing that can reach a log.
      await response.text().catch(() => undefined);
      throw routingError(`http ${response.status}`, 'http', response.status);
    }
    await recordRoutingSpend();
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw routingError('parse', 'parse');
    }
    const decision = interpretDesignRouting(payload, input, designRoutingThresholds(env));
    logRouting({
      channel: input.channel,
      sessionId: input.sessionId,
      action: decision.action,
      reason: decision.action === 'keep' ? decision.reason : undefined,
      axis: decision.action === 'ask' ? decision.axis : undefined,
      noul: 'noul' in decision ? decision.noul : undefined,
      choice: 'choice' in decision ? decision.choice : undefined,
      choiceConfidence: 'choiceConfidence' in decision ? decision.choiceConfidence : undefined,
      durationMs: Date.now() - started,
      inputTokens: readInputTokens(payload),
    });
    return decision;
  } catch (error) {
    const reason = classify(error);
    const status = error instanceof RoutingCallError ? error.status : undefined;
    logRouting({
      channel: input.channel,
      sessionId: input.sessionId,
      action: 'keep',
      reason,
      status,
      durationMs: Date.now() - started,
      error: redact(errorText(error), key),
    }, 'warn');
    return { action: 'keep', reason };
  }
}

function routingState(input: DesignRoutingInput): Record<string, unknown> {
  const record = input.record;
  return {
    channel: input.channel,
    designAlreadyGenerated: input.channel === 'sms-placement',
    transcript: input.transcript.slice(-16).map((message) => ({
      role: message.role,
      text: message.text.slice(0, 500),
    })),
    brief: {
      placement: (record.placement ?? '').trim(),
      styleTags: record.styleTags ?? [],
      meaning: (record.meaning ?? '').trim(),
      subject: (record.subject ?? '').trim(),
      ambiguousAxes: record.ambiguousAxes ?? [],
    },
  };
}

function playbackFor(record: Partial<IntakeRecord>): string {
  const drawn = (record.subject ?? '').trim() || (record.meaning ?? '').trim() || 'the piece';
  const style = (record.styleTags ?? [])[0]?.replace(/-/g, ' ');
  const placement = (record.placement ?? '').trim();
  const detail = [drawn, style].filter(Boolean).join(', ');
  return placement ? `${detail} on your ${placement}` : detail;
}

function gateFor(axis: DesignQuestionAxis): GateState | undefined {
  const blocking: BlockingField | undefined =
    axis === 'placement' ? 'placement' : axis === 'subject' ? 'meaning' : axis === 'style' ? 'styleTags' : undefined;
  if (!blocking) return undefined;
  return { blocking, stalled: false, line: GATE_LINE[blocking] };
}

function typesafeApiKey(env: NodeJS.ProcessEnv): string | undefined {
  const key = envString('TYPESAFE_API_KEY', env);
  return key || undefined;
}

function typesafeModel(env: NodeJS.ProcessEnv): string {
  return envString('TYPESAFE_MODEL', env) || DEFAULT_MODEL;
}

function typesafeTimeoutMs(env: NodeJS.ProcessEnv): number {
  const value = envInt('TYPESAFE_TIMEOUT_MS', env);
  if (value === undefined || !Number.isFinite(value) || value < 1) return DEFAULT_TIMEOUT_MS;
  return value;
}

async function recordRoutingSpend(): Promise<void> {
  try {
    await recordSpend(DESIGN_ROUTING_COST_CENTS);
  } catch (error) {
    logger.warn({
      event_type: 'design_session.typesafe_routing',
      action: 'spend_unrecorded',
      error: errorText(error),
    });
  }
}

function logRouting(fields: Record<string, unknown>, level: 'info' | 'warn' = 'info'): void {
  const payload: Record<string, unknown> = { event_type: 'design_session.typesafe_routing' };
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) payload[key] = value;
  }
  logger[level](payload);
}

class RoutingCallError extends Error {
  readonly reason: 'http' | 'timeout' | 'parse';
  readonly status?: number;

  constructor(message: string, reason: 'http' | 'timeout' | 'parse', status?: number) {
    super(message);
    this.name = 'RoutingCallError';
    this.reason = reason;
    this.status = status;
  }
}

function routingError(message: string, reason: 'http' | 'timeout' | 'parse', status?: number): RoutingCallError {
  return new RoutingCallError(message, reason, status);
}

function classify(error: unknown): 'http' | 'timeout' | 'parse' {
  if (error instanceof RoutingCallError) return error.reason;
  if (isTimeoutError(error)) return 'timeout';
  return 'http';
}

function isTimeoutError(error: unknown): boolean {
  if (!error || typeof error !== 'object' || !('name' in error)) return false;
  const name = String((error as { name?: string }).name);
  return name === 'TimeoutError' || name === 'AbortError';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function readUnit(answer: unknown, field: string): number {
  if (!isRecord(answer)) throw routingError('parse', 'parse');
  const value = answer[field];
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    throw routingError('parse', 'parse');
  }
  return value;
}

function readChoice(answer: unknown): { choice: string; confidence: number } {
  if (!isRecord(answer) || typeof answer.choice !== 'string') {
    throw routingError('parse', 'parse');
  }
  return { choice: answer.choice, confidence: readUnit(answer, 'confidence') };
}

function readInputTokens(payload: unknown): number | undefined {
  if (!isRecord(payload) || !isRecord(payload.usage)) return undefined;
  const tokens = payload.usage.input_tokens;
  return typeof tokens === 'number' && Number.isFinite(tokens) ? tokens : undefined;
}

function unitOr(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value) || value < 0 || value > 1) return fallback;
  return value;
}

function errorText(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, 200);
}

function redact(message: string, key: string): string {
  if (!key || !message.includes(key)) return message;
  return message.split(key).join('[redacted]');
}
