/**
 * Brief-fit weights and the shortlist reorder.
 *
 * TypeSafe returns a Score on a 0..n-1 rubric (four levels here, so 0..3).
 * This module normalizes each axis to 0..1 and combines them. The weights
 * live here, not in the model: style 0.40, placement 0.30, subject 0.30.
 * They sum to 1. Candidate generation (embeddings, Neo4j, keyword search)
 * still decides who is on the shortlist; this only reorders the head.
 */

export const RERANK_WEIGHTS = Object.freeze({
  style: 0.4,
  placement: 0.3,
  subject: 0.3,
});

export const DEFAULT_RERANK_TOP_N = 20;
export const MAX_RERANK_TOP_N = 50;

/** Ordered low → high. A Score answer is a position on this list, 0..3. */
export const SCORE_QUESTIONS = Object.freeze({
  style: Object.freeze({
    instructions: "How well does this candidate's style fit the client's brief?",
    criteria: Object.freeze([
      "The candidate's style conflicts with the style the brief asks for.",
      "The candidate's style is only loosely related to the brief.",
      "The candidate's style partly fits the brief.",
      "The candidate's style is what the brief asks for.",
    ]),
  }),
  placement: Object.freeze({
    instructions: "How well does this candidate fit the placement in the client's brief?",
    criteria: Object.freeze([
      "The candidate does not fit the placement the brief asks for.",
      "The candidate's placement is only loosely related to the brief.",
      "The candidate partly fits the placement in the brief.",
      "The candidate fits the placement the brief asks for.",
    ]),
  }),
  subject: Object.freeze({
    instructions: "How well does this candidate fit the subject of the client's brief?",
    criteria: Object.freeze([
      "The candidate's subject conflicts with the brief.",
      "The candidate's subject is only loosely related to the brief.",
      "The candidate's subject partly fits the brief.",
      "The candidate's subject is what the brief asks for.",
    ]),
  }),
});

export const SCORE_SPAN = SCORE_QUESTIONS.style.criteria.length - 1;

/**
 * Questions object for one System One request. `criteria` is the ordered
 * rubric. `options` is intentionally absent — the API rejects it.
 */
export function scoreQuestions() {
  const questions = {};
  for (const key of ['style', 'placement', 'subject']) {
    const question = SCORE_QUESTIONS[key];
    questions[key] = {
      type: 'score',
      instructions: question.instructions,
      criteria: [...question.criteria],
    };
  }
  return questions;
}

/**
 * @param {number} raw Score position, 0..SCORE_SPAN
 * @returns {number|undefined} 0..1, or undefined when the value is not on the rubric
 */
export function normalizeScore(raw) {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return undefined;
  if (raw < -1e-6 || raw > SCORE_SPAN + 1e-6) return undefined;
  const clamped = Math.min(SCORE_SPAN, Math.max(0, raw));
  return clamped / SCORE_SPAN;
}

/**
 * @param {{ style: number, placement: number, subject: number }} parts each already 0..1
 * @returns {number}
 */
export function compositeFit(parts) {
  return (RERANK_WEIGHTS.style * parts.style)
    + (RERANK_WEIGHTS.placement * parts.placement)
    + (RERANK_WEIGHTS.subject * parts.subject);
}

/**
 * @param {{ style: number, placement: number, subject: number }} raw rubric positions
 * @returns {{ style: number, placement: number, subject: number, composite: number }|undefined}
 */
export function fitFromRawScores(raw) {
  if (!raw) return undefined;
  const style = normalizeScore(raw.style);
  const placement = normalizeScore(raw.placement);
  const subject = normalizeScore(raw.subject);
  if (style === undefined || placement === undefined || subject === undefined) return undefined;
  return {
    style,
    placement,
    subject,
    composite: compositeFit({ style, placement, subject }),
  };
}

function round4(value) {
  return Math.round(value * 10000) / 10000;
}

/**
 * Reorder the first `topN` candidates by brief fit. A missing fit fails
 * closed: the original list comes back and nothing is marked applied.
 * Candidates past the head keep their relative order after the head.
 *
 * @param {Array<{ id?: string|number }>} candidates
 * @param {Array<{ style: number, placement: number, subject: number, composite: number }|undefined>} fits
 *        aligned with the scored head (index 0 is the first candidate)
 * @param {number} topN
 * @returns {{ items: Array, applied: boolean }}
 */
export function rerankTopN(candidates, fits, topN) {
  const list = Array.isArray(candidates) ? candidates : [];
  const n = Math.max(0, Math.min(topN, list.length));
  if (n === 0) return { items: list.slice(), applied: false };

  const headFits = Array.isArray(fits) ? fits.slice(0, n) : [];
  if (headFits.length < n || headFits.some((fit) => !fit || typeof fit.composite !== 'number')) {
    return { items: list.slice(), applied: false };
  }

  const head = list.slice(0, n).map((item, index) => ({
    item,
    index,
    fit: headFits[index],
  }));
  head.sort((a, b) => b.fit.composite - a.fit.composite || a.index - b.index);

  return {
    items: [
      ...head.map(({ item, fit }) => ({
        ...item,
        briefFit: {
          style: round4(fit.style),
          placement: round4(fit.placement),
          subject: round4(fit.subject),
          composite: round4(fit.composite),
        },
      })),
      ...list.slice(n),
    ],
    applied: true,
  };
}
