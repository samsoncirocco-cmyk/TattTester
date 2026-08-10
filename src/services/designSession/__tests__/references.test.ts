/**
 * Reference-image entries on the design session (TAT-50): the signal merge
 * into the working record (style tags, Brief lines, the IP rule via the
 * same character machinery as text), the per-turn re-merge in converse(),
 * and the attachReference phase guards. Engine and Firebase are mocked;
 * persistence runs on the in-memory store; the ontology resolves against
 * the real data/style-ontology.json.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { converse, attachReference, DesignSessionError } from '../index';
import { clearMemorySessions, memorySessionStore } from '../internal/store';
import {
  applyReferenceSignals,
  buildStoredReference,
  referenceImagePaths,
  subjectFromReferences,
  MAX_SESSION_REFERENCES,
} from '../internal/references';
import { runTurn } from '../../designConversation';
import type { ConversationTurnResult } from '../../designConversation/types';
import type { ReferenceAnalysis } from '../../vision';

vi.mock('../../designConversation', () => {
  class ConversationUnavailableError extends Error {}
  return {
    runTurn: vi.fn(),
    opener: () => 'Where on your body are you thinking, and what should it mean?',
    HANDOFF_URL: '/smart-match',
    ConversationUnavailableError,
  };
});
vi.mock('@/lib/firebase-admin', () => ({ ensureAdminApp: vi.fn(() => false) }));
vi.mock('@/services/gcs-service', () => ({
  deleteFromGCS: vi.fn(async () => true),
  uploadToGCS: vi.fn(async (_buf: Buffer, path: string) => ({ url: `gs://test/${path}`, path })),
  getSignedUrl: vi.fn(async (path: string) => `https://signed.test/${path}`),
}));
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  createRequestLogger: vi.fn(),
}));

const runTurnMock = vi.mocked(runTurn);

function analysis(overrides: Partial<ReferenceAnalysis> = {}): ReferenceAnalysis {
  return {
    summary: 'five chibi anime characters, bold outlines, cel shading, red smoke background',
    subjects: ['group of five characters'],
    characters: [
      { name: 'Yusuke Urameshi', series: 'Yu Yu Hakusho' },
      { name: 'Hiei', series: 'Yu Yu Hakusho' },
    ],
    styleDescriptors: ['chibi', 'anime', 'cel shading', 'bold outlines'],
    palette: ['red', 'black'],
    composition: 'group shot in a loose cluster',
    confidence: 0.87,
    ...overrides,
  };
}

function turnResult(overrides: Partial<ConversationTurnResult> = {}): ConversationTurnResult {
  return {
    reply: 'Noted. Where would it go?',
    stage: 'chatting',
    record: { styleTags: [], references: [], ambiguousAxes: ['literal-abstract'] },
    turnLog: { turn: 1, confidence: 0.3, missingFields: [], firedRule: 'none', model: 'm1' },
    notes: { cast: [], ipHeadsUp: false, sufficient: false },
    ...overrides,
  };
}

/** Start a conversational-intake session (the free opener call). */
async function startConversation(): Promise<string> {
  const opened = await converse({});
  return opened.sessionId;
}

beforeEach(() => {
  clearMemorySessions();
  vi.clearAllMocks();
});

describe('applyReferenceSignals', () => {
  it('merges style tags, Brief lines, and the character subject; locks literal-abstract', async () => {
    const reference = await buildStoredReference(analysis(), 'sms');

    const merged = applyReferenceSignals(
      { styleTags: ['fine-line'], references: [], ambiguousAxes: ['literal-abstract', 'bold-fine'] },
      [reference]
    );

    expect(merged.styleTags).toContain('fine-line');
    expect(merged.styleTags).toContain('anime'); // resolved from the descriptors
    expect(merged.references).toEqual([
      'reference image: five chibi anime characters, bold outlines, cel shading, red smoke background',
    ]);
    // Recognized characters became the subject → the IP axis lock applies.
    expect(merged.subject).toBeTruthy();
    expect(merged.ambiguousAxes).toEqual(['bold-fine']);
  });

  it('never overwrites a subject the conversation already carries', async () => {
    const reference = await buildStoredReference(analysis(), 'sms');
    const merged = applyReferenceSignals({ subject: 'a sparrow in flight' }, [reference]);
    expect(merged.subject).toBe('a sparrow in flight');
  });

  it('routes recognized characters through the database machinery when it matches', async () => {
    const reference = await buildStoredReference(analysis(), 'sms');
    const subject = subjectFromReferences([reference]);
    // Whatever phrasing wins, both recognized characters must survive into
    // the prompt-facing subject — dropping one is the TAT-47 defect-6 bug.
    expect(subject).toBeTruthy();
    expect(subject!.toLowerCase()).toContain('yusuke');
    expect(subject!.toLowerCase()).toContain('hiei');
  });

  it('is a no-op with no references', () => {
    const record = { styleTags: ['traditional'] };
    expect(applyReferenceSignals(record, [])).toBe(record);
  });
});

describe('attachReference', () => {
  it('stores the entry, merges the record, and returns notes with the reference row and IP heads-up', async () => {
    const sessionId = await startConversation();

    const result = await attachReference(sessionId, analysis(), 'sms');

    expect(result.summary).toContain('five chibi anime characters');
    expect(result.notes.references).toEqual([
      'five chibi anime characters, bold outlines, cel shading, red smoke background',
    ]);
    // A recognized character in a photo fires the same inspired-by handling
    // as a text mention (TAT-47 defect-5 parity).
    expect(result.notes.ipHeadsUp).toBe(true);
    expect(result.notes.cast.length).toBeGreaterThan(0);

    const stored = await memorySessionStore.get(sessionId);
    expect(stored!.conversation!.references).toHaveLength(1);
    expect(stored!.conversation!.record.styleTags).toContain('anime');
    expect(stored!.conversation!.record.references).toEqual([
      'reference image: five chibi anime characters, bold outlines, cel shading, red smoke background',
    ]);
  });

  it('keeps reference signals across engine turns that rebuild the record', async () => {
    const sessionId = await startConversation();
    await attachReference(sessionId, analysis(), 'sms');

    // The engine returns a fresh record with no knowledge of the reference.
    runTurnMock.mockResolvedValue(turnResult());
    const response = await converse({ sessionId, message: 'on my forearm' });

    expect(response.notes!.references).toHaveLength(1);
    expect(response.notes!.ipHeadsUp).toBe(true);
    const stored = await memorySessionStore.get(sessionId);
    expect(stored!.conversation!.record.styleTags).toContain('anime');
    expect(stored!.conversation!.record.subject).toBeTruthy();
    // The engine offered literal-abstract; the reference subject locks it.
    expect(stored!.conversation!.record.ambiguousAxes).not.toContain('literal-abstract');
  });

  it('bounds stored references per session', async () => {
    const sessionId = await startConversation();
    for (let i = 0; i < MAX_SESSION_REFERENCES + 2; i += 1) {
      await attachReference(sessionId, analysis({ summary: `reference ${i}` }), 'web');
    }
    const stored = await memorySessionStore.get(sessionId);
    expect(stored!.conversation!.references).toHaveLength(MAX_SESSION_REFERENCES);
    expect(stored!.conversation!.references![MAX_SESSION_REFERENCES - 1].summary).toBe(
      `reference ${MAX_SESSION_REFERENCES + 1}`
    );
  });

  // ADR-0050 / #334: an evicted entry's photo object goes with it — but
  // only the evicted one, and only paths inside the reference prefix.
  it('deletes an evicted reference photo, and nothing else', async () => {
    const { deleteFromGCS } = await import('@/services/gcs-service');
    const sessionId = await startConversation();
    for (let i = 0; i <= MAX_SESSION_REFERENCES; i += 1) {
      await attachReference(
        sessionId,
        analysis({ summary: `reference ${i}` }),
        'web',
        `design-sessions/${sessionId}/references/r${i}.jpg`
      );
    }
    // Only the oldest fell off the bound, so only its object is deleted.
    expect(deleteFromGCS).toHaveBeenCalledTimes(1);
    expect(deleteFromGCS).toHaveBeenCalledWith(
      `design-sessions/${sessionId}/references/r0.jpg`
    );
  });

  it('refuses to delete outside the reference prefix', async () => {
    const { deleteFromGCS } = await import('@/services/gcs-service');
    const { deleteReferencePhotos } = await import('../internal/referencePhotos');

    await deleteReferencePhotos('s1', [
      'design-sessions/s1/placement-123.png',
      'design-sessions/s1/variations/v1.png',
      undefined,
      'design-sessions/s1/references/ok.jpg',
      'reference-photos/s1/new-style.jpg',
    ]);

    expect(deleteFromGCS).toHaveBeenCalledTimes(2);
    expect(deleteFromGCS).toHaveBeenCalledWith('design-sessions/s1/references/ok.jpg');
    expect(deleteFromGCS).toHaveBeenCalledWith('reference-photos/s1/new-style.jpg');
  });

  // #334: new uploads land under their own top-level prefix so the GCS
  // lifecycle backstop rule can target them — lifecycle conditions match
  // literal prefixes only, and design-sessions/*/references/ cannot be
  // expressed without also matching the designs.
  it('stores new photos under the lifecycle-friendly prefix', async () => {
    const { storeReferencePhoto } = await import('../internal/referencePhotos');
    const path = await storeReferencePhoto('sess-9', {
      data: Buffer.from('img').toString('base64'),
      mimeType: 'image/jpeg',
    });
    expect(path).toMatch(/^reference-photos\/sess-9\/[0-9a-f-]+\.jpg$/);
  });

  // ADR-0050: the stored photo path persists with the entry, and the
  // accessor yields only real paths — analysis-only references (photo
  // upload failed, or attached before the field existed) contribute none.
  it('persists the photo path and exposes it through referenceImagePaths', async () => {
    const sessionId = await startConversation();
    await attachReference(
      sessionId,
      analysis({ summary: 'with photo' }),
      'sms',
      'design-sessions/s/references/r1.jpg'
    );
    await attachReference(sessionId, analysis({ summary: 'analysis only' }), 'web');

    const stored = await memorySessionStore.get(sessionId);
    const references = stored!.conversation!.references!;
    expect(references[0].imagePath).toBe('design-sessions/s/references/r1.jpg');
    expect(references[1].imagePath).toBeUndefined();
    expect(referenceImagePaths(references)).toEqual(['design-sessions/s/references/r1.jpg']);
  });

  it('refuses outside conversational intake', async () => {
    const sessionId = await startConversation();
    const stored = await memorySessionStore.get(sessionId);
    stored!.phase = 'revealed';
    await memorySessionStore.save(stored!);

    await expect(attachReference(sessionId, analysis(), 'web')).rejects.toThrow(
      DesignSessionError
    );
  });
});
