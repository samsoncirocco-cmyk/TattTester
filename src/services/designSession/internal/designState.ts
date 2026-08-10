/**
 * The design's state object (ADR-0060).
 *
 * Every render builds from the whole object. A critique updates a field and
 * triggers a regeneration from the complete state — it never appends to the
 * previous prompt.
 *
 * ## Why this file exists
 *
 * Session 2026-08-05 asked for "a kingdom hearts sleeve with roxas and sora
 * fight link from zelda and boswer from mario" and got back two of the four
 * characters. It asked for a 9:11 crop of *the totem* and got a re-cut of *the
 * run*. It asked three times for "an unreal engine 5 look" and never got one.
 * Three failures, one cause: nothing held the design, so every turn was
 * interpreted against the last prompt instead of against the brief.
 *
 * `adjustPromptForCritique` built `${target.prompt} Requested change: "..."`.
 * Its own comment said "a critique adds, it does not replace" — which is the
 * flaw. The prompt only grew, contradictions piled up at the tail, and
 * `structuredMode` documents that the lane weights the front of a prompt far
 * more heavily than the end. So the earliest wording won and every later
 * correction was structurally disadvantaged.
 *
 * Here a critique resolves to a *field*. Setting `visualTarget` twice leaves
 * one value, not two competing sentences, and the second one is the one that
 * renders. That is the whole difference.
 *
 * ## Scope of this slice, stated plainly
 *
 * The state object lives on the session. ADR-0060 calls it "the ADR-0055 Idea
 * made concrete" — but there is no Idea object yet, so the session is where it
 * sits until the graph work lands and it moves up a level. Nothing here
 * assumes the session is its permanent home.
 *
 * The REVEAL prompt is still the Council's (`structuredMode`). This module
 * owns the RE-CUT prompt, which is where the failures above happened.
 * Unifying the reveal onto `renderStatePrompt` is deliberate follow-up work,
 * not an oversight — the Council's prompt carries axis-pole divergence this
 * object has no fields for yet.
 */

import type { IntakeRecord } from '../../intake/types';
import type { Variation } from '../types';

/* ── The object ──────────────────────────────────────────────────────────── */

/**
 * The whole state of one design. Fields are ADR-0060's, named as it named
 * them.
 *
 * Optional means "not established yet" and renders as nothing — never as a
 * guess. A field the system could not fill is a field it should ask about,
 * which is why there is no default for `visualTarget` or `action`.
 */
export interface DesignState {
  /**
   * Every character the customer named, in their mention order.
   *
   * **Non-negotiable once given.** Dropping one is a defect, not a paraphrase.
   * No critique in this module removes a name from this array; a customer
   * saying "you dropped some of the characters" needs no state change at all,
   * because regenerating from state already carries all of them. That turn
   * costing a render was the bug.
   */
  roster: string[];
  /** Verified character-to-source bindings, parallel to but not the same as `roster`. */
  identities: { name: string; series: string }[];
  /** "tattoo sleeve", "tattoo on the forearm" — the piece and where it sits. */
  medium: string;
  /**
   * The chosen composition, once one is chosen — "totem", "the clash".
   * A picked cut's composition becomes state and stays attached to every
   * re-cut after it. It is not a passing comment about one image.
   */
  composition?: string;
  /** Render aspect ratio as the customer said it — "9:11". */
  aspect?: string;
  /** "full color", "blackwork, no color". */
  palette?: string;
  /**
   * What the piece should look like, in concrete controls rather than a style
   * word. "unreal engine 5" is not stored here; what it translates to is.
   */
  visualTarget?: string;
  /** What the figures are doing — "mid-combat". */
  action?: string;
  /**
   * What must not appear. Grows from style translations and from negative
   * critiques ("no flat cel-shaded outlines", "not a lot of detail").
   * Deduplicated, because the same exclusion arriving twice is one exclusion.
   */
  exclusions: string[];
  /**
   * Customer directions that resolved to no other field, newest first, in
   * their own words (ADR-0010).
   *
   * This is NOT the old prompt tail under a new name. Two things make it
   * different, and both matter: it renders near the FRONT of the prompt where
   * the lane actually weights it, and newest-first ordering means a later
   * direction outranks an earlier one instead of being buried behind it.
   * Capped, so a long session cannot silt up the prompt.
   */
  directives: string[];
}

/** How many free-text directives a state carries before the oldest fall off. */
export const MAX_DIRECTIVES = 3;

/* ── Deriving the first state ────────────────────────────────────────────── */

const SLEEVE_PATTERN = /\bsleeve\b/i;

/** Style tags that mean the piece has no chromatic color. */
const MONOCHROME_TAGS = new Set([
  'blackwork',
  'black-and-grey',
  'black and grey',
  'blackandgrey',
  'linework',
  'fineline',
  'fine-line',
  'dotwork',
  'tribal',
]);

function derivePalette(styleTags: readonly string[]): string | undefined {
  if (styleTags.length === 0) return undefined;
  const monochrome = styleTags.some((tag) => MONOCHROME_TAGS.has(tag.toLowerCase().trim()));
  return monochrome ? 'blackwork, no color' : 'full color';
}

function deriveMedium(placement: string, meaning: string): string {
  const place = (placement || '').trim();
  if (SLEEVE_PATTERN.test(place) || SLEEVE_PATTERN.test(meaning || '')) {
    return place ? `tattoo sleeve on the ${place}` : 'tattoo sleeve';
  }
  return place ? `tattoo on the ${place}` : 'tattoo';
}

/**
 * The state a session starts with, read off its intake.
 *
 * `visualTarget` and `action` are deliberately left empty even though intake
 * has prose that could be squeezed into them. A guessed field renders as
 * confidently as a known one, and the failing session's whole problem was the
 * system being confident about things nobody told it.
 */
export function deriveDesignState(intake: IntakeRecord): DesignState {
  const identities = (intake.characterIdentities ?? []).map((identity) => ({
    name: identity.name,
    series: identity.series,
  }));
  const roster =
    intake.requestedCharacters && intake.requestedCharacters.length > 0
      ? [...intake.requestedCharacters]
      : identities.map((identity) => identity.name);

  return {
    roster,
    identities,
    medium: deriveMedium(intake.placement, intake.meaning),
    palette: derivePalette(intake.styleTags),
    exclusions: [],
    directives: [],
  };
}

/**
 * Fold a picked cut into the state: its composition becomes the design's
 * composition (ADR-0060 — "a chosen composition becomes state").
 *
 * Only the compositional axis is read. The bold/fine and color axes are the
 * round ladder's business (ADR-0049) and the Council already holds them; the
 * state object would only fight it for ownership.
 */
export function withPickedCut(state: DesignState, cut: Pick<Variation, 'axisPosition'>): DesignState {
  const composition = cut.axisPosition?.composition;
  if (!composition) return state;
  return { ...state, composition };
}

/* ── Style words → concrete controls ─────────────────────────────────────── */

/**
 * A style word is a request the system has to translate, not an adjective to
 * paste on the end of a prompt (ADR-0060).
 *
 * "unreal engine 5" pasted verbatim is three words at the tail of a 400-word
 * prompt, weighted near zero. Translated it is five concrete controls and one
 * exclusion, and it renders. The session that asked three times and never got
 * it is the evidence.
 *
 * An untranslated style word does NOT get pasted. It comes back as
 * `unresolvedStyle` so the caller can ask, because a field we failed to fill
 * is worth one question and is not worth a paid render of a guess.
 */
const STYLE_TRANSLATIONS: readonly {
  pattern: RegExp;
  target: string;
  exclusions: string[];
}[] = [
  {
    pattern: /\bunreal engine(?:\s*5)?\b|\bue\s*5\b|\bue5\b/i,
    target:
      'physically based materials, cinematic lighting, realistic 3D anatomy, ' +
      'volumetric effects, and detailed surfaces',
    exclusions: ['flat cel-shaded outlines'],
  },
  {
    pattern: /\bphoto-?realistic\b|\bphoto-?real\b|\bhyper-?realistic\b/i,
    target: 'photographic realism — accurate anatomy, true-to-life texture, natural lighting',
    exclusions: ['stylized cartoon proportions'],
  },
  {
    pattern: /\bwatercolou?r\b/i,
    target: 'soft watercolor washes with bleeding pigment edges and visible paper texture',
    exclusions: ['hard uniform outlines'],
  },
  {
    pattern: /\banime\b|\bmanga\b/i,
    target: 'anime cel rendering — clean linework, flat color fills, expressive faces',
    exclusions: ['photographic skin texture'],
  },
  {
    pattern: /\bcinematic\b|\bmovie\s*(?:still|poster)\b/i,
    target: 'cinematic framing and dramatic key lighting with deep shadow falloff',
    exclusions: [],
  },
  {
    pattern: /\bwoodcut\b|\bengrav(?:ing|ed)\b|\betch(?:ing|ed)\b/i,
    target: 'engraved linework — dense parallel hatching and stark tonal blocks',
    exclusions: ['soft airbrushed gradients'],
  },
];

/**
 * Does this message read as a request about the LOOK of the piece?
 *
 * Kept in sync with the same intent in `critique.ts` — this one is narrower on
 * purpose. It decides whether an untranslated message earns a question, and
 * asking too eagerly is its own failure mode.
 */
const STYLE_REQUEST_PATTERN =
  /\b(?:look|style|aesthetic|vibe|render(?:ed)?|feel)\b|\b(?:more|less)\s+like\b|\bin the style of\b/i;

/* ── Field resolvers ─────────────────────────────────────────────────────── */

const ASPECT_PATTERN = /\b(\d{1,2}\s*:\s*\d{1,2})\b/;

const PALETTE_RULES: readonly { pattern: RegExp; palette: string }[] = [
  {
    pattern: /\b(?:less colou?r|too colou?rful|too much colou?r|tone down the colou?r|desaturate)\b/i,
    palette: 'a quieter, muted palette with far less saturation',
  },
  {
    pattern: /\b(?:more colou?r|not colou?rful enough|needs colou?r|more saturated)\b/i,
    palette: 'richer, more saturated color throughout',
  },
  {
    pattern: /\b(?:blackwork|black ?(?:and|&) ?gr[ea]y|no colou?r|monochrome)\b/i,
    palette: 'blackwork, no color',
  },
  {
    pattern: /\bfull colou?r\b/i,
    palette: 'full color',
  },
];

const ACTION_PATTERN =
  /\b(?:fight(?:ing)?|battl(?:e|ing)|mid-?combat|combat|clash(?:ing)?|duel(?:ing)?|charging|flying|standing|posing|running)\b/i;

const EXCLUSION_PATTERN = /\b(?:no|without|not|drop the|lose the|get rid of the|remove the)\s+([a-z][a-z\s-]{2,40})/i;

/**
 * Common complaints → the concrete directive the image model can act on.
 *
 * Carried over from `adjustPromptForCritique`'s cue table, which this module
 * replaces. The table itself was never the problem — translating "too busy"
 * into "generous negative space" is exactly the right move, and dropping it
 * on the way to a state object would have been a silent downgrade. What was
 * wrong was where the result went: onto the tail of the last prompt.
 *
 * The customer's own words still travel with it (ADR-0010). This adds the
 * technical reading; it never replaces what they said.
 */
const DIRECTIVE_CUES: readonly { pattern: RegExp; directive: string }[] = [
  {
    pattern: /\btoo (busy|cluttered|crowded|much going on)\b|\bbusy\b.*\bcluttered\b|\bdeclutter\b/i,
    directive:
      'noticeably fewer elements, generous negative space, and one unambiguous focal subject',
  },
  {
    pattern: /\btoo (empty|plain|sparse|simple|bare)\b|\bneeds more\b|\bmore detail\b/i,
    directive: 'more supporting detail and texture around the focal subject',
  },
  {
    pattern: /\b(bigger|larger|scale up|blow up|too small)\b/i,
    directive: 'the elements they called out scaled up and made the clear focal point',
  },
  {
    pattern: /\b(smaller|scale down|too big|too large)\b/i,
    directive: 'the elements they called out scaled down so the composition breathes',
  },
  {
    pattern: /\b(missing|left out|forgot|where'?s|isn'?t (?:in )?there|not (?:in )?there)\b/i,
    directive:
      'every element and character they named present, clearly readable, and correctly proportioned',
  },
  {
    pattern: /\b(too dark|too heavy|too harsh|too aggressive)\b/i,
    directive: 'a lighter touch — softer contrast and less visual weight',
  },
];

/** The customer's words, plus the technical reading when a cue matched. */
function asDirective(text: string): string {
  const cue = DIRECTIVE_CUES.find((candidate) => candidate.pattern.test(text));
  return cue ? `${text} — apply this as: ${cue.directive}` : text;
}

/* ── Applying a critique ─────────────────────────────────────────────────── */

export interface CritiqueApplication {
  /** The state after the change. Identical object identity is never returned. */
  state: DesignState;
  /** Which fields this turn actually changed. Empty means the turn changed nothing. */
  changed: (keyof DesignState)[];
  /**
   * A look the customer asked for that we have no translation for. When set,
   * the caller should ASK rather than spend a render (ADR-0060). `changed` may
   * still be non-empty — "9:11 with the unreal engine changes" moves the
   * aspect AND leaves a style question, and both are true at once.
   */
  unresolvedStyle?: string;
}

function pushExclusions(current: readonly string[], additions: readonly string[]): string[] {
  const seen = new Set(current.map((entry) => entry.toLowerCase()));
  const next = [...current];
  for (const addition of additions) {
    const key = addition.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      next.push(addition);
    }
  }
  return next;
}

/**
 * Read one critique turn as a set of field updates.
 *
 * Deliberately NOT a classifier: ADR-0056's router is the thing that will
 * eventually decide which field a message is trying to change, and it does not
 * exist yet. This is the interim table, in one place, so promoting it is a
 * swap rather than a hunt — the same posture `classifyCritiqueTurn` took for
 * the same reason.
 *
 * The roster is never touched here. That is not an omission: a message about
 * missing characters is already answered by re-rendering the state that still
 * holds all of them.
 */
export function applyCritique(state: DesignState, message: string): CritiqueApplication {
  const text = (message || '').trim().replace(/\s+/g, ' ');
  if (!text) return { state: { ...state }, changed: [] };

  const next: DesignState = { ...state, exclusions: [...state.exclusions], directives: [...state.directives] };
  const changed: (keyof DesignState)[] = [];

  const aspect = text.match(ASPECT_PATTERN)?.[1]?.replace(/\s+/g, '');
  if (aspect && aspect !== state.aspect) {
    next.aspect = aspect;
    changed.push('aspect');
  }

  const palette = PALETTE_RULES.find((rule) => rule.pattern.test(text))?.palette;
  if (palette && palette !== state.palette) {
    next.palette = palette;
    changed.push('palette');
  }

  const style = STYLE_TRANSLATIONS.find((entry) => entry.pattern.test(text));
  if (style) {
    if (style.target !== state.visualTarget) {
      next.visualTarget = style.target;
      changed.push('visualTarget');
    }
    const withExclusions = pushExclusions(next.exclusions, style.exclusions);
    if (withExclusions.length !== next.exclusions.length) {
      next.exclusions = withExclusions;
      changed.push('exclusions');
    }
  }

  const action = text.match(ACTION_PATTERN)?.[0]?.toLowerCase();
  if (action && action !== state.action) {
    next.action = action;
    changed.push('action');
  }

  const excluded = text.match(EXCLUSION_PATTERN)?.[1]?.trim();
  if (excluded) {
    const withExclusion = pushExclusions(next.exclusions, [excluded]);
    if (withExclusion.length !== next.exclusions.length) {
      next.exclusions = withExclusion;
      if (!changed.includes('exclusions')) changed.push('exclusions');
    }
  }

  // A look we could not translate. Ask; do not paste (ADR-0060).
  const unresolvedStyle =
    !style && STYLE_REQUEST_PATTERN.test(text) ? text : undefined;

  // Nothing resolved to a field and it was not a style question — keep the
  // customer's own words as a directive rather than losing them (ADR-0010).
  if (changed.length === 0 && !unresolvedStyle) {
    const directive = asDirective(text);
    next.directives = [
      directive,
      ...next.directives.filter((entry) => entry !== directive),
    ].slice(0, MAX_DIRECTIVES);
    changed.push('directives');
  }

  return { state: next, changed, unresolvedStyle };
}

/* ── Rendering ───────────────────────────────────────────────────────────── */

function naturalList(items: readonly string[]): string {
  if (items.length < 2) return items[0] ?? '';
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(', ')}, and ${items.at(-1)}`;
}

const COUNT_WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight'];

function countWord(n: number): string {
  return COUNT_WORDS[n] ?? String(n);
}

/**
 * The prompt for a state — a pure function of the object, and the reason a
 * re-cut is now reproducible: the same state yields the same prompt, and a
 * diff between two states explains exactly what changed.
 *
 * Order is load-bearing. The lane weights the front of a prompt far more
 * heavily than the end (`structuredMode` documents this), so the things that
 * kept getting lost go first: the roster, then the customer's newest
 * directions, then the look. Boilerplate that never changes goes last, where
 * being weighted lightly costs nothing.
 */
export function renderStatePrompt(state: DesignState): string {
  const parts: string[] = [];

  if (state.roster.length > 1) {
    const n = state.roster.length;
    parts.push(
      `A ${state.medium} depicting exactly ${countWord(n)} distinct figures, one each of ` +
        `${naturalList(state.roster)}. No duplicates and no omissions; all ${countWord(n)} ` +
        'figures are fully visible and readable.'
    );
  } else if (state.roster.length === 1) {
    parts.push(`A ${state.medium} depicting ${state.roster[0]}.`);
  } else {
    parts.push(`A ${state.medium}.`);
  }

  if (state.identities.length > 0) {
    parts.push(
      `Character identities: ${state.identities
        .map((identity) => (identity.series ? `${identity.name} — ${identity.series}` : identity.name))
        .join('; ')}.`
    );
  }

  if (state.action) parts.push(`The figures are ${state.action}.`);
  if (state.composition) parts.push(`Composition: ${state.composition}.`);
  if (state.visualTarget) parts.push(`Rendered with ${state.visualTarget}.`);
  if (state.palette) parts.push(`Palette: ${state.palette}.`);
  if (state.aspect) parts.push(`Framed at ${state.aspect}.`);

  for (const directive of state.directives) {
    parts.push(`Customer direction: "${directive}".`);
  }

  if (state.exclusions.length > 0) {
    parts.push(`Avoid: ${naturalList(state.exclusions)}.`);
  }

  parts.push(
    'Clean readable forms with deliberate focal hierarchy, composed to read at tattoo scale ' +
      'and remain legible as it ages — suitable for professional tattooing.'
  );

  return parts.join(' ');
}

/* ── Validation ──────────────────────────────────────────────────────────── */

/**
 * Roster members a prompt fails to name.
 *
 * ADR-0060: "a state object naming four characters and a prompt mentioning two
 * is a detectable contradiction." It is worth detecting before spending a
 * render, because the failing session paid for that exact contradiction and
 * then had to be told about it by the customer.
 *
 * Matching is on whole words, case-insensitively, so "Sora" does not count
 * itself present because the prompt happens to contain "Sorapunk".
 */
export function rosterOmissions(state: DesignState, prompt: string): string[] {
  const haystack = prompt || '';
  return state.roster.filter((name) => {
    const escaped = name.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (!escaped) return false;
    return !new RegExp(`\\b${escaped}\\b`, 'i').test(haystack);
  });
}
