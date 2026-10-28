/**
 * TypeSafe intake for the fields that are closed sets.
 *
 * One POST per extraction (https://api.typesafe.ai/v1/systemone) asks:
 *   - one Choice for placement, from the canonical body-part list
 *   - one present/absent/unknown Choice per style tag, so compatible
 *     tags (fine-line and dotwork, blackwork and watercolor) can all survive
 *   - one Noul per variation axis: "is this axis still ambiguous?"
 *   - the shared readiness Noul and next-question Choice, so a later
 *     design turn can reuse this packet instead of calling again
 *
 * Choice options go in `criteria`. `options` is rejected with 422.
 * Docs: https://docs.typesafe.ai/primitives/choice
 *       https://docs.typesafe.ai/primitives/noul
 *       https://docs.typesafe.ai/patterns/confidence-routing
 *
 * Confidence decides ask versus proceed. A committed placement or style
 * tag requires the threshold below. A Noul at or under `noulResolved` closes
 * the axis; anything higher — a confident "yes, ambiguous" or the uncertain
 * band between the two cutoffs — leaves the axis open so the existing
 * conversation ask (missing placement, missing style, stalled-field
 * question, or an open reveal axis) keeps going.
 *
 * Subject and characters are not asked here. Callers keep those from Gemini.
 *
 * The flag defaults off. A missing key, a non-2xx response, a timeout, or
 * an unparseable body returns null and the caller keeps Gemini extraction.
 * The API key is never written to a log.
 */

import { envBool } from '@/config/envSchema';
import {
  intakeStateFingerprint,
  postGovernedSystemOne,
  publishIntakeDecisionPacket,
  TYPESAFE_SYSTEMONE_URL,
  typesafeApiKey,
} from '@/services/typesafe';
import { VARIATION_AXIS_POOL, type VariationAxis } from '../types';
import { loadOntology, resolveTag, type OntologyIndex, type StyleOntologyTag } from './ontology';
import {
  canonicalPlacementOptions,
  PLACEMENT_CANONICAL,
  PLACEMENT_PARTS,
} from './placementCatalog';

export { TYPESAFE_SYSTEMONE_URL };

/**
 * Gates. Placement is the hard generation constraint, so it sits higher
 * than a style tag. Noul uses the TypeSafe starting cutoffs (0.7 yes,
 * 0.3 no). Between them the axis stays open — a Noul has no separate
 * confidence, and the middle of the range is the unsure answer.
 */
export const INTAKE_TYPESAFE_THRESHOLDS = {
  placement: 0.6,
  style: 0.5,
  noulYes: 0.7,
  noulResolved: 0.3,
} as const;

const PLACEMENT_ABSTAIN = 'unspecified';

/**
 * Labels for the closed style ontology. They are not an exclusivity rule:
 * fine-line and dotwork can both be requested, and so can blackwork with
 * watercolor. Each tag is its own present/absent/unknown Choice.
 * `american-traditional` is fixture-only; production ids are the rest.
 * An id missing from this map lands in `other` rather than being dropped.
 */
const STYLE_DIMENSION_OF: Record<string, string> = {
  color: 'palette',
  'black-and-grey': 'palette',
  blackwork: 'palette',
  watercolor: 'palette',
  'fine-line': 'line',
  dotwork: 'line',
  sketch: 'line',
  lettering: 'line',
  minimalist: 'density',
  ornamental: 'density',
  realism: 'depiction',
  portrait: 'depiction',
  abstract: 'depiction',
  surrealism: 'depiction',
  illustrative: 'depiction',
  traditional: 'school',
  'american-traditional': 'school',
  americana: 'school',
  'neo-traditional': 'school',
  japanese: 'school',
  irezumi: 'school',
  'new-school': 'school',
  anime: 'school',
  manga: 'school',
  chicano: 'school',
  tribal: 'school',
  biomechanical: 'school',
  'trash-polka': 'school',
  geometric: 'school',
};

const DIMENSION_ORDER = ['palette', 'line', 'density', 'depiction', 'school', 'other'] as const;

const AXIS_NOUL: Record<VariationAxis, { instructions: string; yes: string; no: string }> = {
  'bold-fine': {
    instructions: 'Is the bold-versus-fine line-weight axis still ambiguous in this brief?',
    yes: 'The brief does not commit to bold heavy lines or to fine delicate linework.',
    no: 'The brief commits to bold heavy lines or to fine delicate linework.',
  },
  'color-blackwork': {
    instructions: 'Is the color-versus-blackwork axis still ambiguous in this brief?',
    yes: 'The brief does not commit to full color or to blackwork, black-and-grey, or monochrome ink.',
    no: 'The brief commits to full color or to blackwork, black-and-grey, or monochrome ink.',
  },
  'literal-abstract': {
    instructions: 'Is the literal-versus-abstract axis still ambiguous in this brief?',
    yes: 'The brief does not commit to a recognizable literal depiction or to an abstract symbolic one.',
    no: 'The brief commits to a recognizable literal depiction or to an abstract symbolic one. A named character or subject is a literal commitment.',
  },
  'minimal-ornate': {
    instructions: 'Is the minimal-versus-ornate axis still ambiguous in this brief?',
    yes: 'The brief does not commit to a minimal simple design or to an ornate intricate one.',
    no: 'The brief commits to a minimal simple design or to an ornate intricate one.',
  },
};

export interface TypedIntakeFields {
  /**
   * Canonical placement, with a left/right qualifier copied from the
   * brief when the brief states one. Null means do not commit — the
   * conversation leaves the field empty so the existing ask fires, and
   * the scripted two-answer extractor keeps the customer's own words.
   */
  placement: string | null;
  /** Canonical tag ids the Choices committed to. Empty means style is unresolved. */
  styleTags: string[];
  /** Axes to leave open. Pool order. A named subject has already dropped literal-abstract. */
  ambiguousAxes: VariationAxis[];
}

export interface RefineIntakeInput {
  /** The brief the questions are about. Not logged. */
  state: string;
  /** Gemini's subject, when it already has one. Locks literal-abstract. */
  subject?: string;
}

interface StyleDimension {
  id: string;
  tags: StyleOntologyTag[];
}

export function styleDimensionFor(tagId: string): string {
  return STYLE_DIMENSION_OF[tagId] ?? 'other';
}

export function styleDimensions(index: OntologyIndex): StyleDimension[] {
  const buckets = new Map<string, StyleOntologyTag[]>();
  for (const tag of index.tags) {
    const id = styleDimensionFor(tag.id);
    const list = buckets.get(id) ?? [];
    list.push(tag);
    buckets.set(id, list);
  }
  return DIMENSION_ORDER.filter((id) => (buckets.get(id)?.length ?? 0) > 0).map((id) => ({
    id,
    tags: buckets.get(id) ?? [],
  }));
}

export function buildIntakeQuestions(index: OntologyIndex): Record<string, unknown> {
  const questions: Record<string, unknown> = {};
  const placementCriteria: Record<string, string> = {
    [PLACEMENT_ABSTAIN]: 'The brief does not commit to a body part.',
  };
  for (const part of canonicalPlacementOptions()) {
    placementCriteria[part] = `The tattoo is placed on the ${part}.`;
  }
  questions.placement = {
    type: 'choice',
    instructions:
      'Which body part is this tattoo placed on? Choose unspecified if the brief does not commit to one.',
    criteria: placementCriteria,
  };

  for (const tag of index.tags) {
    const aliases = tag.aliases?.filter((alias) => alias.trim()) ?? [];
    const aliasNote = aliases.length > 0 ? ` Also called ${aliases.join(', ')}.` : '';
    questions[`style_${tag.id}`] = {
      type: 'choice',
      instructions:
        `Does the brief commit to ${tag.label}?${aliasNote} Compatible styles can all be present. Choose unknown when the brief does not say.`,
      criteria: {
        present: `The brief asks for ${tag.label}.`,
        absent: `The brief does not ask for ${tag.label}.`,
        unknown: `The brief does not say whether ${tag.label} is wanted.`,
      },
    };
  }

  for (const axis of VARIATION_AXIS_POOL) {
    const spec = AXIS_NOUL[axis];
    questions[`axis_${axis}`] = {
      type: 'noul',
      instructions: spec.instructions,
      criteria: { true: spec.yes, false: spec.no },
    };
  }

  questions.enough_to_generate = {
    type: 'noul',
    instructions: 'Does this design session have enough information to generate tattoo designs now?',
    criteria: {
      true: 'Where the tattoo goes and what it should show (a subject or a meaning) are known well enough to draw. Open style, size, or color details can be chosen while drawing.',
      false: 'Where it goes or what it shows is still missing, or the customer is still figuring the idea out.',
    },
  };
  questions.next_question = {
    type: 'choice',
    instructions:
      'If one more question would most improve this brief before generating, which axis should it ask about?',
    criteria: {
      placement: 'Where on the body the tattoo goes is missing or too vague to draw.',
      size: 'How large the tattoo should be is the open question.',
      style: 'The line, school, or overall style is unresolved.',
      subject: 'What the tattoo depicts is missing or too vague.',
      color: 'Full color versus black ink or blackwork is unresolved.',
      'bold-fine': 'Bold heavy lines versus fine delicate linework is the most useful open variation.',
      'literal-abstract': 'A recognizable depiction versus an abstract treatment is the most useful open variation.',
      'minimal-ornate': 'A minimal design versus an ornate one is the most useful open variation.',
      other: 'None of the axes above is the right next question.',
    },
  };
  return questions;
}

const PART_SPAN_ORDER = [...PLACEMENT_PARTS].sort((a, b) => b.length - a.length);

function canonicalPartName(part: string): string {
  return PLACEMENT_CANONICAL[part] ?? part;
}

function partSpans(text: string): Array<{ part: string; index: number; length: number }> {
  const claimed = new Array<boolean>(text.length).fill(false);
  const spans: Array<{ part: string; index: number; length: number }> = [];
  for (const part of PART_SPAN_ORDER) {
    const re = new RegExp(`\\b${part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'g');
    for (const match of text.matchAll(re)) {
      const index = match.index ?? 0;
      const length = match[0].length;
      if (claimed.slice(index, index + length).some(Boolean)) continue;
      for (let i = index; i < index + length; i += 1) claimed[i] = true;
      spans.push({ part: canonicalPartName(part), index, length });
    }
  }
  return spans;
}

function closestPart(spans: Array<{ part: string; index: number }>, sideIndex: number): string | null {
  let best: { part: string; distance: number } | null = null;
  for (const span of spans) {
    const distance = Math.abs(span.index - sideIndex);
    if (distance > 48) continue;
    if (!best || distance < best.distance) best = { part: span.part, distance };
  }
  return best?.part ?? null;
}

/**
 * Side of the selected body part only.
 * A later user correction wins. A side attached to a different part
 * (the subject's left hand, an earlier left arm) does not transfer.
 * Bot lines are ignored. Both sides on the selected part abstain.
 */
export function sideForSelectedPlacement(state: string, part: string): 'left' | 'right' | null {
  const selected = canonicalPartName(part);
  const lines = state
    .toLowerCase()
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !/^(bot|assistant)\s*:/.test(line));

  let decision: 'left' | 'right' | 'conflict' | null = null;
  for (const line of lines) {
    const clauses = line.split(/[.!?;]+/);
    for (const clause of clauses) {
      const spans = partSpans(clause);
      const attached = new Set<'left' | 'right'>();
      const floating = new Set<'left' | 'right'>();
      for (const match of clause.matchAll(/\b(left|right)\b/g)) {
        const side = match[1] as 'left' | 'right';
        const nearest = closestPart(spans, match.index ?? 0);
        if (!nearest) floating.add(side);
        else if (nearest === selected) attached.add(side);
      }
      if (attached.size > 1) decision = 'conflict';
      else if (attached.size === 1) decision = [...attached][0];
      else if (floating.size > 1 && spans.every((span) => span.part === selected)) decision = 'conflict';
      else if (floating.size === 1 && spans.every((span) => span.part === selected)) decision = [...floating][0];
    }
  }
  return decision === 'conflict' ? null : decision;
}

export function isTypesafeIntakeEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return envBool('TYPESAFE_INTAKE', env);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function readChoice(
  answers: Record<string, unknown>,
  id: string
): { choice: string; confidence: number } {
  const raw = answers[id];
  if (
    !isRecord(raw) ||
    typeof raw.choice !== 'string' ||
    typeof raw.confidence !== 'number' ||
    !Number.isFinite(raw.confidence)
  ) {
    throw new Error('parse');
  }
  return { choice: raw.choice, confidence: raw.confidence };
}

function readNoul(answers: Record<string, unknown>, id: string): number {
  const raw = answers[id];
  if (!isRecord(raw) || typeof raw.noul !== 'number' || !Number.isFinite(raw.noul)) {
    throw new Error('parse');
  }
  return raw.noul;
}

/** A confident "no" closes the axis. A confident "yes" or an unsure middle stays open. */
export function axisStaysAmbiguous(noul: number): boolean {
  return noul > INTAKE_TYPESAFE_THRESHOLDS.noulResolved;
}

export function interpretTypesafeIntake(
  payload: unknown,
  index: OntologyIndex,
  input: RefineIntakeInput
): TypedIntakeFields {
  if (!isRecord(payload) || !isRecord(payload.answers)) {
    throw new Error('parse');
  }
  const answers = payload.answers;
  const placementAnswer = readChoice(answers, 'placement');
  const knownParts = new Set(canonicalPlacementOptions());
  let placement: string | null = null;
  if (
    placementAnswer.choice !== PLACEMENT_ABSTAIN &&
    knownParts.has(placementAnswer.choice) &&
    placementAnswer.confidence >= INTAKE_TYPESAFE_THRESHOLDS.placement
  ) {
    const side = sideForSelectedPlacement(input.state, placementAnswer.choice);
    placement = side ? `${side} ${placementAnswer.choice}` : placementAnswer.choice;
  }

  const styleTags: string[] = [];
  for (const tag of index.tags) {
    const raw = answers[`style_${tag.id}`];
    if (!isRecord(raw)) continue;
    let answer: { choice: string; confidence: number };
    try {
      answer = readChoice(answers, `style_${tag.id}`);
    } catch {
      continue;
    }
    if (answer.choice !== 'present') continue;
    if (answer.confidence < INTAKE_TYPESAFE_THRESHOLDS.style) continue;
    const id = resolveTag(index, tag.id);
    if (!id || styleTags.includes(id)) continue;
    styleTags.push(id);
  }

  let ambiguousAxes = VARIATION_AXIS_POOL.filter((axis) =>
    axisStaysAmbiguous(readNoul(answers, `axis_${axis}`))
  );
  if (input.subject?.trim()) {
    ambiguousAxes = ambiguousAxes.filter((axis) => axis !== 'literal-abstract');
  }

  return { placement, styleTags, ambiguousAxes };
}

function errorName(error: unknown): string {
  if (!error || typeof error !== 'object' || !('name' in error)) return '';
  return typeof error.name === 'string' ? error.name : '';
}

function errorMessage(error: unknown): string {
  if (!error || typeof error !== 'object' || !('message' in error)) return '';
  return typeof error.message === 'string' ? error.message : '';
}

function failureOf(error: unknown): { failure: string; status: number | null } {
  const name = errorName(error);
  const message = errorMessage(error);
  // jsdom's TimeoutError is a DOMException that does not extend Error.
  if (name === 'TimeoutError' || name === 'AbortError' || /timed out|timeout/i.test(message)) {
    return { failure: 'timeout', status: null };
  }
  const match = /^http (\d+)$/.exec(message);
  if (match) return { failure: 'http', status: Number(match[1]) };
  if (message === 'parse') return { failure: 'parse', status: null };
  return { failure: 'error', status: null };
}

/**
 * Status and failure class only. The key, the brief, and the response
 * body stay out of the log — a provider body can echo the request.
 */
function logTypesafeFallback(error: unknown): void {
  const { failure, status } = failureOf(error);
  const statusNote = status === null ? '' : ` ${status}`;
  console.warn(
    `[IntakeExtraction] TypeSafe failed (${failure}${statusNote}), using Gemini extraction`
  );
}

function optionalNoul(answers: Record<string, unknown>, id: string): number | null {
  const raw = answers[id];
  if (!isRecord(raw) || typeof raw.noul !== 'number' || !Number.isFinite(raw.noul)) return null;
  return raw.noul;
}

function optionalChoice(
  answers: Record<string, unknown>,
  id: string
): { choice: string; confidence: number } | null {
  const raw = answers[id];
  if (
    !isRecord(raw) ||
    typeof raw.choice !== 'string' ||
    typeof raw.confidence !== 'number' ||
    !Number.isFinite(raw.confidence)
  ) {
    return null;
  }
  return { choice: raw.choice, confidence: raw.confidence };
}

/**
 * One System One call. Null when the flag is off, demo mode is on, the
 * key is missing, the spend governor denies the call, or the call cannot
 * be used — callers keep the Gemini extraction. Demo mode returns before
 * any TypeSafe request.
 */
export async function refineIntakeFields(input: RefineIntakeInput): Promise<TypedIntakeFields | null> {
  if (!isTypesafeIntakeEnabled()) return null;
  if (process.env.NEXT_PUBLIC_DEMO_MODE === 'true') return null;
  const key = typesafeApiKey();
  if (!key) return null;

  try {
    const index = await loadOntology();
    const result = await postGovernedSystemOne({
      state: input.state,
      questions: buildIntakeQuestions(index) as Record<string, { type: 'noul' | 'choice' | 'score'; instructions: string; criteria?: Record<string, string> }>,
    });
    if (!result.ok) {
      const message = result.failure === 'http'
        ? `http ${result.status}`
        : result.failure === 'timeout'
          ? 'timed out'
          : result.failure;
      logTypesafeFallback(new Error(message));
      return null;
    }
    const fields = interpretTypesafeIntake(result.payload, index, input);
    const unresolvedFields = [
      ...(fields.placement ? [] : ['placement']),
      ...(fields.styleTags.length > 0 ? [] : ['style']),
      ...(input.subject?.trim() ? [] : ['subject']),
      ...fields.ambiguousAxes,
    ];
    const answers = isRecord(result.payload) && isRecord(result.payload.answers)
      ? result.payload.answers
      : {};
    const next = optionalChoice(answers, 'next_question');
    publishIntakeDecisionPacket({
      version: 1,
      fingerprint: intakeStateFingerprint(input.state),
      reading: {
        placement: fields.placement,
        styleTags: fields.styleTags,
        ambiguousAxes: fields.ambiguousAxes,
        readinessNoul: optionalNoul(answers, 'enough_to_generate'),
        nextQuestion: next ? { axis: next.choice, confidence: next.confidence } : null,
        unresolvedFields,
      },
    });
    return fields;
  } catch (error) {
    logTypesafeFallback(error);
    return null;
  }
}
