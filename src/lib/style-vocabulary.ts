/**
 * The one style vocabulary (ADR-0010, ADR-0011).
 *
 * Two checked-in data files decide it, and nothing else may hardcode a style
 * name:
 *
 *   data/style-ontology.json          the closed, human-curated vocabulary —
 *                                     tag id, display label, and the aliases
 *                                     that absorb spelling drift.
 *   data/graph-style-vocabulary.json  which of those tags the live artist
 *                                     graph can actually answer with, plus the
 *                                     graph's own spelling of each. Generated
 *                                     read-only by
 *                                     scripts/sync-graph-style-vocabulary.mjs.
 *
 * Deriving the list from those two files is the fix for a class of bug, not
 * one bug: a hand-typed style list drifts from the graph and the filter dies
 * silently. Before this module, /matches offered "Script" (no such node),
 * "Japanese" (a node with zero artists — the 434 artists sit on "Japanese
 * (Irezumi)") and "Minimalist" (zero artists), while "New School" and
 * "Ornamental" had 283 artists between them and no way to reach them.
 *
 * Both invariants are enforced by style-vocabulary.test.ts, which reads these
 * same files rather than a copy — so a new ontology tag or a re-synced graph
 * cannot quietly reintroduce a dead filter.
 *
 * Plain JSON imports keep this module client-safe (the /smart-match
 * pills are client components; no node:fs here).
 */

import ontology from "../../data/style-ontology.json";
import graphVocabulary from "../../data/graph-style-vocabulary.json";

interface OntologyTag {
  id: string;
  label: string;
  aliases?: string[];
  /** Sub-style roll-up: "irezumi" → "japanese", "manga" → "anime". */
  parent?: string;
}

/** Every ontology tag, by id. */
const TAG_BY_ID = new Map<string, OntologyTag>(
  (ontology.tags as OntologyTag[]).map((t) => [t.id, t]),
);

/**
 * Matchable styles, biggest artist pool first — the pill order users see.
 * Each entry pairs the product-facing label with every spelling the graph
 * uses for it.
 */
const MATCHABLE = [...graphVocabulary.styles]
  .sort((a, b) => b.artists - a.artists)
  .map((entry) => {
    const tag = TAG_BY_ID.get(entry.tag);
    if (!tag) {
      // The sync script only emits tags it resolved against this same
      // ontology, so this means the two data files were committed out of
      // step. Fail loudly at import rather than serving a dead filter.
      throw new Error(
        `[style-vocabulary] graph style tag "${entry.tag}" is not in data/style-ontology.json — ` +
          "re-run scripts/sync-graph-style-vocabulary.mjs",
      );
    }
    return { id: tag.id, label: tag.label, graphNames: entry.graphNames };
  });

/**
 * The style names the UI may offer and the API may be sent. Every one of
 * these is backed by at least one artist in the live graph.
 */
export const CANONICAL_STYLES = MATCHABLE.map((s) => s.label) as readonly string[] as readonly [
  string,
  ...string[],
];

export type CanonicalStyle = string;

/** Ontology tag id for a canonical label (e.g. "Japanese" → "japanese"). */
const TAG_ID_BY_LABEL = new Map(MATCHABLE.map((s) => [s.label.toLowerCase(), s.id]));

/**
 * Every lowercase spelling that should count as a match for a canonical
 * style: the label, the ontology id, its aliases, and the graph's own node
 * names. This is what lets the UI send "Japanese" and still match artists
 * stored under "Japanese (Irezumi)" — without renaming anything in the graph.
 */
const VARIANTS_BY_LABEL = new Map<string, string[]>(
  MATCHABLE.map((style) => {
    const tag = TAG_BY_ID.get(style.id)!;
    const variants = new Set<string>();
    variants.add(style.id);
    variants.add(style.label.toLowerCase());
    for (const alias of tag.aliases ?? []) variants.add(alias.toLowerCase());
    for (const name of style.graphNames) variants.add(name.toLowerCase());
    return [style.label.toLowerCase(), [...variants]];
  }),
);

/**
 * Lowercase spellings that match `style` in the graph. Unknown styles return
 * an empty list, which callers must treat as "matches nothing" — never as
 * "matches everything".
 */
export function styleMatchVariants(style: string): string[] {
  return VARIANTS_BY_LABEL.get(style.trim().toLowerCase()) ?? [];
}

/**
 * Resolve any spelling of a style — ontology id, alias, graph node name, or
 * display label, in any casing — to its canonical label. Returns null when
 * the term is outside the vocabulary; callers drop it rather than guess
 * (ADR-0011: nothing enters the vocabulary unreviewed).
 */
export function resolveCanonicalStyle(raw: string | null | undefined): CanonicalStyle | null {
  if (typeof raw !== "string") return null;
  const needle = raw.trim().toLowerCase();
  if (!needle) return null;
  if (TAG_ID_BY_LABEL.has(needle)) {
    return MATCHABLE.find((s) => s.label.toLowerCase() === needle)!.label;
  }
  for (const [label, variants] of VARIANTS_BY_LABEL) {
    if (variants.includes(needle)) {
      return MATCHABLE.find((s) => s.label.toLowerCase() === label)!.label;
    }
  }
  return null;
}

/**
 * Ontology tag id → the canonical label matching should use for it, following
 * the ontology's `parent` roll-up for sub-styles the graph does not carry as
 * their own Style node ("irezumi" → Japanese, "manga" → Anime, "dotwork" →
 * Blackwork, "portrait" → Realism, "americana" → Traditional).
 *
 * Returns null for a tag with no matchable ancestor — "abstract", "color",
 * "lettering" and friends are real vocabulary the artist graph simply has no
 * artists for. Dropping is the honest answer; guessing a nearest neighbour is
 * exactly the silent drift ADR-0011 rejects.
 */
export function canonicalStyleForTag(tagId: string): CanonicalStyle | null {
  const seen = new Set<string>();
  let current: string | undefined = tagId;
  while (current && !seen.has(current)) {
    seen.add(current);
    const label = MATCHABLE.find((s) => s.id === current)?.label;
    if (label) return label;
    current = TAG_BY_ID.get(current)?.parent;
  }
  return null;
}

/**
 * The ontology tag id behind a canonical label ("Black & Grey" →
 * "black-and-grey"). Null for anything that is not a canonical label.
 *
 * Exported so callers can carry the id alongside the label without deriving
 * one by slugifying the label — that derivation works today and silently stops
 * working the first time a tag's id and label diverge, which is exactly the
 * drift this module exists to prevent.
 */
export function ontologyTagIdForStyle(label: string | null | undefined): string | null {
  if (typeof label !== "string") return null;
  return TAG_ID_BY_LABEL.get(label.trim().toLowerCase()) ?? null;
}

/** Every ontology tag id, matchable or not — the closed vocabulary itself. */
export const ONTOLOGY_TAG_IDS: readonly string[] = ontology.tags.map((t) => t.id);
