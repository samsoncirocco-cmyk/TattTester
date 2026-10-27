/*
 * Seam tests for the unrequested-lettering guard (#297).
 *
 * fetch is stubbed once and dispatched by URL, because the guard and the
 * render share the transport: a test that could not tell a vision call from a
 * render call could not prove the re-roll spent a second render, which is the
 * whole cost question.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/google-auth-edge', () => ({
  getGcpAccessToken: vi.fn().mockResolvedValue('test-token'),
}));

vi.mock('@/lib/observability', () => ({ logEvent: vi.fn() }));

vi.mock('@/lib/logger', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { checkBudgetMock, recordSpendMock } = vi.hoisted(() => ({
  checkBudgetMock: vi.fn(),
  recordSpendMock: vi.fn(),
}));

vi.mock('@/lib/budget-tracker', () => ({
  checkBudget: checkBudgetMock,
  recordSpend: recordSpendMock,
  VISION_ANALYSIS_COST_CENTS: 1,
}));

import { logger } from '@/lib/logger';
import { generate } from '../index';
import {
  DEFAULT_LETTERING_NOUL_THRESHOLD,
  isClean,
  LETTERING_NOUL_COST_CENTS,
  LETTERING_NOUL_QUESTION,
  requestsLettering,
  screenForText,
  TYPESAFE_SYSTEMONE_URL,
} from '../internal/textGuard';

describe('requestsLettering — the half that is deliberately not a model call', () => {
  it.each([
    "script lettering reading Margaret, my grandmother's name",
    'a banner bearing the date 1994',
    'the word RESILIENCE in bold cursive',
    'a scroll with a quote from her favourite poem',
  ])('recognises a request for writing: %s', (prompt) => {
    expect(requestsLettering(prompt)).toBe(true);
  });

  it.each([
    'Goku, Vegeta and Piccolo from Dragon Ball Z standing together',
    'a wolf head in profile, fine detail, high contrast',
    'Batman and the Joker facing each other',
    // Substring traps: needles "text"/"word"/"script" must not fire inside
    // ordinary English, or the intrusion gate disables itself.
    'a sword with weathered texture, high contrast',
    'password lock icon with fine description lines',
    // Explicit refusals must not match lettering needles, or unrequested OCR
    // words (character labels) would pass the gate as "requested".
    'Goku and Vegeta, no text',
    'a wolf head without lettering',
    'portrait, avoid words',
    // Removal phrasing (common in critique re-cuts) is a refusal, not a
    // lettering request — "remove all text" still contains \btext\b.
    'Goku and Vegeta, remove all text',
    'p1 Requested change: "remove all text".',
    'p1 Requested change: "remove the name labels".',
    'portrait, drop the words',
    // Compound refusals: stripping only the first negated term must not leave
    // "or lettering" / "or words" to rematch a needle.
    'Goku and Vegeta, no text or lettering',
    'a wolf head without text or words',
    'portrait, avoid any writing or script',
    // structuredMode embeds styleTags as "in a ${styleDesc} style". The
    // lettering ontology id and its aliases must not clear the intrusion gate
    // for figure-only designs that merely named a style.
    'A tattoo design in a script style, depicting Goku from Dragon Ball Z.',
    'A tattoo design in a lettering, anime style, depicting Vegeta.',
    'Compositional mode: style locks to calligraphy, blackwork depicting a wolf.',
  ])('does not treat a named subject as a request for writing: %s', (prompt) => {
    // The failure this whole split exists to prevent: a character named in the
    // request is a figure to draw, not a name to letter across the artwork.
    expect(requestsLettering(prompt)).toBe(false);
  });

  it('still recognises lettering asked for beside a style-descriptor shell', () => {
    expect(
      requestsLettering(
        'A tattoo design in a script style, script lettering reading Margaret'
      )
    ).toBe(true);
  });
});

describe('screenForText — image payload resolution', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    vi.stubEnv('GCP_PROJECT_ID', 'tatt-test');
    vi.stubEnv('TEXT_GUARD_MODEL', 'gemini-3.1-flash-lite');
    vi.stubEnv('TYPESAFE_LETTERING', 'false');
    checkBudgetMock.mockResolvedValue({ allowed: true });
    recordSpendMock.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.clearAllMocks();
  });

  it('fetches HTTPS Replicate URLs before calling Vertex', async () => {
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        headers: { get: () => 'image/png' },
        arrayBuffer: async () => Uint8Array.from([1, 2, 3]).buffer,
      })
      .mockResolvedValueOnce(ocrResponse(['GOKU']));

    const verdict = await screenForText('https://img.example/1.png', 'a fox');

    expect(verdict).toEqual({ intruded: true, words: ['GOKU'], screened: true });
    // Bounded fetch (#327): the third-party image host gets an abort signal.
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      'https://img.example/1.png',
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    );
    const visionBody = JSON.parse(fetchMock.mock.calls[1][1].body);
    expect(visionBody.contents[0].parts[0].inlineData).toEqual({
      mimeType: 'image/png',
      data: Buffer.from([1, 2, 3]).toString('base64'),
    });
  });

  it('preserves JPEG mime type from data URLs', async () => {
    fetchMock.mockResolvedValueOnce(ocrResponse([]));

    await screenForText('data:image/jpeg;base64,jpgbytes', 'a fox');

    const visionBody = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(visionBody.contents[0].parts[0].inlineData).toEqual({
      mimeType: 'image/jpeg',
      data: 'jpgbytes',
    });
  });

  it('defaults the Vertex project id when env is unset', async () => {
    vi.stubEnv('GCP_PROJECT_ID', '');
    vi.stubEnv('NEXT_PUBLIC_VERTEX_AI_PROJECT_ID', '');
    vi.stubEnv('VERTEX_PROJECT_ID', '');
    fetchMock.mockResolvedValueOnce(ocrResponse([]));

    await screenForText('data:image/png;base64,IMG', 'a fox');

    expect(String(fetchMock.mock.calls[0][0])).toContain('/projects/tatt-pro/');
  });
});

describe('isClean', () => {
  it('does not treat skipped verdicts as clean', () => {
    expect(
      isClean([{ intruded: false, words: [], screened: false, skipReason: 'budget' }])
    ).toBe(false);
    expect(isClean([{ intruded: false, words: [], screened: true }])).toBe(true);
  });
});

/** A Vertex image render: 200 with one inline image part. */
function renderResponse() {
  return {
    ok: true,
    json: async () => ({
      candidates: [
        { content: { parts: [{ inlineData: { mimeType: 'image/png', data: 'IMG' } }] } },
      ],
    }),
  };
}

/**
 * The guard's vision call is pure OCR — it reports what lettering is in the
 * image and nothing else. Whether that lettering was requested is decided
 * afterwards from the prompt, so these stubs carry words only.
 */
function ocrResponse(words: string[] = []) {
  return {
    ok: true,
    json: async () => ({
      candidates: [{ content: { parts: [{ text: JSON.stringify({ words }) }] } }],
    }),
  };
}

/** A TypeSafe System One Noul answer for `requests_lettering`. */
function noulResponse(noul: number) {
  return {
    ok: true,
    status: 200,
    text: async () => '',
    json: async () => ({
      model: 'jev-latest',
      answers: { requests_lettering: { type: 'noul', noul } },
      usage: { input_tokens: 48, output_tokens: 8 },
    }),
  };
}

describe('generation seam — unrequested-lettering guard', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let renderCalls: number;
  let guardCalls: number;

  /**
   * Queue verdicts in order; every image call returns a render. The guard
   * model id is what distinguishes the two, so the routing of the stub mirrors
   * the routing of the real calls.
   */
  function wire(reads: Array<string[] | 'fail'>) {
    let v = 0;
    fetchMock.mockImplementation(async (url: string) => {
      if (String(url).includes('flash-lite')) {
        guardCalls += 1;
        const next = reads[Math.min(v++, reads.length - 1)];
        if (next === 'fail') return { ok: false, status: 503, text: async () => 'down' };
        return ocrResponse(next);
      }
      renderCalls += 1;
      return renderResponse();
    });
  }

  beforeEach(() => {
    renderCalls = 0;
    guardCalls = 0;
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    vi.stubEnv('REPLICATE_API_TOKEN', '');
    vi.stubEnv('GCP_PROJECT_ID', 'tatt-test');
    vi.stubEnv('TEXT_GUARD_MODEL', 'gemini-3.1-flash-lite');
    vi.stubEnv('TYPESAFE_LETTERING', 'false');
    checkBudgetMock.mockResolvedValue({ allowed: true });
    recordSpendMock.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.clearAllMocks();
  });

  it('does not screen at all unless the caller asks for it', async () => {
    wire([[]]);

    const result = await generate({ prompt: 'a fox', style: 'realism', modelId: 'imagen3' });

    expect(guardCalls).toBe(0);
    expect(renderCalls).toBe(1);
    // Absent, not false: "not checked" and "checked and clean" are different.
    expect(result.metadata.textIntrusion).toBeUndefined();
  });

  it('passes a clean render through without spending a second render', async () => {
    wire([[]]);

    const result = await generate({
      prompt: 'a fox',
      style: 'realism',
      modelId: 'imagen3',
      screenText: {},
    });

    expect(renderCalls).toBe(1);
    expect(guardCalls).toBe(1);
    expect(result.metadata.textIntrusion).toBe(false);
    expect(result.metadata.textGuardRerolls).toBeUndefined();
  });

  it('re-rolls once when lettering appears, and returns the clean second render', async () => {
    wire([['GOKU'], []]);

    const result = await generate({
      prompt: 'Goku and Vegeta',
      style: 'anime',
      modelId: 'imagen3',
      screenText: {},
    });

    expect(renderCalls).toBe(2);
    expect(result.metadata.textIntrusion).toBe(false);
    expect(result.metadata.textGuardRerolls).toBe(1);
  });

  it('returns the render flagged rather than throwing when the re-roll budget runs out', async () => {
    // Still lettered after the bounded retry. Showing a flagged design beats
    // showing nothing — the caller decides.
    wire([['GOKU'], ['VEGETA']]);

    const result = await generate({
      prompt: 'Goku and Vegeta',
      style: 'anime',
      modelId: 'imagen3',
      screenText: {},
    });

    expect(renderCalls).toBe(2);
    expect(result.images).toHaveLength(1);
    expect(result.metadata.textIntrusion).toBe(true);
    expect(result.metadata.textIntrusionWords).toEqual(['VEGETA']);
    expect(result.metadata.textGuardRerolls).toBe(1);
  });

  it('returns the lettered first batch when the re-roll itself fails', async () => {
    /*
     * The re-roll runs inside generate()'s primary-dispatch try, so an
     * unguarded throw here would be read as "the first render failed" and
     * trigger provider fallback — discarding a batch the customer already paid
     * for because the free second opinion on it errored.
     */
    let renders = 0;
    fetchMock.mockImplementation(async (url: string) => {
      if (String(url).includes('flash-lite')) {
        guardCalls += 1;
        return ocrResponse(['GOKU']);
      }
      renders += 1;
      renderCalls += 1;
      if (renders === 2) return { ok: false, status: 500, text: async () => 'boom' };
      return renderResponse();
    });

    const result = await generate({
      prompt: 'Goku and Vegeta',
      style: 'anime',
      modelId: 'imagen3',
      screenText: {},
      retry: { maxRetries: 0, baseDelayMs: 1 },
    });

    expect(result.images).toHaveLength(1);
    expect(result.metadata.textIntrusion).toBe(true);
    expect(result.metadata.textIntrusionWords).toEqual(['GOKU']);
    // Failed attempt is not a paid render — billing uses 1 + textGuardRerolls.
    expect(result.metadata.textGuardRerolls).toBeUndefined();
    // Not a fallback: the primary batch is what came back.
    expect(result.metadata.fallbackUsed).toBe(false);
  });

  it('honours a larger re-roll budget', async () => {
    wire([['A'], ['B'], []]);

    const result = await generate({
      prompt: 'a fox',
      style: 'realism',
      modelId: 'imagen3',
      screenText: { maxRerolls: 2 },
    });

    expect(renderCalls).toBe(3);
    expect(result.metadata.textIntrusion).toBe(false);
    expect(result.metadata.textGuardRerolls).toBe(2);
  });

  it('treats non-finite maxRerolls as the default bound of one', async () => {
    // NaN/Infinity never satisfy `rerolls >= maxRerolls`; without a finite
    // default this would unbounded-loop paid renders.
    wire([['A'], ['B'], ['C'], ['D']]);

    const result = await generate({
      prompt: 'a fox',
      style: 'realism',
      modelId: 'imagen3',
      screenText: { maxRerolls: Number.POSITIVE_INFINITY },
    });

    expect(renderCalls).toBe(2);
    expect(result.metadata.textIntrusion).toBe(true);
    expect(result.metadata.textGuardRerolls).toBe(1);
  });

  it('re-rolls when lettering appears despite a "no text" prompt', async () => {
    wire([['GOKU'], []]);

    const result = await generate({
      prompt: 'Goku and Vegeta, no text',
      style: 'anime',
      modelId: 'imagen3',
      screenText: {},
    });

    expect(renderCalls).toBe(2);
    expect(result.metadata.textIntrusion).toBe(false);
    expect(result.metadata.textGuardRerolls).toBe(1);
  });

  it('does not re-roll lettering the customer asked for', async () => {
    // OCR still reads "Margaret" — the request asked for script lettering, so
    // requestsLettering() clears it. A gate that rejected memorial names would
    // break the product to protect it.
    wire([['Margaret']]);

    const result = await generate({
      prompt: "script lettering reading Margaret, my grandmother's name",
      style: 'fine-line',
      modelId: 'imagen3',
      screenText: {},
    });

    expect(renderCalls).toBe(1);
    expect(result.metadata.textIntrusion).toBe(false);
  });

  // #327: both guard fetches are bounded by AbortSignal.timeout. Expiry
  // rejects like any network failure and must degrade to a skipped verdict —
  // a slow third-party host stalls the check, never the customer's reveal.
  it('degrades a timed-out guard fetch to skipped, keeping the render', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (String(url).includes('flash-lite')) {
        guardCalls += 1;
        throw Object.assign(new Error('The operation was aborted due to timeout'), {
          name: 'TimeoutError',
        });
      }
      renderCalls += 1;
      return renderResponse();
    });

    const result = await generate({
      prompt: 'a fox',
      style: 'realism',
      modelId: 'imagen3',
      screenText: {},
    });

    expect(renderCalls).toBe(1);
    expect(result.images).toHaveLength(1);
    expect(result.metadata.textGuardSkipped).toBe('parse');
    expect(result.metadata.textIntrusion).toBeUndefined();
  });

  it('passes an abort signal to both guard fetches', async () => {
    wire([[]]);

    await generate({ prompt: 'a fox', style: 'realism', modelId: 'imagen3', screenText: {} });

    const guardCall = fetchMock.mock.calls.find(([url]) => String(url).includes('flash-lite'));
    expect(guardCall?.[1]?.signal).toBeInstanceOf(AbortSignal);
  });

  it('reports a failed check as skipped, never as clean', async () => {
    wire(['fail']);

    const result = await generate({
      prompt: 'a fox',
      style: 'realism',
      modelId: 'imagen3',
      screenText: {},
    });

    expect(renderCalls).toBe(1);
    expect(result.metadata.textGuardSkipped).toBe('provider');
    // The critical assertion: an outage must not look like a pass.
    expect(result.metadata.textIntrusion).toBeUndefined();
  });

  it('skips screening when the budget is exhausted, and still returns the render', async () => {
    checkBudgetMock.mockResolvedValue({ allowed: false });
    wire([[]]);

    const result = await generate({
      prompt: 'a fox',
      style: 'realism',
      modelId: 'imagen3',
      screenText: {},
    });

    expect(guardCalls).toBe(0);
    expect(result.images).toHaveLength(1);
    expect(result.metadata.textGuardSkipped).toBe('budget');
  });

  it('does not let sibling screens race past a one-call budget remainder', async () => {
    // Near-limit: only one vision call fits. Sequential screening must see
    // the first recordSpend before the second checkBudget; parallel checks
    // would both observe remaining=1 and both call Vertex.
    let remaining = 1;
    checkBudgetMock.mockImplementation(async () =>
      remaining > 0
        ? { allowed: true, spentCents: 0, remainingCents: remaining }
        : { allowed: false, spentCents: 0, remainingCents: 0 }
    );
    recordSpendMock.mockImplementation(async () => {
      remaining -= 1;
    });
    wire([[], []]);

    const result = await generate({
      prompt: 'a fox',
      style: 'realism',
      modelId: 'imagen3',
      numImages: 2,
      screenText: {},
    });

    expect(guardCalls).toBe(1);
    expect(result.metadata.textGuardSkipped).toBe('budget');
  });

  it('re-rolls when one image is lettered even if a sibling screen fails', async () => {
    // Mixed batch: OCR finds lettering on one image, the other vision call
    // fails. Known intrusion must win over the skip — otherwise lettered
    // images ship with only textGuardSkipped set.
    wire([['GOKU'], 'fail', [], []]);

    const result = await generate({
      prompt: 'Goku and Vegeta',
      style: 'anime',
      modelId: 'imagen3',
      numImages: 2,
      screenText: {},
    });

    expect(renderCalls).toBe(4);
    expect(result.metadata.textIntrusion).toBe(false);
    expect(result.metadata.textGuardRerolls).toBe(1);
    expect(result.metadata.textGuardSkipped).toBeUndefined();
  });

  it('does not mark an empty image batch as screened clean', async () => {
    // Replicate can succeed with output: []. That is not a clean pass.
    vi.stubEnv('REPLICATE_API_TOKEN', 'r8_test');
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ id: 'pred_1', status: 'succeeded', output: [] }),
    });

    const result = await generate({
      prompt: 'a fox',
      style: 'realism',
      modelId: 'flux-dev',
      screenText: {},
    });

    expect(result.images).toEqual([]);
    expect(guardCalls).toBe(0);
    expect(result.metadata.textIntrusion).toBeUndefined();
  });

  it('keeps the flagged lettered render when a re-roll returns empty', async () => {
    // A paid re-roll that comes back with output: [] must not drop the prior
    // lettered batch — flagged images beat showing nothing.
    vi.stubEnv('REPLICATE_API_TOKEN', 'r8_test');
    let predictions = 0;
    fetchMock.mockImplementation(async (url: string) => {
      const u = String(url);
      if (u.includes('flash-lite')) {
        guardCalls += 1;
        return ocrResponse(['GOKU']);
      }
      if (u.includes('img.example')) {
        return {
          ok: true,
          headers: { get: () => 'image/png' },
          arrayBuffer: async () => Uint8Array.from([1, 2, 3]).buffer,
        };
      }
      renderCalls += 1;
      predictions += 1;
      if (predictions === 1) {
        return {
          ok: true,
          json: async () => ({
            id: 'pred_1',
            status: 'succeeded',
            output: ['https://img.example/1.png'],
          }),
        };
      }
      return {
        ok: true,
        json: async () => ({ id: 'pred_2', status: 'succeeded', output: [] }),
      };
    });

    const result = await generate({
      prompt: 'a fox',
      style: 'realism',
      modelId: 'flux-dev',
      screenText: {},
    });

    expect(renderCalls).toBe(2);
    expect(result.images).toEqual(['https://img.example/1.png']);
    expect(result.metadata.textIntrusion).toBe(true);
    expect(result.metadata.textIntrusionWords).toEqual(['GOKU']);
    expect(result.metadata.textGuardRerolls).toBe(1);
  });
});

const MEMORIAL = 'in memory of my grandmother Margaret';
const SCRIPT = "script lettering reading Margaret, my grandmother's name";
const HANDWRITTEN = 'a handwritten dedication across the collarbone';
const NO_LETTERING = 'a wolf head in profile, fine detail, high contrast';
const KEY = 'ts_test_secret_key';

describe('lettering Noul — replaces the keyword check when TYPESAFE_LETTERING is on', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    vi.stubEnv('GCP_PROJECT_ID', 'tatt-test');
    vi.stubEnv('TEXT_GUARD_MODEL', 'gemini-3.1-flash-lite');
    vi.stubEnv('TYPESAFE_LETTERING', 'true');
    vi.stubEnv('TYPESAFE_API_KEY', KEY);
    checkBudgetMock.mockResolvedValue({ allowed: true });
    recordSpendMock.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.clearAllMocks();
  });

  function loggedText(): string {
    return JSON.stringify([
      vi.mocked(logger.warn).mock.calls,
      vi.mocked(logger.info).mock.calls,
      vi.mocked(logger.error).mock.calls,
      vi.mocked(logger.debug).mock.calls,
    ]);
  }

  function typesafeCalls(): unknown[][] {
    return fetchMock.mock.calls.filter(([url]) => String(url).includes('api.typesafe.ai'));
  }

  /**
   * Data-URL screens hit Vertex once, then TypeSafe. `noul` is the probability,
   * or a failure mode that must fall back to the keyword list.
   */
  function arm(words: string[], noul: number | 'timeout' | 'http' | 'bad-json') {
    fetchMock.mockImplementation(async (url: string) => {
      if (String(url).includes('api.typesafe.ai')) {
        if (noul === 'timeout') {
          throw Object.assign(new Error('The operation was aborted due to timeout'), {
            name: 'TimeoutError',
          });
        }
        if (noul === 'http') {
          return {
            ok: false,
            status: 503,
            text: async () => `invalid key ${KEY}`,
            json: async () => ({}),
          };
        }
        if (noul === 'bad-json') {
          return {
            ok: true,
            status: 200,
            text: async () => 'nope',
            json: async () => {
              throw new Error(`bad json ${KEY}`);
            },
          };
        }
        return noulResponse(noul);
      }
      return ocrResponse(words);
    });
  }

  it('asks the lettering question and meters one cent on a 2xx', async () => {
    expect(LETTERING_NOUL_QUESTION).toBe(
      'Does this request ask for text, a name, lettering or a script?'
    );
    expect(DEFAULT_LETTERING_NOUL_THRESHOLD).toBe(0.7);
    expect(LETTERING_NOUL_COST_CENTS).toBe(1);
    // The keyword list misses this memorial. The Noul is what clears it.
    expect(requestsLettering(MEMORIAL)).toBe(false);
    arm(['Margaret'], 0.91);

    const verdict = await screenForText('data:image/png;base64,IMG', MEMORIAL);

    expect(verdict).toEqual({ intruded: false, words: ['Margaret'], screened: true });
    expect(recordSpendMock).toHaveBeenCalledTimes(2);
    expect(recordSpendMock).toHaveBeenNthCalledWith(2, LETTERING_NOUL_COST_CENTS);

    const [url, init] = typesafeCalls()[0];
    expect(url).toBe(TYPESAFE_SYSTEMONE_URL);
    expect(init.headers.Authorization).toBe(`Bearer ${KEY}`);
    expect(init.signal).toBeInstanceOf(AbortSignal);
    const body = JSON.parse(init.body);
    expect(body.model).toBe('jev-latest');
    expect(body.state).toBe(MEMORIAL);
    expect(body.questions.requests_lettering.type).toBe('noul');
    expect(body.questions.requests_lettering.instructions).toBe(LETTERING_NOUL_QUESTION);
    expect(body.questions.requests_lettering.options).toBeUndefined();
    expect(body.questions.requests_lettering.criteria.true).toEqual(expect.any(String));
    expect(String(body.questions.requests_lettering.criteria.false).toLowerCase()).toContain('no text');

    const vision = fetchMock.mock.calls.find(([url]) => !String(url).includes('api.typesafe.ai'));
    const visionText = JSON.parse(vision[1].body).contents[0].parts[1].text as string;
    expect(visionText).toContain('List every piece of legible lettering');
    expect(visionText).not.toContain('Does this request ask');
    expect(loggedText()).not.toContain(KEY);
  });

  it('does not re-roll a memorial name the keyword list misses', async () => {
    let renders = 0;
    fetchMock.mockImplementation(async (url: string) => {
      const u = String(url);
      if (u.includes('api.typesafe.ai')) return noulResponse(0.93);
      if (u.includes('flash-lite')) return ocrResponse(['Margaret']);
      renders += 1;
      return renderResponse();
    });

    const result = await generate({
      prompt: MEMORIAL,
      style: 'fine-line',
      modelId: 'imagen3',
      screenText: {},
    });

    expect(requestsLettering(MEMORIAL)).toBe(false);
    expect(renders).toBe(1);
    expect(result.metadata.textIntrusion).toBe(false);
    expect(result.metadata.textGuardRerolls).toBeUndefined();
    expect(recordSpendMock).toHaveBeenCalledWith(LETTERING_NOUL_COST_CENTS);
  });

  it('treats a script request as requested lettering', async () => {
    expect(requestsLettering(SCRIPT)).toBe(true);
    vi.stubEnv('TYPESAFE_MODEL', 'jev-1.13.0');
    arm(['Margaret'], 0.97);

    const verdict = await screenForText('data:image/png;base64,IMG', SCRIPT);

    expect(verdict).toEqual({ intruded: false, words: ['Margaret'], screened: true });
    const body = JSON.parse(typesafeCalls()[0][1].body);
    expect(body.model).toBe('jev-1.13.0');
    expect(body.questions.requests_lettering.instructions).toBe(
      'Does this request ask for text, a name, lettering or a script?'
    );
  });

  it('clears a script phrasing the keyword list does not recognise', async () => {
    // "handwritten" contains "written" but not as a whole word, so the
    // fallback would re-roll this dedication. The Noul is the decision.
    expect(requestsLettering(HANDWRITTEN)).toBe(false);
    arm(['For Elise'], 0.88);

    const verdict = await screenForText('data:image/png;base64,IMG', HANDWRITTEN);

    expect(verdict).toEqual({ intruded: false, words: ['For Elise'], screened: true });
  });

  it('still flags lettering when the request asked for none', async () => {
    expect(requestsLettering(NO_LETTERING)).toBe(false);
    let renders = 0;
    let guards = 0;
    fetchMock.mockImplementation(async (url: string) => {
      const u = String(url);
      if (u.includes('api.typesafe.ai')) return noulResponse(0.05);
      if (u.includes('flash-lite')) {
        guards += 1;
        return ocrResponse(guards === 1 ? ['GOKU'] : []);
      }
      renders += 1;
      return renderResponse();
    });

    const result = await generate({
      prompt: NO_LETTERING,
      style: 'realism',
      modelId: 'imagen3',
      screenText: {},
    });

    expect(renders).toBe(2);
    expect(result.metadata.textIntrusion).toBe(false);
    expect(result.metadata.textGuardRerolls).toBe(1);
    expect(typesafeCalls()).toHaveLength(1);
  });

  it('uses a low Noul even when the keyword list would have allowed the words', async () => {
    const prompt = 'the word RESILIENCE in bold cursive';
    expect(requestsLettering(prompt)).toBe(true);
    arm(['RESILIENCE'], 0.04);

    const verdict = await screenForText('data:image/png;base64,IMG', prompt);

    expect(verdict).toEqual({ intruded: true, words: ['RESILIENCE'], screened: true });
  });

  it('counts a Noul equal to the threshold as a request for lettering', async () => {
    arm(['Margaret'], DEFAULT_LETTERING_NOUL_THRESHOLD);

    const verdict = await screenForText('data:image/png;base64,IMG', MEMORIAL);

    expect(verdict.intruded).toBe(false);
  });

  it('honours a lower threshold and ignores one outside 0..1', async () => {
    arm(['Margaret'], 0.65);

    const belowDefault = await screenForText('data:image/png;base64,IMG', MEMORIAL);
    expect(belowDefault.intruded).toBe(true);

    vi.stubEnv('TYPESAFE_LETTERING_THRESHOLD', '0.6');
    const lowered = await screenForText('data:image/png;base64,IMG', MEMORIAL);
    expect(lowered.intruded).toBe(false);

    vi.stubEnv('TYPESAFE_LETTERING_THRESHOLD', '1.5');
    const ignored = await screenForText('data:image/png;base64,IMG', MEMORIAL);
    expect(ignored.intruded).toBe(true);
  });

  it('does not call TypeSafe when OCR found no lettering', async () => {
    arm([], 0.99);

    const verdict = await screenForText('data:image/png;base64,IMG', MEMORIAL);

    expect(verdict).toEqual({ intruded: false, words: [], screened: true });
    expect(typesafeCalls()).toHaveLength(0);
    expect(recordSpendMock).toHaveBeenCalledTimes(1);
  });

  it('falls back to the keyword check when the flag is off', async () => {
    vi.stubEnv('TYPESAFE_LETTERING', 'false');
    arm(['Margaret'], 0.99);

    const verdict = await screenForText('data:image/png;base64,IMG', MEMORIAL);

    expect(verdict.intruded).toBe(true);
    expect(typesafeCalls()).toHaveLength(0);
    expect(recordSpendMock).toHaveBeenCalledTimes(1);
  });

  it('falls back to the keyword check when the key is missing', async () => {
    vi.stubEnv('TYPESAFE_API_KEY', '');
    arm(['Margaret'], 0.99);

    const verdict = await screenForText('data:image/png;base64,IMG', MEMORIAL);

    expect(verdict.intruded).toBe(true);
    expect(typesafeCalls()).toHaveLength(0);
    expect(loggedText()).not.toContain(KEY);
  });

  it('falls back to the keyword check on timeout without metering the call', async () => {
    arm(['Margaret'], 'timeout');

    const verdict = await screenForText('data:image/png;base64,IMG', MEMORIAL);

    expect(verdict.intruded).toBe(true);
    expect(recordSpendMock).toHaveBeenCalledTimes(1);
    expect(loggedText()).toContain('timeout');
    expect(loggedText()).not.toContain(KEY);
  });

  it('falls back to the keyword check on an HTTP error and does not log the key', async () => {
    arm(['Margaret'], 'http');

    const verdict = await screenForText('data:image/png;base64,IMG', MEMORIAL);

    expect(verdict.intruded).toBe(true);
    expect(recordSpendMock).toHaveBeenCalledTimes(1);
    expect(loggedText()).not.toContain(KEY);
  });

  it('meters a 2xx whose body cannot be parsed, then uses the keyword check', async () => {
    arm(['Margaret'], 'bad-json');

    const verdict = await screenForText('data:image/png;base64,IMG', MEMORIAL);

    expect(verdict.intruded).toBe(true);
    expect(recordSpendMock).toHaveBeenNthCalledWith(2, LETTERING_NOUL_COST_CENTS);
    expect(loggedText()).not.toContain(KEY);
  });

  it('falls back to the keyword check when the cap cannot cover the Noul', async () => {
    checkBudgetMock
      .mockResolvedValueOnce({ allowed: true, remainingCents: 1 })
      .mockResolvedValueOnce({ allowed: false, remainingCents: 0 });
    arm(['Margaret'], 0.99);

    const verdict = await screenForText('data:image/png;base64,IMG', MEMORIAL);

    expect(verdict.intruded).toBe(true);
    expect(typesafeCalls()).toHaveLength(0);
    expect(recordSpendMock).toHaveBeenCalledTimes(1);
  });
});
