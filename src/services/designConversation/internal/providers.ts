/**
 * Provider chain for the conversation LLM (ADR-0019).
 *
 * Primary: Vertex Gemini (model env-configurable via CONVERSATION_MODEL,
 * defaulting to a Flash-Lite tier). Fallback: GLM-5.2 via OpenRouter. The
 * house Vertex call pattern (endpoint shape, getGcpAccessToken, JSON
 * response mime type) mirrors the council/intake internals.
 *
 * Per-session model pinning is the CALLER's job: the caller stores the
 * model that served turn 1 (from TurnLog.model) and passes it back as
 * pinnedModel; this chain only promises to try the pinned provider first.
 * When every provider is exhausted it throws ConversationUnavailableError —
 * the caller downgrades to the v1 scripted intake flow (ADR-0019).
 */

import { logger } from '@/lib/logger';
import { getGcpAccessToken } from '@/lib/google-auth-edge';
import { buildVertexEndpoint } from '@/lib/vertex-endpoint';
import { refineIntakeFields } from '@/services/intake';
import type { ConversationMessage } from '../types';

/**
 * Structured-logging event names for the ADR-0019 degradation path.
 *
 * `PROVIDER_FAILOVER_EVENT` fires when one provider fails but another remains
 * in the chain (the turn still gets served conversationally);
 * `CONVERSATION_DEGRADED_EVENT` fires when the chain is exhausted and the
 * caller is about to downgrade the session to the v1 scripted two-question
 * intake. Neither ever carries prompt text, transcript content, or
 * credentials — provider/model/error-class/status/session/turn only.
 */
export const PROVIDER_FAILOVER_EVENT = 'design_conversation.provider.failover';
export const CONVERSATION_DEGRADED_EVENT = 'design_conversation.degraded';

/**
 * SketchBot's listener (TAT-56).
 *
 * Gemini 3.1 Flash Lite replaced the 2.5 Flash Lite that shipped with
 * ADR-0019. It is one generation newer for ~2¢ per session against ~0.7¢,
 * which is noise next to the images the same session buys — and unlike the
 * cheaper tier it reads reference images natively, so a session that opens
 * with a screenshot no longer needs a second model to understand it.
 *
 * Served only from the Vertex `global` location; buildVertexEndpoint routes it.
 */
export const DEFAULT_VERTEX_MODEL = 'gemini-3.1-flash-lite';
export const OPENROUTER_FALLBACK_MODEL = 'z-ai/glm-5.2';

const OPENROUTER_API_URL = 'https://openrouter.ai/api/v1/chat/completions';

/** The model's double-duty payload, unvalidated (the engine sanitizes it). */
export interface RawTurnPayload {
  reply?: unknown;
  record?: {
    placement?: unknown;
    styleTags?: unknown;
    meaning?: unknown;
    /**
     * The model's own subject extraction. The persona has always asked for
     * it; dropping it here silently discarded five named characters in a
     * real session, leaving only the deterministic backfill's matches.
     */
    subject?: unknown;
    /** Lossless named roster; visual subject prose must never replace it. */
    characters?: unknown;
    /** Verified candidate name-to-source bindings; the engine grounds both. */
    characterIdentities?: unknown;
    references?: unknown;
    ambiguousAxes?: unknown;
  };
}

export interface ProviderTurn {
  payload: RawTurnPayload;
  /** The model that actually served the turn — goes into TurnLog.model. */
  model: string;
}

/**
 * Thrown when EVERY conversation provider is exhausted. The caller catches
 * this and downgrades to the v1 scripted two-question intake (ADR-0019) —
 * never silently substitutes mock conversation.
 */
export class ConversationUnavailableError extends Error {
  attempts: { provider: string; model: string; reason: string }[];

  constructor(
    message: string,
    attempts: { provider: string; model: string; reason: string }[] = []
  ) {
    super(message);
    this.name = 'ConversationUnavailableError';
    this.attempts = attempts;
  }
}

/**
 * A non-2xx provider response. Carries the HTTP status as a field so the
 * degradation logs can report it without parsing (or logging) the response
 * body, which can echo prompt text.
 */
export class ProviderHttpError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'ProviderHttpError';
    this.status = status;
  }
}

/** Why an attempt did not produce a turn — a bounded, content-free class. */
type FailureClass = 'not_configured' | 'unparseable_response' | 'provider_error';

interface AttemptRecord {
  provider: string;
  model: string;
  /** Human-readable reason (may embed a provider message) — never logged. */
  reason: string;
  /** Log-safe classification of the failure. */
  failure: FailureClass;
  /** Constructor name of the thrown error, when one was thrown. */
  errorClass: string | null;
  /** HTTP status, when the failure was a non-2xx provider response. */
  status: number | null;
}

function errorClassOf(error: unknown): string {
  if (error instanceof Error) return error.constructor?.name || error.name || 'Error';
  return typeof error;
}

function statusOf(error: unknown): number | null {
  return error instanceof ProviderHttpError ? error.status : null;
}

/* ──────────────────────────────────────────────────────────────────────────
 * Provider configuration (read lazily so tests can toggle env per case)
 * ────────────────────────────────────────────────────────────────────────── */

function vertexProjectId(): string | null {
  return (
    process.env.NEXT_PUBLIC_VERTEX_AI_PROJECT_ID ||
    process.env.GCP_PROJECT_ID ||
    process.env.VERTEX_PROJECT_ID ||
    null
  );
}

function isVertexConfigured(): boolean {
  const credJson =
    process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON || process.env.GCP_SERVICE_ACCOUNT_KEY;
  const credPair = process.env.GCP_SERVICE_ACCOUNT_EMAIL && process.env.GCP_PRIVATE_KEY;
  return Boolean(vertexProjectId() && (credJson || credPair));
}

function isOpenRouterConfigured(): boolean {
  return Boolean(process.env.OPENROUTER_API_KEY);
}

function vertexModel(): string {
  return process.env.CONVERSATION_MODEL || DEFAULT_VERTEX_MODEL;
}

/* ──────────────────────────────────────────────────────────────────────────
 * Response parsing
 * ────────────────────────────────────────────────────────────────────────── */

function parseJsonFromText(text: string): RawTurnPayload | null {
  if (!text) return null;
  try {
    return JSON.parse(text) as RawTurnPayload;
  } catch {
    /* fall through to brace scan */
  }
  const first = text.indexOf('{');
  if (first === -1) return null;
  let depth = 0;
  for (let i = first; i < text.length; i += 1) {
    if (text[i] === '{') depth += 1;
    if (text[i] === '}') depth -= 1;
    if (depth === 0) {
      try {
        return JSON.parse(text.slice(first, i + 1)) as RawTurnPayload;
      } catch {
        return null;
      }
    }
  }
  return null;
}

/* ──────────────────────────────────────────────────────────────────────────
 * Provider calls
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * Bound on each provider call (#327) — the last unbounded production
 * fetches. Without it, a stalled provider burns the route's entire
 * function budget before the customer hears anything. Expiry throws
 * TimeoutError into the chain's existing catch, which is already the
 * right behavior: failover to the next provider, scripted fallback when
 * exhausted. 30s matches the render gate's vision ceiling.
 */
const PROVIDER_CALL_TIMEOUT_MS = 30_000;

async function callVertex(
  systemPrompt: string,
  messages: ConversationMessage[],
  model: string
): Promise<RawTurnPayload | null> {
  const projectId = vertexProjectId();
  const accessToken = await getGcpAccessToken();
  const endpoint = buildVertexEndpoint(projectId, model);

  const response = await fetch(endpoint, {
    method: 'POST',
    signal: AbortSignal.timeout(PROVIDER_CALL_TIMEOUT_MS),
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      systemInstruction: { role: 'system', parts: [{ text: systemPrompt }] },
      contents: messages.map((m) => ({
        role: m.role === 'bot' ? 'model' : 'user',
        parts: [{ text: m.text }],
      })),
      generationConfig: { responseMimeType: 'application/json', temperature: 0.7 },
    }),
  });
  if (!response.ok) {
    throw new ProviderHttpError(
      `Gemini API error: ${response.status} - ${await response.text()}`,
      response.status
    );
  }
  const data = await response.json();
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
  return text ? parseJsonFromText(text) : null;
}

async function callOpenRouter(
  systemPrompt: string,
  messages: ConversationMessage[],
  model: string
): Promise<RawTurnPayload | null> {
  const response = await fetch(OPENROUTER_API_URL, {
    method: 'POST',
    signal: AbortSignal.timeout(PROVIDER_CALL_TIMEOUT_MS),
    headers: {
      Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
      'Content-Type': 'application/json',
      'X-Title': 'TattTester - Design Conversation',
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: systemPrompt },
        ...messages.map((m) => ({
          role: m.role === 'bot' ? 'assistant' : 'user',
          content: m.text,
        })),
      ],
      temperature: 0.7,
      max_tokens: 900,
    }),
  });
  if (!response.ok) {
    throw new ProviderHttpError(
      `OpenRouter API error: ${response.status} ${response.statusText}`,
      response.status
    );
  }
  const data = await response.json();
  const text = data.choices?.[0]?.message?.content;
  return text ? parseJsonFromText(text) : null;
}

/**
 * Type placement, style dimensions, and axis ambiguity when TYPESAFE_INTAKE
 * is on. Subject, characters, meaning, and the reply stay on the Gemini
 * payload. A low-confidence placement is cleared so the engine's existing
 * ask (placement gate, stalled-field question) fires; low-confidence style
 * tags are dropped the same way. Flag off, or any TypeSafe failure, leaves
 * the payload exactly as Gemini parsed it.
 */
async function overlayTypesafeIntake(
  payload: RawTurnPayload,
  messages: ConversationMessage[]
): Promise<void> {
  const subject = typeof payload.record?.subject === 'string' ? payload.record.subject : '';
  const typed = await refineIntakeFields({
    state: messages.map((message) => `${message.role}: ${message.text}`).join('\n'),
    subject,
  });
  if (!typed) return;

  const record = payload.record ?? {};
  payload.record = record;
  record.placement = typed.placement ?? '';
  record.styleTags = typed.styleTags;
  record.ambiguousAxes = typed.ambiguousAxes;
}

/* ──────────────────────────────────────────────────────────────────────────
 * Chain
 * ────────────────────────────────────────────────────────────────────────── */

interface Provider {
  name: 'vertex' | 'openrouter';
  model: string;
  configured: () => boolean;
  call: (systemPrompt: string, messages: ConversationMessage[]) => Promise<RawTurnPayload | null>;
}

function providerChain(pinnedModel?: string): Provider[] {
  const vModel = vertexModel();
  const chain: Provider[] = [
    {
      name: 'vertex',
      model: vModel,
      configured: isVertexConfigured,
      call: (s, m) => callVertex(s, m, vModel),
    },
    {
      name: 'openrouter',
      model: OPENROUTER_FALLBACK_MODEL,
      configured: isOpenRouterConfigured,
      call: (s, m) => callOpenRouter(s, m, OPENROUTER_FALLBACK_MODEL),
    },
  ];
  if (pinnedModel) {
    chain.sort((a, b) =>
      (b.model === pinnedModel ? 1 : 0) - (a.model === pinnedModel ? 1 : 0)
    );
  }
  return chain;
}

/**
 * Run one conversation turn through the provider chain, pinned-first.
 * Throws ConversationUnavailableError when every provider is exhausted.
 */
export async function converseWithProviders(opts: {
  systemPrompt: string;
  messages: ConversationMessage[];
  pinnedModel?: string;
  /** Session the turn belongs to — logged so operators can trace a degradation. */
  sessionId?: string;
  /** 1-based user-turn number, logged alongside the session id. */
  userTurn?: number;
}): Promise<ProviderTurn> {
  const attempts: AttemptRecord[] = [];
  const chain = providerChain(opts.pinnedModel);

  for (let i = 0; i < chain.length; i += 1) {
    const provider = chain[i];
    let attempt: AttemptRecord;

    if (!provider.configured()) {
      attempt = {
        provider: provider.name,
        model: provider.model,
        reason: 'not configured',
        failure: 'not_configured',
        errorClass: null,
        status: null,
      };
    } else {
      try {
        const payload = await provider.call(opts.systemPrompt, opts.messages);
        if (payload) {
          try {
            await overlayTypesafeIntake(payload, opts.messages);
          } catch {
            // A surprise here must not discard a turn Gemini already parsed.
            // The key and the brief stay out of the log.
            console.warn('[IntakeExtraction] TypeSafe failed (error), using Gemini extraction');
          }
          return { payload, model: provider.model };
        }
        attempt = {
          provider: provider.name,
          model: provider.model,
          reason: 'unparseable response',
          failure: 'unparseable_response',
          errorClass: null,
          status: null,
        };
      } catch (error) {
        attempt = {
          provider: provider.name,
          model: provider.model,
          reason: error instanceof Error ? error.message : String(error),
          failure: 'provider_error',
          errorClass: errorClassOf(error),
          status: statusOf(error),
        };
      }
    }

    attempts.push(attempt);

    // Failover, not degradation: another provider is still going to be tried,
    // so the session stays conversational. The exhausted case is logged once,
    // below, as the degraded event.
    const next = chain[i + 1];
    if (next) {
      logger.warn({
        event_type: PROVIDER_FAILOVER_EVENT,
        session_id: opts.sessionId ?? null,
        turn: opts.userTurn ?? null,
        provider: attempt.provider,
        model: attempt.model,
        failure: attempt.failure,
        error_class: attempt.errorClass,
        status: attempt.status,
        next_provider: next.name,
        next_model: next.model,
        outcome: 'failover',
      });
    }
  }

  // Every provider is exhausted: the caller downgrades this session to the v1
  // scripted two-question intake (ADR-0019 degraded mode). This is the ONLY
  // place that transition originates, so it is logged here at error level.
  logger.error({
    event_type: CONVERSATION_DEGRADED_EVENT,
    session_id: opts.sessionId ?? null,
    turn: opts.userTurn ?? null,
    pinned_model: opts.pinnedModel ?? null,
    outcome: 'scripted_fallback',
    providers_attempted: attempts.map((a) => a.provider),
    attempts: attempts.map((a) => ({
      provider: a.provider,
      model: a.model,
      failure: a.failure,
      error_class: a.errorClass,
      status: a.status,
    })),
  });

  throw new ConversationUnavailableError(
    'all_providers_exhausted: design conversation temporarily unavailable',
    attempts.map(({ provider, model, reason }) => ({ provider, model, reason }))
  );
}
