/**
 * Shared TypeSafe System One client.
 *
 * One place reads TYPESAFE_API_KEY, TYPESAFE_MODEL, and TYPESAFE_TIMEOUT_MS.
 * The model default is the evaluated release (`jev-1.14.0`). The floating
 * aliases `jev-latest` and `jev-preview` are rewritten to that id so a
 * threshold tuned against the evaluation cannot follow an alias move.
 *
 * Paid calls check the shared spend governor before any request and debit
 * one cent after a 2xx. That cent is the same deliberate over-estimate the
 * other text calls use. It is not a new price, and it does not change
 * BUDGET_MAX_SPEND_CENTS. A denial or a governor error makes no request.
 * Timeouts and transport errors are not debited. The API key is never logged.
 *
 * Demo mode is not handled here. Callers that must stay free in demo mode
 * return before calling this client.
 */

import { envInt, envString } from '@/config/envSchema';
import { checkBudget, recordSpend } from '@/lib/budget-tracker';

export const TYPESAFE_SYSTEMONE_URL = 'https://api.typesafe.ai/v1/systemone';

/** Evaluated System One release. `jev-latest` currently aliases this id. */
export const TYPESAFE_EVALUATED_MODEL = 'jev-1.14.0';

export const TYPESAFE_DEFAULT_TIMEOUT_MS = 8_000;

/**
 * Cents recorded against the shared cap after a 2xx. Jev's published list
 * price is $0.042 per million input tokens, so one call is a fraction of
 * a cent. One cent over-estimates that without introducing a new price.
 */
export const TYPESAFE_CALL_COST_CENTS = 1;

const FLOATING_ALIASES = new Set(['jev-latest', 'jev-preview']);

export type SystemOneQuestionType = 'noul' | 'choice' | 'score';

export interface SystemOneQuestion {
  type: SystemOneQuestionType;
  instructions: string;
  criteria?: Record<string, string>;
}

export interface PostSystemOneArgs {
  state: unknown;
  questions: Record<string, SystemOneQuestion>;
  apiKey?: string;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}

export type SystemOneFailure =
  | 'missing_key'
  | 'budget'
  | 'timeout'
  | 'http'
  | 'parse'
  | 'error';

export type PostSystemOneResult =
  | {
      ok: true;
      status: number;
      payload: unknown;
      metered: boolean;
      model: string;
    }
  | {
      ok: false;
      failure: SystemOneFailure;
      status: number | null;
      metered: boolean;
    };

export function typesafeApiKey(env: NodeJS.ProcessEnv = process.env): string | undefined {
  try {
    const key = envString('TYPESAFE_API_KEY', env);
    const trimmed = key?.trim();
    return trimmed || undefined;
  } catch {
    return undefined;
  }
}

/** Versioned model id. Floating aliases collapse to the evaluated release. */
export function typesafeModel(env: NodeJS.ProcessEnv = process.env): string {
  try {
    const value = envString('TYPESAFE_MODEL', env)?.trim();
    if (!value || FLOATING_ALIASES.has(value)) return TYPESAFE_EVALUATED_MODEL;
    return value;
  } catch {
    return TYPESAFE_EVALUATED_MODEL;
  }
}

export function typesafeTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  try {
    const value = envInt('TYPESAFE_TIMEOUT_MS', env);
    if (value === undefined || !Number.isFinite(value) || value < 1) return TYPESAFE_DEFAULT_TIMEOUT_MS;
    return value;
  } catch {
    return TYPESAFE_DEFAULT_TIMEOUT_MS;
  }
}

export function redactTypesafeSecret(text: string, secret?: string): string {
  if (!secret || !text.includes(secret)) return text;
  return text.split(secret).join('[redacted]');
}

function isTimeoutError(error: unknown): boolean {
  if (!error || typeof error !== 'object' || !('name' in error)) return false;
  const name = String((error as { name?: string }).name);
  return name === 'TimeoutError' || name === 'AbortError';
}

/**
 * Check the shared governor, then POST /v1/systemone.
 * A missing key, a denied budget, or a governor error does not touch the network.
 */
export async function postGovernedSystemOne(args: PostSystemOneArgs): Promise<PostSystemOneResult> {
  const env = args.env ?? process.env;
  const key = args.apiKey?.trim() || typesafeApiKey(env);
  if (!key) return { ok: false, failure: 'missing_key', status: null, metered: false };

  try {
    const budget = await checkBudget();
    if (!budget.allowed) {
      return { ok: false, failure: 'budget', status: null, metered: false };
    }
  } catch {
    return { ok: false, failure: 'budget', status: null, metered: false };
  }

  const model = typesafeModel(env);
  const timeoutMs = typesafeTimeoutMs(env);
  const doFetch = args.fetchImpl ?? fetch;
  const signal = args.signal ?? AbortSignal.timeout(timeoutMs);

  let response: Response;
  try {
    response = await doFetch(TYPESAFE_SYSTEMONE_URL, {
      method: 'POST',
      signal,
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        state: args.state,
        questions: args.questions,
      }),
    });
  } catch (error) {
    return {
      ok: false,
      failure: isTimeoutError(error) ? 'timeout' : 'error',
      status: null,
      metered: false,
    };
  }

  if (!response.ok) {
    await response.text().catch(() => undefined);
    return { ok: false, failure: 'http', status: response.status, metered: false };
  }

  let metered = false;
  try {
    await recordSpend(TYPESAFE_CALL_COST_CENTS);
    metered = true;
  } catch {
    metered = false;
  }

  try {
    const payload: unknown = await response.json();
    return { ok: true, status: response.status, payload, metered, model };
  } catch {
    return { ok: false, failure: 'parse', status: response.status, metered };
  }
}
