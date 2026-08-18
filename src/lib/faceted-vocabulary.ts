/**
 * The faceted vocabulary (ADR-0058), tier one and tier two.
 *
 * ## What this replaces, and what it does not
 *
 * `style-vocabulary.ts` answers one question — "is this string a style the
 * artist graph can match on?" — and answers it well. What it cannot do is hold
 * the *other* words a customer says. Session `0f6234e9` produced `blackwork`,
 * `punk`, `crying`, `hard dark lines` and `not a lot of detail`. Exactly one of
 * those is a style. Filed under a flat style list, the other four are either
 * discarded or — worse — smuggled into artist matching as unvetted style tags.
 *
 * So this module adds the two axes a flat list has no room for:
 *
 *   **Facet** — which dimension of the piece a term describes. `blackwork` is
 *   a style, `punk` is a mood, `hard dark lines` is linework, `not a lot of
 *   detail` is texture/detail. Same sentence, four different dimensions.
 *
 *   **Tier** — whether a term is *canonical* (closed, human-governed under
 *   ADR-0011, and the ONLY vocabulary artist matching runs on) or a
 *   *descriptor* (free text, faceted, steers prompt generation, never joins to
 *   an artist).
 *
 * The tier boundary is the load-bearing part. ADR-0058 rejected "free
 * descriptors treated as weak style tags for matching" explicitly, because
 * matching is where being wrong costs a real booking. The types here make a
 * descriptor structurally distinguishable from a canonical term, and
 * `assertCanonicalOnly` makes a leak throw rather than quietly degrade a match.
 *
 * ## What is deliberately absent
 *
 * - **Named relations.** `INSPIRED_BY`, `DEPICTS`, `USES_STYLE`,
 *   `HAS_CONSTRAINT`, `REJECTED_DESCRIPTOR` belong to the Idea graph
 *   (ADR-0055) and land with it. Nothing here creates a node or an edge.
 * - **Promotion.** Recurrence is *recorded* here so the review queue has
 *   something to read, but nothing in this module promotes a descriptor to
 *   canonical. ADR-0011 says a person does that, every time, through
 *   `scripts/propose-ontology-candidates.mjs`. Automatic promotion would
 *   override ADR-0011 by side effect, which ADR-0058 rejected by name.
 * - **Multi-facet canonical vocabulary.** `data/style-ontology.json` is a
 *   style list today, so the canonical tier currently has exactly one facet
 *   populated: `style`. ADR-0058 calls that migration "the first real
 *   implementation question" and leaves it open. `canonicalTerm()` is written
 *   for n facets and answers for one; when the ontology grows facets, the
 *   resolver grows a branch and no caller changes.
 */

import {
  canonicalStyleForTag,
  ontologyTagIdForStyle,
  resolveCanonicalStyle,
} from "./style-vocabulary";
import { VARIATION_AXIS_POOL, type VariationAxis } from "../services/intake/types";

/* ── Facets ──────────────────────────────────────────────────────────────── */

/**
 * The dimensions a term can describe. One per row of ADR-0058's table, in the
 * ADR's order; the ids are kebab-case handles, `FACET_LABELS` carries the
 * ADR's own wording so the two can be checked against each other.
 */
export const FACETS = [
  "style",
  "subject",
  "motif",
  "composition",
  "linework",
  "color",
  "texture",
  "mood",
  "placement",
  "scale",
  "constraint",
] as const;

export type Facet = (typeof FACETS)[number];

/** ADR-0058's wording for each facet, for UI and review-queue display. */
export const FACET_LABELS: Readonly<Record<Facet, string>> = {
  style: "style",
  subject: "subject / character",
  motif: "motif",
  composition: "composition",
  linework: "linework",
  color: "color",
  texture: "texture / detail",
  mood: "mood / action",
  placement: "placement",
  scale: "scale",
  constraint: "hard constraint",
};

const FACET_SET: ReadonlySet<string> = new Set(FACETS);

/** Is `value` one of the eleven facets? Narrows, so callers can validate input. */
export function isFacet(value: unknown): value is Facet {
  return typeof value === "string" && FACET_SET.has(value);
}

/* ── The axis ladder is the same vocabulary ──────────────────────────────── */

/**
 * Each variation axis (ADR-0012/ADR-0049) is a facet the reveal is deliberately
 * spreading. ADR-0058: "the axis ladder and the ontology are the same
 * vocabulary seen from two directions, and they should not drift into two
 * vocabularies."
 *
 * `literal-abstract` is filed under `mood` on the ADR's own reading — it lists
 * the fourth axis as "mood/abstraction" while the facet table's fourth row is
 * "mood / action". Those are one row, not two; there is no `abstraction` facet.
 *
 * This map is exhaustive over `VariationAxis` by its type, and a test pins it
 * exhaustive over `VARIATION_AXIS_POOL` by its value — so adding an axis
 * without giving it a facet fails, which is the drift the ADR is guarding.
 */
export const FACET_BY_AXIS: Readonly<Record<VariationAxis, Facet>> = {
  "bold-fine": "linework",
  "color-blackwork": "color",
  "minimal-ornate": "texture",
  "literal-abstract": "mood",
};

/** The facet a variation axis varies. */
export function facetForAxis(axis: VariationAxis): Facet {
  return FACET_BY_AXIS[axis];
}

/**
 * The axes that vary `facet` — empty for the seven facets no axis touches.
 *
 * This is the lookup ADR-0058 rejected unfaceted descriptors for not
 * supporting: it is what lets a caller notice that a descriptor reading
 * "simple linework" moves the same dimension the `bold-fine` axis is already
 * spreading. Detecting that contradiction is downstream work (the router,
 * ADR-0056); having the vocabulary able to express it is this module's job.
 */
export function axesForFacet(facet: Facet): VariationAxis[] {
  return VARIATION_AXIS_POOL.filter((axis) => FACET_BY_AXIS[axis] === facet);
}

/** The axes a term collides with, canonical or descriptor alike. */
export function conflictingAxes(term: FacetedTerm): VariationAxis[] {
  return axesForFacet(term.facet);
}

/* ── Tier one: canonical terms ───────────────────────────────────────────── */

/**
 * A term from the closed, human-governed vocabulary (ADR-0011). This is the
 * only thing artist matching is allowed to see.
 *
 * `label` is the product-facing spelling and the one matching queries with;
 * `id` is the ontology tag id it resolved to. Both come out of
 * `style-vocabulary.ts` rather than being re-derived here, so there is still
 * one vocabulary and not two.
 */
export interface CanonicalTerm {
  readonly tier: "canonical";
  readonly facet: Facet;
  /** Ontology tag id — e.g. "blackwork". */
  readonly id: string;
  /** Canonical display label — e.g. "Blackwork". */
  readonly label: string;
}

/**
 * Resolve raw text to a canonical term, or null when it is outside the closed
 * vocabulary.
 *
 * Null is the honest answer and callers must treat it as such: the term is not
 * canonical, so it does not go to matching. The caller's next move is
 * `describe()` — keep it as a descriptor, where it can steer a prompt without
 * touching an artist join.
 *
 * `facet` is a hint, not an override. Asking for `mood` gets null today
 * because the ontology has no mood tags; asking for `style` runs the ontology
 * resolver. A hint that disagrees with the vocabulary loses — ADR-0011 means a
 * caller cannot talk a term into the canonical tier.
 */
export function canonicalTerm(raw: string | null | undefined, facet: Facet = "style"): CanonicalTerm | null {
  if (facet !== "style") return null;
  const label = resolveCanonicalStyle(raw);
  if (!label) return null;
  const id = ontologyTagIdForStyle(label);
  return id ? { tier: "canonical", facet: "style", id, label } : null;
}

/**
 * Canonical term for an ontology tag id, following the ontology's `parent`
 * roll-up (`irezumi` → Japanese). Null when no ancestor is matchable — real
 * vocabulary the graph simply has no artists for, which is dropped rather than
 * guessed at (ADR-0011).
 */
export function canonicalTermForTag(tagId: string): CanonicalTerm | null {
  const label = canonicalStyleForTag(tagId);
  if (!label) return null;
  const id = ontologyTagIdForStyle(label);
  return id ? { tier: "canonical", facet: "style", id, label } : null;
}

/* ── Tier two: idea-level descriptors ────────────────────────────────────── */

/** The surfaces a turn can arrive on (ADR-0055: an Idea spans web and SMS). */
export type DescriptorChannel = "web" | "sms";

/**
 * Where a descriptor came from. ADR-0058 requires all three: without them a
 * descriptor is an unattributable adjective, and the review queue cannot tell
 * a customer's own word from something an agent invented about them.
 */
export interface DescriptorProvenance {
  /** 1-based turn index within the conversation the descriptor was said on. */
  readonly turn: number;
  /** Which agent recorded it — "intake", "council", "critique", "human". */
  readonly agent: string;
  readonly channel: DescriptorChannel;
}

/**
 * A free-text term that is faceted but not canonical.
 *
 * A descriptor steers prompt generation and nothing else. It is not a weak
 * style tag, it is not a candidate the system may promote on its own, and it
 * never appears in an artist query — see `assertCanonicalOnly`.
 */
export interface Descriptor {
  readonly tier: "descriptor";
  readonly facet: Facet;
  /** The customer's own words, whitespace-normalized and nothing else (ADR-0010). */
  readonly text: string;
  /** Lowercased `text`; the identity a descriptor recurs under. */
  readonly key: string;
  readonly provenance: DescriptorProvenance;
  /** 0–1. How sure the recorder is this is really a term and really this facet. */
  readonly confidence: number;
  /** How many times this descriptor has been said. Starts at 1. */
  readonly recurrence: number;
}

export type FacetedTerm = CanonicalTerm | Descriptor;

const DEFAULT_CONFIDENCE = 0.5;

function normalizeText(raw: string): string {
  return raw.trim().replace(/\s+/g, " ");
}

function clampConfidence(value: number | undefined): number {
  if (typeof value !== "number" || Number.isNaN(value)) return DEFAULT_CONFIDENCE;
  return Math.min(1, Math.max(0, value));
}

/**
 * Record a descriptor. Returns null for empty text or an unknown facet — a
 * descriptor with no facet is the thing ADR-0058 rejected, so there is no way
 * to make one.
 *
 * Note what this does NOT do: it does not check whether the text happens to be
 * a canonical term. "blackwork" is a perfectly legal descriptor — it means
 * someone said it, at a turn, with a confidence. Whether it also resolves
 * canonically is a separate question with a separate function, and conflating
 * them is how a descriptor ends up in a match query.
 */
export function describe(input: {
  facet: Facet;
  text: string;
  provenance: DescriptorProvenance;
  confidence?: number;
}): Descriptor | null {
  if (!isFacet(input.facet)) return null;
  const text = normalizeText(input.text ?? "");
  if (!text) return null;
  return {
    tier: "descriptor",
    facet: input.facet,
    text,
    key: text.toLowerCase(),
    provenance: input.provenance,
    confidence: clampConfidence(input.confidence),
    recurrence: 1,
  };
}

/**
 * Fold a descriptor into a list, merging with an existing one of the same
 * facet and text.
 *
 * Recurrence counts *sayings*, so a merge increments it. Provenance stays the
 * FIRST sighting — when this eventually reaches the ADR-0011 review queue, the
 * useful question is when a term entered the conversation, not when it was
 * last echoed. Confidence takes the maximum: the system got more sure, not
 * less, by hearing it again.
 *
 * Returns a new array; the input is never mutated.
 */
export function recordDescriptor(
  existing: readonly Descriptor[],
  incoming: Descriptor,
): Descriptor[] {
  const index = existing.findIndex(
    (entry) => entry.facet === incoming.facet && entry.key === incoming.key,
  );
  if (index === -1) return [...existing, incoming];
  const current = existing[index];
  const merged: Descriptor = {
    ...current,
    confidence: Math.max(current.confidence, incoming.confidence),
    recurrence: current.recurrence + incoming.recurrence,
  };
  const next = [...existing];
  next[index] = merged;
  return next;
}

/** Descriptors on one facet, most-recurrent first — the review queue's order. */
export function descriptorsByFacet(
  descriptors: readonly Descriptor[],
  facet: Facet,
): Descriptor[] {
  return descriptors
    .filter((entry) => entry.facet === facet)
    .sort((a, b) => b.recurrence - a.recurrence || a.key.localeCompare(b.key));
}

/* ── The tier boundary ───────────────────────────────────────────────────── */

export function isCanonicalTerm(term: FacetedTerm): term is CanonicalTerm {
  return term.tier === "canonical";
}

export function isDescriptor(term: FacetedTerm): term is Descriptor {
  return term.tier === "descriptor";
}

/**
 * Thrown when a descriptor reaches somewhere only canonical vocabulary may go.
 *
 * Loud on purpose. The quiet version of this failure is a descriptor scoring
 * as a weak style tag and shifting a recommendation nobody can explain, which
 * ADR-0058 rejected outright. A thrown error at the boundary is recoverable;
 * a silently degraded match is not detectable at all.
 */
export class DescriptorLeakError extends Error {
  readonly leaked: readonly Descriptor[];

  constructor(leaked: readonly Descriptor[], context: string) {
    const listed = leaked.map((d) => `${d.facet}:"${d.text}"`).join(", ");
    super(
      `[faceted-vocabulary] ${leaked.length} descriptor(s) reached ${context}, which is ` +
        `canonical-only (ADR-0058): ${listed}. Descriptors steer prompts; they never join ` +
        "artists. Filter with matchingVocabulary() before this point.",
    );
    this.name = "DescriptorLeakError";
    this.leaked = leaked;
  }
}

/**
 * The sanctioned way to get vocabulary into artist matching: canonical terms
 * only, descriptors dropped, order preserved, duplicates collapsed by id.
 *
 * Dropping rather than throwing is right *here* — a mixed list is the normal
 * shape of an Idea's vocabulary, and asking every caller to pre-split it is
 * how the split gets skipped. Use `assertCanonicalOnly` at the point where a
 * descriptor would already be a bug.
 */
export function matchingVocabulary(terms: readonly FacetedTerm[]): CanonicalTerm[] {
  const seen = new Set<string>();
  const out: CanonicalTerm[] = [];
  for (const term of terms) {
    if (!isCanonicalTerm(term)) continue;
    if (seen.has(term.id)) continue;
    seen.add(term.id);
    out.push(term);
  }
  return out;
}

/** The style labels `matchingVocabulary` yields — what a match query is sent. */
export function matchingStyleLabels(terms: readonly FacetedTerm[]): string[] {
  return matchingVocabulary(terms)
    .filter((term) => term.facet === "style")
    .map((term) => term.label);
}

/**
 * Throw unless every term is canonical.
 *
 * Call this at an artist-matching entry point. It is the tripwire for the
 * invariant most likely to be broken later by a well-meaning change — someone
 * widens a parameter type, descriptors flow in, and matching degrades with no
 * test failing. This makes that change fail immediately and say why.
 *
 * `context` names the boundary, so the message points at the caller rather
 * than at this file.
 */
export function assertCanonicalOnly(
  terms: readonly FacetedTerm[],
  context: string,
): asserts terms is readonly CanonicalTerm[] {
  const leaked = terms.filter(isDescriptor);
  if (leaked.length > 0) throw new DescriptorLeakError(leaked, context);
}

/* ── Fitting the design state object (ADR-0060) ──────────────────────────── */

/**
 * Which facet each `DesignState` field carries.
 *
 * The state object (ADR-0060) landed before this vocabulary did, and it is
 * already faceted — it just says so in field names instead of in a facet
 * column. `palette` is the color facet; `composition` is composition;
 * `visualTarget` is texture/detail; `action` is mood/action; `medium` carries
 * placement; `roster` and `identities` are subject; `exclusions` are hard
 * constraints.
 *
 * `directives` is the exception and is the interesting one: it is free text
 * that resolved to no field, which is precisely the unfaceted bag ADR-0058
 * rejected. Those are descriptors that have not been faceted yet, which is why
 * this map leaves them null rather than inventing a facet for them. Faceting
 * the directive stream is follow-up work and belongs with ADR-0056's router.
 *
 * Nothing here changes `designState.ts` behavior. It exists so the two models
 * are provably the same one, and so a field added on either side without a
 * counterpart is visible.
 */
export const FACET_BY_STATE_FIELD: Readonly<Record<string, Facet | null>> = {
  roster: "subject",
  identities: "subject",
  medium: "placement",
  composition: "composition",
  aspect: "composition",
  palette: "color",
  visualTarget: "texture",
  action: "mood",
  exclusions: "constraint",
  directives: null,
};
