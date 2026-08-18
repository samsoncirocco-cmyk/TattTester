/**
 * The tier boundary, pinned hard (ADR-0058).
 *
 * ADR-0058 rejected "free descriptors treated as weak style tags for matching"
 * by name, "because it degrades matching with unvetted vocabulary, and matching
 * is where being wrong costs a real booking." That is a decision nothing in the
 * type system can enforce on its own — a widened parameter, a `string[]` where
 * a `CanonicalTerm[]` was meant, and descriptors flow into an artist query with
 * no test failing and no output visibly wrong.
 *
 * So the descriptor tests here do not stop at this module's own functions. They
 * run the real vocabulary of session `0f6234e9` through the actual matching
 * primitives — `styleMatchVariants` (what `neo4jService.findMatchingArtists`
 * calls) and `buildRosterFilter` (what `/artists` calls) — and assert the
 * descriptors reach nothing.
 *
 * The other thing pinned here is drift. ADR-0058: the axis ladder and the
 * ontology "are the same vocabulary seen from two directions, and they should
 * not drift into two vocabularies." Adding a variation axis without giving it a
 * facet fails below.
 */
import { describe, it, expect } from "vitest";
import {
  FACETS,
  FACET_LABELS,
  FACET_BY_AXIS,
  FACET_BY_STATE_FIELD,
  DescriptorLeakError,
  assertCanonicalOnly,
  axesForFacet,
  canonicalTerm,
  canonicalTermForTag,
  conflictingAxes,
  describe as describeTerm,
  descriptorsByFacet,
  facetForAxis,
  isCanonicalTerm,
  isDescriptor,
  isFacet,
  matchingStyleLabels,
  matchingVocabulary,
  recordDescriptor,
  type Descriptor,
  type DescriptorProvenance,
  type FacetedTerm,
} from "./faceted-vocabulary";
import { CANONICAL_STYLES, ONTOLOGY_TAG_IDS, styleMatchVariants } from "./style-vocabulary";
import { buildRosterFilter } from "./artists-graph";
import { VARIATION_AXIS_POOL, ROUND_AXIS_LADDER } from "../services/intake/types";

const PROVENANCE: DescriptorProvenance = { turn: 3, agent: "intake", channel: "web" };

/**
 * The words session `0f6234e9` actually produced. One of the five is a style;
 * ADR-0058 exists because the other four had nowhere to go.
 */
const SESSION_0F6234E9: FacetedTerm[] = [
  canonicalTerm("blackwork")!,
  describeTerm({ facet: "mood", text: "punk", provenance: PROVENANCE })!,
  describeTerm({ facet: "mood", text: "crying", provenance: PROVENANCE })!,
  describeTerm({ facet: "linework", text: "hard dark lines", provenance: PROVENANCE })!,
  describeTerm({ facet: "texture", text: "not a lot of detail", provenance: PROVENANCE })!,
  describeTerm({ facet: "subject", text: "Nelson Muntz", provenance: PROVENANCE })!,
  describeTerm({
    facet: "constraint",
    text: "must not clash with greek myth work",
    provenance: PROVENANCE,
  })!,
];

const descriptorsOf = (terms: readonly FacetedTerm[]): Descriptor[] => terms.filter(isDescriptor);

describe("the facets themselves", () => {
  it("carries every row of ADR-0058's table, and no extras", () => {
    expect([...FACETS]).toEqual([
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
    ]);
  });

  it("labels every facet in the ADR's own wording", () => {
    for (const facet of FACETS) {
      expect(FACET_LABELS[facet], `facet "${facet}" has no label`).toBeTruthy();
    }
    expect(Object.keys(FACET_LABELS).sort()).toEqual([...FACETS].sort());
  });

  it("narrows only real facets", () => {
    expect(isFacet("linework")).toBe(true);
    expect(isFacet("Linework")).toBe(false);
    expect(isFacet("abstraction")).toBe(false);
    expect(isFacet(null)).toBe(false);
  });
});

describe("the axis ladder and the vocabulary are one vocabulary", () => {
  it("gives every variation axis a facet — an axis with none is the drift ADR-0058 forbids", () => {
    expect(Object.keys(FACET_BY_AXIS).sort()).toEqual([...VARIATION_AXIS_POOL].sort());
    for (const axis of VARIATION_AXIS_POOL) {
      expect(isFacet(FACET_BY_AXIS[axis]), `axis "${axis}" has no facet`).toBe(true);
    }
  });

  it("maps the four axes exactly as ADR-0058 reads them", () => {
    expect(facetForAxis("bold-fine")).toBe("linework");
    expect(facetForAxis("color-blackwork")).toBe("color");
    expect(facetForAxis("minimal-ornate")).toBe("texture");
    expect(facetForAxis("literal-abstract")).toBe("mood");
  });

  it("covers the whole round ladder, so no round varies an unfaceted dimension", () => {
    for (const axis of ROUND_AXIS_LADDER) {
      expect(isFacet(FACET_BY_AXIS[axis]), `ladder rung "${axis}" has no facet`).toBe(true);
    }
  });

  it("finds the axis a term collides with — the lookup an unfaceted bag cannot do", () => {
    const linework = describeTerm({
      facet: "linework",
      text: "simple linework",
      provenance: PROVENANCE,
    })!;
    // ADR-0058's example: this descriptor moves the same dimension `bold-fine`
    // is already spreading, and the router has to be able to see that.
    expect(conflictingAxes(linework)).toEqual(["bold-fine"]);
    expect(axesForFacet("color")).toEqual(["color-blackwork"]);
  });

  it("returns no axes for the seven facets no axis varies", () => {
    for (const facet of ["style", "subject", "motif", "composition", "placement", "scale", "constraint"] as const) {
      expect(axesForFacet(facet), `facet "${facet}" unexpectedly has an axis`).toEqual([]);
    }
  });
});

describe("canonical terms — tier one, closed and human-governed (ADR-0011)", () => {
  it("resolves a real style through the ontology, carrying id and label", () => {
    const term = canonicalTerm("blackwork");
    expect(term).toEqual({ tier: "canonical", facet: "style", id: "blackwork", label: "Blackwork" });
    expect(isCanonicalTerm(term!)).toBe(true);
  });

  it("resolves aliases and graph spellings, because there is one vocabulary", () => {
    expect(canonicalTerm("black work")?.label).toBe("Blackwork");
    expect(canonicalTerm("  BLACKWORK ")?.label).toBe("Blackwork");
  });

  it("refuses to canonicalize anything outside the ontology", () => {
    for (const outsider of ["punk", "crying", "hard dark lines", "not a lot of detail", ""]) {
      expect(canonicalTerm(outsider), `"${outsider}" must not be canonical`).toBeNull();
    }
  });

  it("cannot be talked into a non-style facet — a caller does not grow the vocabulary", () => {
    // The ontology is style-only today. A hint asking for `mood` gets null even
    // for a word that is a real style, rather than minting a mood term.
    expect(canonicalTerm("blackwork", "mood")).toBeNull();
    expect(canonicalTerm("punk", "mood")).toBeNull();
  });

  it("only ever emits ids the ontology actually contains", () => {
    const ids = new Set(ONTOLOGY_TAG_IDS);
    for (const label of CANONICAL_STYLES) {
      const term = canonicalTerm(label);
      expect(term, `canonical style "${label}" did not resolve`).not.toBeNull();
      expect(ids, `"${label}" resolved to id "${term!.id}", not an ontology tag`).toContain(term!.id);
    }
  });

  it("follows the ontology's parent roll-up for sub-styles", () => {
    expect(canonicalTermForTag("irezumi")?.label).toBe(canonicalTermForTag("japanese")?.label);
    // Real vocabulary with no artists behind it is dropped, never guessed.
    expect(canonicalTermForTag("not-a-tag")).toBeNull();
  });
});

describe("descriptors — tier two, free text with a facet", () => {
  it("records provenance, confidence and recurrence, per ADR-0058", () => {
    const d = describeTerm({
      facet: "mood",
      text: "  punk  ",
      provenance: PROVENANCE,
      confidence: 0.8,
    })!;
    expect(d).toMatchObject({
      tier: "descriptor",
      facet: "mood",
      text: "punk",
      key: "punk",
      confidence: 0.8,
      recurrence: 1,
    });
    expect(d.provenance).toEqual({ turn: 3, agent: "intake", channel: "web" });
    expect(isDescriptor(d)).toBe(true);
  });

  it("cannot be made without a facet — the unfaceted bag ADR-0058 rejected", () => {
    // @ts-expect-error a facet outside the eleven is not a Facet
    expect(describeTerm({ facet: "vibes", text: "punk", provenance: PROVENANCE })).toBeNull();
    expect(describeTerm({ facet: "mood", text: "   ", provenance: PROVENANCE })).toBeNull();
  });

  it("clamps confidence and defaults it rather than trusting a caller's number", () => {
    const mk = (confidence?: number) =>
      describeTerm({ facet: "mood", text: "punk", provenance: PROVENANCE, confidence })!.confidence;
    expect(mk(2)).toBe(1);
    expect(mk(-1)).toBe(0);
    expect(mk(Number.NaN)).toBe(0.5);
    expect(mk(undefined)).toBe(0.5);
  });

  it("lets a canonical word also be a descriptor — they are different claims", () => {
    // "someone said blackwork on turn 3" and "blackwork is in the ontology"
    // are separate facts. Conflating them is how a descriptor reaches a join.
    const said = describeTerm({ facet: "style", text: "blackwork", provenance: PROVENANCE })!;
    expect(said.tier).toBe("descriptor");
    expect(canonicalTerm(said.text)?.tier).toBe("canonical");
  });

  it("counts recurrence on repeat, keeps first provenance, takes the higher confidence", () => {
    const first = describeTerm({
      facet: "mood",
      text: "punk",
      provenance: { turn: 1, agent: "intake", channel: "web" },
      confidence: 0.4,
    })!;
    const echoed = describeTerm({
      facet: "mood",
      text: "Punk",
      provenance: { turn: 9, agent: "critique", channel: "sms" },
      confidence: 0.9,
    })!;
    const list = recordDescriptor(recordDescriptor([], first), echoed);
    expect(list).toHaveLength(1);
    expect(list[0].recurrence).toBe(2);
    expect(list[0].confidence).toBe(0.9);
    expect(list[0].provenance.turn).toBe(1);
  });

  it("keeps the same word on two facets apart", () => {
    const a = describeTerm({ facet: "mood", text: "sharp", provenance: PROVENANCE })!;
    const b = describeTerm({ facet: "linework", text: "sharp", provenance: PROVENANCE })!;
    expect(recordDescriptor(recordDescriptor([], a), b)).toHaveLength(2);
  });

  it("never mutates the list it folds into", () => {
    const start = [describeTerm({ facet: "mood", text: "punk", provenance: PROVENANCE })!];
    const next = recordDescriptor(start, describeTerm({ facet: "mood", text: "punk", provenance: PROVENANCE })!);
    expect(start[0].recurrence).toBe(1);
    expect(next[0].recurrence).toBe(2);
  });

  it("orders a facet's descriptors most-recurrent first — the review queue's order", () => {
    let list: Descriptor[] = [];
    list = recordDescriptor(list, describeTerm({ facet: "mood", text: "crying", provenance: PROVENANCE })!);
    list = recordDescriptor(list, describeTerm({ facet: "mood", text: "punk", provenance: PROVENANCE })!);
    list = recordDescriptor(list, describeTerm({ facet: "mood", text: "punk", provenance: PROVENANCE })!);
    list = recordDescriptor(list, describeTerm({ facet: "linework", text: "hard dark lines", provenance: PROVENANCE })!);
    expect(descriptorsByFacet(list, "mood").map((d) => d.text)).toEqual(["punk", "crying"]);
    expect(descriptorsByFacet(list, "scale")).toEqual([]);
  });

  it("does not promote anything — promotion is a person's call (ADR-0011)", () => {
    let list: Descriptor[] = [];
    for (let turn = 0; turn < 50; turn++) {
      list = recordDescriptor(list, describeTerm({ facet: "mood", text: "punk", provenance: PROVENANCE })!);
    }
    expect(list[0].recurrence).toBe(50);
    // Fifty sightings still does not make it canonical.
    expect(canonicalTerm("punk")).toBeNull();
    expect(list[0].tier).toBe("descriptor");
  });
});

describe("THE TIER BOUNDARY — a descriptor must never reach artist matching", () => {
  it("hands matching the canonical terms only", () => {
    const matchable = matchingVocabulary(SESSION_0F6234E9);
    expect(matchable.map((t) => t.label)).toEqual(["Blackwork"]);
    expect(matchable.every(isCanonicalTerm)).toBe(true);
    expect(matchingStyleLabels(SESSION_0F6234E9)).toEqual(["Blackwork"]);
  });

  it("collapses duplicate canonical terms without collapsing the tiers", () => {
    const terms = [canonicalTerm("blackwork")!, canonicalTerm("black work")!, ...descriptorsOf(SESSION_0F6234E9)];
    expect(matchingVocabulary(terms)).toHaveLength(1);
  });

  it("hands matching nothing at all when the vocabulary is all descriptors", () => {
    // The failure this guards is the tempting one: six good words about the
    // tattoo, none of them canonical, and a matcher that would rather match on
    // something than on nothing.
    expect(matchingVocabulary(descriptorsOf(SESSION_0F6234E9))).toEqual([]);
    expect(matchingStyleLabels(descriptorsOf(SESSION_0F6234E9))).toEqual([]);
  });

  it("throws loudly when a descriptor reaches a canonical-only boundary", () => {
    expect(() => assertCanonicalOnly(SESSION_0F6234E9, "findMatchingArtists")).toThrow(DescriptorLeakError);
    try {
      assertCanonicalOnly(SESSION_0F6234E9, "findMatchingArtists");
      expect.unreachable("assertCanonicalOnly must throw on a leak");
    } catch (error) {
      const leak = error as DescriptorLeakError;
      expect(leak.name).toBe("DescriptorLeakError");
      expect(leak.leaked).toHaveLength(6);
      // The message has to name the boundary and the offending words, or the
      // person reading the stack trace learns nothing.
      expect(leak.message).toContain("findMatchingArtists");
      expect(leak.message).toContain('mood:"punk"');
      expect(leak.message).toContain("ADR-0058");
    }
  });

  it("passes a purely canonical vocabulary through the guard", () => {
    expect(() => assertCanonicalOnly(matchingVocabulary(SESSION_0F6234E9), "findMatchingArtists")).not.toThrow();
    expect(() => assertCanonicalOnly([], "findMatchingArtists")).not.toThrow();
  });

  /**
   * The two above test this module. These two test the actual matching
   * primitives, which is where the invariant either holds or does not.
   */
  it("produces no graph match variants for any descriptor — `styleMatchVariants` sees nothing", () => {
    for (const descriptor of descriptorsOf(SESSION_0F6234E9)) {
      expect(
        styleMatchVariants(descriptor.text),
        `descriptor "${descriptor.text}" resolved to graph variants — it would join artists`,
      ).toEqual([]);
    }
    // The canonical one does, which is what makes the assertion above mean
    // something rather than being true of every string.
    expect(styleMatchVariants(matchingStyleLabels(SESSION_0F6234E9)[0]).length).toBeGreaterThan(0);
  });

  it("fails the roster filter closed for a descriptor, and open for a canonical term", () => {
    for (const descriptor of descriptorsOf(SESSION_0F6234E9)) {
      const { params } = buildRosterFilter({ style: descriptor.text });
      expect(
        params.styleVariants,
        `descriptor "${descriptor.text}" produced roster style variants`,
      ).toEqual([]);
    }
    const canonical = buildRosterFilter({ style: matchingStyleLabels(SESSION_0F6234E9)[0] });
    expect(canonical.params.styleVariants.length).toBeGreaterThan(0);
  });

  it("keeps every descriptor — dropping them from matching is not dropping them", () => {
    // ADR-0058's complaint about the flat list is that it *discards* the
    // brief. The tier boundary must not reintroduce that.
    expect(descriptorsOf(SESSION_0F6234E9).map((d) => d.text)).toEqual([
      "punk",
      "crying",
      "hard dark lines",
      "not a lot of detail",
      "Nelson Muntz",
      "must not clash with greek myth work",
    ]);
  });
});

describe("fitting the design state object (ADR-0060)", () => {
  it("gives every state field a facet, or says plainly that it has none", () => {
    for (const [field, facet] of Object.entries(FACET_BY_STATE_FIELD)) {
      if (facet === null) continue;
      expect(isFacet(facet), `state field "${field}" maps to "${facet}", not a facet`).toBe(true);
    }
  });

  it("leaves `directives` unfaceted, because that is what it honestly is", () => {
    // Free text that resolved to no field is the unfaceted bag ADR-0058
    // rejected. Naming a facet for it here would be a guess dressed as a fact.
    expect(FACET_BY_STATE_FIELD.directives).toBeNull();
  });

  it("agrees with the state object's own reading of its fields", () => {
    expect(FACET_BY_STATE_FIELD.palette).toBe("color");
    expect(FACET_BY_STATE_FIELD.exclusions).toBe("constraint");
    expect(FACET_BY_STATE_FIELD.roster).toBe("subject");
    expect(FACET_BY_STATE_FIELD.action).toBe("mood");
  });
});
