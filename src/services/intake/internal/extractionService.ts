/**
 * Intake extraction (ADR-0009, ADR-0010, ADR-0012).
 *
 * Turns the two fixed intake answers (placement, meaning) into an
 * IntakeRecord:
 *   - placement: normalized body placement (hard generation constraint)
 *   - styleTags: ONLY canonical ids from the closed style ontology
 *   - meaning: the user's answer kept verbatim as prose — never flattened
 *   - references: reference imagery the user mentioned
 *   - ambiguousAxes: variation axes the answers did NOT resolve
 *
 * Provider order mirrors the Council's conventions (Vertex Gemini first,
 * OpenRouter second) with one deliberate difference: on no provider or
 * provider failure we degrade to a deterministic keyword extractor rather
 * than throwing — dev mode must work offline, and a heuristic extraction
 * is a real (if blunter) extraction, not mock data.
 *
 * TYPESAFE_INTAKE (default off) types placement, style dimensions, and
 * axis ambiguity with one TypeSafe call after Gemini has filled the
 * free-text fields. Flag off, a missing key, a timeout, or any TypeSafe
 * error leaves this Gemini/heuristic result untouched.
 */

import type { IntakeRecord, VariationAxis } from '../types';
import { VARIATION_AXIS_POOL } from '../types';
import {
  loadOntology,
  resolveTags,
  type OntologyIndex,
} from './ontology';
import { getGcpAccessToken } from '@/lib/google-auth-edge';
import {
  characterSubjectFrom,
  charactersIn,
  characterIdentitiesFor,
} from './characterSubject';
import {
  groundedCharacterIdentities,
  mergeCharacterIdentities,
} from './characterIdentity';
import { normalizePlacement } from './placementCatalog';
import { refineIntakeFields } from './typesafeExtraction';

export interface IntakeAnswers {
  placementAnswer: string;
  meaningAnswer: string;
}

/* ──────────────────────────────────────────────────────────────────────────
 * Provider configuration (read lazily so tests can toggle env per case)
 * ────────────────────────────────────────────────────────────────────────── */

function vertexProjectId(): string | null {
  return (
    process.env.NEXT_PUBLIC_VERTEX_AI_PROJECT_ID ||
    process.env.GCP_PROJECT_ID ||
    process.env.VERTEX_PROJECT_ID ||
    null
  );
}

function isVertexConfigured(): boolean {
  const credJson =
    process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON || process.env.GCP_SERVICE_ACCOUNT_KEY;
  const credPair = process.env.GCP_SERVICE_ACCOUNT_EMAIL && process.env.GCP_PRIVATE_KEY;
  return Boolean(vertexProjectId() && (credJson || credPair));
}

function isOpenRouterConfigured(): boolean {
  return Boolean(process.env.OPENROUTER_API_KEY);
}

const OPENROUTER_API_URL = 'https://openrouter.ai/api/v1/chat/completions';

export { normalizePlacement } from './placementCatalog';

/* ──────────────────────────────────────────────────────────────────────────
 * Ambiguity detection (ADR-0012)
 *
 * An axis is resolved when either of its poles is signalled by the answers
 * (or by a resolved style tag — "fine-line" resolves bold↔fine the same way
 * "delicate script" does). Everything unresolved stays ambiguous and drives
 * variation-axis selection.
 * ────────────────────────────────────────────────────────────────────────── */

const AXIS_POLE_KEYWORDS: Record<VariationAxis, [string[], string[]]> = {
  'bold-fine': [
    ['bold', 'thick', 'heavy', 'chunky', 'strong lines', 'blocky'],
    ['fine', 'fine line', 'fineline', 'delicate', 'thin', 'dainty', 'single needle', 'script', 'micro'],
  ],
  'color-blackwork': [
    ['color', 'colour', 'colorful', 'colourful', 'watercolor', 'watercolour', 'vibrant', 'full color'],
    ['blackwork', 'black work', 'black and grey', 'black and gray', 'monochrome', 'grayscale', 'greyscale', 'black ink'],
  ],
  'literal-abstract': [
    ['realistic', 'realism', 'photorealistic', 'portrait', 'literal', 'lifelike', 'true to life'],
    ['abstract', 'geometric', 'surreal', 'symbolic', 'impressionist', 'stylized', 'stylised'],
  ],
  'minimal-ornate': [
    ['minimal', 'minimalist', 'simple', 'tiny', 'subtle', 'understated'],
    ['ornate', 'detailed', 'intricate', 'elaborate', 'filigree', 'baroque', 'busy'],
  ],
};

function matchesAny(text: string, keywords: string[]): boolean {
  return keywords.some((kw) => new RegExp(`\\b${kw}\\b`).test(text));
}

/** Axes the given text (answers + resolved tags) leaves unresolved. */
export function detectAmbiguousAxes(answers: IntakeAnswers, styleTags: string[]): VariationAxis[] {
  const text = [
    answers.placementAnswer,
    answers.meaningAnswer,
    // Tag ids are kebab-case; spaced-out they hit the same keyword lists.
    ...styleTags.map((id) => id.replace(/-/g, ' ')),
  ]
    .join(' ')
    .toLowerCase();

  return VARIATION_AXIS_POOL.filter((axis) => {
    const [poleA, poleB] = AXIS_POLE_KEYWORDS[axis];
    return !matchesAny(text, poleA) && !matchesAny(text, poleB);
  });
}

/* ──────────────────────────────────────────────────────────────────────────
 * Deterministic heuristic extractor (offline / no-provider fallback)
 * ────────────────────────────────────────────────────────────────────────── */

const URL_PATTERN = /https?:\/\/[^\s"'<>)]+/g;

function extractReferences(answers: IntakeAnswers): string[] {
  const combined = `${answers.placementAnswer} ${answers.meaningAnswer}`;
  return Array.from(new Set(combined.match(URL_PATTERN) ?? []));
}

function heuristicStyleTags(answers: IntakeAnswers, index: OntologyIndex): string[] {
  const text = `${answers.placementAnswer} ${answers.meaningAnswer}`.toLowerCase();
  const found: string[] = [];
  for (const [alias, id] of index.aliasToId) {
    if (found.includes(id)) continue;
    const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (new RegExp(`\\b${escaped}\\b`).test(text)) found.push(id);
  }
  return found;
}

/** Keyword-only extraction — deterministic, offline, no provider needed. */
export function heuristicExtract(answers: IntakeAnswers, index: OntologyIndex): IntakeRecord {
  const styleTags = heuristicStyleTags(answers, index);
  const scanText = `${answers.placementAnswer} ${answers.meaningAnswer}`;
  const subject = characterSubjectFrom(scanText);
  const characterIdentities = characterIdentitiesFor(charactersIn(scanText));
  const ambiguousAxes = detectAmbiguousAxes(answers, styleTags).filter(
    (axis) => !subject || axis !== 'literal-abstract'
  );
  return {
    placement: normalizePlacement(answers.placementAnswer),
    styleTags,
    meaning: answers.meaningAnswer.trim(),
    subject,
    characterIdentities: characterIdentities.length > 0 ? characterIdentities : undefined,
    references: extractReferences(answers),
    ambiguousAxes,
  };
}

/* ──────────────────────────────────────────────────────────────────────────
 * LLM extraction
 * ────────────────────────────────────────────────────────────────────────── */

interface LlmExtraction {
  placement?: unknown;
  styleTags?: unknown;
  subject?: unknown;
  characterIdentities?: unknown;
  references?: unknown;
  ambiguousAxes?: unknown;
}

function buildExtractionPrompt(answers: IntakeAnswers, index: OntologyIndex): string {
  const allowedTags = Array.from(index.canonicalIds).join(', ');
  return [
    'You extract structured tattoo intake data from two conversational answers.',
    'Return ONLY a JSON object with exactly these keys:',
    '{"placement": string, "styleTags": string[], "subject": string | null, "characterIdentities": [{"name": string, "series": string}], "references": string[], "ambiguousAxes": string[]}',
    '',
    '- placement: the body placement, normalized to a short lowercase phrase (e.g. "left forearm").',
    `- styleTags: tattoo style tags, chosen ONLY from this closed list: [${allowedTags}]. Empty array if the answers do not clearly signal a style.`,
    '- subject: when the answers name a SPECIFIC character, franchise, person, or thing, write a concrete visual subject phrase that names it and anchors it to real, recognizable visual elements — e.g. "Izuku Midoriya (Deku) from My Hero Academia, determined expression, One For All lightning crackling around his fist". Name the character AND the franchise. Only include visual elements that genuinely belong to that subject; if you are not sure of its iconography, name the subject plainly without invented details. null when the answers name nothing specific (a mood, a value, an abstract feeling). Anchor the subject with COSTUME specificity, not just hair and powers — outfit, silhouette, and accessories are what separate a character from lookalikes in the same archetype (e.g. \"Killua Zoldyck, Hunter x Hunter, silver spiky hair, blue eyes, plain long-sleeve white turtleneck, wide shorts, boots\" rather than just \"white-haired boy with lightning\").',
    '- characterIdentities: verified pairs binding each named character to its source series, franchise, game, comic, manga, anime, film, or other named work. Preserve the customer\'s title when stated. Never guess a source from a shared name; omit uncertain pairs and return an empty array when none are known.',
    '- references: any reference imagery the user mentioned (URLs or short descriptions of images they referenced). Empty array if none.',
    '- COLOR IS A FIRST-CLASS RESOLUTION: if the answers signal color at all — saying color outright, naming a color-bearing style (neo-traditional, watercolor, new-school), or referencing color artwork such as the color palette of an anime — include "color" in styleTags and treat color-blackwork as RESOLVED. Equally, explicit blackwork / black-and-grey / fine-line wording resolves it the other way. Only leave color-blackwork ambiguous when the answers genuinely say nothing either way.',
    `- ambiguousAxes: the subset of [${VARIATION_AXIS_POOL.join(', ')}] the answers leave UNRESOLVED. An axis is resolved when the answers commit to either pole (e.g. "delicate script" resolves bold-fine toward fine; "black and grey" resolves color-blackwork). IMPORTANT: when subject is non-null, literal-abstract is RESOLVED (toward literal) — a named character or franchise means the user wants a recognizable depiction, so never list literal-abstract as ambiguous in that case.`,
    '',
    'Do NOT paraphrase or summarize the meaning answer — it is preserved verbatim elsewhere.',
    '',
    `Placement answer: "${answers.placementAnswer}"`,
    `Meaning answer: "${answers.meaningAnswer}"`,
  ].join('\n');
}

function parseJsonFromText(text: string): LlmExtraction | null {
  if (!text) return null;
  try {
    return JSON.parse(text) as LlmExtraction;
  } catch {
    /* fall through to brace scan */
  }
  const first = text.indexOf('{');
  if (first === -1) return null;
  let depth = 0;
  for (let i = first; i < text.length; i += 1) {
    if (text[i] === '{') depth += 1;
    if (text[i] === '}') depth -= 1;
    if (depth === 0) {
      try {
        return JSON.parse(text.slice(first, i + 1)) as LlmExtraction;
      } catch {
        return null;
      }
    }
  }
  return null;
}

async function extractWithVertex(prompt: string): Promise<LlmExtraction | null> {
  const projectId = vertexProjectId();
  const region = process.env.GCP_REGION || 'us-central1';
  const model = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
  const accessToken = await getGcpAccessToken();
  const endpoint = `https://${region}-aiplatform.googleapis.com/v1/projects/${projectId}/locations/${region}/publishers/google/models/${model}:generateContent`;

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: { responseMimeType: 'application/json', temperature: 0 },
    }),
  });
  if (!response.ok) {
    throw new Error(`Gemini API error: ${response.status} - ${await response.text()}`);
  }
  const data = await response.json();
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
  return text ? parseJsonFromText(text) : null;
}

async function extractWithOpenRouter(prompt: string): Promise<LlmExtraction | null> {
  const model = process.env.INTAKE_EXTRACTION_MODEL || 'google/gemini-2.5-flash';
  const response = await fetch(OPENROUTER_API_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
      'Content-Type': 'application/json',
      'X-Title': 'TattTester - Intake Extraction',
    },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0,
      max_tokens: 500,
    }),
  });
  if (!response.ok) {
    throw new Error(`OpenRouter API error: ${response.status} ${response.statusText}`);
  }
  const data = await response.json();
  const text = data.choices?.[0]?.message?.content;
  return text ? parseJsonFromText(text) : null;
}

/* ──────────────────────────────────────────────────────────────────────────
 * Merge: LLM output is a suggestion; the contract is enforced here
 * ────────────────────────────────────────────────────────────────────────── */

function asStringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  return value.filter((v): v is string => typeof v === 'string' && v.trim().length > 0);
}

function mergeLlmExtraction(
  llm: LlmExtraction,
  answers: IntakeAnswers,
  index: OntologyIndex
): IntakeRecord {
  // Closed vocabulary: aliases resolve, unknown tags are rejected outright.
  const styleTags = resolveTags(index, asStringArray(llm.styleTags) ?? []);

  const rawPlacement =
    typeof llm.placement === 'string' && llm.placement.trim()
      ? llm.placement
      : answers.placementAnswer;

  // The model is asked for a subject but drops it often enough to matter, so
  // a name match in the answers backfills one deterministically.
  const subject =
    (typeof llm.subject === 'string' && llm.subject.trim() ? llm.subject.trim() : undefined) ??
    characterSubjectFrom(`${answers.placementAnswer} ${answers.meaningAnswer}`);
  const sourceText = `${answers.placementAnswer} ${answers.meaningAnswer}`;
  const providerIdentities = groundedCharacterIdentities(llm.characterIdentities, sourceText);
  const characterIdentities = mergeCharacterIdentities(
    providerIdentities,
    characterIdentitiesFor(charactersIn(sourceText)),
    sourceText
  );

  const llmAxes = asStringArray(llm.ambiguousAxes);
  let ambiguousAxes = llmAxes
    ? VARIATION_AXIS_POOL.filter((axis) => llmAxes.includes(axis))
    : detectAmbiguousAxes(answers, styleTags);
  // A named subject means the user wants a recognizable depiction — enforce
  // the prompt's rule here too so literal-abstract can never slip through as
  // ambiguous and burn reveal slots on abstract takes of a named character.
  if (subject) {
    ambiguousAxes = ambiguousAxes.filter((axis) => axis !== 'literal-abstract');
  }

  return {
    placement: normalizePlacement(rawPlacement),
    styleTags,
    // Meaning is NEVER taken from the model — verbatim prose per ADR-0010.
    meaning: answers.meaningAnswer.trim(),
    subject,
    characterIdentities: characterIdentities.length > 0 ? characterIdentities : undefined,
    references: asStringArray(llm.references)?.map((r) => r.trim()) ?? extractReferences(answers),
    ambiguousAxes: [...ambiguousAxes],
  };
}

/* ──────────────────────────────────────────────────────────────────────────
 * Entry point
 * ────────────────────────────────────────────────────────────────────────── */

export async function extractIntakeRecord(answers: IntakeAnswers): Promise<IntakeRecord> {
  const index = await loadOntology();
  const prompt = buildExtractionPrompt(answers, index);

  let llm: LlmExtraction | null = null;

  if (isVertexConfigured()) {
    try {
      llm = await extractWithVertex(prompt);
    } catch (error) {
      console.warn('[IntakeExtraction] Vertex AI failed, trying fallback:', error);
    }
  }

  if (!llm && isOpenRouterConfigured()) {
    try {
      llm = await extractWithOpenRouter(prompt);
    } catch (error) {
      console.warn('[IntakeExtraction] OpenRouter failed, falling back to heuristic:', error);
    }
  }

  const state = [
    `Placement answer: ${answers.placementAnswer}`,
    `Meaning answer: ${answers.meaningAnswer}`,
  ].join('\n');
  const typed = await refineIntakeFields({
    state,
    subject: typeof llm?.subject === 'string' ? llm.subject : undefined,
  });

  if (!llm && !typed) return heuristicExtract(answers, index);

  if (!llm) {
    const heuristic = heuristicExtract(answers, index);
    llm = {
      placement: heuristic.placement,
      styleTags: heuristic.styleTags,
      subject: heuristic.subject,
      characterIdentities: heuristic.characterIdentities,
      references: heuristic.references,
      ambiguousAxes: heuristic.ambiguousAxes,
    };
  }

  if (typed) {
    // A withheld placement keeps the customer's own answer. This path is
    // the two-question scripted intake — there is no later turn to ask.
    // The conversation overlay clears the field instead so the ask fires.
    llm = {
      ...llm,
      placement: typed.placement ?? answers.placementAnswer,
      styleTags: typed.styleTags,
      ambiguousAxes: typed.ambiguousAxes,
    };
  }

  return mergeLlmExtraction(llm, answers, index);
}
