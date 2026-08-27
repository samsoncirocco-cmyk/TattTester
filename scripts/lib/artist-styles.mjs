/**
 * Artist style-tag vocabulary + bio extraction, shared by the enrichment pair:
 *
 *   scripts/harvest-ig-styles.mjs  — reads Instagram bios, emits a style artifact
 *   scripts/link-artist-styles.mjs — MERGEs that artifact into the Neo4j graph
 *
 * Why this vocabulary matters: `/api/v1/match/semantic` treats style as a HARD
 * FILTER, not a ranking signal (src/features/match-pulse/services/neo4jService.ts —
 * `any(style IN $styles WHERE any(s IN styles WHERE toLower(s) = toLower(style)))`).
 * An artist without a matching style is excluded outright, so a WRONG tag surfaces
 * the wrong artist and a MISSING tag hides the right one. Precision beats recall.
 *
 * ── Vocabulary: derived, never hand-typed (ADR-0010, ADR-0011) ─────────────
 * Every style name here comes from the two checked-in files PR #166 made the
 * single controlled vocabulary, the same pair src/lib/style-vocabulary.ts reads:
 *
 *   data/style-ontology.json          tag id, display label, and the aliases
 *                                     that absorb spelling drift.
 *   data/graph-style-vocabulary.json  the graph's OWN spelling of each tag.
 *
 * This module therefore names two different things, and the difference is the
 * whole point:
 *
 *   ontology LABEL  ("Japanese", "Lettering")     — what the artifact records
 *   graph NAME      (e.g. "Japanese (Irezumi)" pre-#176) — what MERGE writes
 *
 * Writing a label the graph does not use is how a vocabulary re-splits. Before
 * this was derived, the extractor emitted "Script" (no such Style node — the
 * import would have CREATED one, re-splitting the tag #166 had just folded into
 * `lettering`) and "Japanese" (a real node carrying zero artists, while the 434
 * Japanese artists sit on "Japanese (Irezumi)"). Both are now resolved through
 * the ontology instead: "script" is an alias of `lettering`, and the `japanese`
 * tag writes the graph's spelling.
 *
 * STYLE_PATTERNS is a faithful port of STYLE_PATTERNS in
 * ~/tatt-scraper/execution/enrich_artists.py, kept regex-for-regex identical so the
 * hand-measured precision of that lane carries over. Each rule is keyed by its
 * ontology TAG ID so the display name is looked up, not duplicated.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DATA_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'data');
const readData = (file) => JSON.parse(readFileSync(path.join(DATA_DIR, file), 'utf8'));

const ONTOLOGY = readData('style-ontology.json');
const GRAPH_VOCABULARY = readData('graph-style-vocabulary.json');

/** Ontology tag id → its tag record. */
const TAG_BY_ID = new Map(ONTOLOGY.tags.map((t) => [t.id, t]));

/** Every approved style label, in ontology order. */
export const ONTOLOGY_STYLE_LABELS = ONTOLOGY.tags.map((t) => t.label);

/**
 * Ontology tag id → the name the GRAPH stores. A tag the graph already answers
 * with keeps the graph's spelling (pre-#176, "japanese" → "Japanese (Irezumi)";
 * since the #176 merge the graph answers "Japanese" directly); anything
 * else falls back to its approved ontology label. A newly approved tag may
 * therefore create its first `:Style` node when an artist carrying it is
 * imported, but an unapproved term can never create a node.
 */
const GRAPH_NAME_BY_TAG = new Map(
  ONTOLOGY.tags.map((t) => {
    const entry = GRAPH_VOCABULARY.styles.find((s) => s.tag === t.id);
    return [t.id, entry?.graphNames?.[0] ?? t.label];
  }),
);

/** Every spelling of a tag — id, label, aliases, graph names — lowercased. */
const TAG_BY_SPELLING = new Map();
for (const tag of ONTOLOGY.tags) {
  const spellings = new Set([tag.id, tag.label, ...(tag.aliases ?? [])]);
  const entry = GRAPH_VOCABULARY.styles.find((s) => s.tag === tag.id);
  for (const n of entry?.graphNames ?? []) spellings.add(n);
  for (const s of spellings) TAG_BY_SPELLING.set(String(s).toLowerCase(), tag.id);
}

/**
 * Bio → style rules, ported one-for-one from enrich_artists.py STYLE_PATTERNS.
 * Ordered so the output is deterministic regardless of Object key iteration.
 * `tag` is the ontology id; `style` is its display label, derived not typed.
 */
export const STYLE_PATTERNS = [
  { tag: 'traditional', pattern: /\b(?:american\s+)?traditional\b(?!\s*chinese)/i },
  { tag: 'neo-traditional', pattern: /\bneo[\s-]?traditional\b/i },
  { tag: 'black-and-grey', pattern: /\bblack\s*(?:&|and|\+|n)\s*gr[ae]y\b/i },
  { tag: 'blackwork', pattern: /\bblack[\s-]?work\b/i },
  { tag: 'fine-line', pattern: /\bfine[\s-]?line\b/i },
  { tag: 'realism', pattern: /\b(?:photo[\s-]?)?realis(?:m|tic)\b/i },
  { tag: 'illustrative', pattern: /\billustrat(?:ive|ion)\b/i },
  { tag: 'japanese', pattern: /\b(?:japanese|irezumi)\b/i },
  { tag: 'watercolor', pattern: /\bwater[\s-]?colou?r\b/i },
  { tag: 'geometric', pattern: /\bgeometr(?:ic|y)\b/i },
  { tag: 'tribal', pattern: /\btribal\b/i },
  { tag: 'chicano', pattern: /\bchicano\b/i },
  { tag: 'anime', pattern: /\b(?:anime|manga)\b/i },
  { tag: 'minimalist', pattern: /\bminimalis(?:t|m)\b/i },
  // "script"/"calligraphy" are ALIASES of `lettering` in the ontology — the
  // regex is unchanged, only the name it resolves to.
  { tag: 'lettering', pattern: /\b(?:script|lettering|calligraphy)\s*(?:tattoo|work|style)?\b/i },
].map((rule) => {
  const tag = TAG_BY_ID.get(rule.tag);
  if (!tag) {
    throw new Error(
      `[artist-styles] style rule "${rule.tag}" is not a tag in data/style-ontology.json — ` +
        'the extractor may only emit names from the controlled vocabulary.',
    );
  }
  return { ...rule, style: tag.label };
});

/**
 * Ontology LABELS this extractor can emit — the vocabulary of the artifact.
 * Derived from STYLE_PATTERNS, so adding a rule cannot forget to widen it.
 */
export const CANONICAL_STYLE_NAMES = STYLE_PATTERNS.map((r) => r.style);

/**
 * Resolve any spelling of a style — ontology id, alias, graph node name or
 * display label, in any casing — to its ontology label. Returns null when the
 * term is outside the controlled vocabulary; callers DROP it rather than guess
 * (ADR-0011: nothing enters the vocabulary unreviewed).
 *
 * This is what lets the committed artifact keep working across a vocabulary
 * change: a row that still says "Script" resolves to "Lettering".
 */
export function resolveOntologyLabel(raw) {
  if (typeof raw !== 'string') return null;
  const tagId = TAG_BY_SPELLING.get(raw.trim().toLowerCase());
  return tagId ? TAG_BY_ID.get(tagId).label : null;
}

/**
 * Normalize a style array to ontology labels and fail on unknown input.
 *
 * Importers must never mint a second vocabulary from unchecked source data.
 * Aliases remain accepted for old artifacts ("Old School" → "Traditional"),
 * but an unreviewed term aborts the write path and must go through ADR-0011.
 */
export function normalizeOntologyStyleList(rawStyles, context = 'style list') {
  if (!Array.isArray(rawStyles)) {
    throw new TypeError(`[artist-styles] ${context} must be an array`);
  }

  const labels = [];
  const unknown = [];
  for (const raw of rawStyles) {
    const label = resolveOntologyLabel(raw);
    if (!label) {
      unknown.push(String(raw));
      continue;
    }
    if (!labels.includes(label)) labels.push(label);
  }

  if (unknown.length > 0) {
    throw new Error(
      `[artist-styles] ${context} contains style(s) outside data/style-ontology.json: ` +
        unknown.join(', '),
    );
  }
  return labels;
}

/**
 * Ontology label → the `:Style {name}` the graph stores it under. This is the
 * one place the artifact's vocabulary is translated into the graph's, and the
 * only names MERGE is ever given.
 */
export function graphStyleName(label) {
  const tagId = TAG_BY_SPELLING.get(String(label).trim().toLowerCase());
  return tagId ? GRAPH_NAME_BY_TAG.get(tagId) : null;
}

/**
 * Normalize a style array to the graph's controlled spelling.
 *
 * Supabase stores ontology labels; Neo4j stores the spelling recorded in
 * data/graph-style-vocabulary.json when one exists. Both resolve through the
 * same ontology and reject unknowns.
 */
export function normalizeGraphStyleList(rawStyles, context = 'style list') {
  const labels = normalizeOntologyStyleList(rawStyles, context);
  return [...new Set(labels.map((label) => graphStyleName(label)))];
}

const NEO_TRADITIONAL = STYLE_PATTERNS.find((r) => r.style === 'Neo-Traditional').pattern;
const TRADITIONAL = STYLE_PATTERNS.find((r) => r.style === 'Traditional').pattern;

/**
 * Extract canonical styles from one free-text bio, with the evidence that
 * produced each tag so a human can spot-check the artifact without re-running.
 *
 * Returns [{ style, match, index }] in STYLE_PATTERNS order; [] when nothing fires.
 */
export function extractStyleEvidence(bio) {
  if (typeof bio !== 'string' || bio.trim() === '') return [];

  const hits = [];
  for (const { style, pattern } of STYLE_PATTERNS) {
    const m = pattern.exec(bio);
    if (m) hits.push({ style, match: m[0], index: m.index });
  }

  // De-conflict: "neo-traditional" text also satisfies the Traditional pattern.
  // Drop Traditional unless it is supported by evidence OUTSIDE the neo- phrase.
  const hasBoth = hits.some((h) => h.style === 'Traditional') && hits.some((h) => h.style === 'Neo-Traditional');
  if (hasBoth) {
    const stripped = bio.replace(new RegExp(NEO_TRADITIONAL.source, 'gi'), ' ');
    const residual = TRADITIONAL.exec(stripped);
    if (!residual) return hits.filter((h) => h.style !== 'Traditional');
    // Re-anchor the surviving Traditional evidence to the residual match so the
    // stored evidence points at text that actually justifies the tag.
    return hits.map((h) => (h.style === 'Traditional' ? { ...h, match: residual[0], index: null } : h));
  }

  return hits;
}

// ─── Precision guard ───────────────────────────────────────────────────────
//
// STYLE_PATTERNS above is deliberately left byte-identical to the Python
// original so its hand-measured precision transfers. The guard below is a
// SEPARATE, opt-outable layer that drops matches whose surrounding text
// disqualifies them. It only ever removes tags, never adds them.
//
// Both rules were found by auditing the full 2026-07-20 IG bio corpus, not
// invented defensively — see docs/audits/2026-07-25-enrichment-gate-review.md.

/** How far back to look for a negation cue before a style match. */
const NEGATION_WINDOW = 40;

/**
 * Words that flip a style claim into a disclaimer, when nothing but ordinary
 * prose separates the cue from the style word.
 *
 * Two deliberate narrownesses, both learned from the corpus:
 *  - Word cues only. A bare ❌/🚫 is used as a bullet at least as often as a
 *    negation ("❌Geometric / Ornamental / Neo-Trad" is a style LIST).
 *  - The run between cue and match may only contain plain word characters.
 *    Any emoji, bullet or punctuation ends the disclaimer, so
 *    "❌NO DMS❌🌸SOFT TRAD🌸🍥ANIME🍥" keeps its Anime tag.
 */
const NEGATION_CUE = /\b(?:no|not|don'?t|doesn'?t|won'?t|never)\b[A-Za-z0-9 '’\-,/&]*$/i;

/**
 * Proper nouns that contain a style word but name a shop or a clothing brand.
 * "Tribal Rites" alone accounts for 6 of the 19 Tribal tags in the corpus.
 */
const PROPER_NOUN_COLLISIONS = [
  { style: 'Tribal', pattern: /\btribal\s+rites\b/i },   // tattoo shop (CO)
  { style: 'Tribal', pattern: /\btribal\s+gear\b/i },    // clothing brand
  { style: 'Tribal', pattern: /\btribal\s+member\b/i },  // tribal enrollment, not a style
];

/**
 * Drop style evidence the surrounding bio text disqualifies. Returns
 * { kept, rejected } so the harvester can report exactly what it removed —
 * a guard nobody can audit is worse than no guard.
 */
export function rejectSpuriousEvidence(bio, evidence) {
  const kept = [];
  const rejected = [];

  for (const hit of evidence) {
    const collision = PROPER_NOUN_COLLISIONS.find(
      (c) => c.style === hit.style && c.pattern.test(bio),
    );
    if (collision) {
      // Only reject when EVERY occurrence of the style word is inside the
      // collision phrase — "Polynesian tribal at Tribal Rites" is a real claim.
      const scrubbed = bio.replace(new RegExp(collision.pattern.source, 'gi'), ' ');
      const rule = STYLE_PATTERNS.find((r) => r.style === hit.style);
      if (!rule.pattern.test(scrubbed)) {
        rejected.push({ ...hit, reason: 'proper-noun-collision' });
        continue;
      }
    }

    if (typeof hit.index === 'number') {
      const before = bio.slice(Math.max(0, hit.index - NEGATION_WINDOW), hit.index);
      if (NEGATION_CUE.test(before)) {
        rejected.push({ ...hit, reason: 'negated' });
        continue;
      }
    }

    kept.push(hit);
  }

  return { kept, rejected };
}

/** Convenience wrapper: just the style names, in STYLE_PATTERNS order. */
export function stylesFromBio(bio) {
  return extractStyleEvidence(bio).map((h) => h.style);
}

/**
 * Artist ids are interpolated into nothing (always bound as parameters), but a
 * junk id is still a data-quality signal worth rejecting at the door. Matches
 * the scraper's `artist_<handle>` shape and host-artist-images.mjs's rule.
 */
export function isSafeArtistId(artistId) {
  return typeof artistId === 'string' && /^[A-Za-z0-9_.-]+$/.test(artistId) && artistId.length <= 200;
}

/**
 * Validate + normalize one { artistId, styles } row from a style artifact.
 * Every name is resolved through the ontology, so an artifact written under an
 * older spelling still lands on today's vocabulary ("Script" → "Lettering") and
 * casing is canonicalized. Names outside the controlled vocabulary are dropped.
 * Returns null when unusable.
 */
export function normalizeStyleRecord(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const artistId = raw.artistId;
  if (!isSafeArtistId(artistId)) return null;

  const seen = new Set();
  const styles = [];
  for (const s of Array.isArray(raw.styles) ? raw.styles : []) {
    const label = resolveOntologyLabel(s);
    if (!label || seen.has(label)) continue;
    seen.add(label);
    styles.push(label);
  }
  if (styles.length === 0) return null;

  return { artistId, styles };
}

/**
 * Flatten normalized records into the (artistId, style) pairs the graph stores.
 *
 * This is the seam where the artifact's ontology LABELS become the graph's own
 * node NAMES — the only names MERGE ever sees. A label with no graph spelling
 * is dropped rather than invented, so the import can never mint a Style node.
 */
export function toStylePairs(records) {
  const pairs = [];
  for (const rec of records) {
    for (const style of rec.styles) {
      const name = graphStyleName(style);
      if (!name) continue;
      pairs.push({ artistId: rec.artistId, style: name });
    }
  }
  return pairs;
}
