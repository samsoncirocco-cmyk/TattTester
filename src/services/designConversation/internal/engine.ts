/**
 * The conversation engine (ADR-0019, ADR-0020, ADR-0021, ADR-0022).
 *
 * Stateless: the caller owns persistence and passes the full transcript in.
 * Each live turn makes ONE model call that does double duty — the
 * conversational reply plus an incremental structured extraction into
 * Partial<IntakeRecord> — then deterministic code (never model judgment)
 * decides the stage:
 *
 *   turn >= 20                                → 'handoff'  (warm, ADR-0021)
 *   turn >= 12 AND placement present          → 'proposal' (forced best-guess
 *                                                playback, ADR-0020 phrasing)
 *   turn >= 12, no placement                  → 'chatting' (ask for placement
 *                                                directly — the forced proposal
 *                                                never guesses the one field
 *                                                with a hard downstream
 *                                                dependency; ADR-0021
 *                                                amendment)
 *   confidence >= threshold AND placement
 *     + meaning present                       → 'proposal' (judgment)
 *   same field blocked STALLED_FIELD_TURNS
 *     turns running                           → 'chatting' (ask for that
 *                                                field outright; a short
 *                                                answer settles it — #376,
 *                                                internal/gate.ts)
 *   otherwise                                 → 'chatting'
 *
 * Every turn produces a TurnLog (day-one requirement, ADR-0022), returned in
 * the result AND logged via the repo's pino logger.
 */

import { logger } from '@/lib/logger';
import { GUESS_FIRST_EDITED_EVENT } from '../events';
import {
  type IntakeRecord,
  type VariationAxis,
  VARIATION_AXIS_POOL,
  charactersIn,
  characterLabelFor,
  subjectPhraseFor,
  characterIdentitiesFor,
  momentFrom,
  groundedCharacterIdentities,
  mergeCharacterIdentities,
} from '@/services/intake';
import type {
  ConversationMessage,
  ConversationStage,
  ConversationTurnResult,
  TurnLog,
} from '../types';
import {
  buildSystemPrompt,
  HANDOFF_MESSAGE,
  PLACEMENT_GATE_QUESTION,
  SUBJECT_GATE_QUESTION,
  proposalReply,
  proposalFollowUp,
  axisSpreadProposalReply,
  colorCallReply,
  PROPOSAL_LEAD,
  PROPOSAL_REMINDER,
  COLOR_QUESTION,
  KEEP_GOING_QUESTION,
  REPEAT_FALLBACK,
  axisSpreadDeferredReply,
  drawRequestDeferredReply,
  LEGACY_COLOR_ASKS,
  LEGACY_IP_NOTES,
  LEGACY_PROPOSAL_LEADS,
  COLOR_RETRY_QUESTION,
  IP_NOTE,
  EVOCATION_STEM,
  evocationQuestion,
  AESTHETIC_ACK,
  guessFirstReply,
} from './persona';
import {
  detectAxisRequest,
  isSuggestionRequest,
  isAffirmation,
  isDrawRequest,
  evocationRefOf,
  isAestheticAnswer,
} from './intent';
import { loadStyleTagIndex, resolveStyleTags, type StyleTagIndex } from './ontology';
import { scoreRecord, CONFIDENCE_THRESHOLD, isSpecificPlacement } from './confidence';
import {
  blockingFieldFor,
  consecutiveBlockedTurns,
  gateStateFor,
  stalledFieldAsk,
  isStalledAskFor,
  shortAnswerOf,
  isHandBack,
  DEFAULT_PLACEMENT,
  STALLED_FIELD_TURNS,
} from './gate';
import { buildSessionNotes } from './notes';
import { converseWithProviders, type RawTurnPayload } from './providers';
import { isDemoMode, runDemoTurn } from './demoScript';

/** Cadence caps (ADR-0021) — deterministic code, never exposed as limits. */
export const FORCE_PROPOSAL_TURN = 12;

export { GUESS_FIRST_EDITED_EVENT } from '../events';

/**
 * Guess-first intake (spec 17) is off unless DESIGN_INTAKE_GUESS_FIRST is
 * 'true'. Read per turn so a flag flip needs no restart.
 */
export function isGuessFirstEnabled(): boolean {
  return process.env.DESIGN_INTAKE_GUESS_FIRST === 'true';
}
export const HANDOFF_TURN = 20;

export interface RunTurnRequest {
  /** Full transcript so far, oldest first (the caller owns persistence). */
  messages: ConversationMessage[];
  /** 1-based number of user turns taken, including the one being answered. */
  userTurn: number;
  /**
   * Model pinned for this session by the caller (from a previous turn's
   * TurnLog.model). The provider chain tries it first.
   */
  pinnedModel?: string;
  /**
   * Session this turn belongs to. Not used for conversation logic — passed
   * to the provider chain purely so provider-failover and degraded-mode logs
   * are traceable to a session (never any transcript content).
   */
  sessionId?: string;
  /**
   * Every previous turn's TurnLog for this session, oldest first (the
   * caller persists them, ADR-0022). The stall rule (#376) counts how many
   * turns in a row the same field has blocked the proposal off these.
   * Omitted = first turn, nothing blocked yet.
   */
  previousTurnLogs?: readonly TurnLog[];
}

/* ──────────────────────────────────────────────────────────────────────────
 * Record sanitization: the model's extraction is a suggestion; the contract
 * (closed style tags, axis pool membership) is enforced here.
 * ────────────────────────────────────────────────────────────────────────── */

function asTrimmedString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((v): v is string => typeof v === 'string' && v.trim().length > 0)
    .map((v) => v.trim());
}

function sanitizeRecord(
  payload: RawTurnPayload,
  ontology: StyleTagIndex
): Partial<IntakeRecord> {
  const raw = payload.record ?? {};

  const record: Partial<IntakeRecord> = {
    styleTags: resolveStyleTags(ontology, Array.isArray(raw.styleTags) ? raw.styleTags : []),
    references: asStringArray(raw.references),
  };

  const placement = asTrimmedString(raw.placement);
  if (placement) record.placement = placement.toLowerCase();

  // Meaning is verbatim-ish prose stitched from the user's words (the
  // system prompt forbids paraphrase); kept as given, trimmed only.
  const meaning = asTrimmedString(raw.meaning);
  if (meaning) record.meaning = meaning;

  // The model's own subject extraction. The persona has asked for this from
  // day one, but sanitization silently dropped it — which is how a session
  // naming five characters shipped a two-character brief (the deterministic
  // backfill was the only source left, and it was capped). Bounded so a
  // rambling model cannot flood the prompt path.
  const subject = asTrimmedString(raw.subject);
  if (subject) record.subject = subject.slice(0, 500);

  const rawAxes = asStringArray(raw.ambiguousAxes);
  record.ambiguousAxes = Array.isArray(raw.ambiguousAxes)
    ? VARIATION_AXIS_POOL.filter((axis): axis is VariationAxis => rawAxes.includes(axis))
    : [...VARIATION_AXIS_POOL];

  return record;
}

/* ──────────────────────────────────────────────────────────────────────────
 * Playback: the one-line best-guess summary (ADR-0020)
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * The subject fallback, spoken when no character label resolved. Shorter than
 * the meaning budget on purpose: this is a name, not prose.
 */
const PLAYBACK_SUBJECT_MAX = 90;
/** Meaning is the last resort — no character, no subject, nothing else known. */
const PLAYBACK_MEANING_MAX = 140;
/** The scene/moment clause rides after the character list, never truncating it. */
const PLAYBACK_MOMENT_MAX = 120;

function truncateAtWord(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const lastSpace = cut.lastIndexOf(' ');
  return `${cut.slice(0, lastSpace > 40 ? lastSpace : max)}…`;
}

export function buildPlayback(
  record: Partial<IntakeRecord>,
  characterLabel?: string,
  moment?: string
): string {
  const tags = record.styleTags ?? [];
  const style = tags.length
    ? `${tags.map((t) => t.replace(/-/g, ' ')).join(' and ')} `
    : '';
  const article = /^[aeiou]/i.test(style) ? 'an' : 'a';
  const placement = record.placement
    ? `on your ${record.placement}`
    : 'with the placement still open';
  // Named characters read back far better than the raw meaning prose
  // ("Goku (Dragon Ball Z)" vs "never giving up no matter how outmatched").
  // Deliberately the short LABEL, never `record.subject` — subject carries
  // the costume anchors the prompts need ("Goku with wild spiky black hair,
  // orange gi, ...") and dropping that here produces an unreadable sentence.
  // The label enumerates EVERY named character (the brief owes the user the
  // full cast, never a truncated pair), and the scene they settled on rides
  // along after it.
  const subject = (characterLabel ?? '').trim();
  const meaning = (record.meaning ?? '').trim();
  let tailPart = '';
  if (subject) {
    const momentPart = (moment ?? '').trim()
      ? `, ${truncateAtWord((moment ?? '').trim(), PLAYBACK_MOMENT_MAX)}`
      : '';
    tailPart = ` — ${subject}${momentPart}`;
  } else {
    // No character label resolved — the catalog did not recognize anyone. The
    // SUBJECT still knows what we are about to draw, and it outranks meaning.
    //
    // Meaning is *why* they want it, not what is in the picture. Speaking it
    // as the piece is how a session that asked for Nelson Muntz got told we
    // were drawing "punk with a tear" — and the customer cannot tell we
    // substituted one for the other, because both sound like a description.
    //
    // Meaning stays as the LAST resort rather than being removed: with no
    // character and no subject it is the only thing we know, and a brief whose
    // whole content is "a hummingbird for my grandmother" deserves a sentence
    // that mentions the hummingbird. The bug was the precedence, not the
    // existence of the fallback.
    const spoken = spokenSubject(record.subject);
    if (spoken) tailPart = ` — ${spoken}`;
    // Marked as the WHY, never asserted as the what. Bare, the meaning clause
    // sits in the exact position a subject would and reads as one — which is
    // the same substitution this fix exists to stop, just wearing a smaller
    // mask. "about" says we are repeating what it means to them, not claiming
    // to know what is in the picture.
    else if (meaning) tailPart = ` — about ${truncateAtWord(meaning, PLAYBACK_MEANING_MAX)}`;
  }
  return `${article} ${style}piece ${placement}${tailPart}`;
}

/**
 * `record.subject` trimmed down to something worth reading aloud.
 *
 * The subject is written for the image model, not for a person: it carries the
 * costume anchors the prompts need ("Nelson Muntz with blue shirt, purple
 * shorts, single tear, punk styling"). Speaking that whole string back is
 * unreadable, so the playback takes the leading clause — the part that names
 * the thing — and stops there.
 *
 * Returns undefined when there is nothing nameable, in which case the playback
 * simply says less. A shorter true sentence beats a longer substituted one.
 */
function spokenSubject(subject: string | undefined): string | undefined {
  const value = (subject ?? '').trim();
  if (!value) return undefined;

  // Up to the first anchor clause — "X with ...", "X, wearing ..." — so the
  // prompt's costume prose does not arrive in the customer's sentence.
  const clauses = value
    .split(/\s*[,;]|\s+\bwith\b\s+/i)
    .map((clause) => clause.trim())
    .filter(Boolean);
  if (clauses.length === 0) return truncateAtWord(value, PLAYBACK_SUBJECT_MAX);

  // The extraction prompt offers two subject shapes and joins the franchise
  // differently in each: "Izuku Midoriya (Deku) FROM My Hero Academia, ..."
  // keeps the franchise inside the first clause, but "Killua Zoldyck, Hunter
  // x Hunter, silver spiky hair, ..." puts it in the second — where a
  // first-clause-only rule silently dropped it, while the same prompt line
  // instructs the model to name the character AND the franchise.
  //
  // Costume prose and a franchise are both comma-delimited, so the boundary
  // cannot be the comma. Title case is what separates them: "Hunter x Hunter"
  // is mostly capitalized, "silver spiky hair" is not.
  const spoken =
    clauses[1] && looksLikeTitle(clauses[1])
      ? `${clauses[0]}, ${clauses[1]}`
      : clauses[0];
  return truncateAtWord(spoken, PLAYBACK_SUBJECT_MAX);
}

/**
 * Does this clause read as a proper name — a franchise or series — rather than
 * appearance prose?
 *
 * Majority-capitalized and short. Connectors ("of", "the") and the single
 * lowercase letters titles use as joins ("Hunter x Hunter") do not count
 * against it, since neither is capitalized in a real title either.
 */
function looksLikeTitle(clause: string): boolean {
  if (clause.length > 40) return false;
  const words = clause.split(/\s+/).filter(Boolean);
  if (words.length === 0) return false;
  const meaningful = words.filter(
    (word) => word.length > 1 && !LOWERCASE_NAME_CONNECTORS.has(word.toLowerCase())
  );
  if (meaningful.length === 0) return false;
  const capitalized = meaningful.filter((word) => /^[\p{Lu}\p{Lt}]/u.test(word));
  return capitalized.length >= Math.ceil(meaningful.length / 2);
}

/**
 * The provider's cumulative subject is the only generic source for named
 * characters outside our finite character database. Use it as the spoken
 * cast label when it is a short list, while keeping database labels for
 * single-character subjects where the provider often includes long costume
 * prose. This prevents a partial database hit from making the playback claim
 * the customer named only that one character.
 */
function compactCastParts(subject: string | undefined): string[] {
  const value = (subject ?? '').trim();
  if (!value || value.length > 180) return [];
  const hasListJoin = /[,;]|\s(?:and|&)\s/i.test(value);
  const words = value.split(/\s+/).filter(Boolean);
  if (!hasListJoin || words.length > 28) return [];

  // In a natural cast list the Oxford conjunction identifies the final
  // person. Provider-added scene notes after that item are not roster data:
  // "A, B, C, and D protecting the city, Epic Battle" ends at D's clause.
  const finalJoin = [...value.matchAll(/\s+(?:and|&)\s+/gi)].find(
    (match) => match.index !== undefined && /[,;]/.test(value.slice(0, match.index))
  );
  let listValue = value;
  if (finalJoin?.index !== undefined) {
    const finalItemStart = finalJoin.index + finalJoin[0].length;
    const nextDelimiterOffset = value.slice(finalItemStart).search(/[,;]/);
    if (nextDelimiterOffset >= 0) {
      listValue = value.slice(0, finalItemStart + nextDelimiterOffset);
    }
  }

  const parts = listValue
    .split(/\s*[,;]\s*|\s+(?:and|&)\s+/i)
    .map((part) => leadingDisplayName(part))
    .filter(isLikelyCharacterName);
  // Three is intentional: two-character action phrases such as "Gohan and
  // Cell beam struggle" are better served by the database labels. Three or
  // more compact entries is the strong cast-list shape seen in the failure.
  if (parts.length < 3) return [];
  if (parts.some((part) => part.length > 60)) return [];
  return parts;
}

const LOWERCASE_NAME_CONNECTORS = new Set(['the', 'of', 'de', 'del', 'van', 'von']);

const SCENE_DIRECTION_WORDS = new Set([
  'action',
  'background',
  'clash',
  'composition',
  'energy',
  'flow',
  'friendship',
  'match',
  'pose',
  'poses',
  'rivalry',
  'scene',
  'style',
  'weapon',
  'weapons',
]);

/**
 * Keep the name-shaped prefix of a list item and drop whatever action follows.
 * This handles any verb ("Dovan protecting the city"), rather than a finite
 * list of actions that will inevitably miss ordinary customer wording.
 */
function leadingDisplayName(value: string): string {
  const words = value
    .trim()
    .replace(/^(?:and|&)\s+/i, '')
    .split(/\s+/);
  const kept: string[] = [];
  for (const word of words) {
    const normalized = word.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
    if (!normalized) break;
    const isConnector = kept.length > 0 && LOWERCASE_NAME_CONNECTORS.has(normalized.toLowerCase());
    if (!isConnector && !/^[\p{Lu}\p{Lt}\p{N}]/u.test(normalized)) {
      // Preserve a scene noun long enough for `isLikelyCharacterName` to
      // reject the whole phrase ("Keyblade clash" must not become a person
      // named "Keyblade"). Ordinary actions still leave the leading name.
      if (SCENE_DIRECTION_WORDS.has(normalized.toLowerCase())) kept.push(normalized);
      break;
    }
    kept.push(normalized);
  }
  return kept.join(' ');
}

/** Reject scene directions that providers occasionally put in `characters`. */
function isLikelyCharacterName(value: string): boolean {
  const cleaned = value.trim();
  if (!cleaned) return false;
  const words = cleaned.split(/\s+/);
  if (words.length > 4) return false;
  if (/^(?:with|each|using|wielding|holding|surrounded|amid|sparring|fighting|a connected|an interconnected)\b/i.test(
    cleaned
  ) || /\b(?:swirling energy|vertical composition|story flow)\b/i.test(cleaned)) {
    return false;
  }
  if (words.some((word) => SCENE_DIRECTION_WORDS.has(
    word.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '').toLowerCase()
  ))) return false;
  return words.every((word, index) => {
    const normalized = word.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
    if (!normalized) return false;
    if (index > 0 && LOWERCASE_NAME_CONNECTORS.has(normalized.toLowerCase())) return true;
    return /^[\p{Lu}\p{Lt}\p{N}]/u.test(normalized);
  });
}

function compactCastLabel(subject: string | undefined): string | undefined {
  return compactCastParts(subject).length > 0 ? subject?.trim() : undefined;
}

function uniqueNames(names: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const name of names) {
    const cleaned = name.trim().replace(/\s+/g, ' ').slice(0, 80);
    const key = normalizeForCompare(cleaned);
    const keyTokens = key.split(' ');
    const duplicatesExisting = [...seen].some((existing) => {
      if (existing === key) return true;
      const existingTokens = existing.split(' ');
      // Provider names lead this union. A later catalog shorthand ("Cloud")
      // is the same requested person as the fuller grounded name
      // ("Cloud Strife"), not an eighth cast member.
      return (
        (keyTokens.length === 1 && existingTokens.includes(key)) ||
        (existingTokens.length === 1 && keyTokens.includes(existing))
      );
    });
    if (!key || duplicatesExisting) continue;
    seen.add(key);
    result.push(cleaned);
  }
  return result;
}

/**
 * The model's structured roster is accepted only when each display name is
 * grounded in the conversation text. The model may normalize capitalization,
 * but it may not invent an extra cast member.
 */
function groundedCharacterNames(value: unknown, scanText: string): string[] {
  const normalizedTranscript = normalizeForCompare(scanText);
  return uniqueNames(asStringArray(value)).filter((name) => {
    if (!isLikelyCharacterName(name)) return false;
    const normalizedName = normalizeForCompare(name);
    if (normalizedTranscript.includes(normalizedName)) return true;
    // Accept the common catalog form "Last, First" when the customer used
    // natural spoken order ("First Last").
    const comma = name.match(/^\s*([^,]+),\s*(.+)\s*$/);
    if (!comma) return false;
    return normalizedTranscript.includes(
      normalizeForCompare(`${comma[2]} ${comma[1]}`)
    );
  });
}

function joinCastNames(names: readonly string[]): string | undefined {
  if (names.length === 0) return undefined;
  if (names.length === 1) return names[0];
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(', ')}, and ${names[names.length - 1]}`;
}

/** Ensure the lossless roster leads the visual subject even if extraction was partial. */
function subjectWithRequestedCast(
  extractedSubject: string | undefined,
  requestedCharacters: readonly string[]
): string | undefined {
  const extracted = (extractedSubject ?? '').trim();
  const missing = requestedCharacters.filter(
    (name) => !normalizeForCompare(extracted).includes(normalizeForCompare(name))
  );
  if (missing.length === 0) return extracted || undefined;
  const roster = joinCastNames(requestedCharacters);
  return extracted ? `${roster}; ${extracted}` : roster;
}

/**
 * Database anchors enrich the model's cumulative subject; they never replace
 * it. The model knows names beyond our finite catalog, while the catalog adds
 * the costume specificity image models need for the characters it recognizes.
 */
function mergeExtractedSubject(
  extractedSubject: string | undefined,
  anchoredSubject: string | undefined
): string | undefined {
  const extracted = (extractedSubject ?? '').trim();
  const anchored = (anchoredSubject ?? '').trim();
  if (!extracted) return anchored || undefined;
  if (!anchored) return extracted;
  if (extracted.toLowerCase().includes(anchored.toLowerCase())) return extracted;
  return `${extracted}; visual anchors for recognized cast: ${anchored}`;
}

/* ──────────────────────────────────────────────────────────────────────────
 * Repeat guard: the model occasionally re-emits its own previous question,
 * which reads as the bot not listening. Observed in a real session log, the
 * repeat was NOT byte-identical — the second copy simply dropped a leading
 * "Got it. " — so containment, not equality, is the test that catches it.
 * ────────────────────────────────────────────────────────────────────────── */

/** Long enough that containment means repetition, not a shared stock phrase. */
const REPEAT_MIN_WORDS = 8;

function normalizeForCompare(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function wordCount(text: string): number {
  return text.split(' ').filter(Boolean).length;
}

/**
 * True when one message wholly contains the other and the shared part is
 * substantial. Short replies are exempt so stock phrases ("Got it.") never
 * trip the guard.
 */
function isRepeatOf(reply: string, previousBotMessage: string): boolean {
  const candidate = normalizeForCompare(reply);
  const previous = normalizeForCompare(previousBotMessage);
  if (!candidate || !previous) return false;

  const [shorter, longer] =
    candidate.length <= previous.length ? [candidate, previous] : [previous, candidate];
  if (wordCount(shorter) < REPEAT_MIN_WORDS) return false;
  return longer.includes(shorter);
}

function lastBotMessage(messages: ConversationMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i].role === 'bot') return messages[i].text;
  }
  return '';
}

function botTexts(messages: ConversationMessage[]): string[] {
  return messages.filter((m) => m.role === 'bot').map((m) => m.text);
}

/* ──────────────────────────────────────────────────────────────────────────
 * Question-level repeat guard. The whole-message guard above misses the
 * live-transcript failure mode: the SAME question re-asked verbatim inside a
 * different acknowledgment ("Killua and Hiei are both iconic. <question>" →
 * "That's the full lineup. <same question>"), and re-asked two turns later
 * so the last-message comparison never sees it. Questions are tracked as
 * sentences across EVERY prior bot message; a question the bot already asked
 * never leaves its mouth a second time.
 * ────────────────────────────────────────────────────────────────────────── */

/** Below this, question sentences are stock phrases, not trackable asks. */
const QUESTION_MIN_WORDS = 5;

function sentencesOf(text: string): string[] {
  return (text.match(/[^.?!]+[.?!]+|[^.?!]+$/g) ?? []).map((s) => s.trim()).filter(Boolean);
}

function isTrackableQuestion(sentence: string): boolean {
  return sentence.endsWith('?') && wordCount(normalizeForCompare(sentence)) >= QUESTION_MIN_WORDS;
}

function askedQuestionKeys(priorBotTexts: string[]): Set<string> {
  const keys = new Set<string>();
  for (const text of priorBotTexts) {
    for (const sentence of sentencesOf(text)) {
      if (isTrackableQuestion(sentence)) keys.add(normalizeForCompare(sentence));
    }
  }
  return keys;
}

/**
 * Strip every question sentence the bot has already asked in this session.
 * Returns the surviving text and how many questions were dropped, so the
 * caller can log and substitute when nothing survives.
 */
function dropRepeatedQuestions(
  candidate: string,
  priorBotTexts: string[]
): { text: string; dropped: number } {
  const asked = askedQuestionKeys(priorBotTexts);
  if (asked.size === 0) return { text: candidate, dropped: 0 };

  let dropped = 0;
  const kept = sentencesOf(candidate).filter((sentence) => {
    if (isTrackableQuestion(sentence) && asked.has(normalizeForCompare(sentence))) {
      dropped += 1;
      return false;
    }
    return true;
  });
  return { text: kept.join(' ').trim(), dropped };
}

/* ──────────────────────────────────────────────────────────────────────────
 * The color slot (ADR-0023's fixed palette question). The persona mandates
 * exact wording, which is precisely why the engine must own the ask count:
 * a live session heard the identical question three times because nothing
 * deterministic tracked it. One ask, one reworded retry, then the bot makes
 * the call and advances.
 * ────────────────────────────────────────────────────────────────────────── */

const COLOR_ASK_KEYS = [
  COLOR_QUESTION,
  COLOR_RETRY_QUESTION,
  // Sessions that predate the loud-register rewrite still carry the old
  // wording; without them the ask count resets and the palette question can
  // be asked a third time.
  ...LEGACY_COLOR_ASKS,
].map(normalizeForCompare);

function countColorAsks(messages: ConversationMessage[]): number {
  return botTexts(messages).filter((text) => {
    const normalized = normalizeForCompare(text);
    return COLOR_ASK_KEYS.some((key) => normalized.includes(key));
  }).length;
}

function asksColorQuestion(candidate: string): boolean {
  const normalized = normalizeForCompare(candidate);
  return COLOR_ASK_KEYS.some((key) => normalized.includes(key));
}

/** Replace a re-asked color question with the single permitted reworded retry. */
function withColorRetry(candidate: string): string {
  const kept = sentencesOf(candidate).filter(
    (sentence) => !asksColorQuestion(sentence)
  );
  return [...kept, COLOR_RETRY_QUESTION].join(' ').trim();
}

/** Palette tags that resolve the color axis on their own (ADR-0023). */
const PALETTE_TAGS = new Set(['color', 'blackwork', 'black-and-grey']);

function isColorSlotOpen(record: Partial<IntakeRecord>): boolean {
  const axes = record.ambiguousAxes ?? [...VARIATION_AXIS_POOL];
  if (!axes.includes('color-blackwork')) return false;
  return !(record.styleTags ?? []).some((tag) => PALETTE_TAGS.has(tag));
}

/** The bot's palette call: resolve the axis to color on the record. */
function resolveColorToColor(record: Partial<IntakeRecord>, ontology: StyleTagIndex): void {
  const colorTag = resolveStyleTags(ontology, ['color']);
  record.styleTags = [...new Set([...(record.styleTags ?? []), ...colorTag])];
  record.ambiguousAxes = (record.ambiguousAxes ?? []).filter(
    (axis) => axis !== 'color-blackwork'
  );
}

/**
 * The user asked to SEE both poles of an axis (ADR-0012): reopen it
 * deliberately — first in line so downstream axis selection targets it —
 * and, for the palette axis, clear the tags that would re-resolve it.
 */
function applyAxisSpread(record: Partial<IntakeRecord>, axis: VariationAxis): void {
  if (axis === 'color-blackwork') {
    record.styleTags = (record.styleTags ?? []).filter((tag) => !PALETTE_TAGS.has(tag));
  }
  const rest = (record.ambiguousAxes ?? []).filter((candidate) => candidate !== axis);
  record.ambiguousAxes = [axis, ...rest];
  // The explicit ask travels to axis selection by name (ADR-0049): round
  // one leads with THIS axis instead of the ladder's first rung, so the
  // split the bot just promised is the split the customer is charged for.
  record.requestedAxis = axis;
}

/* ──────────────────────────────────────────────────────────────────────────
 * Subject scan (IP rule, ADR-0023). The user's own words plus any bot pitch
 * the user accepted with a bare affirmation — "i like it!" adopts the
 * preceding bot message as brief material, otherwise a bot-proposed concept
 * the user said yes to never reaches the record.
 * ────────────────────────────────────────────────────────────────────────── */

function subjectScanText(messages: ConversationMessage[]): string {
  const parts: string[] = [];
  let lastBot = '';
  for (const message of messages) {
    if (message.role === 'bot') {
      lastBot = message.text;
      continue;
    }
    if (isAffirmation(message.text) && lastBot) parts.push(lastBot);
    parts.push(message.text);
  }
  return parts.join(' ');
}

/* ──────────────────────────────────────────────────────────────────────────
 * The evocation slot (TAT-51). When the meaning points at a person, creator,
 * or franchise ("my love for toriyama") and nothing drawable is on the
 * record, ONE follow-up mines the meaning for imagery. Stateless like the
 * color slot: asked-ness is read off the transcript via the question's
 * stable stem, so it can never be asked twice.
 * ────────────────────────────────────────────────────────────────────────── */

const EVOCATION_KEY = normalizeForCompare(EVOCATION_STEM);

function evocationAskedIn(messages: ConversationMessage[]): boolean {
  return botTexts(messages).some((text) =>
    normalizeForCompare(text).includes(EVOCATION_KEY)
  );
}

/** Bounded so a rambling answer cannot flood the subject/prompt path. */
const EVOCATION_ANSWER_MAX = 140;

/** Leading hedge — stripped so trailing imagery can still be mined. */
const EVOCATION_DODGE_PATTERN =
  /^\s*(idk|i ?d(on'?)?t know|not sure|no idea|dunno|nothing( really)?|hmm+|no clue|good question)\b/i;

/** Filler left after a hedge ("idk man") — still a pure dodge, not a scene. */
const EVOCATION_DODGE_FILLER =
  /^(man|lol|lmao|though|tbh|haha|yeah|nah|bro|dude)?[\s,.!]*$/i;

/**
 * Drawable body of an evocation answer. A leading hedge alone is a dodge;
 * hedge + trailing imagery ("not sure, the ocean at night") keeps the image.
 */
function evocationAnswerBody(answer: string): string | undefined {
  const trimmed = answer.trim();
  if (!trimmed || trimmed.endsWith('?') || isAffirmation(trimmed)) return undefined;
  let body = trimmed;
  if (EVOCATION_DODGE_PATTERN.test(body)) {
    body = body.replace(EVOCATION_DODGE_PATTERN, '').replace(/^[\s,.\-:;!]+/, '').trim();
  }
  if (!body || EVOCATION_DODGE_FILLER.test(body) || body.endsWith('?') || isAffirmation(body)) {
    return undefined;
  }
  return body.slice(0, EVOCATION_ANSWER_MAX);
}

/**
 * The user's answer to the evocation question, when one was given. That
 * answer is the drawable anchor the question exists to mine ("gohan and
 * cell's beam struggle") — it merges into the subject rather than
 * overwriting it (TAT-47 merge rules). Dodges (a question back, a bare
 * affirmation) are skipped so a later mined image still lands; the
 * question is still never re-asked.
 */
function evocationAnswerIn(messages: ConversationMessage[]): string | undefined {
  for (let i = 0; i < messages.length; i += 1) {
    const message = messages[i];
    if (message.role !== 'bot') continue;
    if (!normalizeForCompare(message.text).includes(EVOCATION_KEY)) continue;
    // Walk every user turn after the question — an immediate dodge must
    // not block a drawable answer given on a later turn.
    for (let j = i + 1; j < messages.length; j += 1) {
      const candidate = messages[j];
      if (candidate.role !== 'user') continue;
      const body = evocationAnswerBody(candidate.text);
      if (body) return body;
    }
    return undefined;
  }
  return undefined;
}

/**
 * Meaning questions, for the aesthetic-vibe guard (TAT-51): once the user
 * has said the piece just looks good, the meaning slot is closed and no
 * meaning question ever reaches them again.
 */
const MEANING_QUESTION_PATTERN =
  /\b(mean(s|ing)? (to|for) you|meaning behind|what (does|do|would|should) (it|this|that|the piece) mean|story behind|significance|deeper meaning|why (do you want|this piece))\b/i;

function stripMeaningQuestions(candidate: string): string {
  return sentencesOf(candidate)
    .filter((sentence) => !(sentence.endsWith('?') && MEANING_QUESTION_PATTERN.test(sentence)))
    .join(' ')
    .trim();
}

/**
 * The one in-voice IP line (ADR-0023): said once per session, on the first
 * proposal that carries a named subject.
 */
function withIpNote(
  reply: string,
  record: Partial<IntakeRecord>,
  messages: ConversationMessage[]
): string {
  if (!(record.subject ?? '').trim()) return reply;
  const notes = [IP_NOTE, ...LEGACY_IP_NOTES];
  const alreadySaid = messages.some(
    (message) => message.role === 'bot' && notes.some((note) => message.text.includes(note))
  );
  if (alreadySaid || notes.some((note) => reply.includes(note))) return reply;
  return `${reply} ${IP_NOTE}`;
}

/**
 * Has the playback already been said? The proposal beat announces once; on
 * every later turn the user's message deserves a real answer rather than the
 * same templated sentence. Deterministic — read off the transcript, not a
 * model judgment, so the ADR-0021 cadence caps stay in code.
 */
function hasAlreadyProposed(messages: ConversationMessage[]): boolean {
  // includes(), not startsWith(): a proposal can carry a lead-in sentence
  // (the palette recommendation, the axis-spread framing) ahead of the
  // playback and it still counts as the announce beat having fired.
  const leads = [PROPOSAL_LEAD, ...LEGACY_PROPOSAL_LEADS];
  return messages.some(
    (message) => message.role === 'bot' && leads.some((lead) => message.text.includes(lead))
  );
}

/**
 * What the bot says on a proposal-stage turn.
 *
 * The first time, it announces the playback (ADR-0020). After that the beat
 * used to re-substitute the SAME templated sentence on every turn, discarding
 * whatever the model actually said — so a real question at the proposal beat
 * ("do you know which characters im referring to?") got the playback echoed
 * back verbatim, forever. Once the playback has been said, the model's reply
 * is surfaced instead, with the affordance repeated so the reveal stays one
 * tap away. The stage and the cadence caps are unchanged — this only decides
 * wording.
 */
function proposalBeatReply(
  playback: string,
  payload: RawTurnPayload,
  messages: ConversationMessage[]
): string {
  const modelReply = asTrimmedString(payload.reply);
  if (!hasAlreadyProposed(messages) || !modelReply) return proposalReply(playback);
  // A model that just parroted the playback adds nothing — fall back to the
  // canonical phrasing rather than echoing a near-duplicate.
  if (isRepeatOf(modelReply, lastBotMessage(messages))) return proposalReply(playback);
  // A follow-up must not smuggle back a question the bot already asked —
  // the live transcript re-asked its "what specific moments" question
  // verbatim from the proposal beat, two turns after the first ask.
  const { text } = dropRepeatedQuestions(modelReply, botTexts(messages));
  if (!text) return PROPOSAL_REMINDER;
  return proposalFollowUp(text);
}

/* ──────────────────────────────────────────────────────────────────────────
 * The turn
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * Settle a stalled field from the reply to its direct ask (#376). Mutates
 * `record`. Placement: a short answer replaces anything the model left
 * vague; a hand-back on the committed-default re-ask takes the default.
 * Meaning: the short answer fills an empty meaning. Style: the answer is
 * resolved against the ontology and only lands when it matches a tag.
 */
function settleStalledAnswer(
  record: Partial<IntakeRecord>,
  messages: ConversationMessage[],
  ontology: StyleTagIndex
): void {
  const previousBot = lastBotMessage(messages);
  const userText =
    [...messages].reverse().find((message) => message.role === 'user')?.text ?? '';
  const answer = shortAnswerOf(userText);

  if (isStalledAskFor('placement', previousBot)) {
    const extracted = (record.placement ?? '').trim();
    if (isHandBack(userText) || (isAffirmation(userText) && !extracted)) {
      record.placement = DEFAULT_PLACEMENT;
    } else if (answer && !isSpecificPlacement(extracted)) {
      record.placement = answer.toLowerCase();
    }
    return;
  }
  if (isStalledAskFor('meaning', previousBot)) {
    if (answer && !(record.meaning ?? '').trim() && !isHandBack(userText)) {
      record.meaning = answer;
    }
    return;
  }
  if (isStalledAskFor('styleTags', previousBot)) {
    if (answer && (record.styleTags ?? []).length === 0) {
      const tags = resolveStyleTags(ontology, [answer]);
      if (tags.length) record.styleTags = tags;
    }
  }
}

function logTurn(turnLog: TurnLog, stage: ConversationStage): void {
  logger.info({
    event_type: 'design_conversation.turn',
    stage,
    ...turnLog,
  });
}

export async function runConversationTurn(
  request: RunTurnRequest
): Promise<ConversationTurnResult> {
  if (isDemoMode()) {
    const result = runDemoTurn(request.userTurn);
    logTurn(result.turnLog, result.stage);
    return result;
  }

  const ontology = await loadStyleTagIndex();
  const systemPrompt = buildSystemPrompt([...ontology.canonicalIds]);

  // One call, double duty: reply + extraction. Total provider failure
  // propagates as ConversationUnavailableError — the caller downgrades to
  // the v1 scripted flow (ADR-0019).
  const { payload, model } = await converseWithProviders({
    systemPrompt,
    messages: request.messages,
    pinnedModel: request.pinnedModel,
    sessionId: request.sessionId,
    userTurn: request.userTurn,
  });

  const record = sanitizeRecord(payload, ontology);

  // Deterministic character detection over the user's own words PLUS any
  // bot pitch the user accepted ("i like it!" adopts the preceding bot
  // message as brief material). Two projections of the same matches: the
  // full costume anchors onto `record.subject` for the prompt path
  // (identical to what confirm would back-fill), and the short label for
  // the spoken sentence. The model's own extraction (raw.subject) is kept
  // as the fallback when the database recognizes nothing. This runs BEFORE
  // scoring — the readiness gate accepts a named subject in place of a
  // meaning, so the subject has to be on the record first.
  const scanText = subjectScanText(request.messages);
  const characters = charactersIn(scanText);
  const moment = momentFrom(scanText);
  // The evocation slot (TAT-51): read asked-ness and any answer off the
  // transcript. The answer is a scene anchor — it merges into the subject
  // (never overwrites, TAT-47 rules) and may stand alone as the drawable
  // when nothing else matched ("the ocean at night" is a complete subject).
  const evocationAsked = evocationAskedIn(request.messages);
  const scene = evocationAnswerIn(request.messages);
  const extractedSubject = asTrimmedString(record.subject);
  const providerIdentities = groundedCharacterIdentities(
    payload.record?.characterIdentities,
    scanText
  );
  const fallbackCast = compactCastParts(extractedSubject);
  const fallbackKeys = new Set(fallbackCast.map(normalizeForCompare));
  const structuredCharacters = groundedCharacterNames(payload.record?.characters, scanText);
  // A verified identity pair is the strongest roster signal. When it exists,
  // keep it. When the provider also supplied a strong natural-language cast
  // list, structured names must belong to that bounded list; this prevents
  // title-cased scene notes after the final "and Name" from inflating cast.
  const providerCharacters = uniqueNames([
    ...providerIdentities.map((identity) => identity.name),
    ...structuredCharacters.filter(
      (name) => fallbackKeys.size < 3 || fallbackKeys.has(normalizeForCompare(name))
    ),
  ]);
  const explicitCast = uniqueNames([
    ...providerCharacters,
    ...fallbackCast,
  ]);
  const detectedCast = characters.map(
    (match) =>
      `${match.name.replace(/\b[a-z]/g, (letter) => letter.toUpperCase())} (${match.series})`
  );
  // A transcript-grounded provider/list roster preserves the customer's own
  // display names and ordering. The curated detector remains the fallback
  // when no explicit roster was extracted, keeping its useful series labels.
  const requestedCharacters =
    explicitCast.length > 0 ? explicitCast : uniqueNames(detectedCast);
  if (requestedCharacters.length > 0) {
    record.requestedCharacters = requestedCharacters;
  }
  const characterIdentities = mergeCharacterIdentities(
    providerIdentities,
    characterIdentitiesFor(characters),
    scanText
  );
  if (characterIdentities.length > 0) {
    record.characterIdentities = characterIdentities;
  }
  const subjectBase = mergeExtractedSubject(
    subjectWithRequestedCast(extractedSubject, requestedCharacters),
    subjectPhraseFor(characters)
  );
  let subjectValue = subjectBase;
  if (subjectValue && moment && !subjectValue.toLowerCase().includes(moment.toLowerCase())) {
    subjectValue = `${subjectValue}, ${moment}`;
  }
  if (scene) {
    if (!subjectValue) subjectValue = scene;
    else if (!subjectValue.toLowerCase().includes(scene.toLowerCase())) {
      subjectValue = `${subjectValue}, ${scene}`;
    }
  }
  if (subjectValue) record.subject = subjectValue;
  // What the playback/notes speak as the scene: the evocation answer is the
  // user's own image and outranks the harvested action phrasing.
  const sceneAnchor = scene ?? moment;
  // IP rule, enforced at extraction (ADR-0023, deliberately in addition to
  // the confirm-time enforcement): a named subject locks literal-abstract —
  // a recognizable depiction is the point, so the axis is never offered.
  if ((record.subject ?? '').trim()) {
    record.ambiguousAxes = (record.ambiguousAxes ?? []).filter(
      (axis) => axis !== 'literal-abstract'
    );
  }
  const characterLabel =
    joinCastNames(requestedCharacters) ??
    compactCastLabel(extractedSubject) ??
    characterLabelFor(characters);

  // Meaning is optional (TAT-51): a pure-looks answer anywhere in the
  // session records vibe=aesthetic and closes the meaning slot — the user's
  // own phrasing becomes the meaning (ADR-0010: their words, verbatim), so
  // the slot reads as answered everywhere downstream.
  const aestheticAnswer = request.messages
    .filter((message) => message.role === 'user')
    .map((message) => message.text)
    .find((text) => isAestheticAnswer(text));
  if (aestheticAnswer) {
    record.vibe = 'aesthetic';
    // Always force their verbatim phrase — a model paraphrase on the same
    // turn must not replace the closed meaning slot (ADR-0010).
    record.meaning = aestheticAnswer.trim();
  }

  // Deterministic intent detection on the message being answered — the
  // three shapes a live session showed the model mishandling outright.
  const lastUserMessage =
    [...request.messages].reverse().find((message) => message.role === 'user')?.text ?? '';
  const axisRequest = detectAxisRequest(lastUserMessage);
  if (axisRequest) applyAxisSpread(record, axisRequest.axis);
  // The visible fast lane (TAT-48): "skip the questions — just draw". An
  // axis request wins when both fire — it carries more information (which
  // axis to spread), and both end at the same proposal beat.
  const drawRequest = !axisRequest && isDrawRequest(lastUserMessage);

  const colorAsks = countColorAsks(request.messages);
  let colorCall: 'recommendation' | 'decision' | undefined;
  if (
    !axisRequest &&
    isColorSlotOpen(record) &&
    colorAsks >= 1 &&
    isSuggestionRequest(lastUserMessage)
  ) {
    // "which do you suggest" on the open palette slot: the consultant
    // recommends (ADR-0023) — a direct ask gets a direct answer, never
    // "I'm not here to suggest styles".
    colorCall = 'recommendation';
    resolveColorToColor(record, ontology);
  }

  // Settle a stalled field from a short answer (#376). The previous bot
  // message was the deterministic direct ask for `field`; a short,
  // declarative reply is the answer in the customer's own words (ADR-0010),
  // whether or not the model's extraction caught it. A hand-back on the
  // placement re-ask takes the committed default.
  settleStalledAnswer(record, request.messages, ontology);

  // Guess-first carry-forward (spec 17): a placement the bot assumed and
  // said out loud stays on the record until the customer names one, so the
  // next proposal still states it. The model re-extracts the record from
  // the transcript every turn and may drop an assumption it never heard
  // the customer say.
  const previousLog = request.previousTurnLogs?.[request.previousTurnLogs.length - 1];
  let assumedPlacement: string | undefined;
  // The model can also read the assumption back out of the bot's own
  // reply; a placement equal to the assumption is still the assumption,
  // not one the customer named.
  const extractedPlacement = (record.placement ?? '').trim().toLowerCase();
  if (
    previousLog?.assumedPlacement &&
    (!extractedPlacement || extractedPlacement === previousLog.assumedPlacement.toLowerCase())
  ) {
    record.placement = previousLog.assumedPlacement;
    assumedPlacement = previousLog.assumedPlacement;
  }
  if (previousLog?.firedRule === 'guess-first-proposal') {
    logger.info({
      event_type: GUESS_FIRST_EDITED_EVENT,
      turn: request.userTurn,
      placement_named: assumedPlacement === undefined,
    });
  }

  let { confidence, missingFields, hasRequiredFields } = scoreRecord(record);
  const hasPlacement = Boolean((record.placement ?? '').trim());
  const hasNamedCharacters = Boolean((record.subject ?? '').trim());

  // The proposal gate's state going into this turn (#376): which field
  // blocks, and for how many turns running. Decided before the cadence so
  // the stall branch below can fire; recomputed after it for the TurnLog.
  const blockingBefore = blockingFieldFor(
    { confidence, missingFields, hasRequiredFields },
    CONFIDENCE_THRESHOLD,
    record
  );
  const blockedTurns =
    blockingBefore === undefined
      ? 0
      : consecutiveBlockedTurns(blockingBefore, request.previousTurnLogs ?? []);
  const stalledField =
    blockingBefore !== undefined && blockedTurns >= STALLED_FIELD_TURNS
      ? blockingBefore
      : undefined;

  // Cadence — deterministic code, not model judgment (ADR-0021).
  let stage: ConversationStage;
  let firedRule: TurnLog['firedRule'];
  let reply: string;
  let playback: string | undefined;

  if (request.userTurn >= HANDOFF_TURN) {
    stage = 'handoff';
    firedRule = 'turn20-handoff';
    reply = HANDOFF_MESSAGE;
  } else if (request.userTurn >= FORCE_PROPOSAL_TURN) {
    if (hasPlacement) {
      stage = 'proposal';
      firedRule = 'turn12-force-proposal';
      playback = buildPlayback(record, characterLabel, sceneAnchor);
      reply = withIpNote(
        proposalBeatReply(playback, payload, request.messages),
        record,
        request.messages
      );
    } else {
      // The placement gate (ADR-0021 amendment, owner decision 2026-07-27):
      // the forced proposal may guess past every open question EXCEPT
      // placement — it anchors the downstream composite step, and the render
      // path refuses to invent one. Ask directly; the proposal fires on the
      // next turn once the answer lands. Deterministic wording, so re-asking
      // on later gated turns is the refusal semantics, not a model loop.
      stage = 'chatting';
      firedRule = 'turn12-ask-placement';
      reply = PLACEMENT_GATE_QUESTION;
    }
  } else if (axisRequest && hasPlacement && hasRequiredFields) {
    // "Can I see both X and Y" IS the proposal trigger (ADR-0012/0020): the
    // brief plays back in one line and the reveal spreads that axis. The
    // bot NEVER denies generation capability.
    stage = 'proposal';
    firedRule = 'axis-request-proposal';
    playback = buildPlayback(record, characterLabel, sceneAnchor);
    reply = withIpNote(
      axisSpreadProposalReply(playback, axisRequest.labels),
      record,
      request.messages
    );
  } else if (axisRequest) {
    // Spread requested but the brief cannot render yet — placement is a hard
    // constraint and there must be something to draw. Say yes, then close
    // the one real gap.
    stage = 'chatting';
    firedRule = 'none';
    reply = axisSpreadDeferredReply(
      axisRequest.labels,
      hasPlacement ? SUBJECT_GATE_QUESTION : PLACEMENT_GATE_QUESTION
    );
  } else if (drawRequest && hasRequiredFields) {
    // Skip-the-questions honored (TAT-48): the record can already generate
    // — placement plus something to draw, the same gate confirm enforces —
    // so the request IS the proposal trigger. The playback still runs, so
    // ADR-0020's announce + consent beat is never skipped.
    stage = 'proposal';
    firedRule = 'draw-request-proposal';
    playback = buildPlayback(record, characterLabel, sceneAnchor);
    reply = withIpNote(
      proposalBeatReply(playback, payload, request.messages),
      record,
      request.messages
    );
  } else if (drawRequest) {
    // They asked to skip ahead but there is not yet anything to draw — say
    // yes, then close the one real gap (mirrors the axis-request path;
    // never a refusal, never a limit).
    stage = 'chatting';
    firedRule = 'none';
    reply = drawRequestDeferredReply(
      hasPlacement ? SUBJECT_GATE_QUESTION : PLACEMENT_GATE_QUESTION
    );
  } else if (colorCall) {
    reply = colorCallReply(colorCall, hasNamedCharacters);
    if (hasRequiredFields) {
      stage = 'proposal';
      firedRule = 'style-recommendation';
      playback = buildPlayback(record, characterLabel, sceneAnchor);
      reply = withIpNote(`${reply} ${proposalReply(playback)}`, record, request.messages);
    } else {
      stage = 'chatting';
      firedRule = 'none';
      reply = `${reply} ${hasPlacement ? SUBJECT_GATE_QUESTION : PLACEMENT_GATE_QUESTION}`;
    }
  } else if (confidence >= CONFIDENCE_THRESHOLD && hasRequiredFields) {
    stage = 'proposal';
    firedRule = 'judgment';
    playback = buildPlayback(record, characterLabel, sceneAnchor);
    reply = withIpNote(
      proposalBeatReply(playback, payload, request.messages),
      record,
      request.messages
    );
  } else if (
    // Guess-first (spec 17, Veri V1): the first message has something to
    // draw but the cadence would ask a question first. State the
    // assumptions and propose now. Placement is the only field defaulted,
    // and it is said out loud and confirmed by the consent tap (ADR-0020),
    // never silent. Style is never invented: an open style is the split the
    // two cuts show.
    isGuessFirstEnabled() &&
    request.userTurn === 1 &&
    Boolean((record.subject ?? '').trim() || (record.meaning ?? '').trim())
  ) {
    const assumptions: string[] = [];
    if (!hasPlacement) {
      record.placement = DEFAULT_PLACEMENT;
      assumedPlacement = DEFAULT_PLACEMENT;
      assumptions.push(`it goes on your ${DEFAULT_PLACEMENT}`);
    }
    if ((record.styleTags ?? []).length === 0) {
      assumptions.push('the two cuts split the style so you can pick');
    }
    ({ confidence, missingFields, hasRequiredFields } = scoreRecord(record));
    stage = 'proposal';
    firedRule = 'guess-first-proposal';
    playback = buildPlayback(record, characterLabel, sceneAnchor);
    reply = withIpNote(guessFirstReply(assumptions, playback), record, request.messages);
  } else if (stalledField !== undefined) {
    // The stall rule (#376): the same field has blocked the proposal for
    // STALLED_FIELD_TURNS turns in a row — the model is chatting past it.
    // Ask for it outright, in voice; the next short answer settles it.
    stage = 'chatting';
    firedRule = 'stalled-field-ask';
    reply = stalledFieldAsk(stalledField, blockedTurns, record);
  } else if (
    // The evocation follow-up (TAT-51): the meaning points at a person,
    // creator, or franchise, nothing drawable is on the record, and the
    // question has never been asked. Fires at most once per session — a
    // dodge is a dodge, never a re-ask — and only below the proposal
    // threshold: a record that can already propose doesn't need mining.
    !evocationAsked &&
    record.vibe !== 'aesthetic' &&
    !(record.subject ?? '').trim() &&
    // moment alone never lands on the record (only appended when a subject
    // base already exists — unlike scene), so it must not skip the mine.
    evocationRefOf(record.meaning ?? '')
  ) {
    stage = 'chatting';
    firedRule = 'evocation-question';
    reply = evocationQuestion(evocationRefOf(record.meaning ?? '')!);
  } else {
    stage = 'chatting';
    firedRule = 'none';
    let candidate =
      asTrimmedString(payload.reply) || KEEP_GOING_QUESTION;

    // The meaning slot is closed (TAT-51): a pure-looks answer was given,
    // so any meaning question the model still tries gets stripped — the
    // release valve is only honest if the question truly never returns.
    if (record.vibe === 'aesthetic') {
      const stripped = stripMeaningQuestions(candidate);
      if (stripped !== candidate.trim()) {
        logger.warn({
          event_type: 'design_conversation.meaning_reask_suppressed',
          turn: request.userTurn,
          model,
        });
        candidate =
          stripped ||
          `${AESTHETIC_ACK}${(record.subject ?? '').trim() ? '' : ` ${SUBJECT_GATE_QUESTION}`}`;
      }
    }

    // The color slot is chased at most twice (ask + one reworded retry) —
    // on a third attempt the bot makes the call itself and advances, in
    // voice, never surfacing a limit.
    if (isColorSlotOpen(record) && asksColorQuestion(candidate) && colorAsks >= 1) {
      if (colorAsks >= 2) {
        resolveColorToColor(record, ontology);
        ({ confidence, missingFields, hasRequiredFields } = scoreRecord(record));
        const decision = colorCallReply('decision', hasNamedCharacters);
        if (hasRequiredFields) {
          stage = 'proposal';
          firedRule = 'style-recommendation';
          playback = buildPlayback(record, characterLabel, sceneAnchor);
          candidate = withIpNote(
            `${decision} ${proposalReply(playback)}`,
            record,
            request.messages
          );
        } else {
          candidate = `${decision} ${hasPlacement ? SUBJECT_GATE_QUESTION : PLACEMENT_GATE_QUESTION}`;
        }
      } else {
        candidate = withColorRetry(candidate);
      }
    }

    if (stage === 'chatting') {
      // Never re-ask ANY question verbatim — checked against every prior
      // bot message, not just the last one.
      const deduped = dropRepeatedQuestions(candidate, botTexts(request.messages));
      if (deduped.dropped > 0) {
        logger.warn({
          event_type: 'design_conversation.repeated_reply',
          turn: request.userTurn,
          model,
          repeated: candidate,
        });
        candidate = deduped.text || REPEAT_FALLBACK;
      }
      const previousBotMessage = lastBotMessage(request.messages);
      if (isRepeatOf(candidate, previousBotMessage)) {
        logger.warn({
          event_type: 'design_conversation.repeated_reply',
          turn: request.userTurn,
          model,
          repeated: candidate,
        });
        candidate = REPEAT_FALLBACK;
      }
    }
    reply = candidate;
  }

  // What still blocks, on the record as the branches left it — a colour
  // call above may have resolved the style slot. Only a chatting turn is
  // gated; a proposal or handoff has nothing blocking by definition.
  const blockingField =
    stage === 'chatting'
      ? blockingFieldFor(
          scoreRecord(record),
          CONFIDENCE_THRESHOLD,
          record
        )
      : undefined;
  const gate =
    blockingField === undefined
      ? undefined
      : gateStateFor(
          blockingField,
          consecutiveBlockedTurns(blockingField, request.previousTurnLogs ?? [])
        );

  const turnLog: TurnLog = {
    turn: request.userTurn,
    confidence,
    missingFields,
    firedRule,
    model,
    ...(blockingField !== undefined ? { blockingField } : {}),
    ...(assumedPlacement !== undefined ? { assumedPlacement } : {}),
  };
  logTurn(turnLog, stage);

  return {
    reply,
    stage,
    ...(playback !== undefined ? { playback } : {}),
    record,
    turnLog,
    ...(gate !== undefined ? { gate } : {}),
    // The notepad projection (TAT-48) — built AFTER every branch above, so
    // it reflects the record the branches may have resolved (palette calls,
    // axis spreads). The only record view that ever reaches the browser.
    notes: buildSessionNotes(
      record,
      characters,
      sceneAnchor,
      requestedCharacters
    ),
  };
}
