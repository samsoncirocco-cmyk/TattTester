import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { checkBudget, recordSpend } from '@/lib/budget-tracker';
import { ensureAdminApp } from '@/lib/firebase-admin';
import { logger } from '@/lib/logger';
import { clearModerationFlags, listModerationFlags } from '@/lib/moderationQueue';
import {
  TYPESAFE_MODERATION_COST_CENTS,
  TYPESAFE_SYSTEMONE_URL,
  screenContent,
} from '@/lib/typesafeModeration';

vi.mock('@/lib/budget-tracker', () => ({
  checkBudget: vi.fn(async () => ({ allowed: true, spentCents: 0, remainingCents: 100 })),
  recordSpend: vi.fn(async () => {}),
}));

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('@/lib/firebase-admin', () => ({ ensureAdminApp: vi.fn(() => false) }));
vi.mock('firebase-admin/firestore', () => ({
  getFirestore: () => ({
    collection: () => ({
      doc: () => ({ set: vi.fn(async () => undefined) }),
    }),
  }),
}));

const fetchMock = vi.fn();
const KEY = 'ts_test_key_value';

function systemOne(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

function payload(over: {
  real_person?: number;
  trademark?: number;
  legal_claim?: number;
  severity?: number;
  confidence?: number;
} = {}) {
  return {
    model: 'jev-latest',
    answers: {
      real_person: { type: 'noul', noul: over.real_person ?? 0.04 },
      trademark: { type: 'noul', noul: over.trademark ?? 0.03 },
      legal_claim: { type: 'noul', noul: over.legal_claim ?? 0.02 },
      severity: {
        type: 'score',
        score: over.severity ?? 0.2,
        confidence: over.confidence ?? 0.9,
      },
    },
  };
}

function requestBody(): Record<string, unknown> {
  const init = fetchMock.mock.calls[0][1] as RequestInit;
  return JSON.parse(String(init.body));
}

describe('screenContent', () => {
  const previous = {
    TYPESAFE_MODERATION: process.env.TYPESAFE_MODERATION,
    TYPESAFE_API_KEY: process.env.TYPESAFE_API_KEY,
    TYPESAFE_MODEL: process.env.TYPESAFE_MODEL,
    TYPESAFE_TIMEOUT_MS: process.env.TYPESAFE_TIMEOUT_MS,
  };

  function restore(name: keyof typeof previous) {
    if (previous[name] === undefined) delete process.env[name];
    else process.env[name] = previous[name];
  }

  beforeEach(() => {
    vi.clearAllMocks();
    clearModerationFlags();
    vi.stubGlobal('fetch', fetchMock);
    process.env.TYPESAFE_MODERATION = 'true';
    process.env.TYPESAFE_API_KEY = KEY;
    process.env.TYPESAFE_MODEL = 'jev-latest';
    process.env.TYPESAFE_TIMEOUT_MS = '8000';
    vi.mocked(checkBudget).mockResolvedValue({ allowed: true, spentCents: 0, remainingCents: 100 });
    vi.mocked(recordSpend).mockResolvedValue(undefined);
  });

  afterEach(() => {
    restore('TYPESAFE_MODERATION');
    restore('TYPESAFE_API_KEY');
    restore('TYPESAFE_MODEL');
    restore('TYPESAFE_TIMEOUT_MS');
    vi.unstubAllGlobals();
  });

  it('blocks a high-confidence high-severity design prompt and records one cent', async () => {
    fetchMock.mockResolvedValueOnce(systemOne(payload({
      trademark: 0.94,
      severity: 2.4,
      confidence: 0.86,
    })));

    const result = await screenContent({
      surface: 'design_prompt',
      text: 'Mickey Mouse on my calf',
    });

    expect(result.action).toBe('review');
    expect(result.skipped).toBe(false);
    expect(result.userMessage).toBe('This was not saved for review.');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe(TYPESAFE_SYSTEMONE_URL);
    expect(recordSpend).toHaveBeenCalledWith(TYPESAFE_MODERATION_COST_CENTS);
    expect(TYPESAFE_MODERATION_COST_CENTS).toBe(1);

    const body = requestBody();
    expect(body.model).toBe('jev-1.14.0');
    const questions = body.questions as Record<string, { type: string; options?: unknown }>;
    expect(questions.real_person.type).toBe('noul');
    expect(questions.trademark.type).toBe('noul');
    expect(questions.severity.type).toBe('score');
    expect(questions.legal_claim).toBeUndefined();
    expect(questions.trademark.options).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain(KEY);

    const [flag] = listModerationFlags();
    expect(flag.action).toBe('review');
    expect(flag.status).toBe('open');
    expect(flag.excerpt).toContain('Mickey Mouse');
  });

  it('says a design was saved only after a durable write with a correlation id', async () => {
    vi.mocked(ensureAdminApp).mockReturnValueOnce(true);
    fetchMock.mockResolvedValueOnce(systemOne(payload({
      trademark: 0.94,
      severity: 2.4,
      confidence: 0.86,
    })));

    const result = await screenContent({
      surface: 'design_prompt',
      text: 'Mickey Mouse on my calf',
      subjectId: 'session-42',
    });

    expect(result.action).toBe('review');
    expect(result.userMessage).toBe('Saved for review. Reference session-42.');
    expect(listModerationFlags()[0].subjectId).toBe('session-42');
  });

  it('sends a mid-range item to review', async () => {
    fetchMock.mockResolvedValueOnce(systemOne(payload({
      real_person: 0.52,
      severity: 1.3,
      confidence: 0.6,
    })));

    const result = await screenContent({ surface: 'design_prompt', text: 'a portrait of my friend Alex' });

    expect(result.action).toBe('review');
    expect(result.userMessage).toBe('This was not saved for review.');
    expect(listModerationFlags()[0].action).toBe('review');
    expect(recordSpend).toHaveBeenCalledTimes(1);
  });

  it('passes a low-severity prompt and does not queue it', async () => {
    fetchMock.mockResolvedValueOnce(systemOne(payload()));

    const result = await screenContent({ surface: 'design_prompt', text: 'a fine-line rose on my forearm' });

    expect(result.action).toBe('pass');
    expect(result.skipped).toBe(false);
    expect(result.userMessage).toBeNull();
    expect(listModerationFlags()).toEqual([]);
    expect(recordSpend).toHaveBeenCalledTimes(1);
  });

  it('asks the legal-claim Noul for takedown text, in the same call', async () => {
    fetchMock.mockResolvedValueOnce(systemOne(payload({
      legal_claim: 0.97,
      severity: 2.8,
      confidence: 0.9,
    })));

    const result = await screenContent({
      surface: 'takedown',
      text: 'These photographs are my copyright. Remove them under the DMCA.',
      subjectId: 'TD-1',
    });

    expect(result.action).toBe('block');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const questions = requestBody().questions as Record<string, { type: string; instructions: string }>;
    expect(questions.legal_claim.type).toBe('noul');
    expect(questions.legal_claim.instructions).toMatch(/copyright or legal claim/i);
    expect(listModerationFlags()[0]).toMatchObject({ status: 'open', subjectId: 'TD-1', surface: 'takedown' });
  });

  it('stays on the current path when the flag is off', async () => {
    delete process.env.TYPESAFE_MODERATION;

    const result = await screenContent({ surface: 'design_prompt', text: 'Mickey Mouse' });

    expect(result).toMatchObject({ action: 'pass', skipped: true, reason: 'disabled' });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(recordSpend).not.toHaveBeenCalled();
    expect(listModerationFlags()).toEqual([]);
  });

  it('stays on the current path when the key is missing', async () => {
    delete process.env.TYPESAFE_API_KEY;

    const result = await screenContent({ surface: 'appeal', text: 'please restore my profile' });

    expect(result).toMatchObject({ action: 'pass', skipped: true, reason: 'missing_key' });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(recordSpend).not.toHaveBeenCalled();
  });

  it('stays on the current path on timeout and does not meter it', async () => {
    fetchMock.mockRejectedValueOnce(Object.assign(new Error(`timed out ${KEY}`), { name: 'TimeoutError' }));

    const result = await screenContent({ surface: 'design_prompt', text: 'a rose' });

    expect(result).toMatchObject({ action: 'pass', skipped: true, reason: 'timeout' });
    expect(recordSpend).not.toHaveBeenCalled();
    const logged = JSON.stringify(vi.mocked(logger.warn).mock.calls);
    expect(logged).not.toContain(KEY);
    expect(logged).toContain('[redacted]');
  });

  it('stays on the current path on an HTTP error and does not meter it', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 500,
      text: async () => `error page ${KEY}`,
      json: async () => ({}),
    });

    const result = await screenContent({ surface: 'design_prompt', text: 'a rose' });

    expect(result).toMatchObject({ action: 'pass', skipped: true, reason: 'http' });
    expect(recordSpend).not.toHaveBeenCalled();
    expect(JSON.stringify(vi.mocked(logger.warn).mock.calls)).not.toContain(KEY);
  });

  it('meters an unparseable 2xx and then keeps the current path', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => { throw new Error('not json'); },
      text: async () => 'not json',
    });

    const result = await screenContent({ surface: 'design_prompt', text: 'a rose' });

    expect(result).toMatchObject({ action: 'pass', skipped: true, reason: 'parse' });
    expect(recordSpend).toHaveBeenCalledWith(1);
    expect(listModerationFlags()).toEqual([]);
  });

  it('does not call TypeSafe when the spend cap is already exhausted', async () => {
    vi.mocked(checkBudget).mockResolvedValueOnce({ allowed: false, spentCents: 50000, remainingCents: 0 });

    const result = await screenContent({ surface: 'design_prompt', text: 'a rose' });

    expect(result).toMatchObject({ action: 'pass', skipped: true, reason: 'budget' });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(recordSpend).not.toHaveBeenCalled();
  });
});
