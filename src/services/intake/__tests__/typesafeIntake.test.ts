/**
 * TypeSafe intake overlay. The HTTP call is mocked — no live TypeSafe
 * traffic. Confident answers commit; low confidence leaves the field
 * unresolved; a down, timing-out, or unconfigured client keeps Gemini.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { extractIntake } from '../index';
import { resetOntologyCache } from '../internal/ontology';
import {
  INTAKE_TYPESAFE_THRESHOLDS,
  TYPESAFE_SYSTEMONE_URL,
  styleDimensionFor,
} from '../internal/typesafeExtraction';
import ontology from '../../../../data/style-ontology.json';

vi.mock('@/lib/google-auth-edge', () => ({
  getGcpAccessToken: vi.fn().mockResolvedValue('test-gcp-token'),
}));

const FIXTURE_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'style-ontology.fixture.json'
);

const KEY = 'ts_live_test_key_should_not_log';

const ENV_KEYS = [
  'OPENROUTER_API_KEY',
  'GOOGLE_APPLICATION_CREDENTIALS_JSON',
  'GCP_SERVICE_ACCOUNT_KEY',
  'GCP_SERVICE_ACCOUNT_EMAIL',
  'GCP_PRIVATE_KEY',
  'NEXT_PUBLIC_VERTEX_AI_PROJECT_ID',
  'GCP_PROJECT_ID',
  'VERTEX_PROJECT_ID',
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

function geminiPayload(overrides: Record<string, unknown> = {}) {
  return {
    placement: 'ankle',
    styleTags: ['japanese'],
    subject: 'Goku from Dragon Ball charging a Kamehameha',
    characterIdentities: [{ name: 'Goku', series: 'Dragon Ball' }],
    references: ['https://example.com/ref.jpg'],
    ambiguousAxes: ['color-blackwork'],
    ...overrides,
  };
}

function openRouterResponse(payload: unknown) {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      choices: [{ message: { content: JSON.stringify(payload) } }],
    }),
  };
}

function typesafeResponse(answers: Record<string, unknown>) {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      model: 'jev-1.13.0',
      answers,
      usage: { input_tokens: 40, output_tokens: 10 },
    }),
  };
}

function choice(choice: string, confidence: number) {
  return { type: 'choice', choice, confidence, probabilities: { [choice]: confidence } };
}

function noul(value: number) {
  return { type: 'noul', noul: value };
}

/** High confidence on forearm + fine-line; every axis confidently resolved. */
function confidentAnswers() {
  return {
    placement: choice('forearm', INTAKE_TYPESAFE_THRESHOLDS.placement + 0.35),
    style_palette: choice('none', 0.9),
    style_line: choice('fine-line', INTAKE_TYPESAFE_THRESHOLDS.style + 0.42),
    style_school: choice('none', 0.88),
    'axis_bold-fine': noul(0.05),
    'axis_color-blackwork': noul(0.08),
    'axis_literal-abstract': noul(0.1),
    'axis_minimal-ornate': noul(0.04),
  };
}

/**
 * Placement and every style Choice sit under the commit thresholds.
 * bold-fine is a confident "ambiguous"; color-blackwork is a confident
 * "resolved"; the other two sit in the unsure band and stay open.
 */
function ambiguousAnswers() {
  return {
    placement: choice('shoulder', INTAKE_TYPESAFE_THRESHOLDS.placement - 0.45),
    style_palette: choice('blackwork', INTAKE_TYPESAFE_THRESHOLDS.style - 0.3),
    style_line: choice('fine-line', INTAKE_TYPESAFE_THRESHOLDS.style - 0.28),
    style_school: choice('japanese', INTAKE_TYPESAFE_THRESHOLDS.style - 0.2),
    'axis_bold-fine': noul(INTAKE_TYPESAFE_THRESHOLDS.noulYes + 0.2),
    'axis_color-blackwork': noul(INTAKE_TYPESAFE_THRESHOLDS.noulResolved - 0.18),
    'axis_literal-abstract': noul(0.55),
    'axis_minimal-ornate': noul(0.48),
  };
}

type MockResponse = {
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
};

function routeFetch(
  typesafe: MockResponse | Promise<MockResponse> | (() => Promise<MockResponse>),
  gemini: Record<string, unknown> = {}
) {
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (String(url).includes('api.typesafe.ai')) {
      if (init?.signal?.aborted) return Promise.reject(init.signal.reason);
      return typeof typesafe === 'function' ? typesafe() : typesafe;
    }
    return openRouterResponse(geminiPayload(gemini));
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function enableTypesafe() {
  process.env.TYPESAFE_INTAKE = 'true';
  process.env.TYPESAFE_API_KEY = KEY;
  process.env.OPENROUTER_API_KEY = 'test-openrouter-key';
}

function typesafeCall(fetchMock: ReturnType<typeof routeFetch>) {
  const call = fetchMock.mock.calls.find((entry) => String(entry[0]).includes('api.typesafe.ai'));
  expect(call, 'expected one TypeSafe call').toBeTruthy();
  return call!;
}

describe('style dimensions', () => {
  it('assigns every production ontology tag to a dimension', () => {
    for (const tag of ontology.tags) {
      expect(styleDimensionFor(tag.id), tag.id).not.toBe('other');
    }
  });
});

describe('extractIntake — TypeSafe flag', () => {
  it('does not call TypeSafe when the flag is off, even with a key', async () => {
    process.env.TYPESAFE_API_KEY = KEY;
    process.env.TYPESAFE_INTAKE = 'false';
    process.env.OPENROUTER_API_KEY = 'test-openrouter-key';
    const fetchMock = routeFetch(typesafeResponse(confidentAnswers()));

    const record = await extractIntake({
      placementAnswer: 'left forearm',
      meaningAnswer: 'Goku from Dragon Ball charging a Kamehameha',
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toContain('openrouter.ai');
    expect(record.placement).toBe('ankle');
    expect(record.styleTags).toEqual(['japanese']);
    expect(record.subject).toContain('Goku');
  });

  it('does not call TypeSafe when the key is missing', async () => {
    process.env.TYPESAFE_INTAKE = 'true';
    process.env.OPENROUTER_API_KEY = 'test-openrouter-key';
    const fetchMock = routeFetch(typesafeResponse(confidentAnswers()));

    const record = await extractIntake({
      placementAnswer: 'left forearm',
      meaningAnswer: 'a bird for my grandmother',
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).not.toContain('typesafe');
    expect(record.placement).toBe('ankle');
  });

  it('commits a confident placement and style, and closes resolved axes', async () => {
    enableTypesafe();
    const fetchMock = routeFetch(typesafeResponse(confidentAnswers()));

    const record = await extractIntake({
      placementAnswer: 'on my left forearm I think',
      meaningAnswer: 'Goku from Dragon Ball charging a Kamehameha',
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const call = typesafeCall(fetchMock);
    expect(String(call[0])).toBe(TYPESAFE_SYSTEMONE_URL);
    const init = call[1] as RequestInit;
    expect(init.headers).toMatchObject({ Authorization: `Bearer ${KEY}` });
    expect(init.body).not.toContain(KEY);
    const body = JSON.parse(String(init.body));
    expect(body.model).toBe('jev-latest');
    expect(body.questions.placement.type).toBe('choice');
    expect(body.questions.placement.criteria.forearm).toBeTruthy();
    expect(body.questions.placement.criteria.ribcage).toBeTruthy();
    expect(body.questions.placement.criteria).not.toHaveProperty('ribs');
    expect(body.questions.placement).not.toHaveProperty('options');
    expect(body.questions['axis_bold-fine'].type).toBe('noul');
    expect(body.questions['axis_bold-fine'].criteria.true).toBeTruthy();
    for (const question of Object.values(body.questions) as Array<Record<string, unknown>>) {
      expect(question).not.toHaveProperty('options');
      expect(question.criteria).toBeTruthy();
    }
    expect(Object.keys(body.questions).filter((id) => id.startsWith('style_')).sort()).toEqual([
      'style_line',
      'style_palette',
      'style_school',
    ]);

    expect(record.placement).toBe('left forearm');
    expect(record.styleTags).toEqual(['fine-line']);
    expect(record.ambiguousAxes).toEqual([]);
    // Free text stays with Gemini.
    expect(record.subject).toContain('Goku');
    expect(record.characterIdentities).toContainEqual({ name: 'Goku', series: 'Dragon Ball' });
    expect(record.references).toEqual(['https://example.com/ref.jpg']);
    expect(record.meaning).toBe('Goku from Dragon Ball charging a Kamehameha');
  });

  it('withholds a low-confidence placement and style and keeps unsure axes open', async () => {
    enableTypesafe();
    const fetchMock = routeFetch(typesafeResponse(ambiguousAnswers()), {
      subject: null,
      characterIdentities: [],
    });

    const record = await extractIntake({
      placementAnswer: 'on my left forearm I think',
      meaningAnswer: 'strength through hard times',
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    // Not the low-confidence Choice ("shoulder") and not Gemini's "ankle".
    expect(record.placement).toBe('left forearm');
    expect(record.styleTags).toEqual([]);
    // Confident "yes" and the unsure band stay open. Confident "no" closes.
    expect(record.ambiguousAxes).toEqual(['bold-fine', 'literal-abstract', 'minimal-ornate']);
    expect(record.subject).toBeUndefined();
  });

  it('keeps Gemini extraction when TypeSafe is down, and does not log the key', async () => {
    enableTypesafe();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fetchMock = routeFetch({
      ok: false,
      status: 503,
      json: async () => ({ error: `refused ${KEY}` }),
    });

    const record = await extractIntake({
      placementAnswer: 'calf',
      meaningAnswer: 'Goku from Dragon Ball charging a Kamehameha',
    });

    expect(String(typesafeCall(fetchMock)[0])).toContain('typesafe.ai');
    expect(record.placement).toBe('ankle');
    expect(record.styleTags).toEqual(['japanese']);
    expect(record.ambiguousAxes).toEqual(['color-blackwork']);
    expect(record.subject).toContain('Goku');
    const logged = warn.mock.calls.flat().join(' ');
    expect(logged).toContain('http 503');
    expect(logged).not.toContain(KEY);
  });

  it('keeps Gemini extraction when TypeSafe times out', async () => {
    enableTypesafe();
    process.env.TYPESAFE_TIMEOUT_MS = '30';
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      if (String(url).includes('api.typesafe.ai')) {
        return new Promise((_resolve, reject) => {
          const signal = init?.signal;
          if (!signal) {
            reject(new Error('missing abort signal'));
            return;
          }
          const fail = () => reject(signal.reason);
          if (signal.aborted) fail();
          else signal.addEventListener('abort', fail, { once: true });
        });
      }
      return Promise.resolve(openRouterResponse(geminiPayload()));
    });
    vi.stubGlobal('fetch', fetchMock);

    const record = await extractIntake({
      placementAnswer: 'calf',
      meaningAnswer: 'a tiny blackwork semicolon',
    });

    expect(fetchMock.mock.calls.some((call) => String(call[0]).includes('api.typesafe.ai'))).toBe(true);
    expect(record.placement).toBe('ankle');
    expect(record.styleTags).toEqual(['japanese']);
    const logged = warn.mock.calls.flat().join(' ');
    expect(logged).toContain('timeout');
    expect(logged).not.toContain(KEY);
  });
});
