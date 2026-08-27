/**
 * Conversational-intake integration tests (ADR-0019–0022).
 *
 * Every module boundary is mocked: the conversation engine at its public
 * entry ('@/services/designConversation'), intake/council/generation,
 * durable image storage, the budget ledger, and the Firebase Admin bootstrap
 * (forced off, so persistence runs on the in-memory store). No live LLM,
 * provider, GCS, or Firestore call is ever made.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  converse,
  confirmProposal,
  startSession,
  getSession,
} from '../index';
import { memorySessionStore, clearMemorySessions } from '../internal/store';
import type { StoredSession } from '../internal/store';
import { runTurn, ConversationUnavailableError } from '../../designConversation';
import { enhanceStructured } from '../../council';
import { generate, routeGeneration } from '../../generation';
import { extractIntake } from '../../intake';
import type { IntakeRecord } from '../../intake/types';
import type { ConversationTurnResult, TurnLog } from '../../designConversation/types';
import { logger } from '@/lib/logger';

const OPENER = 'Where on your body are you thinking, and what should it mean?';

vi.mock('../../designConversation', () => {
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
vi.mock('../../intake', () => ({ extractIntake: vi.fn() }));
// Partial mock: the paid council calls are stubbed, but the module's pure
// exports (PRESENTATION_LEAD, stripChromaticWords) stay real — designState
// renders prompts from them, so a stubbed constant would make prompt
// assertions assert the test's own invention.
vi.mock('../../council', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  enhanceStructured: vi.fn(),
}));
vi.mock('../../generation', () => ({ generate: vi.fn(), routeGeneration: vi.fn() }));
vi.mock('@/lib/firebase-admin', () => ({ ensureAdminApp: vi.fn(() => false) }));
vi.mock('@/services/gcs-service', () => ({
  uploadToGCS: vi.fn(),
  getSignedUrl: vi.fn(async (path: string) => `https://signed.example/${path}?sig=test`),
}));
vi.mock('@/services/storage/imageStorageService', () => ({
  recoverImageAtPath: vi.fn(async () => null),
  copyImageToPath: vi.fn(
    async (objectPath: string) => `https://storage.googleapis.com/tatt-pro-assets/${objectPath}`
  ),
  uploadImageToPath: vi.fn(
    async (objectPath: string) => `https://storage.googleapis.com/tatt-pro-assets/${objectPath}`
  ),
}));
vi.mock('@/lib/budget-tracker', () => ({
  recordSpend: vi.fn(),
  VERTEX_IMAGEN_COST_CENTS: 4,
}));
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  createRequestLogger: vi.fn(),
}));

const runTurnMock = vi.mocked(runTurn);
const mockExtractIntake = vi.mocked(extractIntake);
const mockEnhanceStructured = vi.mocked(enhanceStructured);
const mockGenerate = vi.mocked(generate);
const mockRouteGeneration = vi.mocked(routeGeneration);

const intakeRecord: IntakeRecord = {
  placement: 'forearm',
  styleTags: ['fine-line'],
  meaning: 'a sparrow for my grandmother',
  references: [],
  ambiguousAxes: ['bold-fine', 'color-blackwork'],
};

const questionnaireEnhance = {
  axisSelection: {
    mode: 'questionnaire' as const,
    axes: ['color-blackwork' as const, 'bold-fine' as const],
    rationale: 'test rationale',
  },
  variations: [1, 2, 3, 4].map(n => ({
    axisPosition: { 'color-blackwork': n % 2 ? 'color' : 'blackwork', 'bold-fine': n > 2 ? 'fine' : 'bold' },
    prompts: { detailed: `d${n}` },
    negativePrompt: `n${n}`,
  })),
};

const vertexRoute = {
  modelId: 'imagen3',
  provider: 'vertex-ai' as const,
  aspectRatio: '9:16' as const,
  negativePrompt: '',
  fallbackChain: [],
  reasoning: 'test route',
};

function turnLog(overrides: Partial<TurnLog> = {}): TurnLog {
  return {
    turn: 1,
    confidence: 0.4,
    missingFields: ['placement'],
    firedRule: 'none',
    model: 'gemini-2.0-flash',
    ...overrides,
  };
}

function turnResult(overrides: Partial<ConversationTurnResult> = {}): ConversationTurnResult {
  return {
    reply: 'A memorial — what did she love?',
    stage: 'chatting',
    record: {},
    turnLog: turnLog(),
    // The engine's notepad projection (TAT-48) — empty record, empty notes.
    notes: { cast: [], ipHeadsUp: false, sufficient: false },
    ...overrides,
  };
}

let imageCounter = 0;

beforeEach(() => {
  vi.clearAllMocks();
  clearMemorySessions();
  imageCounter = 0;

  runTurnMock.mockResolvedValue(turnResult());
  mockExtractIntake.mockResolvedValue(intakeRecord);
  mockEnhanceStructured.mockResolvedValue(questionnaireEnhance);
  mockRouteGeneration.mockReturnValue(vertexRoute);
  mockGenerate.mockImplementation(async () => ({
    images: [`https://replicate.delivery/pbxt/${++imageCounter}/out.png`],
    metadata: {
      model: 'imagen3',
      provider: 'vertex-ai' as const,
      generatedAt: new Date().toISOString(),
      durationMs: 1,
      attempts: 1,
      fallbackUsed: false,
    },
  }));
});

/** Drive a fresh conversation to the proposal stage; returns the sessionId. */
async function converseToProposal(): Promise<string> {
  const opened = await converse({});
  runTurnMock.mockResolvedValueOnce(
    turnResult({
      reply: "Here's what I'm hearing: a fine-line sparrow on your forearm for your grandmother. Want to see four takes?",
      stage: 'proposal',
      playback: 'a fine-line sparrow on your forearm for your grandmother',
      record: intakeRecord,
      turnLog: turnLog({ turn: 1, confidence: 0.9, missingFields: [], firedRule: 'judgment' }),
    })
  );
  await converse({ sessionId: opened.sessionId, message: 'a sparrow on my forearm for my grandmother, fine line' });
  return opened.sessionId;
}

describe('converse — conversation lifecycle', () => {
  it('creates a session at phase intake and returns the deterministic opener — no engine turn', async () => {
    const response = await converse({});

    expect(response.sessionId).toBeTruthy();
    expect(response.reply).toBe(OPENER);
    expect(response.stage).toBe('chatting');
    expect(response.turn).toBe(0);

    // The opener is free and deterministic — no model call ever (ADR-0019).
    expect(runTurnMock).not.toHaveBeenCalled();

    // The session is persisted at phase 'intake' — no renders, no council.
    const session = await getSession(response.sessionId);
    expect(session.phase).toBe('intake');
    expect(session.variations).toEqual([]);
    expect(mockGenerate).not.toHaveBeenCalled();
    expect(mockEnhanceStructured).not.toHaveBeenCalled();

    const stored = (await memorySessionStore.get(response.sessionId)) as StoredSession;
    expect(stored.conversation?.transcript).toEqual([{ role: 'bot', text: OPENER }]);
    expect(stored.conversation?.turnCount).toBe(0);
  });

  it('runs a user turn through the engine and persists transcript, record, and TurnLogs', async () => {
    const opened = await converse({});

    const record = { placement: 'forearm' };
    runTurnMock.mockResolvedValueOnce(
      turnResult({
        reply: 'A memorial for your grandmother — what did she love?',
        record,
        turnLog: turnLog({ turn: 1, confidence: 0.5, missingFields: ['meaning'] }),
      })
    );
    const response = await converse({ sessionId: opened.sessionId, message: 'my forearm, for my grandmother' });

    expect(response.turn).toBe(1);
    expect(response.stage).toBe('chatting');

    // The engine got the full transcript including the new user message.
    expect(runTurnMock).toHaveBeenCalledTimes(1);
    expect(runTurnMock).toHaveBeenCalledWith({
      messages: [
        { role: 'bot', text: OPENER },
        { role: 'user', text: 'my forearm, for my grandmother' },
      ],
      userTurn: 1,
      pinnedModel: undefined,
      // Passed through purely for the provider-failover / degraded-mode logs.
      sessionId: opened.sessionId,
    });

    // Everything persisted on the stored session (ADR-0022 day-one logs).
    const stored = (await memorySessionStore.get(opened.sessionId)) as StoredSession;
    expect(stored.conversation?.transcript).toHaveLength(3);
    expect(stored.conversation?.transcript[2]).toEqual({
      role: 'bot',
      text: 'A memorial for your grandmother — what did she love?',
    });
    expect(stored.conversation?.record).toEqual(record);
    expect(stored.conversation?.turnCount).toBe(1);
    expect(stored.conversation?.turnLogs).toEqual([
      expect.objectContaining({ turn: 1, missingFields: ['meaning'] }),
    ]);
  });

  it('pins the conversation model and passes the previous TurnLog.model to every later turn', async () => {
    const opened = await converse({});

    await converse({ sessionId: opened.sessionId, message: 'forearm' });
    // The engine fell back mid-conversation — the NEW served model rides forward.
    runTurnMock.mockResolvedValueOnce(turnResult({ turnLog: turnLog({ turn: 2, model: 'openrouter-fallback' }) }));
    await converse({ sessionId: opened.sessionId, message: 'for my grandmother' });
    await converse({ sessionId: opened.sessionId, message: 'something delicate' });

    expect(runTurnMock.mock.calls[0][0].pinnedModel).toBeUndefined();
    expect(runTurnMock.mock.calls[1][0].pinnedModel).toBe('gemini-2.0-flash');
    expect(runTurnMock.mock.calls[2][0].pinnedModel).toBe('openrouter-fallback');
  });

  it('counts user turns across the conversation', async () => {
    const opened = await converse({});
    await converse({ sessionId: opened.sessionId, message: 'one' });
    const second = await converse({ sessionId: opened.sessionId, message: 'two' });

    expect(second.turn).toBe(2);
    expect(runTurnMock.mock.calls[1][0].userTurn).toBe(2);
    // Transcript grows two messages per turn: opener + 2×(user, bot).
    expect(runTurnMock.mock.calls[1][0].messages).toHaveLength(4);
  });

  it('surfaces the playback when the engine reaches the proposal stage', async () => {
    const opened = await converse({});
    runTurnMock.mockResolvedValueOnce(
      turnResult({
        stage: 'proposal',
        playback: 'a fine-line sparrow on your forearm',
        record: intakeRecord,
        turnLog: turnLog({ firedRule: 'judgment' }),
      })
    );
    const response = await converse({ sessionId: opened.sessionId, message: 'a sparrow, fine line' });

    expect(response.stage).toBe('proposal');
    expect(response.playback).toBe('a fine-line sparrow on your forearm');
    expect(response.handoffUrl).toBeUndefined();
  });

  it('returns the warm-handoff URL at stage handoff and closes the conversation (ADR-0021)', async () => {
    const opened = await converse({});
    runTurnMock.mockResolvedValueOnce(
      turnResult({
        stage: 'handoff',
        reply: 'That is actually a great reason to talk to an artist directly.',
        turnLog: turnLog({ turn: 20, firedRule: 'turn20-handoff' }),
      })
    );
    const response = await converse({ sessionId: opened.sessionId, message: 'hmm, still not sure' });

    expect(response.stage).toBe('handoff');
    expect(response.handoffUrl).toBe('/smart-match');

    // The conversation is over — further turns are a phase conflict.
    await expect(
      converse({ sessionId: opened.sessionId, message: 'wait, one more idea' })
    ).rejects.toMatchObject({ name: 'DesignSessionError', code: 'INVALID_PHASE' });
  });

  it('throws SESSION_NOT_FOUND for an unknown session', async () => {
    await expect(converse({ sessionId: 'missing', message: 'hi' })).rejects.toMatchObject({
      code: 'SESSION_NOT_FOUND',
      status: 404,
    });
    expect(runTurnMock).not.toHaveBeenCalled();
  });

  it('maps ConversationUnavailableError to the CONVERSATION_UNAVAILABLE domain error (503)', async () => {
    const opened = await converse({});
    runTurnMock.mockRejectedValueOnce(new ConversationUnavailableError('every provider down'));

    await expect(
      converse({ sessionId: opened.sessionId, message: 'hello?' })
    ).rejects.toMatchObject({
      name: 'DesignSessionError',
      code: 'CONVERSATION_UNAVAILABLE',
      status: 503,
    });

    // The failed turn is never persisted — the transcript still ends at the opener.
    const stored = (await memorySessionStore.get(opened.sessionId)) as StoredSession;
    expect(stored.conversation?.transcript).toHaveLength(1);
    expect(stored.conversation?.turnCount).toBe(0);
  });

  it('logs which providers failed when it downgrades to the scripted intake', async () => {
    const opened = await converse({});
    const attempts = [
      { provider: 'vertex', model: 'gemini-2.0-flash', reason: '429 rate limited' },
      { provider: 'openrouter', model: 'claude-3-5-sonnet', reason: 'not configured' },
    ];
    const failure = new ConversationUnavailableError('every provider down');
    Object.assign(failure, { attempts });
    runTurnMock.mockRejectedValueOnce(failure);

    await expect(
      converse({ sessionId: opened.sessionId, message: 'hello?' })
    ).rejects.toMatchObject({ code: 'CONVERSATION_UNAVAILABLE' });

    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: 'design_conversation.scripted_fallback',
        trigger: 'all_conversation_providers_exhausted',
        session_id: opened.sessionId,
        failed_providers: ['vertex', 'openrouter'],
        attempts,
      })
    );
  });

  it('rethrows other engine failures untouched', async () => {
    const opened = await converse({});
    runTurnMock.mockRejectedValueOnce(new Error('parse exploded'));
    await expect(converse({ sessionId: opened.sessionId, message: 'hi' })).rejects.toThrow('parse exploded');
  });
});

describe('confirmProposal', () => {
  it('runs the existing reveal pipeline over the conversation record and moves intake → revealed', async () => {
    const sessionId = await converseToProposal();

    const session = await confirmProposal(sessionId);

    expect(session.id).toBe(sessionId);
    expect(session.phase).toBe('revealed');
    expect(session.intake).toEqual(intakeRecord);
    expect(session.axisSelection).toEqual(questionnaireEnhance.axisSelection);
    expect(session.provider).toBe('vertex-ai');
    expect(session.variations).toHaveLength(4);
    expect(session.variations.map(v => v.id)).toEqual(['v1', 'v2', 'v3', 'v4']);

    // The shared reveal path ran for real: council + one pinned route + 4 renders.
    expect(mockEnhanceStructured).toHaveBeenCalledWith(intakeRecord);
    expect(mockRouteGeneration).toHaveBeenCalledTimes(1);
    expect(mockGenerate).toHaveBeenCalledTimes(4);
    // The conversation path never touches the scripted extractor.
    expect(mockExtractIntake).not.toHaveBeenCalled();

    // The conversation logs survive the reveal on the stored session (ADR-0022).
    const stored = (await memorySessionStore.get(sessionId)) as StoredSession;
    expect(stored.conversation?.transcript.length).toBeGreaterThan(0);
    expect(stored.conversation?.turnLogs.length).toBeGreaterThan(0);
    expect(stored.pinnedModelId).toBe('imagen3');
  });

  // ADR-0050: photos attached during intake reach the reveal as pixels —
  // presence forces routing, and every render's request carries freshly
  // signed URLs of the stored (private) photos.
  it('feeds stored reference photos into routing and every reveal render', async () => {
    const sessionId = await converseToProposal();
    const stored = (await memorySessionStore.get(sessionId)) as StoredSession;
    stored.conversation!.references = [
      {
        id: 'ref-1',
        source: 'sms',
        summary: 'a rose photo',
        subjects: ['rose'],
        characters: [],
        styleTags: [],
        styleDescriptors: [],
        palette: [],
        composition: '',
        confidence: 0.9,
        createdAt: new Date().toISOString(),
        imagePath: 'design-sessions/s/references/r1.jpg',
      },
      {
        // Analysis-only reference (photo upload failed): contributes no URL.
        id: 'ref-2',
        source: 'web',
        summary: 'a swallow sketch',
        subjects: ['swallow'],
        characters: [],
        styleTags: [],
        styleDescriptors: [],
        palette: [],
        composition: '',
        confidence: 0.8,
        createdAt: new Date().toISOString(),
      },
    ];
    await memorySessionStore.save(stored);

    await confirmProposal(sessionId);

    // Routing sees the stable paths (presence forces the photo lane).
    expect(mockRouteGeneration).toHaveBeenCalledWith(
      expect.objectContaining({
        referenceImages: ['design-sessions/s/references/r1.jpg'],
      })
    );
    // Every render's request carries the signed, fetchable URL — and never
    // an entry for the analysis-only reference.
    expect(mockGenerate).toHaveBeenCalledTimes(4);
    for (const [request] of mockGenerate.mock.calls) {
      expect(request.referenceImages).toEqual([
        'https://signed.example/design-sessions/s/references/r1.jpg?sig=test',
      ]);
    }
  });

  it('never leaks conversation state or the pinned route in public returns', async () => {
    const sessionId = await converseToProposal();
    const confirmed = await confirmProposal(sessionId);
    const fetched = await getSession(sessionId);

    for (const session of [confirmed, fetched]) {
      expect(session).not.toHaveProperty('conversation');
      expect(session).not.toHaveProperty('pinnedModelId');
      expect(session).not.toHaveProperty('pinnedAspectRatio');
      // Belt and braces: no transcript/TurnLogs under any key shape.
      expect(JSON.stringify(session)).not.toContain('transcript');
      expect(JSON.stringify(session)).not.toContain('turnLogs');
    }

    // Stripped from the return, still persisted on the stored session (ADR-0022).
    const stored = (await memorySessionStore.get(sessionId)) as StoredSession;
    expect(stored.conversation?.transcript.length).toBeGreaterThan(0);
    expect(stored.conversation?.turnLogs.length).toBeGreaterThan(0);
  });

  it('rejects a confirm before the proposal stage with INVALID_PHASE', async () => {
    const opened = await converse({}); // still 'chatting'

    await expect(confirmProposal(opened.sessionId)).rejects.toMatchObject({
      name: 'DesignSessionError',
      code: 'INVALID_PHASE',
      status: 409,
    });
    expect(mockGenerate).not.toHaveBeenCalled();
  });

  it('rejects a second confirm — the session already revealed', async () => {
    const sessionId = await converseToProposal();
    await confirmProposal(sessionId);

    await expect(confirmProposal(sessionId)).rejects.toMatchObject({ code: 'INVALID_PHASE' });
    // Still exactly the 4 reveal renders.
    expect(mockGenerate).toHaveBeenCalledTimes(4);
  });

  it('rejects converse once the reveal fired', async () => {
    const sessionId = await converseToProposal();
    await confirmProposal(sessionId);

    await expect(converse({ sessionId, message: 'actually…' })).rejects.toMatchObject({
      code: 'INVALID_PHASE',
    });
  });

  it('throws SESSION_NOT_FOUND for an unknown session', async () => {
    await expect(confirmProposal('missing')).rejects.toMatchObject({
      code: 'SESSION_NOT_FOUND',
      status: 404,
    });
  });
});

describe('legacy scripted startSession (ADR-0019 degraded mode)', () => {
  it('still runs the two-answer flow unchanged, with no conversation state', async () => {
    const session = await startSession({
      placementAnswer: 'forearm',
      meaningAnswer: 'for my grandmother',
    });

    expect(mockExtractIntake).toHaveBeenCalledWith({
      placementAnswer: 'forearm',
      meaningAnswer: 'for my grandmother',
    });
    expect(session.phase).toBe('revealed');
    expect(session.variations).toHaveLength(4);
    expect(runTurnMock).not.toHaveBeenCalled();

    const stored = (await memorySessionStore.get(session.id)) as StoredSession;
    expect(stored.conversation).toBeUndefined();

    // A legacy session never converses.
    await expect(converse({ sessionId: session.id, message: 'hello?' })).rejects.toMatchObject({
      code: 'INVALID_PHASE',
    });

    await expect(getSession(session.id)).resolves.toMatchObject({ id: session.id });
  });
});
