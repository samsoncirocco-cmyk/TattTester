/**
 * TypeSafe design routing: one System One call decides "enough to generate"
 * and which question axis to ask. Ready promotes, not-ready asks, down
 * (and low confidence) keeps the engine and the SMS size line.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { converse } from '../index';
import { clearMemorySessions } from '../internal/store';
import { runTurn } from '@/services/designConversation';
import type { ConversationTurnResult, TurnLog } from '@/services/designConversation/types';
import { checkBudget, recordSpend } from '@/lib/budget-tracker';
import { logger } from '@/lib/logger';
import { planPlacementFollowUp, widthFractionFor } from '@/services/sketchbotSms/internal/placement';
import { PLACEMENT_DONE_TEXT } from '@/services/sketchbotSms/internal/render';
import {
  DESIGN_ROUTING_COST_CENTS,
  questionForAxis,
  routeDesignTurn,
  TYPESAFE_SYSTEMONE_URL,
} from '../typesafeDesignRouting';

const KEY = 'ts_test_key';

vi.mock('@/services/designConversation', () => {
  class ConversationUnavailableError extends Error {
    constructor(message = 'every provider exhausted') {
      super(message);
      this.name = 'ConversationUnavailableError';
    }
  }
  return {
    runTurn: vi.fn(),
    opener: () => 'Where on your body are you thinking, and what should it mean?',
    HANDOFF_URL: '/smart-match',
    ConversationUnavailableError,
  };
});
vi.mock('@/services/intake', () => ({ extractIntake: vi.fn() }));
vi.mock('@/services/council', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  enhanceStructured: vi.fn(),
}));
vi.mock('@/services/generation', () => ({ generate: vi.fn(), routeGeneration: vi.fn() }));
vi.mock('@/lib/firebase-admin', () => ({ ensureAdminApp: vi.fn(() => false) }));
vi.mock('@/services/gcs-service', () => ({
  uploadToGCS: vi.fn(),
  getSignedUrl: vi.fn(async (path: string) => `https://signed.example/${path}?sig=test`),
}));
vi.mock('@/services/storage/imageStorageService', () => ({
  recoverImageAtPath: vi.fn(async () => null),
  copyImageToPath: vi.fn(async (path: string) => `https://storage.example/${path}`),
  uploadImageToPath: vi.fn(async (path: string) => `https://storage.example/${path}`),
}));
vi.mock('@/lib/budget-tracker', () => ({
  recordSpend: vi.fn(async () => {}),
  checkBudget: vi.fn(async () => ({ allowed: true, spentCents: 0, remainingCents: 1000 })),
  VERTEX_IMAGEN_COST_CENTS: 4,
}));
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  createRequestLogger: vi.fn(),
}));

const runTurnMock = vi.mocked(runTurn);

const readyRecord = {
  placement: 'forearm',
  styleTags: ['fine-line'],
  meaning: 'for my grandmother',
  subject: 'a sparrow',
  references: [],
  ambiguousAxes: [],
};

function turnLog(overrides: Partial<TurnLog> = {}): TurnLog {
  return {
    turn: 1,
    confidence: 0.55,
    missingFields: ['styleTags'],
    firedRule: 'none',
    model: 'gemini-2.0-flash',
    ...overrides,
  };
}

function turnResult(overrides: Partial<ConversationTurnResult> = {}): ConversationTurnResult {
  return {
    reply: 'tell me more about the sparrow',
    stage: 'chatting',
    record: readyRecord,
    turnLog: turnLog(),
    notes: { cast: ['a sparrow'], ipHeadsUp: true, sufficient: true, placement: 'forearm' },
    ...overrides,
  };
}

function enableRouting(): void {
  vi.stubEnv('TYPESAFE_DESIGN_ROUTING', 'true');
  vi.stubEnv('TYPESAFE_API_KEY', KEY);
  vi.stubEnv('TYPESAFE_MODEL', 'jev-latest');
  vi.stubEnv('NEXT_PUBLIC_DEMO_MODE', 'false');
}

function typesafeBody(noul: number, choice: string, confidence: number) {
  return {
    model: 'jev-1.13.0',
    answers: {
      enough_to_generate: { type: 'noul', noul },
      next_question: {
        type: 'choice',
        choice,
        confidence,
        probabilities: { [choice]: 0.9 },
      },
    },
    usage: { input_tokens: 640, output_tokens: 28 },
  };
}

function mockTypesafe(noul: number, choice: string, confidence: number) {
  const fetchMock = vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => typesafeBody(noul, choice, confidence),
    text: async () => '',
  }));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

async function userTurn(engine: ConversationTurnResult) {
  const opened = await converse({});
  runTurnMock.mockResolvedValueOnce(engine);
  return converse({
    sessionId: opened.sessionId,
    message: 'a sparrow on my forearm for my grandmother',
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  clearMemorySessions();
  vi.stubEnv('TYPESAFE_DESIGN_ROUTING', 'false');
  vi.stubEnv('TYPESAFE_API_KEY', '');
  vi.stubEnv('NEXT_PUBLIC_DEMO_MODE', 'false');
  vi.mocked(checkBudget).mockResolvedValue({ allowed: true, spentCents: 0, remainingCents: 1000 });
  runTurnMock.mockResolvedValue(turnResult());
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('design session routing', () => {
  it('promotes a chatting turn when the brief is ready', async () => {
    enableRouting();
    const fetchMock = mockTypesafe(0.91, 'color', 0.22);
    const response = await userTurn(turnResult());

    expect(response.stage).toBe('proposal');
    expect(response.reply).toContain("here's what i'm hearing:");
    expect(response.reply).toContain('forearm');
    expect(response.playback).toMatch(/sparrow/);
    expect(response.playback).toMatch(/forearm/);
    expect(response.gate).toBeUndefined();
    expect(response.notes?.sufficient).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(TYPESAFE_SYSTEMONE_URL);
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Bearer ${KEY}`);
    const body = JSON.parse(String(init.body));
    expect(body.model).toBe('jev-latest');
    expect(body.state.channel).toBe('design-session');
    expect(body.questions.enough_to_generate.type).toBe('noul');
    expect(body.questions.enough_to_generate.criteria.true).toEqual(expect.any(String));
    expect(body.questions.next_question.type).toBe('choice');
    expect(body.questions.next_question.options).toBeUndefined();
    expect(Object.keys(body.questions.next_question.criteria).sort()).toEqual(
      ['bold-fine', 'color', 'literal-abstract', 'minimal-ornate', 'other', 'placement', 'size', 'style', 'subject'].sort()
    );
    expect(JSON.stringify(body)).not.toContain(KEY);
    expect(recordSpend).toHaveBeenCalledTimes(1);
    expect(recordSpend).toHaveBeenCalledWith(DESIGN_ROUTING_COST_CENTS);
    expect(JSON.stringify(vi.mocked(logger.info).mock.calls)).not.toContain(KEY);
    expect(JSON.stringify(vi.mocked(logger.warn).mock.calls)).not.toContain(KEY);
  });

  it('asks the chosen axis when the brief is not ready', async () => {
    enableRouting();
    mockTypesafe(0.08, 'style', 0.86);
    const response = await userTurn(
      turnResult({
        reply: "here's what i'm hearing: a sparrow on your forearm. want to see two cuts?",
        stage: 'proposal',
        playback: 'a sparrow on your forearm',
        turnLog: turnLog({ firedRule: 'judgment', confidence: 0.84, missingFields: [] }),
      })
    );

    expect(response.stage).toBe('chatting');
    expect(response.reply).toBe(questionForAxis('style'));
    expect(response.playback).toBeUndefined();
    expect(response.gate?.blocking).toBe('styleTags');
    expect(response.notes?.sufficient).toBe(false);
    expect(recordSpend).toHaveBeenCalledTimes(1);
  });

  it('keeps the engine turn when TypeSafe is down', async () => {
    enableRouting();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: false,
        status: 503,
        json: async () => ({}),
        text: async () => '{"detail":"unavailable"}',
      }))
    );
    const engineReply = 'tell me more about the sparrow';
    const response = await userTurn(turnResult({ reply: engineReply }));

    expect(response.stage).toBe('chatting');
    expect(response.reply).toBe(engineReply);
    expect(recordSpend).not.toHaveBeenCalled();
    expect(JSON.stringify(vi.mocked(logger.warn).mock.calls)).not.toContain('unavailable');
    expect(JSON.stringify(vi.mocked(logger.warn).mock.calls)).not.toContain(KEY);
  });

  it('keeps the engine turn when confidence is low', async () => {
    enableRouting();
    mockTypesafe(0.52, 'subject', 0.21);
    const engineReply = "here's what i'm hearing: a sparrow on your forearm. want to see two cuts?";
    const response = await userTurn(
      turnResult({
        reply: engineReply,
        stage: 'proposal',
        playback: 'a sparrow on your forearm',
        turnLog: turnLog({ firedRule: 'judgment', confidence: 0.8, missingFields: [] }),
      })
    );

    expect(response.stage).toBe('proposal');
    expect(response.reply).toBe(engineReply);
    expect(response.playback).toBe('a sparrow on your forearm');
  });

  it('does not call TypeSafe when the flag is off or the rule is not steerable', async () => {
    const fetchMock = mockTypesafe(0.99, 'placement', 0.99);
    const off = await userTurn(turnResult());
    expect(off.stage).toBe('chatting');
    expect(off.reply).toBe('tell me more about the sparrow');
    expect(fetchMock).not.toHaveBeenCalled();

    enableRouting();
    const handoff = await userTurn(
      turnResult({
        reply: 'sit with an artist',
        stage: 'handoff',
        turnLog: turnLog({ firedRule: 'turn20-handoff' }),
      })
    );
    expect(handoff.stage).toBe('handoff');
    expect(handoff.handoffUrl).toBe('/smart-match');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('routeDesignTurn fallbacks', () => {
  const input = {
    channel: 'design-session' as const,
    transcript: [{ role: 'user' as const, text: 'a sparrow on my forearm' }],
    record: readyRecord,
    stage: 'chatting' as const,
    firedRule: 'none' as const,
  };

  it('times out and redacts the key from the error', async () => {
    enableRouting();
    vi.stubEnv('TYPESAFE_TIMEOUT_MS', '20');
    vi.stubGlobal('fetch', (_url: string, init?: RequestInit) => {
      return new Promise((_resolve, reject) => {
        const signal = init?.signal;
        const fail = () => reject(new DOMException(`timed out ${KEY}`, 'TimeoutError'));
        if (!signal) {
          fail();
          return;
        }
        if (signal.aborted) fail();
        else signal.addEventListener('abort', fail, { once: true });
      });
    });

    const decision = await routeDesignTurn(input);
    expect(decision).toEqual({ action: 'keep', reason: 'timeout' });
    expect(recordSpend).not.toHaveBeenCalled();
    const logged = JSON.stringify(vi.mocked(logger.warn).mock.calls);
    expect(logged).not.toContain(KEY);
    expect(logged).toContain('[redacted]');
  });

  it('skips the call when the key is missing or the budget is spent', async () => {
    vi.stubEnv('TYPESAFE_DESIGN_ROUTING', 'true');
    vi.stubEnv('TYPESAFE_API_KEY', '');
    const fetchMock = mockTypesafe(0.99, 'size', 0.99);
    expect(await routeDesignTurn(input)).toEqual({ action: 'keep', reason: 'missing_key' });
    expect(fetchMock).not.toHaveBeenCalled();

    enableRouting();
    vi.mocked(checkBudget).mockResolvedValueOnce({
      allowed: false,
      spentCents: 50000,
      remainingCents: 0,
    });
    expect(await routeDesignTurn(input)).toEqual({ action: 'keep', reason: 'budget' });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(recordSpend).not.toHaveBeenCalled();
  });

  it('honors a raised yes-threshold and a malformed body', async () => {
    enableRouting();
    vi.stubEnv('TYPESAFE_DESIGN_NOUL_YES', '0.95');
    mockTypesafe(0.91, 'color', 0.1);
    const below = await routeDesignTurn({ ...input, stage: 'proposal', firedRule: 'judgment' });
    expect(below.action).toBe('keep');
    if (below.action === 'keep') expect(below.reason).toBe('low_confidence');

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({ answers: {} }),
        text: async () => '',
      }))
    );
    expect(await routeDesignTurn(input)).toEqual({ action: 'keep', reason: 'parse' });
    expect(recordSpend).toHaveBeenCalledWith(DESIGN_ROUTING_COST_CENTS);
  });
});

describe('SMS placement follow-up', () => {
  const brief = {
    placement: 'forearm',
    styleTags: ['fine-line'],
    meaning: 'for my grandmother',
    subject: 'a sparrow',
  };

  it('keeps the size line when the design is ready', async () => {
    enableRouting();
    const fetchMock = mockTypesafe(0.94, 'subject', 0.9);
    const plan = await planPlacementFollowUp('way bigger', brief);

    expect(plan.closingText).toBe(PLACEMENT_DONE_TEXT);
    expect(plan.widthFraction).toBe(widthFractionFor('way bigger'));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse(String((fetchMock.mock.calls[0] as [string, RequestInit])[1].body));
    expect(body.state.channel).toBe('sms-placement');
    expect(body.state.designAlreadyGenerated).toBe(true);
    expect(body.questions.next_question.options).toBeUndefined();
  });

  it('asks the chosen axis when the brief is not ready', async () => {
    enableRouting();
    mockTypesafe(0.05, 'subject', 0.84);
    const plan = await planPlacementFollowUp('a bit smaller', brief);

    expect(plan.closingText).toBe(questionForAxis('subject'));
    expect(plan.widthFraction).toBe(widthFractionFor('a bit smaller'));
  });

  it('keeps the size line when TypeSafe is down or the flag is off', async () => {
    enableRouting();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: false,
        status: 503,
        text: async () => '',
        json: async () => ({}),
      }))
    );
    const down = await planPlacementFollowUp('here', brief);
    expect(down.closingText).toBe(PLACEMENT_DONE_TEXT);
    expect(down.widthFraction).toBe(widthFractionFor('here'));

    vi.stubEnv('TYPESAFE_DESIGN_ROUTING', 'false');
    const fetchMock = mockTypesafe(0.01, 'subject', 0.99);
    const off = await planPlacementFollowUp('bigger', brief);
    expect(off.closingText).toBe(PLACEMENT_DONE_TEXT);
    expect(off.widthFraction).toBe(widthFractionFor('bigger'));
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
