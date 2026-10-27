/**
 * TypeSafe intake for the fields that are closed sets.
 *
 * One POST per extraction (https://api.typesafe.ai/v1/systemone, model
 * jev-latest) asks:
 *   - one Choice for placement, from the canonical body-part list
 *   - one Choice per style-tag dimension, plus an explicit "none"
 *   - one Noul per variation axis: "is this axis still ambiguous?"
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

import { envBool, envInt, envString } from '@/config/envSchema';
import { VARIATION_AXIS_POOL, type VariationAxis } from '../types';
import { loadOntology, resolveTag, type OntologyIndex, type StyleOntologyTag } from './ontology';
import { canonicalPlacementOptions, placementSide } from './placementCatalog';

export const TYPESAFE_SYSTEMONE_URL = 'https://api.typesafe.ai/v1/systemone';

const DEFAULT_MODEL = 'jev-latest';
const DEFAULT_TIMEOUT_MS = 8_000;

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
const STYLE_ABSTAIN = 'none';

/**
 * Orthogonal slices of the closed style ontology. A brief can carry one
 * tag from each slice (fine-line + japanese + color). Tags inside one
 * slice are mutually exclusive, so each slice is one Choice.
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

  for (const dimension of styleDimensions(index)) {
    const criteria: Record<string, string> = {
      [STYLE_ABSTAIN]: `The brief does not commit to a ${dimension.id} style tag.`,
    };
    for (const tag of dimension.tags) {
      const aliases = tag.aliases?.filter((alias) => alias.trim()) ?? [];
      const aliasNote = aliases.length > 0 ? ` Also called ${aliases.join(', ')}.` : '';
      criteria[tag.id] = `${tag.label}.${aliasNote}`;
    }
    questions[`style_${dimension.id}`] = {
      type: 'choice',
      instructions: `Which ${dimension.id} style tag does the brief commit to? Choose none if it does not commit to one.`,
      criteria,
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
  return questions;
}

export function isTypesafeIntakeEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return envBool('TYPESAFE_INTAKE', env);
}

function typesafeApiKey(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const key = envString('TYPESAFE_API_KEY', env);
  return key || undefined;
}

function typesafeModel(env: NodeJS.ProcessEnv = process.env): string {
  return envString('TYPESAFE_MODEL', env) || DEFAULT_MODEL;
}

function typesafeTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const value = envInt('TYPESAFE_TIMEOUT_MS', env);
  if (value === undefined || !Number.isFinite(value) || value < 1) return DEFAULT_TIMEOUT_MS;
  return value;
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
    const side = placementSide(input.state.toLowerCase());
    placement = side ? `${side} ${placementAnswer.choice}` : placementAnswer.choice;
  }

  const styleTags: string[] = [];
  for (const dimension of styleDimensions(index)) {
    const answer = readChoice(answers, `style_${dimension.id}`);
    if (answer.choice === STYLE_ABSTAIN) continue;
    if (answer.confidence < INTAKE_TYPESAFE_THRESHOLDS.style) continue;
    const id = resolveTag(index, answer.choice);
    if (!id || !dimension.tags.some((tag) => tag.id === id) || styleTags.includes(id)) continue;
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

/**
 * One System One call. Null when the flag is off, the key is missing, or
 * the call cannot be used — callers keep the Gemini extraction.
 */
export async function refineIntakeFields(input: RefineIntakeInput): Promise<TypedIntakeFields | null> {
  if (!isTypesafeIntakeEnabled()) return null;
  const key = typesafeApiKey();
  if (!key) return null;

  try {
    const index = await loadOntology();
    const response = await fetch(TYPESAFE_SYSTEMONE_URL, {
      method: 'POST',
      signal: AbortSignal.timeout(typesafeTimeoutMs()),
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: typesafeModel(),
        state: input.state,
        questions: buildIntakeQuestions(index),
      }),
    });
    if (!response.ok) {
      throw new Error(`http ${response.status}`);
    }
    const payload: unknown = await response.json();
    return interpretTypesafeIntake(payload, index, input);
  } catch (error) {
    logTypesafeFallback(error);
    return null;
  }
}
