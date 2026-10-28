import { beforeEach, describe, expect, it, vi } from 'vitest';
import { checkBudget, recordSpend } from '@/lib/budget-tracker';
import {
  TYPESAFE_CALL_COST_CENTS,
  TYPESAFE_EVALUATED_MODEL,
  TYPESAFE_SYSTEMONE_URL,
  postGovernedSystemOne,
  redactTypesafeSecret,
  typesafeModel,
  typesafeTimeoutMs,
} from './client';

vi.mock('@/lib/budget-tracker', () => ({
  checkBudget: vi.fn(),
  recordSpend: vi.fn(),
}));

const checkBudgetMock = vi.mocked(checkBudget);
const recordSpendMock = vi.mocked(recordSpend);

const env = {
  TYPESAFE_API_KEY: 'ts_test_key_not_a_secret',
  TYPESAFE_MODEL: 'jev-1.14.0',
  TYPESAFE_TIMEOUT_MS: '8000',
} as NodeJS.ProcessEnv;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

beforeEach(() => {
  checkBudgetMock.mockReset();
  recordSpendMock.mockReset();
  checkBudgetMock.mockResolvedValue({ allowed: true, spentCents: 0, remainingCents: 50_000 });
  recordSpendMock.mockResolvedValue(undefined);
});

describe('typesafeModel', () => {
  it('pins an unset model to the evaluated release', () => {
    expect(typesafeModel({})).toBe(TYPESAFE_EVALUATED_MODEL);
    expect(TYPESAFE_EVALUATED_MODEL).toBe('jev-1.14.0');
  });

  it('rewrites floating aliases to the evaluated release', () => {
    expect(typesafeModel({ TYPESAFE_MODEL: 'jev-latest' })).toBe('jev-1.14.0');
    expect(typesafeModel({ TYPESAFE_MODEL: 'jev-preview' })).toBe('jev-1.14.0');
  });

  it('keeps an explicit versioned id', () => {
    expect(typesafeModel({ TYPESAFE_MODEL: 'jev-1.13.0' })).toBe('jev-1.13.0');
  });

  it('falls back when the timeout is unusable', () => {
    expect(typesafeTimeoutMs({})).toBe(8000);
    expect(typesafeTimeoutMs({ TYPESAFE_TIMEOUT_MS: '0' })).toBe(8000);
    expect(typesafeTimeoutMs({ TYPESAFE_TIMEOUT_MS: '1500' })).toBe(1500);
  });
});

describe('postGovernedSystemOne', () => {
  it('does not fetch or debit when the key is missing', async () => {
    const fetchImpl = vi.fn();
    const result = await postGovernedSystemOne({
      state: 'a rose',
      questions: { ready: { type: 'noul', instructions: 'Ready?' } },
      env: {},
      fetchImpl,
    });
    expect(result).toMatchObject({ ok: false, failure: 'missing_key', metered: false });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(checkBudgetMock).not.toHaveBeenCalled();
    expect(recordSpendMock).not.toHaveBeenCalled();
  });

  it('does not fetch when the shared governor denies the call', async () => {
    checkBudgetMock.mockResolvedValue({ allowed: false, spentCents: 50_000, remainingCents: 0 });
    const fetchImpl = vi.fn();
    const result = await postGovernedSystemOne({
      state: 'a rose',
      questions: { ready: { type: 'noul', instructions: 'Ready?' } },
      env,
      fetchImpl,
    });
    expect(result).toMatchObject({ ok: false, failure: 'budget', metered: false });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(recordSpendMock).not.toHaveBeenCalled();
  });

  it('does not fetch when the governor throws', async () => {
    checkBudgetMock.mockRejectedValue(new Error('firestore down'));
    const fetchImpl = vi.fn();
    const result = await postGovernedSystemOne({
      state: 'a rose',
      questions: { ready: { type: 'noul', instructions: 'Ready?' } },
      env,
      fetchImpl,
    });
    expect(result).toMatchObject({ ok: false, failure: 'budget' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('debits one cent after a successful request and sends the pinned model', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ answers: { ready: { noul: 0.2 } } }));
    const result = await postGovernedSystemOne({
      state: 'a rose on the calf',
      questions: { ready: { type: 'noul', instructions: 'Ready?' } },
      env,
      fetchImpl,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.model).toBe('jev-1.14.0');
      expect(result.payload).toEqual({ answers: { ready: { noul: 0.2 } } });
    }
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(TYPESAFE_SYSTEMONE_URL);
    expect(JSON.parse(String(init.body)).model).toBe('jev-1.14.0');
    expect(recordSpendMock).toHaveBeenCalledWith(TYPESAFE_CALL_COST_CENTS);
    expect(TYPESAFE_CALL_COST_CENTS).toBe(1);
  });

  it('does not debit a timeout or an HTTP error', async () => {
    const timeout = Object.assign(new Error('timed out'), { name: 'TimeoutError' });
    const fetchImpl = vi.fn(async () => {
      throw timeout;
    });
    const timedOut = await postGovernedSystemOne({
      state: 'a rose',
      questions: { ready: { type: 'noul', instructions: 'Ready?' } },
      env,
      fetchImpl,
    });
    expect(timedOut).toMatchObject({ ok: false, failure: 'timeout', metered: false });

    fetchImpl.mockResolvedValue(jsonResponse({ error: 'no' }, 503));
    const http = await postGovernedSystemOne({
      state: 'a rose',
      questions: { ready: { type: 'noul', instructions: 'Ready?' } },
      env,
      fetchImpl,
    });
    expect(http).toMatchObject({ ok: false, failure: 'http', status: 503, metered: false });
    expect(recordSpendMock).not.toHaveBeenCalled();
  });

  it('redacts the key from text', () => {
    expect(redactTypesafeSecret('bearer ts_test_key_not_a_secret leaked', env.TYPESAFE_API_KEY)).toBe(
      'bearer [redacted] leaked'
    );
  });
});
