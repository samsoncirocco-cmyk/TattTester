/**
 * TypeSafe overlay on a design-conversation turn.
 *
 * Gemini still writes the reply, subject, and characters. TypeSafe, when
 * TYPESAFE_INTAKE is on, replaces placement, style tags, and ambiguous
 * axes. Low confidence clears placement so the existing stalled-field ask
 * fires. A down TypeSafe call leaves Gemini's record in place.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { runTurn, type ConversationMessage } from '../index';
import { resetStyleTagCache } from '../internal/ontology';
import { STALLED_PLACEMENT_ASK } from '../internal/persona';
import { resetOntologyCache } from '@/services/intake/internal/ontology';
import { TYPESAFE_EVALUATED_MODEL } from '@/services/typesafe';
import { INTAKE_TYPESAFE_THRESHOLDS } from '@/services/intake/internal/typesafeExtraction';

vi.mock('@/lib/google-auth-edge', () => ({
  getGcpAccessToken: vi.fn().mockResolvedValue('test-gcp-token'),
}));

vi.mock('@/lib/budget-tracker', () => ({
  checkBudget: vi.fn(async () => ({ allowed: true, spentCents: 0, remainingCents: 50_000 })),
  recordSpend: vi.fn(async () => undefined),
}));

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  createRequestLogger: vi.fn(),
}));

const FIXTURE_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'style-ontology.fixture.json'
);

const KEY = 'ts_live_test_key_should_not_log';

const ENV_KEYS = [
  'OPENROUTER_API_KEY',
  'CONVERSATION_MODEL',
  'GOOGLE_APPLICATION_CREDENTIALS_JSON',
  'GCP_SERVICE_ACCOUNT_KEY',
  'GCP_SERVICE_ACCOUNT_EMAIL',
  'GCP_PRIVATE_KEY',
  'NEXT_PUBLIC_VERTEX_AI_PROJECT_ID',
  'GCP_PROJECT_ID',
  'VERTEX_PROJECT_ID',
  'GCP_REGION',
  'NEXT_PUBLIC_DEMO_MODE',
  'TYPESAFE_API_KEY',
  'TYPESAFE_INTAKE',
  'TYPESAFE_MODEL',
  'TYPESAFE_TIMEOUT_MS',
  'STYLE_ONTOLOGY_PATH',
];

let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  savedEnv = {};
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  process.env.STYLE_ONTOLOGY_PATH = FIXTURE_PATH;
  process.env.NEXT_PUBLIC_VERTEX_AI_PROJECT_ID = 'tatt-test';
  process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON = '{"project_id":"tatt-test"}';
  resetStyleTagCache();
  resetOntologyCache();
});

afterEach(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const USER = 'maybe the left side, Goku from Dragon Ball charging a Kamehameha';

const MESSAGES: ConversationMessage[] = [
  { role: 'bot', text: 'where should it go, and who is in it?' },
  { role: 'user', text: USER },
];

function geminiRecord(overrides: Record<string, unknown> = {}) {
  return {
    reply: 'tell me which spot you mean',
    record: {
      placement: 'ankle',
      styleTags: ['japanese'],
      meaning: 'Goku from Dragon Ball charging a Kamehameha for my brother',
      subject: 'Goku from Dragon Ball charging a Kamehameha',
      characters: ['Goku'],
      characterIdentities: [{ name: 'Goku', series: 'Dragon Ball' }],
      references: [],
      ambiguousAxes: ['bold-fine', 'color-blackwork', 'literal-abstract', 'minimal-ornate'],
      ...overrides,
    },
  };
}

function vertexResponse(payload: unknown) {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      candidates: [{ content: { parts: [{ text: JSON.stringify(payload) }] } }],
    }),
  };
}

function choice(choice: string, confidence: number) {
  return { type: 'choice', choice, confidence, probabilities: { [choice]: confidence } };
}

function noul(value: number) {
  return { type: 'noul', noul: value };
}

function confidentAnswers() {
  return {
    placement: choice('forearm', INTAKE_TYPESAFE_THRESHOLDS.placement + 0.35),
    'style_fine-line': choice('present', INTAKE_TYPESAFE_THRESHOLDS.style + 0.4),
    'style_american-traditional': choice('absent', 0.9),
    style_blackwork: choice('absent', 0.9),
    style_watercolor: choice('absent', 0.9),
    style_japanese: choice('absent', 0.88),
    'axis_bold-fine': noul(0.05),
    'axis_color-blackwork': noul(0.08),
    'axis_literal-abstract': noul(0.1),
    'axis_minimal-ornate': noul(0.04),
  };
}

function ambiguousAnswers() {
  return {
    placement: choice('shoulder', INTAKE_TYPESAFE_THRESHOLDS.placement - 0.45),
    'style_fine-line': choice('present', INTAKE_TYPESAFE_THRESHOLDS.style - 0.28),
    style_blackwork: choice('unknown', 0.4),
    style_watercolor: choice('absent', 0.8),
    style_japanese: choice('present', INTAKE_TYPESAFE_THRESHOLDS.style - 0.2),
    'style_american-traditional': choice('absent', 0.7),
    'axis_bold-fine': noul(INTAKE_TYPESAFE_THRESHOLDS.noulYes + 0.2),
    'axis_color-blackwork': noul(INTAKE_TYPESAFE_THRESHOLDS.noulResolved - 0.18),
    'axis_literal-abstract': noul(0.9),
    'axis_minimal-ornate': noul(0.48),
  };
}

function typesafeBody(answers: Record<string, unknown>, ok = true, status = 200) {
  return {
    ok,
    status,
    json: async () => ({ model: 'jev-1.13.0', answers }),
  };
}

function routeFetch(answers: Record<string, unknown>, typesafeOk = true) {
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.signal?.aborted && String(url).includes('api.typesafe.ai')) {
      return Promise.reject(init.signal.reason);
    }
    if (String(url).includes('api.typesafe.ai')) {
      return typesafeOk
        ? typesafeBody(answers)
        : { ok: false, status: 503, json: async () => ({ error: KEY }) };
    }
    return vertexResponse(geminiRecord());
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function enableTypesafe() {
  process.env.TYPESAFE_INTAKE = 'true';
  process.env.TYPESAFE_API_KEY = KEY;
}

describe('runTurn — TypeSafe intake', () => {
  it('leaves Gemini in charge when the flag is off', async () => {
    process.env.TYPESAFE_API_KEY = KEY;
    process.env.TYPESAFE_INTAKE = 'false';
    const fetchMock = routeFetch(confidentAnswers());

    const result = await runTurn({ messages: MESSAGES, userTurn: 2 });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toContain('aiplatform.googleapis.com');
    expect(result.record.placement).toBe('ankle');
    expect(result.record.styleTags).toEqual(['japanese']);
    expect(result.record.subject).toContain('Goku');
  });

  it('proceeds on a confident placement and style, and keeps Gemini free text', async () => {
    enableTypesafe();
    const fetchMock = routeFetch(confidentAnswers());

    const result = await runTurn({ messages: MESSAGES, userTurn: 2 });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const typesafe = fetchMock.mock.calls.find((call) => String(call[0]).includes('api.typesafe.ai'));
    expect(typesafe).toBeTruthy();
    const body = JSON.parse(String((typesafe![1] as RequestInit).body));
    expect(body.model).toBe(TYPESAFE_EVALUATED_MODEL);
    expect(body.questions.placement).not.toHaveProperty('options');
    expect(body.questions.placement.criteria.forearm).toBeTruthy();
    expect(body.state).toContain('Goku');
    expect(String((typesafe![1] as RequestInit).body)).not.toContain(KEY);

    expect(result.stage).toBe('proposal');
    expect(result.record.placement).toBe('left forearm');
    expect(result.record.styleTags).toEqual(['fine-line']);
    expect(result.record.ambiguousAxes).toEqual([]);
    expect(result.record.subject).toContain('Goku');
    expect(result.record.requestedCharacters).toContain('Goku');
  });

  it('asks for placement through the existing stall when TypeSafe is unsure', async () => {
    enableTypesafe();
    routeFetch(ambiguousAnswers());

    const first = await runTurn({ messages: MESSAGES, userTurn: 1 });

    expect(first.stage).toBe('chatting');
    expect(first.record.placement).toBeUndefined();
    expect(first.record.styleTags).toEqual([]);
    // Named subject closes literal-abstract; the unsure minimal axis stays open.
    expect(first.record.ambiguousAxes).toEqual(['bold-fine', 'minimal-ornate']);
    expect(first.record.subject).toContain('Goku');
    expect(first.record.requestedCharacters).toContain('Goku');
    expect(first.reply).toBe('tell me which spot you mean');

    const second = await runTurn({
      messages: [...MESSAGES, { role: 'bot', text: first.reply }, { role: 'user', text: 'still Goku' }],
      userTurn: 2,
      previousTurnLogs: [first.turnLog],
    });

    expect(second.stage).toBe('chatting');
    expect(second.reply).toBe(STALLED_PLACEMENT_ASK);
    expect(second.record.placement).toBeUndefined();
    expect(second.record.subject).toContain('Goku');
  });

  it('keeps the Gemini record when TypeSafe is down, and does not log the key', async () => {
    enableTypesafe();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fetchMock = routeFetch(confidentAnswers(), false);

    const result = await runTurn({ messages: MESSAGES, userTurn: 2 });

    expect(fetchMock.mock.calls.some((call) => String(call[0]).includes('api.typesafe.ai'))).toBe(true);
    expect(result.record.placement).toBe('ankle');
    expect(result.record.styleTags).toEqual(['japanese']);
    expect(result.record.subject).toContain('Goku');
    expect(result.stage).toBe('proposal');
    const logged = warn.mock.calls.flat().join(' ');
    expect(logged).toContain('http 503');
    expect(logged).not.toContain(KEY);
  });
});
