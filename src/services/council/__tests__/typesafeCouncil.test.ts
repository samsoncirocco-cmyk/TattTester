/**
 * Typed council: one generator, one TypeSafe judge call.
 * Fetch is mocked. No key material is a real credential.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getRecentLogs } from '@/lib/observability';
import type { IntakeRecord } from '../../intake/types';
import {
  COUNCIL_COST_MODEL,
  COUNCIL_SCORE_WEIGHTS,
  buildQuestions,
  draftPasses,
  parseJudgment,
  redactSecret,
  decisionAfterRetry,
} from '../internal/typesafeJudge';

const API_KEY = 'typesafe-test-key-do-not-log';
const OPENROUTER_KEY = 'openrouter-test-key-do-not-log';

const GENERATOR_DRAFT = {
  simple: 'A traditional dragon',
  detailed: 'A traditional dragon with bold outlines on the forearm',
  ultra: 'A traditional dragon composed vertically for the forearm with heavy black linework',
  negativePrompt: 'blurry, watermark',
};

function jsonResponse(data: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    json: async () => data,
    text: async () => (typeof data === 'string' ? data : JSON.stringify(data)),
  };
}

function openRouterMessage(content: string) {
  return jsonResponse({ choices: [{ message: { content } }] });
}

function scoreAnswer(score: number, confidence = 0.9) {
  const level = String(Math.round(score));
  return {
    type: 'score',
    score,
    confidence,
    probabilities: { '0': 0, '1': 0, '2': 0, '3': 0, '4': 0, [level]: 1 },
  };
}

function typesafePayload(opts: {
  score?: number;
  confidence?: number;
  textNoul?: number;
  personNoul?: number;
  choice?: string;
  choiceConfidence?: number;
} = {}) {
  const score = opts.score ?? 4;
  const confidence = opts.confidence ?? 0.92;
  const choice = opts.choice ?? 'flux_dev';
  const choiceConfidence = opts.choiceConfidence ?? 0.9;
  return {
    model: 'jev-1.14.0',
    answers: {
      fits_body_placement: scoreAnswer(score, confidence),
      line_weight_holds_on_skin: scoreAnswer(score, confidence),
      ages_well: scoreAnswer(score, confidence),
      true_to_chosen_style: scoreAnswer(score, confidence),
      follows_user_request: scoreAnswer(score, confidence),
      image_model: {
        type: 'choice',
        choice,
        confidence: choiceConfidence,
        probabilities: {
          flux_dev: choice === 'flux_dev' ? 0.9 : 0.05,
          flux_schnell: 0.02,
          krea_2: choice === 'krea_2' ? 0.9 : 0.02,
          nano_banana_2: 0.01,
        },
      },
      contains_text_not_requested: { type: 'noul', noul: opts.textNoul ?? 0.02 },
      names_real_person_or_brand: { type: 'noul', noul: opts.personNoul ?? 0.01 },
    },
    usage: { input_tokens: 1600, output_tokens: 80 },
  };
}

interface RecordedCall {
  url: string;
  body: { model?: string; messages?: { content?: string }[]; questions?: Record<string, { type?: string; criteria?: unknown; options?: unknown }> } | null;
  init: RequestInit;
}

function installFetch(behavior: {
  typesafe?: (callIndex: number, body: RecordedCall['body'], init: RequestInit) => Promise<unknown> | unknown;
}) {
  const calls: RecordedCall[] = [];
  let typesafeCount = 0;
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
    const body = init.body ? JSON.parse(String(init.body)) : null;
    calls.push({ url: String(url), body, init });
    if (String(url).includes('typesafe.ai')) {
      typesafeCount += 1;
      if (behavior.typesafe) return behavior.typesafe(typesafeCount, body, init);
      return jsonResponse(typesafePayload());
    }
    if (String(url).includes('openrouter.ai')) {
      const model = body?.model;
      if (model === 'google/gemini-2.5-flash') {
        return openRouterMessage(JSON.stringify(GENERATOR_DRAFT));
      }
      if (model === 'anthropic/claude-3.5-sonnet') {
        return openRouterMessage(JSON.stringify({
          simple: 'legacy simple',
          detailed: 'legacy detailed',
          ultra: 'legacy ultra',
        }));
      }
      if (model === 'openai/gpt-4-turbo') return openRouterMessage('legacy technical plain text');
      if (model === 'google/gemini-1.5-pro') return openRouterMessage('legacy style plain text');
      throw new Error(`unexpected openrouter model ${model}`);
    }
    throw new Error(`unexpected url ${url}`);
  }));
  return calls;
}

async function loadEnhance(overrides: Record<string, string | undefined>) {
  vi.resetModules();
  const originalEnv = { ...process.env };
  process.env.NEXT_PUBLIC_COUNCIL_DEMO_MODE = 'false';
  process.env.NEXT_PUBLIC_DEMO_MODE = 'false';
  process.env.COUNCIL_VERTEX_AI_ENABLED = 'false';
  process.env.NEXT_PUBLIC_VERTEX_AI_ENABLED = 'false';
  process.env.COUNCIL_USE_OPENROUTER = 'true';
  process.env.OPENROUTER_API_KEY = OPENROUTER_KEY;
  delete process.env.COUNCIL_API_URL;
  delete process.env.NEXT_PUBLIC_COUNCIL_API_URL;
  delete process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON;
  delete process.env.GCP_SERVICE_ACCOUNT_KEY;
  delete process.env.GCP_SERVICE_ACCOUNT_EMAIL;
  delete process.env.GCP_PRIVATE_KEY;
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  const mod = await import('../internal/councilService');
  return {
    enhancePrompt: mod.enhancePrompt as (input: Record<string, unknown>) => Promise<{
      prompts: { simple: string; detailed: string; ultra: string };
      negativePrompt: string;
      clarifyingQuestion?: string;
      modelSelection: { modelId: string; source?: string };
      metadata: {
        provider?: string;
        llmCalls?: number;
        typesafeCalls?: number;
        needsClarification?: boolean;
        estimatedCostUsd?: number;
        judgment?: { combinedScore?: number };
      };
    }>,
    restore() {
      process.env = originalEnv;
      vi.unstubAllGlobals();
      vi.resetModules();
    },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('typesafe judge primitives', () => {
  it('puts choice options in criteria and weights the five scores to 1', () => {
    const questions = buildQuestions();
    const imageModel = questions.image_model as { criteria: Record<string, string>; options?: unknown };
    expect(imageModel.options).toBeUndefined();
    expect(Object.keys(imageModel.criteria).sort()).toEqual(
      ['flux_dev', 'flux_schnell', 'krea_2', 'nano_banana_2']
    );
    expect(questions.contains_text_not_requested).toMatchObject({ type: 'noul' });
    expect(questions.names_real_person_or_brand).toMatchObject({ type: 'noul' });
    const weight = Object.values(COUNCIL_SCORE_WEIGHTS).reduce((sum, value) => sum + value, 0);
    expect(weight).toBeCloseTo(1, 5);
  });

  it('normalizes scores and fails a low combined score or a text noul', () => {
    const passing = parseJudgment(typesafePayload());
    expect(passing.combined).toBeCloseTo(1, 5);
    expect(draftPasses(passing)).toBe(true);

    const weak = parseJudgment(typesafePayload({ score: 0 }));
    expect(weak.combined).toBeCloseTo(0, 5);
    expect(draftPasses(weak)).toBe(false);
    expect(decisionAfterRetry(weak)).toBe('clarify');

    const lettering = parseJudgment(typesafePayload({ textNoul: 0.95 }));
    expect(draftPasses(lettering)).toBe(false);
    expect(decisionAfterRetry(lettering)).toBe('fallback');
  });

  it('redacts the api key from error text', () => {
    expect(redactSecret(`bad ${API_KEY} request`, API_KEY)).toBe('bad [redacted] request');
    expect(redactSecret('plain failure', API_KEY)).toBe('plain failure');
  });
});

describe('enhancePrompt TypeSafe council', () => {
  it('passes on one generator call and one TypeSafe call', async () => {
    const calls = installFetch({});
    const { enhancePrompt, restore } = await loadEnhance({
      TYPESAFE_COUNCIL: 'true',
      TYPESAFE_API_KEY: API_KEY,
    });
    try {
      const result = await enhancePrompt({
        userIdea: 'A dragon for the forearm',
        style: 'anime',
        bodyPart: 'forearm',
      });

      const typesafeCalls = calls.filter(call => call.url.includes('typesafe.ai'));
      const generatorCalls = calls.filter(call => call.body?.model === 'google/gemini-2.5-flash');
      const legacyCalls = calls.filter(call =>
        ['anthropic/claude-3.5-sonnet', 'openai/gpt-4-turbo', 'google/gemini-1.5-pro'].includes(call.body?.model)
      );
      expect(generatorCalls).toHaveLength(1);
      expect(typesafeCalls).toHaveLength(1);
      expect(legacyCalls).toHaveLength(0);
      expect(typesafeCalls[0].body.model).toBe('jev-latest');
      expect(typesafeCalls[0].body.questions.image_model.criteria.flux_dev).toEqual(expect.any(String));
      expect(typesafeCalls[0].body.questions.image_model.options).toBeUndefined();
      expect(typesafeCalls[0].init.headers).toMatchObject({ Authorization: `Bearer ${API_KEY}` });

      expect(result.prompts.ultra).toContain('dragon');
      expect(result.prompts.ultra.toLowerCase()).toContain('vertical');
      expect(result.negativePrompt.length).toBeGreaterThan(0);
      expect(result.modelSelection.modelId).toBe('flux_dev');
      expect(result.modelSelection.source).toBe('typesafe');
      expect(result.metadata.provider).toBe('typesafe-council');
      expect(result.metadata.llmCalls).toBe(1);
      expect(result.metadata.typesafeCalls).toBe(1);
      expect(result.metadata.judgment.combinedScore).toBeGreaterThan(0.9);
      expect(result.clarifyingQuestion).toBeUndefined();

      const audit = getRecentLogs(50).filter(entry => entry.type === 'council.typesafe.audit');
      expect(audit.at(-1)?.data.decision).toBe('pass');
      expect(audit.at(-1)?.data.scores).toBeTruthy();
      expect(JSON.stringify(audit)).not.toContain(API_KEY);
    } finally {
      restore();
    }
  });

  it('regenerates once when the first combined score is low, then accepts the second draft', async () => {
    const calls = installFetch({
      typesafe: (index) => jsonResponse(typesafePayload(index === 1 ? { score: 0 } : { score: 4 })),
    });
    const { enhancePrompt, restore } = await loadEnhance({
      TYPESAFE_COUNCIL: 'true',
      TYPESAFE_API_KEY: API_KEY,
    });
    try {
      const result = await enhancePrompt({
        userIdea: 'A koi on the forearm',
        style: 'traditional',
        bodyPart: 'forearm',
      });
      const generatorCalls = calls.filter(call => call.body?.model === 'google/gemini-2.5-flash');
      const typesafeCalls = calls.filter(call => call.url.includes('typesafe.ai'));
      expect(generatorCalls).toHaveLength(2);
      expect(typesafeCalls).toHaveLength(2);
      expect(calls.some(call => call.body?.model === 'anthropic/claude-3.5-sonnet')).toBe(false);
      expect(generatorCalls[1].body.messages[1].content).toContain('Problems to fix');
      expect(result.metadata.llmCalls).toBe(2);
      expect(result.metadata.typesafeCalls).toBe(2);
      expect(result.metadata.judgment.combinedScore).toBeGreaterThan(0.9);
      expect(result.clarifyingQuestion).toBeUndefined();
    } finally {
      restore();
    }
  });

  it('asks one clarifying question after a second soft miss and does not run the legacy council', async () => {
    const calls = installFetch({
      typesafe: () => jsonResponse(typesafePayload({ score: 0, confidence: 0.2 })),
    });
    const { enhancePrompt, restore } = await loadEnhance({
      TYPESAFE_COUNCIL: 'true',
      TYPESAFE_API_KEY: API_KEY,
    });
    try {
      const result = await enhancePrompt({
        userIdea: 'Something on my arm',
        style: 'traditional',
        bodyPart: 'forearm',
      });
      expect(calls.filter(call => call.url.includes('typesafe.ai'))).toHaveLength(2);
      expect(calls.some(call => call.body?.model === 'openai/gpt-4-turbo')).toBe(false);
      expect(result.clarifyingQuestion).toEqual(expect.any(String));
      expect(result.metadata.needsClarification).toBe(true);
      expect(result.prompts.detailed).toContain('dragon');
    } finally {
      restore();
    }
  });

  it('falls back to the three serial models when a text hazard survives the retry', async () => {
    const calls = installFetch({
      typesafe: () => jsonResponse(typesafePayload({ textNoul: 0.97 })),
    });
    const { enhancePrompt, restore } = await loadEnhance({
      TYPESAFE_COUNCIL: 'true',
      TYPESAFE_API_KEY: API_KEY,
    });
    try {
      const result = await enhancePrompt({
        userIdea: 'A banner on the forearm',
        style: 'traditional',
        bodyPart: 'forearm',
      });
      expect(calls.filter(call => call.url.includes('typesafe.ai'))).toHaveLength(2);
      expect(calls.filter(call => call.body?.model === 'google/gemini-2.5-flash')).toHaveLength(2);
      expect(calls.filter(call => call.body?.model === 'anthropic/claude-3.5-sonnet')).toHaveLength(1);
      expect(calls.filter(call => call.body?.model === 'openai/gpt-4-turbo')).toHaveLength(2);
      expect(calls.filter(call => call.body?.model === 'google/gemini-1.5-pro')).toHaveLength(1);
      expect(result.prompts.detailed).toContain('legacy technical plain text');
      expect(result.metadata.provider).toBe('openrouter');
    } finally {
      restore();
    }
  });

  it('falls back to the legacy council when TypeSafe returns an error, and does not log the key', async () => {
    const calls = installFetch({
      typesafe: () => jsonResponse(`invalid key ${API_KEY}`, 503),
    });
    const { enhancePrompt, restore } = await loadEnhance({
      TYPESAFE_COUNCIL: 'true',
      TYPESAFE_API_KEY: API_KEY,
    });
    try {
      const result = await enhancePrompt({
        userIdea: 'A wolf on the forearm',
        style: 'traditional',
        bodyPart: 'forearm',
      });
      expect(calls.filter(call => call.url.includes('typesafe.ai'))).toHaveLength(1);
      expect(calls.filter(call => call.body?.model === 'anthropic/claude-3.5-sonnet')).toHaveLength(1);
      expect(result.metadata.provider).toBe('openrouter');
      const audit = getRecentLogs(30).filter(entry => entry.type === 'council.typesafe.audit');
      expect(audit.at(-1)?.data.reason).toBe('http');
      expect(JSON.stringify(audit)).not.toContain(API_KEY);
      expect(JSON.stringify(audit)).toContain('[redacted]');
    } finally {
      restore();
    }
  });

  it('falls back when the TypeSafe call times out', async () => {
    const calls = installFetch({
      typesafe: (_index, _body, init) => new Promise((_resolve, reject) => {
        const signal = init.signal;
        const abort = () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        if (signal?.aborted) abort();
        else signal?.addEventListener('abort', abort);
      }),
    });
    const { enhancePrompt, restore } = await loadEnhance({
      TYPESAFE_COUNCIL: 'true',
      TYPESAFE_API_KEY: API_KEY,
      TYPESAFE_TIMEOUT_MS: '40',
    });
    try {
      const result = await enhancePrompt({
        userIdea: 'A moth on the forearm',
        style: 'traditional',
        bodyPart: 'forearm',
      });
      expect(calls.filter(call => call.url.includes('typesafe.ai'))).toHaveLength(1);
      expect(result.prompts.ultra).toContain('legacy style plain text');
      const audit = getRecentLogs(20).filter(entry => entry.type === 'council.typesafe.audit');
      expect(audit.at(-1)?.data.reason).toBe('timeout');
    } finally {
      restore();
    }
  });

  it('does not call TypeSafe when the key is missing', async () => {
    const calls = installFetch({});
    const { enhancePrompt, restore } = await loadEnhance({
      TYPESAFE_COUNCIL: 'true',
      TYPESAFE_API_KEY: undefined,
    });
    try {
      const result = await enhancePrompt({
        userIdea: 'A snake on the forearm',
        style: 'traditional',
        bodyPart: 'forearm',
      });
      expect(calls.some(call => call.url.includes('typesafe.ai'))).toBe(false);
      expect(calls.filter(call => call.body?.model === 'anthropic/claude-3.5-sonnet')).toHaveLength(1);
      expect(result.metadata.provider).toBe('openrouter');
      const audit = getRecentLogs(20).filter(entry => entry.type === 'council.typesafe.audit');
      expect(audit.at(-1)?.data.reason).toBe('missing_key');
    } finally {
      restore();
    }
  });

  it('keeps the legacy serial council when the flag is off', async () => {
    const calls = installFetch({});
    const { enhancePrompt, restore } = await loadEnhance({
      TYPESAFE_COUNCIL: 'false',
      TYPESAFE_API_KEY: API_KEY,
    });
    try {
      const result = await enhancePrompt({
        userIdea: 'A crane on the forearm',
        style: 'traditional',
        bodyPart: 'forearm',
      });
      expect(calls.some(call => call.url.includes('typesafe.ai'))).toBe(false);
      expect(calls.map(call => call.body?.model)).toEqual([
        'anthropic/claude-3.5-sonnet',
        'openai/gpt-4-turbo',
        'google/gemini-1.5-pro',
        'openai/gpt-4-turbo',
      ]);
      expect(result.metadata.provider).toBe('openrouter');
      expect(result.metadata.estimatedCostUsd).toBeCloseTo(COUNCIL_COST_MODEL.legacyFlatUsd, 5);
    } finally {
      restore();
    }
  });

  it('ignores a low-confidence image-model choice and uses the rules table', async () => {
    installFetch({
      typesafe: () => jsonResponse(typesafePayload({
        choice: 'krea_2',
        choiceConfidence: 0.1,
      })),
    });
    const { enhancePrompt, restore } = await loadEnhance({
      TYPESAFE_COUNCIL: 'true',
      TYPESAFE_API_KEY: API_KEY,
    });
    try {
      const result = await enhancePrompt({
        userIdea: 'A peony on the forearm',
        style: 'traditional',
        bodyPart: 'forearm',
      });
      expect(result.modelSelection.modelId).toBe('flux_dev');
      expect(result.modelSelection.source).toBe('rules');
    } finally {
      restore();
    }
  });
});

describe('structured drafts', () => {
  const record: IntakeRecord = {
    placement: 'forearm',
    styleTags: ['traditional'],
    meaning: 'a phoenix for my grandmother',
    references: [],
    ambiguousAxes: ['bold-fine'],
  };

  const saved = {
    flag: process.env.TYPESAFE_COUNCIL,
    key: process.env.TYPESAFE_API_KEY,
  };

  afterEach(() => {
    if (saved.flag === undefined) delete process.env.TYPESAFE_COUNCIL;
    else process.env.TYPESAFE_COUNCIL = saved.flag;
    if (saved.key === undefined) delete process.env.TYPESAFE_API_KEY;
    else process.env.TYPESAFE_API_KEY = saved.key;
  });

  it('does not call TypeSafe when the flag is off', async () => {
    process.env.TYPESAFE_COUNCIL = 'false';
    process.env.TYPESAFE_API_KEY = API_KEY;
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const { enhanceStructured } = await import('../internal/structuredMode');
    const result = await enhanceStructured(record);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.variations).toHaveLength(2);
    expect(result.variations[0].clarifyingQuestion).toBeUndefined();
  });

  it('judges each structured draft once when the scores pass', async () => {
    process.env.TYPESAFE_COUNCIL = 'true';
    process.env.TYPESAFE_API_KEY = API_KEY;
    const calls = installFetch({});
    const { enhanceStructured } = await import('../internal/structuredMode');
    const result = await enhanceStructured(record);
    const typesafeCalls = calls.filter(call => call.url.includes('typesafe.ai'));
    expect(typesafeCalls).toHaveLength(2);
    expect(typesafeCalls[0].body.questions.fits_body_placement.type).toBe('score');
    expect(result.variations[0].modelSelection?.source).toBe('typesafe');
    expect(result.variations[0].clarifyingQuestion).toBeUndefined();
    expect(result.variations[0].prompts.ultra).not.toContain('Compose the design');
  });

  it('repairs a structured draft once and keeps the repaired text when the second judge passes', async () => {
    process.env.TYPESAFE_COUNCIL = 'true';
    process.env.TYPESAFE_API_KEY = API_KEY;
    const calls = installFetch({
      typesafe: (index) => jsonResponse(typesafePayload(index <= 2 ? { score: 0 } : { score: 4 })),
    });
    const { enhanceStructured } = await import('../internal/structuredMode');
    const result = await enhanceStructured(record);
    expect(calls.filter(call => call.url.includes('typesafe.ai'))).toHaveLength(4);
    expect(result.variations[0].prompts.ultra).toContain('named body placement');
    expect(result.variations[1].prompts.detailed).toContain('named body placement');
  });

  it('keeps the template drafts when TypeSafe errors', async () => {
    process.env.TYPESAFE_COUNCIL = 'true';
    process.env.TYPESAFE_API_KEY = API_KEY;
    const calls = installFetch({
      typesafe: () => jsonResponse('nope', 500),
    });
    const { enhanceStructured } = await import('../internal/structuredMode');
    const result = await enhanceStructured(record);
    expect(calls.filter(call => call.url.includes('typesafe.ai'))).toHaveLength(2);
    expect(result.variations[0].prompts.ultra).not.toContain('bold readable forms');
    expect(result.variations[0].clarifyingQuestion).toBeUndefined();
    expect(JSON.stringify(getRecentLogs(20))).not.toContain(API_KEY);
  });
});
