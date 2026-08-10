/**
 * Conversational intake integration (ADR-0019–0022).
 *
 * Wires the conversation engine ('@/services/designConversation', consumed
 * only via its public entry) into the design session. The engine is
 * stateless — this module owns everything it doesn't: persistence of the
 * transcript, turn count, partial record, and per-turn TurnLogs (the
 * ADR-0022 day-one logs live on the stored session), per-session
 * conversation-model pinning (TurnLog.model passed back as pinnedModel,
 * precedent: pinnedModelId), and the ConverseRequest/Response mapping.
 *
 * confirmProposal() is the user's yes to the ADR-0020 proposal — it runs
 * the EXISTING reveal pipeline over the conversation's extracted record via
 * the shared startFromRecord path, moving phase 'intake' → 'revealed'.
 */
import { randomUUID } from 'crypto';
import { logger } from '@/lib/logger';
import {
  runTurn,
  opener,
  HANDOFF_URL,
  ConversationUnavailableError,
} from '../../designConversation';
import type {
  ConversationTurnResult,
  ConverseRequest,
  ConverseResponse,
  SessionNotes,
} from '../../designConversation/types';
import {
  buildSessionNotes,
  withReferenceNotes,
} from '../../designConversation/internal/notes';
import type { IntakeRecord } from '../../intake/types';
import {
  characterSubjectFrom,
  charactersIn,
} from '../../intake/internal/characterSubject';
import type { ReferenceAnalysis } from '@/services/vision';
import { resolveSessionStore } from './store';
import type { StoredSession } from './store';
import { DesignSessionError, loadSession, startFromRecord } from './orchestrator';
import {
  applyReferenceSignals,
  buildStoredReference,
  referenceCastLabels,
  MAX_SESSION_REFERENCES,
  type StoredReference,
} from './references';
import { deleteReferencePhotos } from './referencePhotos';

/**
 * Placeholder DesignSession fields for a session still in conversational
 * intake: the frozen contract requires them, but they only become real at
 * confirm, when startFromRecord overwrites every one of them.
 */
function newConversationSession(): StoredSession {
  const now = new Date().toISOString();
  return {
    id: randomUUID(),
    phase: 'intake',
    intake: { placement: '', styleTags: [], meaning: '', references: [], ambiguousAxes: [] },
    axisSelection: {
      mode: 'questionnaire',
      axes: [],
      rationale: 'Pending conversational intake — axis selection happens at confirm.',
    },
    provider: '',
    pinnedModelId: '',
    variations: [],
    conversation: { transcript: [], turnCount: 0, record: {}, turnLogs: [], stage: 'chatting' },
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * The engine promises the record is complete enough to generate once the
 * stage is 'proposal' (frozen contract); the fill-ins below only normalize
 * absent optionals so the reveal pipeline gets a well-formed record.
 */
function completeIntakeRecord(
  record: Partial<IntakeRecord>,
  transcriptText = ''
): IntakeRecord {
  // Same backfill as the scripted intake: the conversation model drops
  // `subject` often enough that a named character otherwise vanishes from
  // the prompt entirely (a Goku session rendered lettering of the meaning).
  const subject = record.subject?.trim() || characterSubjectFrom(transcriptText) || undefined;
  let ambiguousAxes = record.ambiguousAxes ?? [];
  // Enforced here as well as in the persona contract: a named subject means
  // a recognizable depiction — reveal slots never go abstract on it.
  if (subject) {
    ambiguousAxes = ambiguousAxes.filter((axis) => axis !== 'literal-abstract');
  }
  return {
    placement: record.placement ?? '',
    styleTags: record.styleTags ?? [],
    meaning: record.meaning ?? '',
    subject,
    ...(record.requestedCharacters
      ? { requestedCharacters: [...record.requestedCharacters] }
      : {}),
    // A looks-first session stays looks-first through the reveal (TAT-51).
    ...(record.vibe ? { vibe: record.vibe } : {}),
    references: record.references ?? [],
    ambiguousAxes,
    // The explicitly requested spread (ADR-0049) rides through to axis
    // selection — except literal-abstract on a named subject, which the
    // same rule above already forbids from rendering abstract.
    ...(record.requestedAxis && !(subject && record.requestedAxis === 'literal-abstract')
      ? { requestedAxis: record.requestedAxis }
      : {}),
  };
}

/**
 * One conversational turn (ADR-0019). No sessionId starts a new session at
 * phase 'intake' — the deterministic opener, no model call. With one, the
 * user message becomes the next engine turn on the session's pinned
 * conversation model, and everything the engine returns is persisted before
 * responding.
 */
export async function converse(request: ConverseRequest): Promise<ConverseResponse> {
  const store = resolveSessionStore();

  let session: StoredSession;
  if (request.sessionId === undefined) {
    session = newConversationSession();
    if (request.message === undefined) {
      // The opening call: the bot leads with placement and meaning
      // (ADR-0019) — deterministic, free, and never a model turn.
      const reply = opener();
      session.conversation!.transcript = [{ role: 'bot', text: reply }];
      await store.save(session);
      return { sessionId: session.id, reply, stage: 'chatting', turn: 0 };
    }
  } else {
    session = await loadSession(store, request.sessionId);
    if (session.phase !== 'intake' || !session.conversation) {
      throw new DesignSessionError(
        'INVALID_PHASE',
        `Cannot converse while the session is '${session.phase}' — the conversation ends once the reveal fires.`
      );
    }
    if (session.conversation.stage === 'handoff') {
      throw new DesignSessionError(
        'INVALID_PHASE',
        'This conversation closed with a warm handoff to artists — start a new session to design again.'
      );
    }
  }

  const conversation = session.conversation!;
  const message = request.message?.trim() ?? '';
  const userTurn = conversation.turnCount + 1;
  const messages = [...conversation.transcript, { role: 'user' as const, text: message }];

  let result: ConversationTurnResult;
  try {
    result = await runTurn({
      messages,
      userTurn,
      pinnedModel: conversation.model,
      // Only so the provider-failover / degraded-mode logs name a session.
      sessionId: session.id,
    });
  } catch (error) {
    if (error instanceof ConversationUnavailableError) {
      // The downgrade used to be silent: a live session dropped mid-way to
      // "Keeping it simple today — two quick questions and we're off." with
      // nothing in the logs explaining why or which provider gave out. The
      // per-provider attempts are the whole diagnostic value, so they are
      // recorded here rather than collapsed into a message string.
      logger.warn({
        event_type: 'design_conversation.scripted_fallback',
        trigger: 'all_conversation_providers_exhausted',
        session_id: session.id,
        turn: userTurn,
        // Which provider failed, and why — e.g.
        // [{ provider: 'vertex', model: 'gemini-2.0-flash', reason: '429' }]
        failed_providers: (error.attempts ?? []).map((attempt) => attempt.provider),
        attempts: error.attempts ?? [],
        pinned_model: conversation.model,
      });
      // Typed domain error the route maps to 503 — the UI downgrades to the
      // scripted two-question intake (ADR-0019 degraded mode).
      throw new DesignSessionError(
        'CONVERSATION_UNAVAILABLE',
        'Every conversation provider is unavailable — fall back to the scripted intake.'
      );
    }
    throw error;
  }

  // Re-merge reference signals EVERY turn (TAT-50): the engine rebuilds the
  // record wholesale from this turn's extraction, which would silently drop
  // an attached reference image's style tags/subject/Brief line otherwise.
  const references = conversation.references ?? [];
  const mergedRecord = applyReferenceSignals(result.record, references);
  const notes = withReferenceNotes(
    result.notes,
    mergedRecord,
    references.map((ref) => ref.summary),
    referenceCastLabels(references)
  );

  // Persist everything: transcript + TurnLogs are the ADR-0022 day-one logs.
  conversation.transcript = [...messages, { role: 'bot', text: result.reply }];
  conversation.turnCount = userTurn;
  conversation.record = mergedRecord;
  conversation.turnLogs = [...conversation.turnLogs, result.turnLog];
  conversation.stage = result.stage;
  if (result.playback !== undefined) conversation.playback = result.playback;
  // Per-session model pinning: pass back TurnLog.model as the next turn's
  // pinnedModel (the engine's provider chain tries it first).
  conversation.model = result.turnLog.model;
  session.updatedAt = new Date().toISOString();
  await store.save(session);

  const response: ConverseResponse = {
    sessionId: session.id,
    reply: result.reply,
    stage: result.stage,
    turn: userTurn,
    // SketchBot's notepad (TAT-48): the engine's whitelisted projection of
    // the record — never the record itself, never TurnLogs or rationale.
    // Reference rows (TAT-50) are overlaid through the same whitelist file.
    notes,
  };
  if (result.stage === 'proposal' && result.playback !== undefined) {
    response.playback = result.playback;
  }
  if (result.stage === 'handoff') {
    // Warm handoff CTA (ADR-0021) — the engine owns the destination.
    response.handoffUrl = HANDOFF_URL;
  }
  return response;
}

/**
 * The user's yes to the proposal (ADR-0020): requires phase 'intake' with
 * stage 'proposal' reached, then runs the existing reveal pipeline over the
 * conversation's extracted record — the session moves to phase 'revealed'
 * in place, keeping its id and conversation logs.
 */
export async function confirmProposal(sessionId: string): Promise<StoredSession> {
  const store = resolveSessionStore();
  const session = await loadSession(store, sessionId);

  if (session.phase !== 'intake' || !session.conversation) {
    throw new DesignSessionError(
      'INVALID_PHASE',
      `Cannot confirm while the session is '${session.phase}' — confirmation fires the reveal exactly once.`
    );
  }
  if (session.conversation.stage !== 'proposal') {
    throw new DesignSessionError(
      'INVALID_PHASE',
      'The conversation has not reached its proposal yet — generation fires on announce + confirm (ADR-0020), never before.'
    );
  }

  // The user's own words across the conversation — the backfill source when
  // the model returned no subject.
  const userText = session.conversation.transcript
    .filter((entry) => entry.role === 'user')
    .map((entry) => entry.text)
    .join(' ');

  // Belt and braces with the per-turn merge in converse(): the record that
  // reaches Council enhancement and generation carries every attached
  // reference image's signals (TAT-50), whatever order attach/turns ran in.
  const record = applyReferenceSignals(
    session.conversation.record,
    session.conversation.references ?? []
  );

  return startFromRecord(completeIntakeRecord(record, userText), session);
}

/** What attachReference hands back — enough for a channel to speak and render. */
export interface AttachReferenceResult {
  sessionId: string;
  /** The stored entry's user-visible line. */
  summary: string;
  /** The notepad projection including the new reference row. */
  notes: SessionNotes;
}

/**
 * Attach an analyzed reference image to a session in conversational intake
 * (TAT-50). The analysis is stored as a reference entry, and its signals
 * merge into the working record immediately — style tags toward Council
 * enhancement, a reference line toward the artist Brief, and recognized
 * characters through the same inspired-by machinery as text mentions.
 * Both channels land here: SMS media and the web reference upload.
 */
export async function attachReference(
  sessionId: string,
  analysis: ReferenceAnalysis,
  source: StoredReference['source'],
  imagePath?: string
): Promise<AttachReferenceResult> {
  const store = resolveSessionStore();
  const session = await loadSession(store, sessionId);

  if (session.phase !== 'intake' || !session.conversation) {
    throw new DesignSessionError(
      'INVALID_PHASE',
      `Cannot attach a reference while the session is '${session.phase}' — references inform the brief before the reveal.`
    );
  }
  if (session.conversation.stage === 'handoff') {
    throw new DesignSessionError(
      'INVALID_PHASE',
      'This conversation closed with a warm handoff to artists — start a new session to design again.'
    );
  }

  const reference = await buildStoredReference(analysis, source, imagePath);
  // Newest-first eviction bound: a brief, not a photo album.
  const combined = [...(session.conversation.references ?? []), reference];
  const references = combined.slice(-MAX_SESSION_REFERENCES);
  const evicted = combined.slice(0, combined.length - references.length);
  session.conversation.references = references;
  session.conversation.record = applyReferenceSignals(
    session.conversation.record,
    references
  );
  session.updatedAt = new Date().toISOString();
  await store.save(session);

  // The save dropped the evicted entries; their photo objects go with them
  // (ADR-0050 / #334). After the save so a failed save deletes nothing.
  if (evicted.length) {
    await deleteReferencePhotos(
      session.id,
      evicted.map((entry) => entry.imagePath)
    );
  }

  logger.info({
    event_type: 'design_session.reference_attached',
    session_id: session.id,
    source,
    characters: reference.characters.length,
    style_tags: reference.styleTags,
    reference_count: references.length,
  });

  const record = session.conversation.record;
  const notes = withReferenceNotes(
    buildSessionNotes(record, charactersIn(record.subject ?? '')),
    record,
    references.map((ref) => ref.summary),
    referenceCastLabels(references)
  );
  return { sessionId: session.id, summary: reference.summary, notes };
}
