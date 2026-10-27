/**
 * TypeSafe System One judges for the design council.
 *
 * One generator writes the prompt. One POST to /v1/systemone scores that
 * draft on five tattoo dimensions, picks an image model, and checks two
 * yes/no hazards. Weights, thresholds, and the pass/regenerate/clarify/
 * fallback decision all live in this file — Jev does not rewrite the prompt.
 *
 * Docs: https://docs.typesafe.ai/introduction
 *       https://docs.typesafe.ai/patterns/composite-scoring
 * Choice options belong in `criteria`. `options` is rejected with 422.
 */

import { envBool, envInt, envString } from '@/config/envSchema';
import { logEvent } from '@/lib/observability';
import { MODEL_CONFIGS } from '../../../config/modelRoutingRules.js';
import { selectModelWithFallback } from '../../../utils/styleModelMapping.js';

export const TYPESAFE_SYSTEMONE_URL = 'https://api.typesafe.ai/v1/systemone';

/** Live image models the Choice may return. `imagen3` stays off this list. */
export const IMAGE_MODEL_IDS = ['flux_dev', 'flux_schnell', 'krea_2', 'nano_banana_2'] as const;

export type ImageModelId = (typeof IMAGE_MODEL_IDS)[number];

export type ScoreQuestionId =
  | 'fits_body_placement'
  | 'line_weight_holds_on_skin'
  | 'ages_well'
  | 'true_to_chosen_style'
  | 'follows_user_request';

/**
 * Composite-scoring weights. They sum to 1. Change them here when a
 * dimension should count more; the judge request does not change.
 *
 * The request itself is weighted highest. Placement and line weight are
 * the two craft failures that survive a pretty prompt. Style matches
 * placement. Longevity is real but slightly easier to repair in a rewrite.
 */
export const COUNCIL_SCORE_WEIGHTS: Record<ScoreQuestionId, number> = {
  fits_body_placement: 0.2,
  line_weight_holds_on_skin: 0.2,
  ages_well: 0.15,
  true_to_chosen_style: 0.2,
  follows_user_request: 0.25,
};

/**
 * Gates. Score confidence is the minimum across the five scores, not the
 * mean, so one unsure dimension cannot be averaged away. Noul uses the
 * TypeSafe starting yes-threshold (0.7); Noul has no separate confidence.
 */
export const COUNCIL_JUDGE_THRESHOLDS = {
  minCombinedScore: 0.62,
  minScoreConfidence: 0.35,
  minChoiceConfidence: 0.35,
  noulYes: 0.7,
} as const;

/**
 * Planning figures for the PR's before/after comparison. Not a billing path.
 * Legacy flat sum is what the old council logs (technical counted once).
 * The token estimate prices all four legacy HTTP calls at public list rates.
 * Judge price is Jev's published input rate ($0.042 / million); output is free.
 */
export const COUNCIL_COST_MODEL = {
  legacyLlmCalls: 4,
  legacyFlatUsd: 0.08,
  legacyTokenEstimateUsd: 0.0335,
  /** ~700 input / 450 output tokens at Gemini 2.5 Flash list price ($0.30 / $2.50 per million). */
  generatorEstimateUsd: 0.00134,
  /** ~1,600 input tokens at $0.042 / million. */
  judgeEstimateUsd: 0.000067,
  typesafeUsdPerMillionInputTokens: 0.042,
  /** Assumed p50s used by scripts/benchmark-council-typesafe.mjs. Not a live trace. */
  legacyCallMs: 1800,
  generatorCallMs: 1800,
  judgeCallMs: 450,
} as const;

export function estimateJudgeCostUsd(inputTokens: number | undefined): number {
  if (inputTokens === undefined || !Number.isFinite(inputTokens) || inputTokens < 0) {
    return COUNCIL_COST_MODEL.judgeEstimateUsd;
  }
  return (inputTokens / 1_000_000) * COUNCIL_COST_MODEL.typesafeUsdPerMillionInputTokens;
}

const SCORE_CRITERIA: Record<ScoreQuestionId, { instructions: string; criteria: string[] }> = {
  fits_body_placement: {
    instructions: 'How well does `draft` fit a tattoo on `bodyPart`? Judge the composition against that placement.',
    criteria: [
      'The draft ignores the body placement or composes a design that cannot sit on that canvas.',
      'The placement is named, but the composition fights the shape or flow of that body area.',
      'The composition could sit on the placement, with some crowding or unused canvas.',
      'The composition follows the placement\'s shape and flow.',
      'The design is composed for this exact placement, including its edges, flow, and how it will be seen on the body.',
    ],
  },
  line_weight_holds_on_skin: {
    instructions: 'Will the line weight described in `draft` hold up on skin, rather than blur or fall out?',
    criteria: [
      'Line weight is absent or described in a way that would blur into skin.',
      'Lines are mentioned, but they are too fine, too muddy, or packed too tightly to hold after healing.',
      'Line weight is workable, with a few passages that may soften on skin.',
      'Line weight and spacing are deliberate and should stay readable on skin.',
      'Line weight, contrast, and spacing are specified so the tattoo stays readable on skin after healing.',
    ],
  },
  ages_well: {
    instructions: 'How well will the tattoo described in `draft` age on skin over years of ink spread?',
    criteria: [
      'The draft depends on micro-detail or soft gradients that will blur within a few years.',
      'Some of the design will survive, but important parts rely on detail that ink spread will erase.',
      'Bold structure is present, mixed with detail that may not last.',
      'The design is mostly bold, readable forms that age cleanly.',
      'The design is built from bold readable forms with room for ink spread, and nothing important depends on micro-detail.',
    ],
  },
  true_to_chosen_style: {
    instructions: 'How true is `draft` to the tattoo style named in `style`?',
    criteria: [
      'The draft contradicts the chosen tattoo style.',
      'The style is named, but the described techniques belong to a different style.',
      'Some style markers are present and some are generic or borrowed from another style.',
      'The draft uses the chosen style\'s characteristic techniques.',
      'The draft is unmistakably the chosen style, including its line, shading, and motifs.',
    ],
  },
  follows_user_request: {
    instructions: 'How faithfully does `draft` follow `userRequest`, without adding or dropping something important?',
    criteria: [
      'The draft depicts something the user did not ask for, or drops the thing they did ask for.',
      'The main subject is missing or replaced.',
      'The subject is present, but the draft adds or changes something important.',
      'The draft is faithful to the request and adds only tattoo-execution detail.',
      'The draft is the user\'s request made tattoo-ready, with nothing important added or dropped.',
    ],
  },
};

const NOUL_QUESTIONS = {
  contains_text_not_requested: {
    instructions:
      'Does `draft` instruct the image model to render words, letters, numbers, or a banner that `userRequest` did not ask to be written? Naming a subject is not a request to letter that name.',
    criteria: {
      true: 'The draft tells the image model to draw text, a caption, a banner, or numerals the user did not ask to be written.',
      false: 'The draft does not ask for written text, or the user explicitly asked for that lettering. A character or subject name in the prompt is not lettering.',
    },
  },
  names_real_person_or_brand: {
    instructions: 'Does `draft` name a real living person or a commercial brand that `userRequest` did not name?',
    criteria: {
      true: 'The draft names a real person or a commercial brand the user did not name.',
      false: 'Every real person or brand in the draft was named by the user, or the draft names none. Fictional characters the user asked for are not real people or brands.',
    },
  },
} as const;

export type NoulQuestionId = keyof typeof NOUL_QUESTIONS;

/**
 * One question, the way the design conversation asks one gap
 * (src/services/designConversation/internal/confidence.ts) instead of a list.
 */
export const CLARIFYING_QUESTIONS: Record<ScoreQuestionId, string> = {
  fits_body_placement: 'Where on the body should this sit, and should it fill that area or stay small?',
  line_weight_holds_on_skin: 'Do you want bold heavy lines, or fine delicate linework?',
  ages_well: 'Should this read clearly from a few feet away, or is close-up detail the point?',
  true_to_chosen_style: 'Which tattoo style should this stay closest to?',
  follows_user_request: 'What is the one thing this tattoo has to show?',
};

const REPAIR_CLAUSES: Record<ScoreQuestionId, string> = {
  fits_body_placement: 'Compose the design to fit the named body placement and its natural flow.',
  line_weight_holds_on_skin: 'Specify line weight that stays readable on skin, with enough spacing that lines will not blur together.',
  ages_well: 'Prefer bold readable forms over micro-detail that will blur as the tattoo ages.',
  true_to_chosen_style: 'Stay inside the named tattoo style and its characteristic techniques.',
  follows_user_request: 'Depict only what the user asked for, and do not add subjects they did not request.',
};

const IMAGE_MODEL_INSTRUCTIONS = 'Which image model should render `draft` for this tattoo?';

/** Same word heuristic as validatePromptLength in councilService (450 tokens). */
function fitsPromptBudget(text: string): boolean {
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  return Math.ceil(words * 1.3) <= 450;
}

export function isTypesafeCouncilEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return envBool('TYPESAFE_COUNCIL', env);
}

export function typesafeApiKey(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const key = envString('TYPESAFE_API_KEY', env);
  if (!key) return undefined;
  return key;
}

export function redactSecret(text: string, secret?: string): string {
  if (!secret || secret.length < 8 || !text) return text;
  return text.split(secret).join('[redacted]');
}

export function buildQuestions(): Record<string, unknown> {
  const questions: Record<string, unknown> = {};
  for (const [id, spec] of Object.entries(SCORE_CRITERIA)) {
    questions[id] = {
      type: 'score',
      instructions: spec.instructions,
      criteria: spec.criteria,
    };
  }
  const criteria: Record<string, string> = {};
  for (const id of IMAGE_MODEL_IDS) {
    const config = (MODEL_CONFIGS as Record<string, { name: string; description: string }>)[id];
    criteria[id] = `${config.name}: ${config.description}`;
  }
  questions.image_model = {
    type: 'choice',
    instructions: IMAGE_MODEL_INSTRUCTIONS,
    criteria,
  };
  for (const [id, spec] of Object.entries(NOUL_QUESTIONS)) {
    questions[id] = {
      type: 'noul',
      instructions: spec.instructions,
      criteria: spec.criteria,
    };
  }
  return questions;
}

export interface DraftText {
  prompts: { simple?: string; detailed?: string; ultra?: string };
  negativePrompt?: string;
}

export interface GeneratedDraft extends DraftText {
  prompts: { simple: string; detailed: string; ultra: string };
  negativePrompt: string;
  generator: 'vertex' | 'openrouter';
  generatorModel: string;
}

export interface ScoreReading {
  score: number;
  normalized: number;
  confidence: number;
  probabilities: Record<string, number>;
}

export interface ParsedJudgment {
  model: string;
  scores: Record<ScoreQuestionId, ScoreReading>;
  normalized: Record<ScoreQuestionId, number>;
  combined: number;
  minScoreConfidence: number;
  imageModel: {
    choice: string;
    confidence: number;
    probabilities: Record<string, number>;
    acceptedModelId: ImageModelId | null;
  };
  nouls: Record<NoulQuestionId, number>;
  inputTokens?: number;
  outputTokens?: number;
}

export type JudgeDecision = 'pass' | 'regenerate' | 'clarify' | 'fallback';

interface ScoreAnswer {
  type?: string;
  score: number;
  confidence: number;
  probabilities?: Record<string, number>;
}

interface ChoiceAnswer {
  type?: string;
  choice: string;
  confidence: number;
  probabilities?: Record<string, number>;
}

interface NoulAnswer {
  type?: string;
  noul: number;
}

interface SystemOneResponse {
  model?: string;
  answers?: Record<string, ScoreAnswer | ChoiceAnswer | NoulAnswer>;
  usage?: { input_tokens?: number; output_tokens?: number };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function readScore(answers: Record<string, unknown>, id: ScoreQuestionId): ScoreReading {
  const raw = answers[id];
  if (!isRecord(raw) || typeof raw.score !== 'number' || typeof raw.confidence !== 'number') {
    throw new TypeSafeCouncilError(`TypeSafe score "${id}" was missing`, 'parse');
  }
  const top = SCORE_CRITERIA[id].criteria.length - 1;
  const clamped = Math.min(top, Math.max(0, raw.score));
  const probabilities = isRecord(raw.probabilities)
    ? Object.fromEntries(Object.entries(raw.probabilities).map(([key, value]) => [key, Number(value)]))
    : {};
  return {
    score: raw.score,
    normalized: clamped / top,
    confidence: raw.confidence,
    probabilities,
  };
}

function readChoice(answers: Record<string, unknown>): ParsedJudgment['imageModel'] {
  const raw = answers.image_model;
  if (!isRecord(raw) || typeof raw.choice !== 'string' || typeof raw.confidence !== 'number') {
    throw new TypeSafeCouncilError('TypeSafe image_model choice was missing', 'parse');
  }
  const probabilities = isRecord(raw.probabilities)
    ? Object.fromEntries(Object.entries(raw.probabilities).map(([key, value]) => [key, Number(value)]))
    : {};
  const known = (IMAGE_MODEL_IDS as readonly string[]).includes(raw.choice);
  const accepted = known && raw.confidence >= COUNCIL_JUDGE_THRESHOLDS.minChoiceConfidence
    ? raw.choice as ImageModelId
    : null;
  return {
    choice: raw.choice,
    confidence: raw.confidence,
    probabilities,
    acceptedModelId: accepted,
  };
}

function readNoul(answers: Record<string, unknown>, id: NoulQuestionId): number {
  const raw = answers[id];
  if (!isRecord(raw) || typeof raw.noul !== 'number') {
    throw new TypeSafeCouncilError(`TypeSafe noul "${id}" was missing`, 'parse');
  }
  return raw.noul;
}

export function parseJudgment(payload: unknown): ParsedJudgment {
  if (!isRecord(payload) || !isRecord(payload.answers)) {
    throw new TypeSafeCouncilError('TypeSafe response had no answers', 'parse');
  }
  const answers = payload.answers;
  const scores = {} as Record<ScoreQuestionId, ScoreReading>;
  const normalized = {} as Record<ScoreQuestionId, number>;
  let combined = 0;
  let minScoreConfidence = 1;
  for (const id of Object.keys(SCORE_CRITERIA) as ScoreQuestionId[]) {
    const reading = readScore(answers, id);
    scores[id] = reading;
    normalized[id] = reading.normalized;
    combined += COUNCIL_SCORE_WEIGHTS[id] * reading.normalized;
    minScoreConfidence = Math.min(minScoreConfidence, reading.confidence);
  }
  const usage = isRecord(payload.usage) ? payload.usage : undefined;
  return {
    model: typeof payload.model === 'string' ? payload.model : 'unknown',
    scores,
    normalized,
    combined,
    minScoreConfidence,
    imageModel: readChoice(answers),
    nouls: {
      contains_text_not_requested: readNoul(answers, 'contains_text_not_requested'),
      names_real_person_or_brand: readNoul(answers, 'names_real_person_or_brand'),
    },
    inputTokens: typeof usage?.input_tokens === 'number' ? usage.input_tokens : undefined,
    outputTokens: typeof usage?.output_tokens === 'number' ? usage.output_tokens : undefined,
  };
}

export function draftPasses(judgment: ParsedJudgment): boolean {
  if (judgment.combined < COUNCIL_JUDGE_THRESHOLDS.minCombinedScore) return false;
  if (judgment.minScoreConfidence < COUNCIL_JUDGE_THRESHOLDS.minScoreConfidence) return false;
  if (judgment.nouls.contains_text_not_requested >= COUNCIL_JUDGE_THRESHOLDS.noulYes) return false;
  if (judgment.nouls.names_real_person_or_brand >= COUNCIL_JUDGE_THRESHOLDS.noulYes) return false;
  return true;
}

/** Repeated text/brand hazards fall back to the legacy council. Soft misses ask one question. */
export function decisionAfterRetry(judgment: ParsedJudgment): 'clarify' | 'fallback' {
  if (judgment.nouls.contains_text_not_requested >= COUNCIL_JUDGE_THRESHOLDS.noulYes) return 'fallback';
  if (judgment.nouls.names_real_person_or_brand >= COUNCIL_JUDGE_THRESHOLDS.noulYes) return 'fallback';
  return 'clarify';
}

export function clarifyingQuestionFor(judgment: ParsedJudgment): string {
  let weakest: ScoreQuestionId = 'follows_user_request';
  let lowest = Infinity;
  for (const id of Object.keys(judgment.normalized) as ScoreQuestionId[]) {
    const confidencePenalty = judgment.scores[id].confidence < COUNCIL_JUDGE_THRESHOLDS.minScoreConfidence ? 0.05 : 0;
    const rank = judgment.normalized[id] - confidencePenalty;
    if (rank < lowest) {
      lowest = rank;
      weakest = id;
    }
  }
  return CLARIFYING_QUESTIONS[weakest];
}

export function revisionNotesFrom(judgment: ParsedJudgment): string {
  const lines: string[] = [];
  for (const id of Object.keys(judgment.normalized) as ScoreQuestionId[]) {
    if (judgment.normalized[id] < COUNCIL_JUDGE_THRESHOLDS.minCombinedScore) {
      lines.push(`${id} scored ${judgment.normalized[id].toFixed(2)}: ${REPAIR_CLAUSES[id]}`);
    }
  }
  if (judgment.minScoreConfidence < COUNCIL_JUDGE_THRESHOLDS.minScoreConfidence) {
    lines.push('The draft was too ambiguous to score confidently. Be specific about placement, line, and subject.');
  }
  if (judgment.nouls.contains_text_not_requested >= COUNCIL_JUDGE_THRESHOLDS.noulYes) {
    lines.push('Remove instructions to render words, letters, numbers, or banners the user did not ask to be written.');
  }
  if (judgment.nouls.names_real_person_or_brand >= COUNCIL_JUDGE_THRESHOLDS.noulYes) {
    lines.push('Remove real people and commercial brands the user did not name.');
  }
  return lines.join('\n');
}

export function repairClause(judgment: ParsedJudgment): string {
  let weakest: ScoreQuestionId = 'follows_user_request';
  let lowest = Infinity;
  for (const id of Object.keys(judgment.normalized) as ScoreQuestionId[]) {
    if (judgment.normalized[id] < lowest) {
      lowest = judgment.normalized[id];
      weakest = id;
    }
  }
  const parts = [REPAIR_CLAUSES[weakest]];
  if (judgment.nouls.contains_text_not_requested >= COUNCIL_JUDGE_THRESHOLDS.noulYes) {
    parts.push('Do not instruct the image model to render words, letters, numbers, or banners.');
  }
  if (judgment.nouls.names_real_person_or_brand >= COUNCIL_JUDGE_THRESHOLDS.noulYes) {
    parts.push('Do not name a real person or a commercial brand.');
  }
  return parts.join(' ');
}

export class TypeSafeCouncilError extends Error {
  readonly reason: 'timeout' | 'http' | 'parse' | 'generator' | 'config';
  constructor(message: string, reason: TypeSafeCouncilError['reason']) {
    super(message);
    this.name = 'TypeSafeCouncilError';
    this.reason = reason;
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError');
}

export interface JudgeContext {
  requestId: string;
  userRequest: string;
  style: string;
  bodyPart: string;
  stencilMode?: boolean;
}

function draftState(context: JudgeContext, draft: DraftText) {
  return {
    userRequest: context.userRequest,
    style: context.style,
    bodyPart: context.bodyPart,
    stencilMode: Boolean(context.stencilMode),
    draft: {
      simple: draft.prompts.simple || '',
      detailed: draft.prompts.detailed || '',
      ultra: draft.prompts.ultra || '',
      negativePrompt: draft.negativePrompt || '',
    },
  };
}

export async function callTypeSafe(
  state: unknown,
  key: string,
  env: NodeJS.ProcessEnv = process.env
): Promise<SystemOneResponse> {
  const timeoutMs = envInt('TYPESAFE_TIMEOUT_MS', env) ?? 8000;
  const model = envString('TYPESAFE_MODEL', env) || 'jev-latest';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(TYPESAFE_SYSTEMONE_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        state,
        questions: buildQuestions(),
      }),
      signal: controller.signal,
    });
    if (!response.ok) {
      const body = await response.text();
      throw new TypeSafeCouncilError(
        `TypeSafe API error: ${response.status} ${redactSecret(body.slice(0, 300), key)}`,
        'http'
      );
    }
    return await response.json() as SystemOneResponse;
  } catch (error) {
    if (error instanceof TypeSafeCouncilError) throw error;
    if (isAbortError(error)) {
      throw new TypeSafeCouncilError(`TypeSafe judge timed out after ${timeoutMs}ms`, 'timeout');
    }
    const message = error instanceof Error ? error.message : String(error);
    throw new TypeSafeCouncilError(redactSecret(message, key), 'http');
  } finally {
    clearTimeout(timer);
  }
}

function auditPayload(input: {
  requestId: string;
  attempt: number;
  judgment: ParsedJudgment;
  decision: JudgeDecision;
  durationMs: number;
  generatorModel?: string;
}) {
  const { judgment } = input;
  return {
    requestId: input.requestId,
    attempt: input.attempt,
    judgeModel: judgment.model,
    generatorModel: input.generatorModel,
    durationMs: input.durationMs,
    combinedScore: Number(judgment.combined.toFixed(4)),
    minScoreConfidence: Number(judgment.minScoreConfidence.toFixed(4)),
    decision: input.decision,
    scores: judgment.scores,
    probabilities: Object.fromEntries(
      (Object.keys(judgment.scores) as ScoreQuestionId[]).map(id => [id, judgment.scores[id].probabilities])
    ),
    imageModel: judgment.imageModel,
    nouls: judgment.nouls,
    inputTokens: judgment.inputTokens,
    outputTokens: judgment.outputTokens,
    estimatedCostUsd: estimateJudgeCostUsd(judgment.inputTokens),
  };
}

async function judgeOnce(
  context: JudgeContext,
  draft: DraftText,
  key: string,
  attempt: number,
  generatorModel?: string
): Promise<{ judgment: ParsedJudgment; durationMs: number }> {
  const started = Date.now();
  const payload = await callTypeSafe(draftState(context, draft), key);
  const judgment = parseJudgment(payload);
  const durationMs = Date.now() - started;
  const decision: JudgeDecision = draftPasses(judgment)
    ? 'pass'
    : attempt === 1
      ? 'regenerate'
      : decisionAfterRetry(judgment);
  logEvent('council.typesafe.audit', auditPayload({
    requestId: context.requestId,
    attempt,
    judgment,
    decision,
    durationMs,
    generatorModel,
  }));
  return { judgment, durationMs };
}

export interface ModelSelectionSummary {
  modelId: string;
  modelName: string;
  reasoning: string;
  estimatedTime?: string;
  cost?: number;
  isFallback: boolean;
  source?: string;
  choiceConfidence?: number | null;
  choiceProbabilities?: Record<string, number> | null;
}

async function selectImageModel(
  context: JudgeContext,
  judgment: ParsedJudgment
): Promise<ModelSelectionSummary> {
  const accepted = judgment.imageModel.acceptedModelId;
  const selection = await selectModelWithFallback(
    context.style,
    context.userRequest,
    context.bodyPart,
    accepted
      ? {
          preferredModelId: accepted,
          reasoning: `TypeSafe judge selected ${accepted} (confidence ${judgment.imageModel.confidence.toFixed(2)})`,
          choiceConfidence: judgment.imageModel.confidence,
          choiceProbabilities: judgment.imageModel.probabilities,
        }
      : {}
  ) as ModelSelectionSummary;
  return {
    modelId: selection.modelId,
    modelName: selection.modelName,
    reasoning: selection.reasoning,
    estimatedTime: selection.estimatedTime,
    cost: selection.cost,
    isFallback: Boolean(selection.isFallback),
    source: selection.source,
    choiceConfidence: selection.choiceConfidence ?? judgment.imageModel.confidence,
    choiceProbabilities: selection.choiceProbabilities ?? judgment.imageModel.probabilities,
  };
}

export interface TypedCouncilArgs {
  requestId: string;
  userIdea: string;
  style: string;
  bodyPart: string;
  isStencilMode: boolean;
  onDiscussionUpdate?: ((update: unknown) => void) | null;
  generateDraft: (revisionNotes?: string) => Promise<GeneratedDraft>;
}

export interface TypedCouncilResult {
  prompts: { simple: string; detailed: string; ultra: string };
  negativePrompt: string;
  clarifyingQuestion?: string;
  modelSelection: ModelSelectionSummary;
  metadata: Record<string, unknown>;
}

function resultFrom(
  args: TypedCouncilArgs,
  draft: GeneratedDraft,
  judgment: ParsedJudgment,
  modelSelection: ModelSelectionSummary,
  started: number,
  llmCalls: number,
  typesafeCalls: number,
  clarifyingQuestion?: string
): TypedCouncilResult {
  const perJudge = estimateJudgeCostUsd(judgment.inputTokens);
  const estimatedCostUsd = COUNCIL_COST_MODEL.generatorEstimateUsd * llmCalls + perJudge * typesafeCalls;
  return {
    prompts: draft.prompts,
    negativePrompt: draft.negativePrompt,
    clarifyingQuestion,
    modelSelection,
    metadata: {
      userIdea: args.userIdea,
      style: args.style,
      bodyPart: args.bodyPart,
      generatedAt: new Date().toISOString(),
      enhancementTime: Date.now() - started,
      provider: 'typesafe-council',
      generator: draft.generator,
      model: draft.generatorModel,
      councilMembers: ['generator', 'typesafe-judge'],
      estimatedCostUsd: Number(estimatedCostUsd.toFixed(6)),
      judgeCostUsd: Number((perJudge * typesafeCalls).toFixed(6)),
      llmCalls,
      typesafeCalls,
      needsClarification: Boolean(clarifyingQuestion),
      judgment: {
        combinedScore: Number(judgment.combined.toFixed(4)),
        minScoreConfidence: Number(judgment.minScoreConfidence.toFixed(4)),
        scores: judgment.scores,
        nouls: judgment.nouls,
        imageModel: judgment.imageModel,
        judgeModel: judgment.model,
      },
    },
  };
}

/**
 * Draft once, judge once. On a low score or low confidence, draft one more
 * time and judge again. A second soft miss returns the better draft plus
 * one clarifying question. A second text/brand hazard, or any TypeSafe
 * error, returns null so the caller can run the legacy council.
 */
export async function tryTypedCouncil(args: TypedCouncilArgs): Promise<TypedCouncilResult | null> {
  const key = typesafeApiKey();
  if (!key) {
    logEvent('council.typesafe.audit', {
      requestId: args.requestId,
      decision: 'fallback',
      reason: 'missing_key',
    }, 'warn');
    return null;
  }

  const started = Date.now();
  const context: JudgeContext = {
    requestId: args.requestId,
    userRequest: args.userIdea,
    style: args.style,
    bodyPart: args.bodyPart,
    stencilMode: args.isStencilMode,
  };

  try {
    args.onDiscussionUpdate?.('Drafting one prompt for placement, line, and style...');
    const firstDraft = await args.generateDraft();
    args.onDiscussionUpdate?.('Judging placement, line weight, longevity, style, and the request...');
    const first = await judgeOnce(context, firstDraft, key, 1, firstDraft.generatorModel);
    if (draftPasses(first.judgment)) {
      const modelSelection = await selectImageModel(context, first.judgment);
      const result = resultFrom(args, firstDraft, first.judgment, modelSelection, started, 1, 1);
      logEvent('council.result', {
        requestId: args.requestId,
        provider: 'typesafe-council',
        durationMs: result.metadata.enhancementTime,
        estimatedCostUsd: result.metadata.estimatedCostUsd,
        llmCalls: 1,
        typesafeCalls: 1,
        decision: 'pass',
      });
      return result;
    }

    args.onDiscussionUpdate?.('Regenerating the draft once...');
    const secondDraft = await args.generateDraft(revisionNotesFrom(first.judgment));
    const second = await judgeOnce(context, secondDraft, key, 2, secondDraft.generatorModel);
    const winner = second.judgment.combined >= first.judgment.combined
      ? { draft: secondDraft, judgment: second.judgment }
      : { draft: firstDraft, judgment: first.judgment };

    if (draftPasses(second.judgment)) {
      const modelSelection = await selectImageModel(context, second.judgment);
      const result = resultFrom(args, secondDraft, second.judgment, modelSelection, started, 2, 2);
      logEvent('council.result', {
        requestId: args.requestId,
        provider: 'typesafe-council',
        durationMs: result.metadata.enhancementTime,
        estimatedCostUsd: result.metadata.estimatedCostUsd,
        llmCalls: 2,
        typesafeCalls: 2,
        decision: 'pass',
      });
      return result;
    }

    if (decisionAfterRetry(second.judgment) === 'fallback') {
      logEvent('council.typesafe.audit', {
        requestId: args.requestId,
        decision: 'fallback',
        reason: 'guardrail_after_retry',
        combinedScore: Number(second.judgment.combined.toFixed(4)),
        nouls: second.judgment.nouls,
      }, 'warn');
      return null;
    }

    const question = clarifyingQuestionFor(winner.judgment);
    args.onDiscussionUpdate?.(question);
    const modelSelection = await selectImageModel(context, winner.judgment);
    const result = resultFrom(args, winner.draft, winner.judgment, modelSelection, started, 2, 2, question);
    logEvent('council.result', {
      requestId: args.requestId,
      provider: 'typesafe-council',
      durationMs: result.metadata.enhancementTime,
      estimatedCostUsd: result.metadata.estimatedCostUsd,
      llmCalls: 2,
      typesafeCalls: 2,
      decision: 'clarify',
    });
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logEvent('council.typesafe.audit', {
      requestId: args.requestId,
      decision: 'fallback',
      reason: error instanceof TypeSafeCouncilError ? error.reason : 'error',
      message: redactSecret(message, key),
    }, 'warn');
    return null;
  }
}

export interface JudgedVariation<T extends DraftText> {
  draft: T;
  clarifyingQuestion?: string;
  modelSelection?: ModelSelectionSummary;
  fellBack: boolean;
}

function appendClause(text: string | undefined, clause: string): string | undefined {
  if (!text) return text;
  if (text.includes(clause)) return text;
  const next = `${text} ${clause}`;
  return fitsPromptBudget(next) ? next : text;
}

/**
 * One TypeSafe call per structured draft. A soft miss appends one repair
 * clause and judges again. Judge errors leave the template text alone.
 */
export async function judgeStructuredVariations<T extends DraftText>(
  drafts: T[],
  context: JudgeContext
): Promise<Array<JudgedVariation<T>>> {
  const key = typesafeApiKey();
  if (!key) {
    logEvent('council.typesafe.audit', {
      requestId: context.requestId,
      decision: 'fallback',
      reason: 'missing_key',
      surface: 'structured',
    }, 'warn');
    return drafts.map(draft => ({ draft, fellBack: true }));
  }

  return Promise.all(drafts.map(async (original) => {
    try {
      const first = await judgeOnce(context, original, key, 1);
      if (draftPasses(first.judgment)) {
        return {
          draft: original,
          modelSelection: await selectImageModel(context, first.judgment),
          fellBack: false,
        };
      }
      const clause = repairClause(first.judgment);
      const repaired = {
        ...original,
        prompts: {
          ...original.prompts,
          detailed: appendClause(original.prompts.detailed, clause),
          ultra: appendClause(original.prompts.ultra, clause),
        },
      };
      const second = await judgeOnce(context, repaired, key, 2);
      if (draftPasses(second.judgment)) {
        return {
          draft: repaired,
          modelSelection: await selectImageModel(context, second.judgment),
          fellBack: false,
        };
      }
      if (decisionAfterRetry(second.judgment) === 'fallback') {
        return { draft: original, fellBack: true };
      }
      const winner = second.judgment.combined >= first.judgment.combined ? repaired : original;
      const winnerJudgment = winner === repaired ? second.judgment : first.judgment;
      return {
        draft: winner,
        clarifyingQuestion: clarifyingQuestionFor(winnerJudgment),
        modelSelection: await selectImageModel(context, winnerJudgment),
        fellBack: false,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logEvent('council.typesafe.audit', {
        requestId: context.requestId,
        decision: 'fallback',
        reason: error instanceof TypeSafeCouncilError ? error.reason : 'error',
        message: redactSecret(message, key),
        surface: 'structured',
      }, 'warn');
      return { draft: original, fellBack: true };
    }
  }));
}
