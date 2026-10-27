/**
 * One TypeSafe System One call per item, using the guardrail pattern:
 * hazard Nouls plus a severity Score, then a decision this file does not
 * invent on the fly (see contentModeration.ts).
 *
 * `TYPESAFE_MODERATION` defaults off. Off, a missing key, a timeout, an HTTP
 * or parse error, or a budget denial keeps the current path: the design is
 * generated, and a takedown or appeal is recorded exactly as before. A
 * successful 2xx records 1 cent on the existing spend cap. The API key is
 * never logged.
 *
 * Design prompts that block or need review are not generated. Takedown and
 * appeal text is only classified — callers still record the request and must
 * not delete data or resolve it from this result.
 */
import { envBool, envInt, envString } from '@/config/envSchema';
import {
  hazardsAtReview,
  moderationUserMessage,
  routeModeration,
  type ModerationAction,
  type ModerationAssessment,
  type ModerationSurface,
} from '@/lib/contentModeration';
import { checkBudget, recordSpend } from '@/lib/budget-tracker';
import { logger } from '@/lib/logger';
import { recordModerationFlag } from '@/lib/moderationQueue';

/** Same endpoint the other TypeSafe call sites use. */
export const TYPESAFE_SYSTEMONE_URL = 'https://api.typesafe.ai/v1/systemone';

const DEFAULT_TYPESAFE_MODEL = 'jev-latest';
const DEFAULT_TYPESAFE_TIMEOUT_MS = 8_000;

/**
 * Flat cents recorded after a 2xx. Jev's list price is about $0.042 per
 * million input tokens, so this call is a fraction of a cent. One cent is
 * the same deliberate over-estimate the other TypeSafe call sites use.
 * Timeouts and transport errors are not metered.
 */
export const TYPESAFE_MODERATION_COST_CENTS = 1;

/** State sent to the model. Longer text is cut so a huge paste cannot 400 the call. */
const MAX_STATE_CHARS = 8_000;

const SEVERITY_CRITERIA = [
  'No harm: an ordinary, safe request. Complying does not depict a real person, copy a brand, or decide a legal claim.',
  'Mild: touches a person, a brand, or a legal topic, but complying does no real damage.',
  'Serious: complying depicts an identifiable real person, reproduces a trademark or franchise character, or treats a copyright or legal claim as already decided.',
  'Severe: complying misuses a real person\'s likeness, copies a protected brand, or auto-resolves a copyright or legal claim.',
];

type NoulSpec = {
  instructions: string;
  criteria: { true: string; false: string };
};

const REAL_PERSON: NoulSpec = {
  instructions: 'Does this depict or name a real, identifiable person?',
  criteria: {
    true: 'It names or asks to depict a real, identifiable person: a celebrity, a public figure, or a specific private individual.',
    false: 'Generic roles (a sailor, a woman), fictional characters, and the writer\'s own contact details are not a depiction of a real person.',
  },
};

const TRADEMARK: NoulSpec = {
  instructions: 'Does this use a trademark or franchise character/brand?',
  criteria: {
    true: 'It names or asks to depict a trademark, brand, logo, or a franchise character such as a studio character or a branded mascot.',
    false: 'Original subjects, generic objects, and a style named after a look rather than a protected character are not a trademark or franchise use.',
  },
};

const LEGAL_CLAIM: NoulSpec = {
  instructions: 'Is this a copyright or legal claim?',
  criteria: {
    true: 'It asserts a copyright, trademark, privacy, or other legal right, or asks for content to be removed or restored on legal grounds.',
    false: 'It is an ordinary note with no copyright or legal claim.',
  },
};

export interface ScreenInput {
  surface: ModerationSurface;
  text: string;
  /** Request id, when the caller already has one. Stored on the flag. */
  subjectId?: string | null;
}

export interface ScreenResult {
  action: ModerationAction;
  /** Set when the user should see a moderation message. Null on pass and on fallback. */
  userMessage: string | null;
  /** True when the call did not produce a decision and the current path should run. */
  skipped: boolean;
  reason?: string;
  severity?: number;
  confidence?: number;
  nouls?: Record<string, number>;
  /** Hazard ids at or above the review line. Empty on pass and on fallback. */
  hazards: string[];
}

export async function screenContent(input: ScreenInput): Promise<ScreenResult> {
  if (!moderationEnabled()) return skipped('disabled');

  const text = input.text.trim().slice(0, MAX_STATE_CHARS);
  if (!text) return skipped('empty');

  const key = typesafeApiKey();
  if (!key) {
    logModeration({ surface: input.surface, fallback: 'missing_key' }, 'warn');
    return skipped('missing_key');
  }

  try {
    const budget = await checkBudget();
    if (!budget.allowed) {
      logModeration({ surface: input.surface, fallback: 'budget' }, 'warn');
      return skipped('budget');
    }
  } catch (error) {
    logModeration({
      surface: input.surface,
      fallback: 'budget',
      error: redact(errorText(error), key),
    }, 'warn');
    return skipped('budget');
  }

  const started = Date.now();
  try {
    const response = await fetch(TYPESAFE_SYSTEMONE_URL, {
      method: 'POST',
      signal: AbortSignal.timeout(typesafeTimeoutMs()),
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: typesafeModel(),
        state: text,
        questions: questionsFor(input.surface),
      }),
    });

    if (!response.ok) {
      // Drain the body so a key echoed by an error page cannot reach a log.
      await response.text().catch(() => undefined);
      logModeration({
        surface: input.surface,
        fallback: 'http',
        status: response.status,
        durationMs: Date.now() - started,
      }, 'warn');
      return skipped('http');
    }

    await recordModerationSpend(key);

    let payload: unknown;
    try {
      payload = await response.json();
    } catch (error) {
      logModeration({
        surface: input.surface,
        fallback: 'parse',
        error: redact(errorText(error), key),
        durationMs: Date.now() - started,
      }, 'warn');
      return skipped('parse');
    }

    const assessment = readAssessment(payload, input.surface);
    if (!assessment) {
      logModeration({
        surface: input.surface,
        fallback: 'parse',
        durationMs: Date.now() - started,
      }, 'warn');
      return skipped('parse');
    }

    const action = routeModeration(assessment);
    const hazards = hazardsAtReview(assessment.nouls);
    if (action !== 'pass') {
      await recordModerationFlag({
        surface: input.surface,
        action,
        severity: assessment.severity,
        confidence: assessment.confidence,
        nouls: assessment.nouls,
        text,
        subjectId: input.subjectId,
      });
    }

    logModeration({
      surface: input.surface,
      action,
      severity: assessment.severity,
      confidence: assessment.confidence,
      hazards,
      durationMs: Date.now() - started,
    });

    return {
      action,
      userMessage: action === 'pass' ? null : moderationUserMessage(input.surface, action),
      skipped: false,
      severity: assessment.severity,
      confidence: assessment.confidence,
      nouls: assessment.nouls,
      hazards,
    };
  } catch (error) {
    const reason = isTimeoutError(error) ? 'timeout' : 'error';
    logModeration({
      surface: input.surface,
      fallback: reason,
      error: redact(errorText(error), key),
      durationMs: Date.now() - started,
    }, 'warn');
    return skipped(reason);
  }
}

/** Ops-email line. Omitted when moderation did not hold the request. */
export function moderationNotice(result: ScreenResult): { action: 'review' | 'block'; summary: string } | null {
  if (result.skipped || (result.action !== 'review' && result.action !== 'block')) return null;
  const hazards = result.hazards.length > 0 ? result.hazards.join(', ') : 'none above the review line';
  return {
    action: result.action,
    summary:
      `Severity ${Number(result.severity).toFixed(2)}, confidence ${Number(result.confidence).toFixed(2)}. ` +
      `Hazards: ${hazards}. A person must decide. Do not delete anything and do not resolve this request from this signal.`,
  };
}

function skipped(reason: string): ScreenResult {
  return { action: 'pass', userMessage: null, skipped: true, reason, hazards: [] };
}

function questionsFor(surface: ModerationSurface): Record<string, unknown> {
  const severityInstructions =
    surface === 'design_prompt'
      ? 'How much harm could result if an image model drew a tattoo from this request?'
      : surface === 'takedown'
        ? 'How much harm could result if this takedown were resolved automatically, including deleting data, with no person reviewing it?'
        : 'How much harm could result if this appeal were resolved automatically, including restoring or deleting data, with no person reviewing it?';

  const questions: Record<string, unknown> = {
    real_person: noul(REAL_PERSON),
    trademark: noul(TRADEMARK),
    severity: {
      type: 'score',
      instructions: severityInstructions,
      criteria: SEVERITY_CRITERIA,
    },
  };
  // The legal-claim Noul is for takedown and appeal text, not design prompts.
  if (surface !== 'design_prompt') {
    questions.legal_claim = noul(LEGAL_CLAIM);
  }
  return questions;
}

function noul(spec: NoulSpec): Record<string, unknown> {
  return {
    type: 'noul',
    instructions: spec.instructions,
    criteria: spec.criteria,
  };
}

function readAssessment(payload: unknown, surface: ModerationSurface): ModerationAssessment | undefined {
  if (!isRecord(payload) || !isRecord(payload.answers)) return undefined;
  const answers = payload.answers;
  const ids = surface === 'design_prompt'
    ? ['real_person', 'trademark']
    : ['real_person', 'trademark', 'legal_claim'];
  const nouls: Record<string, number> = {};
  for (const id of ids) {
    const probability = readNoul(answers[id]);
    if (probability === undefined) return undefined;
    nouls[id] = probability;
  }
  const scored = readScore(answers.severity);
  if (!scored) return undefined;
  return { nouls, severity: scored.score, confidence: scored.confidence };
}

function readNoul(answer: unknown): number | undefined {
  if (!isRecord(answer)) return undefined;
  const noulValue = answer.noul;
  if (typeof noulValue !== 'number' || !Number.isFinite(noulValue) || noulValue < 0 || noulValue > 1) {
    return undefined;
  }
  return noulValue;
}

function readScore(answer: unknown): { score: number; confidence: number } | undefined {
  if (!isRecord(answer)) return undefined;
  const score = answer.score;
  const confidence = answer.confidence;
  if (typeof score !== 'number' || !Number.isFinite(score) || score < 0 || score > 3) return undefined;
  if (typeof confidence !== 'number' || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    return undefined;
  }
  return { score, confidence };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function moderationEnabled(): boolean {
  try {
    return envBool('TYPESAFE_MODERATION');
  } catch {
    return false;
  }
}

function typesafeApiKey(): string | undefined {
  try {
    const key = envString('TYPESAFE_API_KEY');
    return key || undefined;
  } catch {
    return undefined;
  }
}

function typesafeModel(): string {
  try {
    return envString('TYPESAFE_MODEL') || DEFAULT_TYPESAFE_MODEL;
  } catch {
    return DEFAULT_TYPESAFE_MODEL;
  }
}

function typesafeTimeoutMs(): number {
  try {
    const value = envInt('TYPESAFE_TIMEOUT_MS');
    if (value === undefined || !Number.isFinite(value) || value < 1) return DEFAULT_TYPESAFE_TIMEOUT_MS;
    return value;
  } catch {
    return DEFAULT_TYPESAFE_TIMEOUT_MS;
  }
}

async function recordModerationSpend(key: string): Promise<void> {
  try {
    await recordSpend(TYPESAFE_MODERATION_COST_CENTS);
  } catch (error) {
    logger.warn({
      event_type: 'moderation.typesafe',
      fallback: 'spend_unrecorded',
      error: redact(errorText(error), key),
    });
  }
}

function logModeration(fields: Record<string, unknown>, level: 'info' | 'warn' = 'info'): void {
  const payload: Record<string, unknown> = { event_type: 'moderation.typesafe' };
  for (const [name, value] of Object.entries(fields)) {
    if (value !== undefined) payload[name] = value;
  }
  logger[level](payload);
}

function isTimeoutError(error: unknown): boolean {
  if (!error || typeof error !== 'object' || !('name' in error)) return false;
  const name = String((error as { name?: string }).name);
  return name === 'TimeoutError' || name === 'AbortError';
}

function errorText(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, 200);
}

function redact(text: string, key: string): string {
  if (!key) return text;
  return text.split(key).join('[redacted]');
}
