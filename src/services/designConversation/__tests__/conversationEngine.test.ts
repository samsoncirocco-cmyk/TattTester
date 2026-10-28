/**
 * Conversation engine tests (ADR-0019, ADR-0020, ADR-0021, ADR-0022).
 *
 * Providers are fully mocked — no live LLM/API calls. The ontology comes
 * from a local fixture (never the real data/style-ontology.json, owned by
 * another workstream) via the STYLE_ONTOLOGY_PATH override.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  opener,
  runTurn,
  ConversationUnavailableError,
  HANDOFF_URL,
  type ConversationMessage,
} from '../index';
import { scoreRecord, CONFIDENCE_THRESHOLD } from '../internal/confidence';
// Assert against the constants, not their wording. These tests are about the
// beat firing, not about the copy in it — hardcoding the sentence made a pure
// copy change look like nine behavioural regressions.
import {
  HANDOFF_MESSAGE,
  PROPOSAL_AFFORDANCE,
  PROPOSAL_LEAD,
  PROPOSAL_REMINDER,
  STALLED_PLACEMENT_ASK,
  STALLED_PLACEMENT_REASK,
  STALLED_MEANING_ASK,
} from '../internal/persona';
import { STALLED_FIELD_TURNS, DEFAULT_PLACEMENT } from '../internal/gate';
import type { TurnLog } from '../types';
import { resetStyleTagCache } from '../internal/ontology';
import { buildPlayback } from '../internal/engine';
import {
  PROVIDER_FAILOVER_EVENT,
  CONVERSATION_DEGRADED_EVENT,
  DEFAULT_VERTEX_MODEL,
} from '../internal/providers';
import { logger } from '@/lib/logger';

vi.mock('@/lib/google-auth-edge', () => ({
  getGcpAccessToken: vi.fn().mockResolvedValue('test-gcp-token'),
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

// Every env var the module reads — cleared per test so cases are hermetic
// regardless of the developer's local .env.
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
];

let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  savedEnv = {};
  for (const key of [...ENV_KEYS, 'STYLE_ONTOLOGY_PATH']) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  process.env.STYLE_ONTOLOGY_PATH = FIXTURE_PATH;
  resetStyleTagCache();
});

afterEach(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

/* ── helpers ─────────────────────────────────────────────────────────────── */

function configureVertex() {
  process.env.NEXT_PUBLIC_VERTEX_AI_PROJECT_ID = 'tatt-test';
  process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON = '{"project_id":"tatt-test"}';
}

function configureOpenRouter() {
  process.env.OPENROUTER_API_KEY = 'test-key';
}

function vertexResponse(payload: unknown) {
  return {
    ok: true,
    json: async () => ({
      candidates: [{ content: { parts: [{ text: JSON.stringify(payload) }] } }],
    }),
  };
}

function openRouterResponse(payload: unknown) {
  return {
    ok: true,
    json: async () => ({
      choices: [{ message: { content: JSON.stringify(payload) } }],
    }),
  };
}

function stubFetchNever() {
  const fetchMock = vi.fn(() => {
    throw new Error('unexpected network call in offline test');
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const MESSAGES: ConversationMessage[] = [
  { role: 'bot', text: opener() },
  { role: 'user', text: 'thinking my left forearm, a hummingbird for my grandmother' },
];

/** Rich extraction: confidence 0.8 (0.3 placement + 0.3 meaning + 0.1 tag + 0.1 axes). */
const RICH_PAYLOAD = {
  reply: 'Love that — fine line suits a hummingbird beautifully.',
  record: {
    placement: 'left forearm',
    styleTags: ['fine line'],
    meaning: 'a hummingbird for my grandmother, delicate and warm',
    references: [],
    ambiguousAxes: ['color-blackwork', 'literal-abstract'],
  },
};

/** Sparse extraction: confidence 0. */
const SPARSE_PAYLOAD = {
  reply: 'Where on your body are you thinking?',
  record: {
    placement: '',
    styleTags: [],
    meaning: '',
    references: [],
    ambiguousAxes: ['bold-fine', 'color-blackwork', 'literal-abstract', 'minimal-ornate'],
  },
};

/* ── opener ──────────────────────────────────────────────────────────────── */

describe('opener', () => {
  it('is deterministic and leads with placement and meaning (ADR-0019)', () => {
    expect(opener()).toBe(opener());
    expect(opener().toLowerCase()).toContain('where on your body');
    expect(opener().toLowerCase()).toContain('mean');
  });
});

/* ── cadence: judgment fire / no-fire ────────────────────────────────────── */

describe('runTurn — judgment cadence', () => {
  it('fires the proposal when the record completes early (ADR-0020)', async () => {
    configureVertex();
    const fetchMock = vi.fn().mockResolvedValue(vertexResponse(RICH_PAYLOAD));
    vi.stubGlobal('fetch', fetchMock);

    const result = await runTurn({ messages: MESSAGES, userTurn: 3 });

    expect(result.stage).toBe('proposal');
    expect(result.turnLog.firedRule).toBe('judgment');
    expect(result.turnLog.confidence).toBeGreaterThanOrEqual(CONFIDENCE_THRESHOLD);
    expect(result.playback).toBeTruthy();
    // ADR-0020's exact phrasing style.
    expect(result.reply).toBe(
      `${PROPOSAL_LEAD} ${result.playback}. ${PROPOSAL_AFFORDANCE}`
    );
    expect(result.playback).toContain('fine line');
    expect(result.playback).toContain('left forearm');
    expect(result.record.placement).toBe('left forearm');
  });

  it('does not fire below the threshold — the model reply passes through', async () => {
    configureVertex();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(vertexResponse(SPARSE_PAYLOAD)));

    const result = await runTurn({ messages: MESSAGES, userTurn: 3 });

    expect(result.stage).toBe('chatting');
    expect(result.turnLog.firedRule).toBe('none');
    expect(result.turnLog.confidence).toBeLessThan(CONFIDENCE_THRESHOLD);
    expect(result.playback).toBeUndefined();
    expect(result.reply).toBe(SPARSE_PAYLOAD.reply);
  });

  it('requires placement AND meaning even at high confidence', async () => {
    configureVertex();
    // Strong style/axis signal but no placement: 0.3 meaning + 0.2 tags +
    // 0.2 axes = 0.7 — meets the threshold but must NOT fire.
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        vertexResponse({
          reply: 'Sounds striking. Where would it live on your body?',
          record: {
            placement: '',
            styleTags: ['blackwork', 'japanese'],
            meaning: 'a koi swimming upstream for perseverance through hard years',
            references: [],
            ambiguousAxes: [],
          },
        })
      )
    );

    const result = await runTurn({ messages: MESSAGES, userTurn: 4 });

    expect(result.turnLog.confidence).toBeGreaterThanOrEqual(CONFIDENCE_THRESHOLD);
    expect(result.stage).toBe('chatting');
    expect(result.turnLog.firedRule).toBe('none');
  });
});

/* ── cadence: forced proposal and handoff ────────────────────────────────── */

describe('runTurn — forced cadence (deterministic code, not model judgment)', () => {
  it('forces the proposal at user turn 12 with a best-guess playback', async () => {
    configureVertex();
    // Placement present, everything else sparse: the forced best-guess fires
    // on every open question EXCEPT placement, which gates it (ADR-0021
    // amendment) — this payload used to be fully sparse, which encoded the
    // empty-placement → silent-forearm bug as correct behaviour.
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        vertexResponse({
          ...SPARSE_PAYLOAD,
          record: { ...SPARSE_PAYLOAD.record, placement: 'shoulder' },
        })
      )
    );

    const result = await runTurn({ messages: MESSAGES, userTurn: 12 });

    expect(result.stage).toBe('proposal');
    expect(result.turnLog.firedRule).toBe('turn12-force-proposal');
    expect(result.playback).toBeTruthy();
    expect(result.reply).toContain(PROPOSAL_LEAD);
    expect(result.reply).toContain(PROPOSAL_AFFORDANCE);
    // Best guess on a sparse record still reads as a judgment call, not a limit.
    expect(result.reply).not.toMatch(/limit|turn|cap/i);
  });

  it('asks for placement instead of proposing when turn 12 arrives without one (ADR-0021 amendment)', async () => {
    configureVertex();
    // Sparse record: no placement extracted by turn 12. The waiter may not
    // walk to the kitchen without a real order — the bot must ask, not guess.
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(vertexResponse(SPARSE_PAYLOAD)));

    const result = await runTurn({ messages: MESSAGES, userTurn: 12 });

    expect(result.stage).toBe('chatting');
    expect(result.turnLog.firedRule).toBe('turn12-ask-placement');
    expect(result.playback).toBeUndefined();
    expect(result.reply.toLowerCase()).toContain('where on your body');
    // Still framed as a judgment call, never a surfaced limit.
    expect(result.reply).not.toMatch(/limit|turn|cap/i);
  });

  it('holds the placement gate on later turns until an answer lands', async () => {
    configureVertex();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(vertexResponse(SPARSE_PAYLOAD)));

    const result = await runTurn({ messages: MESSAGES, userTurn: 15 });

    expect(result.stage).toBe('chatting');
    expect(result.turnLog.firedRule).toBe('turn12-ask-placement');
  });

  it('proposes past the gate once the placement answer lands, brief carrying it', async () => {
    configureVertex();
    const answeredMessages: ConversationMessage[] = [
      ...MESSAGES,
      { role: 'bot', text: 'Where on your body is this going?' },
      { role: 'user', text: 'left forearm' },
    ];
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        vertexResponse({
          reply: 'Left forearm it is.',
          record: { ...SPARSE_PAYLOAD.record, placement: 'left forearm' },
        })
      )
    );

    const result = await runTurn({ messages: answeredMessages, userTurn: 13 });

    expect(result.stage).toBe('proposal');
    expect(result.turnLog.firedRule).toBe('turn12-force-proposal');
    expect(result.record.placement).toBe('left forearm');
    expect(result.playback).toContain('left forearm');
    // Never the "placement still open" phrasing — the brief has a real answer.
    expect(result.playback).not.toContain('placement still open');
  });

  it('hands off warmly at user turn 20 (ADR-0021 phrasing, never a limit)', async () => {
    configureVertex();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(vertexResponse(SPARSE_PAYLOAD)));

    const result = await runTurn({ messages: MESSAGES, userTurn: 20 });

    expect(result.stage).toBe('handoff');
    expect(result.turnLog.firedRule).toBe('turn20-handoff');
    expect(result.reply).toBe(HANDOFF_MESSAGE);
    expect(result.reply).not.toMatch(/limit|cap/i);
    expect(HANDOFF_URL).toBe('/smart-match');
  });
});

/* ── confidence formula ──────────────────────────────────────────────────── */

describe('confidence scoring', () => {
  it('is monotonically non-decreasing as the record grows', () => {
    const growth = [
      {},
      { placement: 'arm' },
      { placement: 'left forearm' },
      { placement: 'left forearm', meaning: 'for grandma' },
      {
        placement: 'left forearm',
        meaning: 'a hummingbird for my grandmother who fed them',
      },
      {
        placement: 'left forearm',
        meaning: 'a hummingbird for my grandmother who fed them',
        styleTags: ['fine-line'],
      },
      {
        placement: 'left forearm',
        meaning: 'a hummingbird for my grandmother who fed them',
        styleTags: ['fine-line', 'blackwork'],
        ambiguousAxes: ['literal-abstract' as const],
      },
      {
        placement: 'left forearm',
        meaning: 'a hummingbird for my grandmother who fed them',
        styleTags: ['fine-line', 'blackwork'],
        ambiguousAxes: [],
      },
    ];

    const scores = growth.map((record) => scoreRecord(record).confidence);
    for (let i = 1; i < scores.length; i += 1) {
      expect(scores[i]).toBeGreaterThanOrEqual(scores[i - 1]);
    }
    expect(scores[0]).toBe(0);
    expect(scores[scores.length - 1]).toBe(1);
  });

  it('reports missing/weak fields', () => {
    expect(scoreRecord({}).missingFields).toEqual([
      'placement',
      'meaning',
      'styleTags',
    ]);
    // Vague placement and trivial meaning are weak, not full credit. One
    // committed style tag is a RESOLVED style (ADR-0023: "style tags
    // present +0.20") — never reported weak.
    const weak = scoreRecord({ placement: 'arm', meaning: 'for grandma', styleTags: ['fine-line'] });
    expect(weak.missingFields).toEqual(['placement', 'meaning']);
    const full = scoreRecord({
      placement: 'left forearm',
      meaning: 'a hummingbird for my grandmother who fed them',
      styleTags: ['fine-line', 'blackwork'],
      ambiguousAxes: [],
    });
    expect(full.missingFields).toEqual([]);
  });

  it('surfaces missingFields in the TurnLog', async () => {
    configureVertex();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(vertexResponse(SPARSE_PAYLOAD)));

    const result = await runTurn({ messages: MESSAGES, userTurn: 2 });

    expect(result.turnLog.missingFields).toEqual(['placement', 'meaning', 'styleTags']);
  });
});

/* ── extraction contract ─────────────────────────────────────────────────── */

describe('runTurn — extraction sanitization', () => {
  it('validates style tags against the closed ontology (aliases resolve, unknowns drop)', async () => {
    configureVertex();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        vertexResponse({
          reply: 'Nice.',
          record: {
            placement: 'Ribs',
            styleTags: ['Old School', 'fineline', 'trash-polka'],
            meaning: 'a bold eagle for my dad who served in the navy',
            references: ['https://pin.it/abc'],
            ambiguousAxes: ['color-blackwork', 'not-an-axis'],
          },
        })
      )
    );

    const result = await runTurn({ messages: MESSAGES, userTurn: 2 });

    expect(result.record.styleTags).toEqual(['american-traditional', 'fine-line']);
    expect(result.record.placement).toBe('ribs');
    expect(result.record.references).toEqual(['https://pin.it/abc']);
    // Non-pool axes are filtered out.
    expect(result.record.ambiguousAxes).toEqual(['color-blackwork']);
    // Meaning survives as given — the engine never rewrites it.
    expect(result.record.meaning).toBe('a bold eagle for my dad who served in the navy');
  });
});

/* ── providers ───────────────────────────────────────────────────────────── */

describe('runTurn — provider chain', () => {
  it('prefers Vertex, honors CONVERSATION_MODEL, and records the model in the TurnLog', async () => {
    configureVertex();
    configureOpenRouter();
    process.env.CONVERSATION_MODEL = 'gemini-2.5-flash-lite';
    const fetchMock = vi.fn().mockResolvedValue(vertexResponse(SPARSE_PAYLOAD));
    vi.stubGlobal('fetch', fetchMock);

    const result = await runTurn({ messages: MESSAGES, userTurn: 1 });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toContain('aiplatform.googleapis.com');
    expect(fetchMock.mock.calls[0][0]).toContain('gemini-2.5-flash-lite');
    expect(result.turnLog.model).toBe('gemini-2.5-flash-lite');
  });

  it('falls back to GLM-5.2 via OpenRouter when Vertex fails', async () => {
    configureVertex();
    configureOpenRouter();
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error('vertex down'))
      .mockResolvedValueOnce(openRouterResponse(SPARSE_PAYLOAD));
    vi.stubGlobal('fetch', fetchMock);

    const result = await runTurn({ messages: MESSAGES, userTurn: 1 });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][0]).toContain('aiplatform.googleapis.com');
    expect(fetchMock.mock.calls[1][0]).toContain('openrouter.ai');
    const openRouterBody = JSON.parse(fetchMock.mock.calls[1][1].body);
    expect(openRouterBody.model).toBe('z-ai/glm-5.2');
    expect(result.turnLog.model).toBe('z-ai/glm-5.2');
  });

  it('tries the pinned model first (per-session pinning is the caller job)', async () => {
    configureVertex();
    configureOpenRouter();
    const fetchMock = vi.fn().mockResolvedValue(openRouterResponse(SPARSE_PAYLOAD));
    vi.stubGlobal('fetch', fetchMock);

    const result = await runTurn({
      messages: MESSAGES,
      userTurn: 2,
      pinnedModel: 'z-ai/glm-5.2',
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toContain('openrouter.ai');
    expect(result.turnLog.model).toBe('z-ai/glm-5.2');
  });

  // #327: both provider fetches carry a timeout signal, and expiry (a
  // TimeoutError throw) rides the existing failover — a stalled Vertex
  // never hangs the turn, the next provider answers instead.
  it('bounds both provider calls and fails over when the timeout fires', async () => {
    configureVertex();
    configureOpenRouter();
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(
        new DOMException('The operation was aborted due to timeout', 'TimeoutError')
      )
      .mockResolvedValueOnce(openRouterResponse(SPARSE_PAYLOAD));
    vi.stubGlobal('fetch', fetchMock);

    const result = await runTurn({ messages: MESSAGES, userTurn: 1 });

    expect(result.turnLog.model).toBe('z-ai/glm-5.2');
    expect(fetchMock.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
    expect(fetchMock.mock.calls[1][1].signal).toBeInstanceOf(AbortSignal);
  });

  it('throws ConversationUnavailableError when every provider fails', async () => {
    configureVertex();
    configureOpenRouter();
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('everything down')));

    await expect(runTurn({ messages: MESSAGES, userTurn: 1 })).rejects.toBeInstanceOf(
      ConversationUnavailableError
    );
  });

  it('throws ConversationUnavailableError when no provider is configured', async () => {
    const fetchMock = stubFetchNever();

    const rejection = runTurn({ messages: MESSAGES, userTurn: 1 });
    await expect(rejection).rejects.toBeInstanceOf(ConversationUnavailableError);
    await rejection.catch((error: ConversationUnavailableError) => {
      expect(error.attempts.map((a) => a.provider)).toEqual(['vertex', 'openrouter']);
      expect(error.attempts.every((a) => a.reason === 'not configured')).toBe(true);
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

/* ── degradation logging (provider failover + scripted fallback) ─────────── */

describe('runTurn — degradation logging', () => {
  const warnMock = logger.warn as unknown as ReturnType<typeof vi.fn>;
  const errorMock = logger.error as unknown as ReturnType<typeof vi.fn>;

  function eventsOf(mock: ReturnType<typeof vi.fn>, eventType: string) {
    return mock.mock.calls
      .map((call) => call[0] as Record<string, unknown>)
      .filter((entry) => entry?.event_type === eventType);
  }

  it('logs a failover event when one provider fails and another remains', async () => {
    configureVertex();
    configureOpenRouter();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 503, text: async () => 'overloaded' })
      .mockResolvedValueOnce(openRouterResponse(SPARSE_PAYLOAD));
    vi.stubGlobal('fetch', fetchMock);

    const result = await runTurn({
      messages: MESSAGES,
      userTurn: 4,
      sessionId: 'sess-abc',
    });

    // The turn was still served conversationally — no degraded event.
    expect(result.turnLog.model).toBe('z-ai/glm-5.2');
    expect(eventsOf(errorMock, CONVERSATION_DEGRADED_EVENT)).toHaveLength(0);

    const failovers = eventsOf(warnMock, PROVIDER_FAILOVER_EVENT);
    expect(failovers).toHaveLength(1);
    expect(failovers[0]).toMatchObject({
      event_type: 'design_conversation.provider.failover',
      session_id: 'sess-abc',
      turn: 4,
      provider: 'vertex',
      failure: 'provider_error',
      error_class: 'ProviderHttpError',
      status: 503,
      next_provider: 'openrouter',
      next_model: 'z-ai/glm-5.2',
      outcome: 'failover',
    });
  });

  it('records the error class and status of a failing OpenRouter fallback', async () => {
    configureVertex();
    configureOpenRouter();
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce({ ok: false, status: 429, text: async () => 'quota' })
        .mockResolvedValueOnce({ ok: false, status: 401, statusText: 'Unauthorized' })
    );

    await expect(
      runTurn({ messages: MESSAGES, userTurn: 2, sessionId: 'sess-xyz' })
    ).rejects.toBeInstanceOf(ConversationUnavailableError);

    const [degraded] = eventsOf(errorMock, CONVERSATION_DEGRADED_EVENT);
    expect(degraded).toMatchObject({
      event_type: 'design_conversation.degraded',
      session_id: 'sess-xyz',
      turn: 2,
      outcome: 'scripted_fallback',
      providers_attempted: ['vertex', 'openrouter'],
    });
    expect(degraded.attempts).toEqual([
      {
        provider: 'vertex',
        model: DEFAULT_VERTEX_MODEL,
        failure: 'provider_error',
        error_class: 'ProviderHttpError',
        status: 429,
      },
      {
        provider: 'openrouter',
        model: 'z-ai/glm-5.2',
        failure: 'provider_error',
        error_class: 'ProviderHttpError',
        status: 401,
      },
    ]);
  });

  it('logs the scripted fallback when every provider is unavailable', async () => {
    stubFetchNever();

    await expect(
      runTurn({ messages: MESSAGES, userTurn: 1, sessionId: 'sess-down' })
    ).rejects.toBeInstanceOf(ConversationUnavailableError);

    const degradeds = eventsOf(errorMock, CONVERSATION_DEGRADED_EVENT);
    expect(degradeds).toHaveLength(1);
    expect(degradeds[0]).toMatchObject({
      session_id: 'sess-down',
      turn: 1,
      outcome: 'scripted_fallback',
      providers_attempted: ['vertex', 'openrouter'],
    });
    expect(degradeds[0].attempts).toEqual([
      {
        provider: 'vertex',
        model: DEFAULT_VERTEX_MODEL,
        failure: 'not_configured',
        error_class: null,
        status: null,
      },
      {
        provider: 'openrouter',
        model: 'z-ai/glm-5.2',
        failure: 'not_configured',
        error_class: null,
        status: null,
      },
    ]);
  });

  it('never logs prompt text, transcript content, or credentials', async () => {
    configureVertex();
    configureOpenRouter();
    process.env.OPENROUTER_API_KEY = 'super-secret-key';
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('everything down')));

    await expect(
      runTurn({ messages: MESSAGES, userTurn: 1, sessionId: 'sess-quiet' })
    ).rejects.toBeInstanceOf(ConversationUnavailableError);

    const logged = JSON.stringify([...warnMock.mock.calls, ...errorMock.mock.calls]);
    expect(logged).not.toContain('hummingbird');
    expect(logged).not.toContain('grandmother');
    expect(logged).not.toContain('super-secret-key');
    // Not even the provider's own error message, which can echo the request.
    expect(logged).not.toContain('everything down');
  });
});

/* ── demo mode ───────────────────────────────────────────────────────────── */

describe('runTurn — demo mode (NEXT_PUBLIC_DEMO_MODE)', () => {
  beforeEach(() => {
    process.env.NEXT_PUBLIC_DEMO_MODE = 'true';
  });

  it('is deterministic and never calls a provider', async () => {
    const fetchMock = stubFetchNever();

    const first = await runTurn({ messages: MESSAGES, userTurn: 1 });
    const again = await runTurn({ messages: MESSAGES, userTurn: 1 });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(first).toEqual(again);
    expect(first.stage).toBe('chatting');
    expect(first.turnLog.model).toBe('demo-script');
  });

  it('plays opener → two follow-ups → fixed proposal with a demo record', async () => {
    stubFetchNever();

    const turn1 = await runTurn({ messages: MESSAGES, userTurn: 1 });
    const turn2 = await runTurn({ messages: MESSAGES, userTurn: 2 });
    const turn3 = await runTurn({ messages: MESSAGES, userTurn: 3 });
    const turn5 = await runTurn({ messages: MESSAGES, userTurn: 5 });

    expect(turn1.stage).toBe('chatting');
    expect(turn2.stage).toBe('chatting');
    expect(turn3.stage).toBe('proposal');
    expect(turn3.turnLog.firedRule).toBe('judgment');
    expect(turn3.playback).toBeTruthy();
    expect(turn3.reply).toContain(PROPOSAL_LEAD);
    expect(turn3.record).toEqual({
      placement: 'left forearm',
      styleTags: ['fine-line'],
      meaning: 'a hummingbird for my grandmother — she fed them every morning',
      references: [],
      ambiguousAxes: ['color-blackwork', 'literal-abstract'],
    });
    // The script holds at the proposal beat (only the turn counter moves on).
    expect(turn5).toEqual({
      ...turn3,
      turnLog: { ...turn3.turnLog, turn: 5 },
    });
    // Same TurnLog discipline: confidence from the real scorer, monotone.
    expect(turn2.turnLog.confidence).toBeGreaterThanOrEqual(turn1.turnLog.confidence);
    expect(turn3.turnLog.confidence).toBeGreaterThanOrEqual(turn2.turnLog.confidence);
  });
});

/* ── TurnLog discipline (ADR-0022) ───────────────────────────────────────── */

describe('TurnLog — always present, always logged', () => {
  it('every live turn returns a full TurnLog and logs it via the repo logger', async () => {
    configureVertex();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(vertexResponse(RICH_PAYLOAD)));

    const result = await runTurn({ messages: MESSAGES, userTurn: 3 });

    expect(result.turnLog).toEqual({
      turn: 3,
      confidence: expect.any(Number),
      missingFields: expect.any(Array),
      firedRule: 'judgment',
      model: DEFAULT_VERTEX_MODEL,
    });
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: 'design_conversation.turn',
        stage: 'proposal',
        turn: 3,
        firedRule: 'judgment',
        model: DEFAULT_VERTEX_MODEL,
      })
    );
  });

  it('demo turns keep the same TurnLog discipline', async () => {
    process.env.NEXT_PUBLIC_DEMO_MODE = 'true';
    stubFetchNever();

    const result = await runTurn({ messages: MESSAGES, userTurn: 2 });

    expect(result.turnLog.turn).toBe(2);
    expect(result.turnLog.model).toBe('demo-script');
    expect(result.turnLog.missingFields).toBeInstanceOf(Array);
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: 'design_conversation.turn',
        model: 'demo-script',
        turn: 2,
      })
    );
  });
});

/* ── playback names the character (short label, not costume prose) ───────── */

describe('runTurn — playback names a recognized character', () => {
  const GOKU_MESSAGES: ConversationMessage[] = [
    { role: 'bot', text: opener() },
    {
      role: 'user',
      text: 'forearm. goku from dragon ball z charging a kamehameha, blackwork, black ink only',
    },
    { role: 'bot', text: 'What are you hoping to capture?' },
    {
      role: 'user',
      text: 'his determination — never giving up no matter how outmatched you are',
    },
  ];

  const GOKU_PAYLOAD = {
    reply: 'Blackwork Goku it is.',
    record: {
      placement: 'forearm',
      styleTags: ['blackwork'],
      meaning: 'never giving up no matter how outmatched you are',
      references: [],
      ambiguousAxes: ['bold-fine'],
    },
  };

  it('names the character instead of only the meaning prose', async () => {
    configureVertex();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(vertexResponse(GOKU_PAYLOAD)));

    const result = await runTurn({ messages: GOKU_MESSAGES, userTurn: 2 });

    expect(result.stage).toBe('proposal');
    expect(result.playback).toContain('Goku (Dragon Ball)');
    expect(result.playback).toContain('forearm');
  });

  it('never leaks the costume anchors the prompts use into the playback', async () => {
    configureVertex();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(vertexResponse(GOKU_PAYLOAD)));

    const result = await runTurn({ messages: GOKU_MESSAGES, userTurn: 2 });

    // These live on IntakeRecord.subject for the generation prompts and
    // would make the spoken sentence unreadable.
    expect(result.playback!.toLowerCase()).not.toContain('orange gi');
    expect(result.playback!.toLowerCase()).not.toContain('spiky');
  });

  /**
   * The reported failure: a session about Nelson Muntz was read back as
   * "punk with a tear". The catalog did not recognize him, so the label was
   * empty and the playback reached straight past `subject` — which knew
   * exactly what we were about to draw — to `meaning`, which is why they
   * wanted it. Both sound like descriptions, so the substitution is invisible.
   */
  it('speaks the SUBJECT, not the meaning, when the catalog knows nobody', () => {
    const playback = buildPlayback({
      placement: 'forearm',
      styleTags: ['neo traditional'],
      subject: 'Nelson Muntz with a blue shirt, purple shorts, single tear, punk styling',
      meaning: 'punk with a tear',
    });

    expect(playback).toContain('Nelson Muntz');
    expect(playback).not.toContain('punk with a tear');
  });

  it('trims the costume anchors off the subject before speaking it', () => {
    // `subject` is written for the image model. Reading the whole string back
    // is unreadable, so only the clause that names the thing is spoken.
    const playback = buildPlayback({
      placement: 'forearm',
      subject: 'Nelson Muntz with a blue shirt, purple shorts, single tear',
    });

    expect(playback).toContain('Nelson Muntz');
    expect(playback).not.toContain('purple shorts');
    expect(playback).not.toContain('blue shirt');
  });

  it('still falls back to meaning when there is no subject either', () => {
    // The bug was the precedence, not the existence of the fallback. A brief
    // whose whole content is the meaning deserves a sentence that uses it.
    const playback = buildPlayback({
      placement: 'left forearm',
      styleTags: ['fine line'],
      meaning: 'a hummingbird for my grandmother, delicate and warm',
    });

    expect(playback).toContain('hummingbird');
  });

  it('keeps the franchise when the extractor comma-joins it to the name', () => {
    // The extraction prompt offers two subject shapes: one joins the franchise
    // with "from", the other with a comma. A first-clause-only trim silently
    // dropped the franchise from the comma-joined shape, while the same prompt
    // line instructs the model to name the character AND the franchise.
    const playback = buildPlayback({
      placement: 'forearm',
      subject:
        'Killua Zoldyck, Hunter x Hunter, silver spiky hair, blue eyes, plain long-sleeve white turtleneck, wide shorts, boots',
    });

    expect(playback).toContain('Killua Zoldyck, Hunter x Hunter');
    // ...and still none of the costume prose that follows it.
    expect(playback).not.toContain('turtleneck');
    expect(playback).not.toContain('silver spiky hair');
  });

  it('does not mistake appearance prose for a franchise', () => {
    const playback = buildPlayback({
      placement: 'forearm',
      subject: 'Nelson Muntz, blue shirt, purple shorts, single tear',
    });

    expect(playback).toContain('Nelson Muntz');
    expect(playback).not.toContain('blue shirt');
  });

  it('MARKS the meaning as the why rather than asserting it as the subject', () => {
    // Bare, the meaning clause sits in the exact position a subject would and
    // reads as one — the same substitution in a smaller mask.
    const withMeaning = buildPlayback({
      placement: 'left forearm',
      meaning: 'a hummingbird for my grandmother',
    });
    const withSubject = buildPlayback({
      placement: 'left forearm',
      subject: 'Nelson Muntz with a blue shirt',
    });

    expect(withMeaning).toContain('— about a hummingbird for my grandmother');
    // The subject path asserts, because there we actually know.
    expect(withSubject).toContain('— Nelson Muntz');
    expect(withSubject).not.toContain('about');
  });

  it('falls back to the meaning when no character is named', async () => {
    configureVertex();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(vertexResponse(RICH_PAYLOAD)));

    const result = await runTurn({ messages: MESSAGES, userTurn: 3 });

    expect(result.playback).toContain('hummingbird');
  });
});

/* ── repeat guard ────────────────────────────────────────────────────────── */

describe('runTurn — repeated-reply guard', () => {
  it('does not replay the previous bot message verbatim', async () => {
    configureVertex();
    const repeated =
      'Nice — would you want to include any background elements like the energy aura or maybe some debris?';
    const messages: ConversationMessage[] = [
      { role: 'bot', text: opener() },
      { role: 'user', text: 'a dragon on my ribs' },
      { role: 'bot', text: repeated },
      { role: 'user', text: 'not sure yet' },
    ];
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        vertexResponse({ ...SPARSE_PAYLOAD, reply: repeated })
      )
    );

    const result = await runTurn({ messages, userTurn: 3 });

    expect(result.stage).toBe('chatting');
    expect(result.reply).not.toBe(repeated);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ event_type: 'design_conversation.repeated_reply' })
    );
  });

  it('lets a genuinely new reply through untouched', async () => {
    configureVertex();
    const messages: ConversationMessage[] = [
      { role: 'bot', text: opener() },
      { role: 'user', text: 'a dragon on my ribs' },
      { role: 'bot', text: 'What mood are you going for?' },
      { role: 'user', text: 'not sure yet' },
    ];
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(vertexResponse(SPARSE_PAYLOAD)));

    const result = await runTurn({ messages, userTurn: 3 });

    expect(result.reply).toBe(SPARSE_PAYLOAD.reply);
    expect(logger.warn).not.toHaveBeenCalledWith(
      expect.objectContaining({ event_type: 'design_conversation.repeated_reply' })
    );
  });
});

/* ── proposal beat: a real question gets a real answer ────────────────────
 * Regression for a real logged session (data/conversation-logs): after the
 * playback fired, the user asked "do you know which characters im referring
 * to?" and got the identical templated playback echoed back.
 * ──────────────────────────────────────────────────────────────────────── */

describe('runTurn — proposal beat answers follow-up questions', () => {
  const PLAYED_BACK =
    `${PROPOSAL_LEAD} a illustrative piece on your forearm — love for anime/manga. ${PROPOSAL_AFFORDANCE}`;

  const AFTER_PROPOSAL: ConversationMessage[] = [
    { role: 'bot', text: opener() },
    { role: 'user', text: 'my forearm and show my love for anime/manga' },
    { role: 'bot', text: PLAYED_BACK },
    { role: 'user', text: 'do you know which characters im referring to?' },
  ];

  const ANSWER_PAYLOAD = {
    reply:
      'Gon and Killua from Hunter x Hunter, and Yusuke from Yu Yu Hakusho — the main trio energy from both series.',
    record: RICH_PAYLOAD.record,
  };

  it('surfaces the model answer instead of replaying the playback', async () => {
    configureVertex();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(vertexResponse(ANSWER_PAYLOAD)));

    const result = await runTurn({ messages: AFTER_PROPOSAL, userTurn: 4 });

    expect(result.stage).toBe('proposal');
    expect(result.reply).not.toBe(PLAYED_BACK);
    expect(result.reply).toContain('Hunter x Hunter');
    // The reveal must stay one tap away — restated as a STATEMENT, never
    // the same affordance question verbatim a second time.
    expect(result.reply).toContain(PROPOSAL_REMINDER);
    // ...and as a statement, not the affordance question asked twice.
    expect(result.reply).not.toContain(PROPOSAL_AFFORDANCE);
  });

  it('still announces the playback the FIRST time the beat fires', async () => {
    configureVertex();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(vertexResponse(RICH_PAYLOAD)));

    const result = await runTurn({ messages: MESSAGES, userTurn: 3 });

    expect(result.reply).toBe(
      `${PROPOSAL_LEAD} ${result.playback}. ${PROPOSAL_AFFORDANCE}`
    );
  });

  it('falls back to the canonical playback when the model just parrots it', async () => {
    configureVertex();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        vertexResponse({ reply: PLAYED_BACK, record: RICH_PAYLOAD.record })
      )
    );

    const result = await runTurn({ messages: AFTER_PROPOSAL, userTurn: 4 });

    expect(result.reply).toContain(PROPOSAL_LEAD);
    expect(result.reply).toContain(result.playback!);
  });
});

/* ── readiness gate: a named subject substitutes for meaning ─────────────── */

describe('runTurn — a named character can stand in for meaning', () => {
  const GOKU_NO_MEANING: ConversationMessage[] = [
    { role: 'bot', text: opener() },
    {
      role: 'user',
      text: 'forearm. goku from dragon ball z charging a kamehameha, blackwork, black ink only',
    },
    { role: 'bot', text: 'Black-and-grey, or straight black ink?' },
    { role: 'user', text: 'no background at all. just him and the aura. thats everything' },
  ];

  // Placement 0.3 + two style tags 0.2 + all axes resolved 0.2 = 0.7, but
  // the model returned NO meaning — the old gate stranded this session.
  const NO_MEANING_PAYLOAD = {
    reply: 'Got it — solid black, no shading.',
    record: {
      placement: 'forearm',
      styleTags: ['blackwork', 'japanese'],
      meaning: '',
      references: [],
      ambiguousAxes: [],
    },
  };

  it('advances to the proposal on placement + subject with no meaning', async () => {
    configureVertex();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(vertexResponse(NO_MEANING_PAYLOAD)));

    const result = await runTurn({ messages: GOKU_NO_MEANING, userTurn: 4 });

    expect(result.stage).toBe('proposal');
    expect(result.turnLog.firedRule).toBe('judgment');
    expect(result.playback).toContain('Goku (Dragon Ball)');
  });

  it('backfills the prompt-facing subject onto the record', async () => {
    configureVertex();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(vertexResponse(NO_MEANING_PAYLOAD)));

    const result = await runTurn({ messages: GOKU_NO_MEANING, userTurn: 4 });

    // The costume anchors the generation prompts depend on.
    expect(result.record.subject?.toLowerCase()).toContain('orange gi');
  });

  it('still refuses to advance with neither meaning nor subject', async () => {
    configureVertex();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        vertexResponse({
          reply: 'What is the piece about?',
          record: { ...NO_MEANING_PAYLOAD.record },
        })
      )
    );

    const messages: ConversationMessage[] = [
      { role: 'bot', text: opener() },
      { role: 'user', text: 'forearm, blackwork, japanese, no idea what of yet' },
    ];
    const result = await runTurn({ messages, userTurn: 2 });

    expect(result.stage).toBe('chatting');
  });
});

/* ── repeat guard catches the real near-verbatim case ────────────────────── */

describe('runTurn — repeat guard catches a non-identical repeat', () => {
  it('catches a repeat that only dropped a leading stock phrase', async () => {
    configureVertex();
    // Straight from a real session log: the second copy is the first minus
    // "Got it. " — byte equality would have missed it.
    const first =
      'Got it. Solid black, no shading. So, just Goku charging his Kamehameha, or would you want to include any background elements like the energy aura or maybe some debris?';
    const second =
      'Solid black, no shading. So, just Goku charging his Kamehameha, or would you want to include any background elements like the energy aura or maybe some debris?';
    const messages: ConversationMessage[] = [
      { role: 'bot', text: opener() },
      { role: 'user', text: 'straight black ink, no shading, solid blacks' },
      { role: 'bot', text: first },
      { role: 'user', text: 'just goku and the energy aura, no background' },
    ];
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(vertexResponse({ ...SPARSE_PAYLOAD, reply: second }))
    );

    const result = await runTurn({ messages, userTurn: 3 });

    expect(result.reply).not.toBe(second);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ event_type: 'design_conversation.repeated_reply' })
    );
  });
});

/* ── SketchBot's notepad projection (TAT-48) ─────────────────────────────── */

describe('runTurn — session notes (TAT-48)', () => {
  const NOTE_KEYS = ['placement', 'cast', 'style', 'scene', 'vibe', 'ipHeadsUp', 'sufficient'];

  it('enumerates every named cast member and carries no internal fields', async () => {
    configureVertex();
    // Five characters across two Togashi series, typed the way fans type
    // them — the regression shape from TAT-47 defect 6.
    const messages: ConversationMessage[] = [
      { role: 'bot', text: opener() },
      {
        role: 'user',
        text:
          'arm sleeve with gon and killua from hxh, plus hiei, kurama and yusuke from yu yu hakusho, all of them mid-fight',
      },
    ];
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        vertexResponse({
          reply: 'That is a full Togashi lineup — which moment anchors it?',
          record: {
            placement: 'arm sleeve',
            styleTags: [],
            meaning: 'the shows that raised me',
            references: [],
            ambiguousAxes: ['bold-fine', 'color-blackwork', 'minimal-ornate'],
          },
        })
      )
    );

    const result = await runTurn({ messages, userTurn: 2 });

    // All five enumerated, one entry each — never a truncated pair.
    expect(result.notes.cast).toHaveLength(5);
    expect(result.notes.cast).toEqual(
      expect.arrayContaining([
        'Gon (Hunter x Hunter)',
        'Killua (Hunter x Hunter)',
        'Hiei (Yu Yu Hakusho)',
        'Kurama (Yu Yu Hakusho)',
        'Yusuke (Yu Yu Hakusho)',
      ])
    );
    expect(result.notes.placement).toBe('arm sleeve');
    expect(result.notes.vibe).toBe('the shows that raised me');
    expect(result.notes.scene).toContain('mid-fight');
    // Named characters fired the IP rule — the heads-up flag is on.
    expect(result.notes.ipHeadsUp).toBe(true);

    // HARD RULE (TAT-47 defect 8): only the whitelisted user-meaningful
    // fields — no rationale, confidence, axes, or turn telemetry, ever.
    expect(Object.keys(result.notes).every((key) => NOTE_KEYS.includes(key))).toBe(true);
    const serialized = JSON.stringify(result.notes);
    expect(serialized).not.toMatch(/rationale|confidence|ambiguousAxes|missingFields|firedRule|turnLog/i);
  });

  it('reports sufficiency from the same gate confirm enforces (ADR-0028 readiness)', async () => {
    configureVertex();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(vertexResponse(SPARSE_PAYLOAD)));
    const sparse = await runTurn({ messages: MESSAGES, userTurn: 2 });
    expect(sparse.notes.sufficient).toBe(false);
    expect(sparse.notes.cast).toEqual([]);
    expect(sparse.notes.ipHeadsUp).toBe(false);

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(vertexResponse(RICH_PAYLOAD)));
    const rich = await runTurn({ messages: MESSAGES, userTurn: 2 });
    expect(rich.notes.sufficient).toBe(true);
    expect(rich.notes.style).toBe('fine line');
  });
});

/* ── the visible fast lane: "skip the questions — just draw" (TAT-48) ────── */

describe('runTurn — draw request (TAT-48 visible fast lane)', () => {
  const DRAW_MESSAGE = 'skip the questions — just draw';

  it('fires the proposal when the record is already generation-sufficient', async () => {
    configureVertex();
    const messages: ConversationMessage[] = [
      { role: 'bot', text: opener() },
      { role: 'user', text: 'left forearm, a hummingbird for my grandmother' },
      { role: 'bot', text: 'What feel are you after — delicate or bold?' },
      { role: 'user', text: DRAW_MESSAGE },
    ];
    // Placement + meaning present but style unresolved: confidence sits
    // below the judgment threshold, so ONLY the draw request advances it.
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        vertexResponse({
          reply: 'Happy to keep riffing — bold or fine?',
          record: {
            placement: 'left forearm',
            styleTags: [],
            meaning: 'a hummingbird for my grandmother',
            references: [],
            ambiguousAxes: ['bold-fine', 'color-blackwork', 'literal-abstract', 'minimal-ornate'],
          },
        })
      )
    );

    const result = await runTurn({ messages, userTurn: 2 });

    expect(result.stage).toBe('proposal');
    expect(result.turnLog.firedRule).toBe('draw-request-proposal');
    // The announce beat still runs — consent is never skipped (ADR-0020).
    expect(result.playback).toBeTruthy();
    expect(result.reply).toContain(PROPOSAL_LEAD);
  });

  it('asks for the one real gap instead of refusing when there is nothing to draw yet', async () => {
    configureVertex();
    const messages: ConversationMessage[] = [
      { role: 'bot', text: opener() },
      { role: 'user', text: DRAW_MESSAGE },
    ];
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(vertexResponse(SPARSE_PAYLOAD)));

    const result = await runTurn({ messages, userTurn: 1 });

    expect(result.stage).toBe('chatting');
    // Never a refusal, never a limit — the gap question is the reply. (The
    // placement gate's "I can't decide for you" is a judgment call, not a
    // capability refusal — only capability language is forbidden.)
    expect(result.reply.toLowerCase()).toContain('where on your body');
    expect(result.reply).not.toMatch(/can'?t (show|draw|generate)|cannot (show|draw|generate)|limit/i);
  });
});

/* ── the stall rule (#376) ───────────────────────────────────────────────── */

describe('runTurn — stalled-field ask (#376)', () => {
  /** Everything but placement: 0.3 meaning + 0.2 style + 0.1 axes = 0.6. */
  const NO_PLACEMENT_PAYLOAD = {
    // No person in the meaning: the evocation follow-up (TAT-51) must not be
    // what fires here — this block is about the gate, not the mine.
    reply: 'A hummingbird mid-hover — what pulls you toward that moment?',
    record: {
      placement: '',
      styleTags: ['fine line'],
      meaning: 'a hummingbird hovering over a lily, delicate and warm',
      references: [],
      ambiguousAxes: ['color-blackwork', 'literal-abstract'],
    },
  };

  function blockedLog(blockingField: TurnLog['blockingField'], turn: number): TurnLog {
    return {
      turn,
      confidence: 0.6,
      missingFields: ['placement'],
      firedRule: 'none',
      model: DEFAULT_VERTEX_MODEL,
      ...(blockingField ? { blockingField } : {}),
    };
  }

  it('names the blocking field on the first blocked turn but lets the model reply through', async () => {
    configureVertex();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(vertexResponse(NO_PLACEMENT_PAYLOAD)));

    const result = await runTurn({ messages: MESSAGES, userTurn: 2, previousTurnLogs: [] });

    expect(result.stage).toBe('chatting');
    expect(result.turnLog.firedRule).toBe('none');
    expect(result.reply).toBe(NO_PLACEMENT_PAYLOAD.reply);
    expect(result.turnLog.blockingField).toBe('placement');
    // The gate state travels, not yet stalled: one blocked turn is conversation.
    expect(result.gate).toEqual({
      blocking: 'placement',
      stalled: false,
      line: expect.stringMatching(/placement/i),
    });
    // Never the score or the rule in the spoken line (ADR-0012 log-not-speak).
    expect(result.gate?.line).not.toMatch(/confidence|threshold|rule|0\.\d/i);
  });

  it(`asks for the field outright on the ${STALLED_FIELD_TURNS}nd consecutive block`, async () => {
    configureVertex();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(vertexResponse(NO_PLACEMENT_PAYLOAD)));

    const result = await runTurn({
      messages: MESSAGES,
      userTurn: 3,
      previousTurnLogs: [blockedLog(undefined, 1), blockedLog('placement', 2)],
    });

    expect(result.stage).toBe('chatting');
    expect(result.turnLog.firedRule).toBe('stalled-field-ask');
    expect(result.reply).toBe(STALLED_PLACEMENT_ASK);
    expect(result.reply.toLowerCase()).toContain('where on your body');
    expect(result.reply).not.toMatch(/limit|turn|cap/i);
    expect(result.gate).toEqual({
      blocking: 'placement',
      stalled: true,
      line: expect.any(String),
    });
  });

  it('resets the count when the blocking field changes', async () => {
    configureVertex();
    // Placement arrived this turn; now nothing to draw blocks instead.
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        vertexResponse({
          ...SPARSE_PAYLOAD,
          record: { ...SPARSE_PAYLOAD.record, placement: 'left forearm' },
        })
      )
    );

    const result = await runTurn({
      messages: MESSAGES,
      userTurn: 3,
      previousTurnLogs: [blockedLog('placement', 1), blockedLog('placement', 2)],
    });

    expect(result.turnLog.firedRule).toBe('none');
    expect(result.turnLog.blockingField).toBe('meaning');
    expect(result.gate?.stalled).toBe(false);
    expect(result.reply).toBe(SPARSE_PAYLOAD.reply);
  });

  it('asks for the field directly once the new field has blocked twice in a row', async () => {
    configureVertex();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        vertexResponse({
          ...SPARSE_PAYLOAD,
          record: { ...SPARSE_PAYLOAD.record, placement: 'left forearm' },
        })
      )
    );

    const result = await runTurn({
      messages: MESSAGES,
      userTurn: 4,
      previousTurnLogs: [blockedLog('placement', 1), blockedLog('placement', 2), blockedLog('meaning', 3)],
    });

    expect(result.turnLog.firedRule).toBe('stalled-field-ask');
    expect(result.reply).toBe(STALLED_MEANING_ASK);
  });

  it('takes a short answer to the direct ask as the placement, even when extraction misses it', async () => {
    configureVertex();
    const messages: ConversationMessage[] = [
      ...MESSAGES,
      { role: 'bot', text: STALLED_PLACEMENT_ASK },
      { role: 'user', text: 'left shoulder blade' },
    ];
    // The model still returns no placement — the deterministic settle wins.
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(vertexResponse(NO_PLACEMENT_PAYLOAD)));

    const result = await runTurn({
      messages,
      userTurn: 4,
      previousTurnLogs: [blockedLog('placement', 2), blockedLog('placement', 3)],
    });

    expect(result.record.placement).toBe('left shoulder blade');
    // 0.3 placement + 0.3 meaning + 0.2 style + 0.1 axes clears the gate.
    expect(result.stage).toBe('proposal');
    expect(result.turnLog.firedRule).toBe('judgment');
    expect(result.playback).toContain('left shoulder blade');
    expect(result.gate).toBeUndefined();
    expect(result.turnLog.blockingField).toBeUndefined();
  });

  it('commits to the default placement and lets the customer steer when the direct ask is talked past', async () => {
    configureVertex();
    const messages: ConversationMessage[] = [
      ...MESSAGES,
      { role: 'bot', text: STALLED_PLACEMENT_ASK },
      {
        role: 'user',
        text: 'honestly the garden mattered more than anything, always out there at dawn with the birds',
      },
    ];
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(vertexResponse(NO_PLACEMENT_PAYLOAD)));

    const result = await runTurn({
      messages,
      userTurn: 4,
      previousTurnLogs: [blockedLog('placement', 2), blockedLog('placement', 3)],
    });

    // A long reply is conversation, not an answer — nothing settled.
    expect(result.record.placement).toBeUndefined();
    expect(result.turnLog.firedRule).toBe('stalled-field-ask');
    expect(result.reply).toBe(STALLED_PLACEMENT_REASK);
    expect(result.reply).toContain(DEFAULT_PLACEMENT);
  });

  it('a hand-back on the committed-default re-ask takes the default and proposes', async () => {
    configureVertex();
    const messages: ConversationMessage[] = [
      ...MESSAGES,
      { role: 'bot', text: STALLED_PLACEMENT_REASK },
      { role: 'user', text: 'sure, you pick' },
    ];
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(vertexResponse(NO_PLACEMENT_PAYLOAD)));

    const result = await runTurn({
      messages,
      userTurn: 5,
      previousTurnLogs: [
        blockedLog('placement', 2),
        blockedLog('placement', 3),
        blockedLog('placement', 4),
      ],
    });

    expect(result.record.placement).toBe(DEFAULT_PLACEMENT);
    expect(result.stage).toBe('proposal');
    expect(result.playback).toContain(DEFAULT_PLACEMENT);
  });

  it('never fires on a proposal turn — the gate has nothing to say once the brief is complete', async () => {
    configureVertex();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(vertexResponse(RICH_PAYLOAD)));

    const result = await runTurn({
      messages: MESSAGES,
      userTurn: 3,
      previousTurnLogs: [blockedLog('placement', 1), blockedLog('placement', 2)],
    });

    expect(result.stage).toBe('proposal');
    expect(result.turnLog.firedRule).toBe('judgment');
    expect(result.gate).toBeUndefined();
  });
});
