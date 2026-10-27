/**
 * Guess-first intake (spec 17, REA gap V1). Providers are mocked; no live
 * model calls and no renders.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { opener, runTurn, type ConversationMessage } from '../index';
import { PROPOSAL_LEAD, GUESS_FIRST_AFFORDANCE } from '../internal/persona';
import { DEFAULT_PLACEMENT } from '../internal/gate';
import { GUESS_FIRST_EDITED_EVENT } from '../internal/engine';
import type { TurnLog } from '../types';
import { resetStyleTagCache } from '../internal/ontology';
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
  'DESIGN_INTAKE_GUESS_FIRST',
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
});

afterEach(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

function modelReturns(payload: unknown) {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        candidates: [{ content: { parts: [{ text: JSON.stringify(payload) }] } }],
      }),
    })
  );
}

const MODEL_QUESTION = 'Love that. Where on your body are you thinking?';

/** Something to draw, no placement, no style: the vague first message. */
const VAGUE_PAYLOAD = {
  reply: MODEL_QUESTION,
  record: {
    placement: '',
    styleTags: [],
    meaning: 'something for my grandma, maybe flowers',
    references: [],
    ambiguousAxes: ['bold-fine', 'color-blackwork', 'literal-abstract', 'minimal-ornate'],
  },
};

/** Nothing to draw yet. */
const EMPTY_PAYLOAD = {
  reply: 'What should it show?',
  record: {
    placement: '',
    styleTags: [],
    meaning: '',
    references: [],
    ambiguousAxes: ['bold-fine', 'color-blackwork', 'literal-abstract', 'minimal-ornate'],
  },
};

/** Proposal-ready on its own: judgment fires without guess-first. */
const RICH_PAYLOAD = {
  reply: 'Fine line suits a hummingbird beautifully.',
  record: {
    placement: 'left forearm',
    styleTags: ['fine line'],
    meaning: 'a hummingbird for my grandmother, delicate and warm',
    references: [],
    ambiguousAxes: ['color-blackwork', 'literal-abstract'],
  },
};

function firstTurn(text: string): ConversationMessage[] {
  return [
    { role: 'bot', text: opener() },
    { role: 'user', text },
  ];
}

describe('guess-first intake (spec 17)', () => {
  it('flag off: a vague first message still gets the question back', async () => {
    modelReturns(VAGUE_PAYLOAD);
    const result = await runTurn({ messages: firstTurn('something for my grandma, maybe flowers'), userTurn: 1 });

    expect(result.stage).toBe('chatting');
    expect(result.turnLog.firedRule).not.toBe('guess-first-proposal');
    expect(result.record.placement ?? '').toBe('');
  });

  it('flag on: proposes on the first turn and states the assumed placement', async () => {
    process.env.DESIGN_INTAKE_GUESS_FIRST = 'true';
    modelReturns(VAGUE_PAYLOAD);
    const result = await runTurn({ messages: firstTurn('something for my grandma, maybe flowers'), userTurn: 1 });

    expect(result.stage).toBe('proposal');
    expect(result.turnLog.firedRule).toBe('guess-first-proposal');
    expect(result.turnLog.assumedPlacement).toBe(DEFAULT_PLACEMENT);
    expect(result.record.placement).toBe(DEFAULT_PLACEMENT);
    // Stated, never silent: the assumption line names the placement and
    // the playback repeats it.
    expect(result.reply.toLowerCase()).toMatch(/^i'm assuming/);
    expect(result.reply).toContain(DEFAULT_PLACEMENT);
    expect(result.playback).toContain(DEFAULT_PLACEMENT);
    // The announce beat and the consent question stay (ADR-0020).
    expect(result.reply).toContain(PROPOSAL_LEAD);
    expect(result.reply).toContain(GUESS_FIRST_AFFORDANCE);
    // Style is never invented: an open style is named as the split.
    expect(result.record.styleTags).toEqual([]);
    expect(result.reply.toLowerCase()).toContain('split');
  });

  it('flag on: a placement the customer gave is kept, not replaced', async () => {
    process.env.DESIGN_INTAKE_GUESS_FIRST = 'true';
    modelReturns({ ...VAGUE_PAYLOAD, record: { ...VAGUE_PAYLOAD.record, placement: 'calf' } });
    const result = await runTurn({ messages: firstTurn('flowers for my grandma on my calf'), userTurn: 1 });

    expect(result.record.placement).toBe('calf');
    expect(result.turnLog.assumedPlacement).toBeUndefined();
    if (result.turnLog.firedRule === 'guess-first-proposal') {
      expect(result.reply).not.toContain(DEFAULT_PLACEMENT);
    }
  });

  it('flag on: with nothing to draw it asks, as today', async () => {
    process.env.DESIGN_INTAKE_GUESS_FIRST = 'true';
    modelReturns(EMPTY_PAYLOAD);
    const result = await runTurn({ messages: firstTurn('i want a tattoo'), userTurn: 1 });

    expect(result.stage).toBe('chatting');
    expect(result.turnLog.firedRule).not.toBe('guess-first-proposal');
    expect(result.record.placement ?? '').toBe('');
  });

  it('flag on: only the first turn guesses', async () => {
    process.env.DESIGN_INTAKE_GUESS_FIRST = 'true';
    modelReturns(VAGUE_PAYLOAD);
    const messages: ConversationMessage[] = [
      { role: 'bot', text: opener() },
      { role: 'user', text: 'hey' },
      { role: 'bot', text: 'hey! what are you thinking of?' },
      { role: 'user', text: 'something for my grandma, maybe flowers' },
    ];
    const result = await runTurn({ messages, userTurn: 2 });

    expect(result.turnLog.firedRule).not.toBe('guess-first-proposal');
    expect(result.record.placement ?? '').toBe('');
  });

  it('flag on: a first turn that already proposes keeps its own rule', async () => {
    process.env.DESIGN_INTAKE_GUESS_FIRST = 'true';
    modelReturns(RICH_PAYLOAD);
    const result = await runTurn({ messages: firstTurn('a fine line hummingbird on my left forearm for my grandmother'), userTurn: 1 });

    expect(result.stage).toBe('proposal');
    expect(result.turnLog.firedRule).toBe('judgment');
    expect(result.turnLog.assumedPlacement).toBeUndefined();
  });

  it('the reply after a guess logs the edit and carries the stated placement', async () => {
    process.env.DESIGN_INTAKE_GUESS_FIRST = 'true';
    modelReturns(VAGUE_PAYLOAD);
    const guessLog: TurnLog = {
      turn: 1,
      confidence: 0.4,
      missingFields: ['placement', 'styleTags'],
      firedRule: 'guess-first-proposal',
      model: 'gemini-test',
      assumedPlacement: DEFAULT_PLACEMENT,
    };
    const messages: ConversationMessage[] = [
      ...firstTurn('something for my grandma, maybe flowers'),
      { role: 'bot', text: `i'm assuming it goes on your ${DEFAULT_PLACEMENT}. ${PROPOSAL_LEAD} a piece on your ${DEFAULT_PLACEMENT}. ${GUESS_FIRST_AFFORDANCE}` },
      { role: 'user', text: 'make it bolder' },
    ];
    const result = await runTurn({ messages, userTurn: 2, previousTurnLogs: [guessLog] });

    expect(result.record.placement).toBe(DEFAULT_PLACEMENT);
    expect(result.turnLog.firedRule).not.toBe('guess-first-proposal');
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ event_type: GUESS_FIRST_EDITED_EVENT, turn: 2 })
    );
  });

  it('a placement named after the guess replaces the assumption', async () => {
    process.env.DESIGN_INTAKE_GUESS_FIRST = 'true';
    modelReturns({ ...VAGUE_PAYLOAD, record: { ...VAGUE_PAYLOAD.record, placement: 'ribs' } });
    const guessLog: TurnLog = {
      turn: 1,
      confidence: 0.4,
      missingFields: ['placement'],
      firedRule: 'guess-first-proposal',
      model: 'gemini-test',
      assumedPlacement: DEFAULT_PLACEMENT,
    };
    const messages: ConversationMessage[] = [
      ...firstTurn('something for my grandma, maybe flowers'),
      { role: 'bot', text: `i'm assuming it goes on your ${DEFAULT_PLACEMENT}.` },
      { role: 'user', text: 'actually on my ribs' },
    ];
    const result = await runTurn({ messages, userTurn: 2, previousTurnLogs: [guessLog] });

    expect(result.record.placement).toBe('ribs');
  });
});
