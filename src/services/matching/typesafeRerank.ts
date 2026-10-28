/**
 * Rerank a search shortlist by fit to the client's brief.
 *
 * Candidate generation stays where it is (embeddings, Neo4j, Supabase
 * pgvector, or the design-library keyword filter). This module scores the
 * leading candidates with one TypeSafe System One request each: three Score
 * questions (style, placement, subject) over state `{ brief, candidate }`.
 * Weights in `rerankOrder.js` turn those scores into one number.
 *
 * `TYPESAFE_RERANK` defaults off. Off, a missing key, a spent or too-small
 * budget, a timeout, an HTTP error, or a body we cannot read all return the
 * original order. The API key is never logged.
 */

import { envBool, envInt, envString } from '@/config/envSchema';
import { typesafeModel as pinnedTypesafeModel } from '@/services/typesafe';
import { checkBudget, recordSpend } from '@/lib/budget-tracker';
import { logger } from '@/lib/logger';
import {
  DEFAULT_RERANK_TOP_N,
  MAX_RERANK_TOP_N,
  fitFromRawScores,
  rerankTopN,
  scoreQuestions,
} from './rerankOrder.js';

export const TYPESAFE_SYSTEMONE_URL = 'https://api.typesafe.ai/v1/systemone';

const DEFAULT_TYPESAFE_TIMEOUT_MS = 8_000;

/**
 * Flat cents recorded against the global spend cap after a 2xx. Jev's list
 * price is about $0.042 per million input tokens, so one candidate is a
 * fraction of a cent. One cent is the same deliberate over-estimate the
 * lettering Noul and design-routing calls use. Timeouts and transport
 * errors are not metered. A 2xx whose body cannot be parsed is metered,
 * then the original order is kept.
 */
export const RERANK_COST_CENTS = 1;

const AXES = ['style', 'placement', 'subject'] as const;

export interface BriefFit {
  style: number;
  placement: number;
  subject: number;
  composite: number;
}

interface ArtistLike {
  name?: unknown;
  styles?: unknown;
  tags?: unknown;
  city?: unknown;
  location?: unknown;
  bio?: unknown;
  description?: unknown;
  bodyPart?: unknown;
  bodyParts?: unknown;
  [key: string]: unknown;
}

type FetchImpl = typeof fetch;

type ScoreOutcome =
  | { ok: true; fit: NonNullable<ReturnType<typeof fitFromRawScores>> }
  | { ok: false; fallback: 'http' | 'parse' | 'timeout' | 'error'; status?: number; error?: string };

export function isTypesafeRerankEnabled(): boolean {
  try {
    return envBool('TYPESAFE_RERANK');
  } catch {
    return false;
  }
}

/** Included in the semantic-match cache key so a flag or top-N change does not reuse the other order. */
export function rerankCacheKeyParts(): { enabled: boolean; topN: number } {
  return { enabled: isTypesafeRerankEnabled(), topN: resolveRerankTopN() };
}

export function resolveRerankTopN(): number {
  try {
    const value = envInt('TYPESAFE_RERANK_TOP_N');
    if (
      value === undefined
      || !Number.isInteger(value)
      || value < 1
      || value > MAX_RERANK_TOP_N
    ) {
      return DEFAULT_RERANK_TOP_N;
    }
    return value;
  } catch {
    return DEFAULT_RERANK_TOP_N;
  }
}

export function buildSemanticBrief(
  query: string,
  preferences: { styles?: string[]; location?: string | null; budget?: number | null } = {},
): Record<string, unknown> {
  return {
    text: typeof query === 'string' ? query : '',
    styles: Array.isArray(preferences.styles)
      ? preferences.styles.filter((style) => typeof style === 'string')
      : [],
    location: preferences.location ?? null,
    budget: typeof preferences.budget === 'number' && Number.isFinite(preferences.budget)
      ? preferences.budget
      : null,
  };
}

export function buildPulseBrief(context: {
  prompt?: unknown;
  style?: unknown;
  bodyPart?: unknown;
  location?: unknown;
  budget?: unknown;
  [key: string]: unknown;
} | null | undefined): Record<string, unknown> {
  const source = context ?? {};
  return {
    text: typeof source.prompt === 'string' ? source.prompt : '',
    style: typeof source.style === 'string' ? source.style : null,
    placement: typeof source.bodyPart === 'string' ? source.bodyPart : null,
    location: typeof source.location === 'string' ? source.location : null,
    budget: typeof source.budget === 'number' && Number.isFinite(source.budget) ? source.budget : null,
  };
}

/** Descriptive fields only. Portfolio URLs, rates, and claim ids stay out of the request. */
export function artistCandidateProfile(artist: ArtistLike): Record<string, unknown> {
  const placementList = stringList(artist.bodyParts);
  return compact({
    name: clip(artist.name, 120),
    styles: stringList(artist.styles),
    tags: stringList(artist.tags),
    city: clip(artist.city, 80) || clip(artist.location, 80),
    placement: clip(artist.bodyPart, 120) || (placementList.length > 0 ? placementList : undefined),
    bio: clip(artist.bio, 400) || clip(artist.description, 400),
  });
}

export type Ranked<T> = T & { briefFit?: BriefFit };

export async function rerankArtistCandidates<T extends { id: string | number }>(
  brief: Record<string, unknown>,
  candidates: T[],
): Promise<Array<Ranked<T>>> {
  return rerankByBrief({ brief, candidates, profile: (item) => artistCandidateProfile(item as ArtistLike) });
}

export async function rerankByBrief<T extends { id: string | number }>(options: {
  brief: Record<string, unknown>;
  candidates: T[];
  profile: (item: T) => Record<string, unknown>;
  fetchImpl?: FetchImpl;
}): Promise<Array<Ranked<T>>> {
  const candidates = options.candidates;
  if (!Array.isArray(candidates) || candidates.length === 0) return candidates as Array<Ranked<T>>;
  if (!isTypesafeRerankEnabled()) return candidates as Array<Ranked<T>>;

  const key = typesafeApiKey();
  if (!key) {
    logRerank({ fallback: 'missing_key', candidates: candidates.length }, 'warn');
    return candidates as Array<Ranked<T>>;
  }

  const topN = resolveRerankTopN();
  const headCount = Math.min(topN, candidates.length);

  try {
    const budget = await checkBudget();
    if (!budget.allowed || (budget.remainingCents >= 0 && budget.remainingCents < headCount)) {
      logRerank({
        fallback: 'budget',
        candidates: headCount,
        remainingCents: budget.remainingCents,
      }, 'warn');
      return candidates as Array<Ranked<T>>;
    }
  } catch (error) {
    logRerank({
      fallback: 'budget',
      candidates: headCount,
      error: redact(errorText(error), key),
    }, 'warn');
    return candidates as Array<Ranked<T>>;
  }

  const started = Date.now();
  const doFetch = options.fetchImpl ?? fetch;
  let outcomes: ScoreOutcome[];
  try {
    outcomes = await Promise.all(candidates.slice(0, headCount).map((item) => (
      scoreCandidate(doFetch, key, options.brief, safeProfile(options.profile, item))
    )));
  } catch (error) {
    logRerank({
      fallback: 'error',
      candidates: headCount,
      error: redact(errorText(error), key),
      durationMs: Date.now() - started,
    }, 'warn');
    return candidates as Array<Ranked<T>>;
  }

  const failed = outcomes.find((outcome) => !outcome.ok);
  if (failed && !failed.ok) {
    logRerank({
      fallback: failed.fallback,
      status: failed.status,
      error: failed.error,
      candidates: headCount,
      durationMs: Date.now() - started,
    }, 'warn');
    return candidates as Array<Ranked<T>>;
  }

  const fits = outcomes.map((outcome) => (outcome.ok ? outcome.fit : undefined));
  const { items, applied } = rerankTopN(candidates, fits, topN);
  if (!applied) {
    logRerank({ fallback: 'parse', candidates: headCount, durationMs: Date.now() - started }, 'warn');
    return candidates as Array<Ranked<T>>;
  }

  logRerank({ candidates: headCount, applied: true, durationMs: Date.now() - started });
  return items as Array<Ranked<T>>;
}

async function scoreCandidate(
  doFetch: FetchImpl,
  key: string,
  brief: Record<string, unknown>,
  candidate: Record<string, unknown>,
): Promise<ScoreOutcome> {
  try {
    const response = await doFetch(TYPESAFE_SYSTEMONE_URL, {
      method: 'POST',
      signal: AbortSignal.timeout(typesafeTimeoutMs()),
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: typesafeModel(),
        state: { brief, candidate },
        questions: scoreQuestions(),
      }),
    });

    if (!response.ok) {
      // Drain so a key echoed by an error page cannot sit in a buffer we later log.
      await response.text().catch(() => undefined);
      return { ok: false, fallback: 'http', status: response.status };
    }

    await recordRerankSpend(key);

    let payload: unknown;
    try {
      payload = await response.json();
    } catch (error) {
      logRerank({ fallback: 'parse', error: redact(errorText(error), key) }, 'warn');
      return { ok: false, fallback: 'parse' };
    }

    const raw = readRawScores(payload);
    const fit = raw ? fitFromRawScores(raw) : undefined;
    if (!fit) return { ok: false, fallback: 'parse' };
    return { ok: true, fit };
  } catch (error) {
    return {
      ok: false,
      fallback: isTimeoutError(error) ? 'timeout' : 'error',
      error: redact(errorText(error), key),
    };
  }
}

function safeProfile<T>(
  profile: (item: T) => Record<string, unknown>,
  item: T,
): Record<string, unknown> {
  try {
    const value = profile(item);
    return value && typeof value === 'object' ? value : {};
  } catch {
    return {};
  }
}

/** Below this, or outside (0, 1], a Score is too uncertain to reorder. */
export const RERANK_MIN_CONFIDENCE = 0.35;

function scoreConfidence(answer: Record<string, unknown>): number | undefined {
  if (typeof answer.confidence !== 'number' || !Number.isFinite(answer.confidence)) return undefined;
  if (answer.confidence <= 0 || answer.confidence > 1) return undefined;
  return answer.confidence;
}

function readRawScores(payload: unknown): { style: number; placement: number; subject: number } | undefined {
  if (!isRecord(payload) || !isRecord(payload.answers)) return undefined;
  const scores = {} as { style: number; placement: number; subject: number };
  for (const axis of AXES) {
    const answer = payload.answers[axis];
    if (!isRecord(answer) || answer.type !== 'score') return undefined;
    if (typeof answer.score !== 'number' || !Number.isFinite(answer.score)) return undefined;
    const confidence = scoreConfidence(answer);
    if (confidence === undefined || confidence < RERANK_MIN_CONFIDENCE) return undefined;
    scores[axis] = answer.score;
  }
  return scores;
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
    return pinnedTypesafeModel();
  } catch {
    return 'jev-1.14.0';
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

async function recordRerankSpend(key: string): Promise<void> {
  try {
    await recordSpend(RERANK_COST_CENTS);
  } catch (error) {
    logRerank({
      fallback: 'spend_unrecorded',
      error: redact(errorText(error), key),
    }, 'warn');
  }
}

function logRerank(fields: Record<string, unknown>, level: 'info' | 'warn' = 'info'): void {
  const payload: Record<string, unknown> = { event_type: 'matching.typesafe_rerank' };
  for (const [field, value] of Object.entries(fields)) {
    if (value !== undefined) payload[field] = value;
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

function redact(message: string, key: string): string {
  if (!key || !message.includes(key)) return message;
  return message.split(key).join('[redacted]');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function clip(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed.length > max ? trimmed.slice(0, max) : trimmed;
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    .map((item) => item.trim())
    .slice(0, 12);
}

function compact(record: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (value === undefined || value === null) continue;
    if (typeof value === 'string' && value.length === 0) continue;
    if (Array.isArray(value) && value.length === 0) continue;
    out[key] = value;
  }
  return out;
}
