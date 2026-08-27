/**
 * Council structured-input mode (ADR-0015).
 *
 * Accepts the intake record (closed style tags + placement + freeform
 * meaning) and emits a round's two axis-divergent prompt sets (ADR-0049:
 * two cuts spread on one axis per round). With structured input the
 * Council's job shifts from interpretation to axis differentiation
 * (ADR-0012), so construction is fully template-based and works offline —
 * no LLM/provider call is made. The classic `enhance()` path and its
 * provider fallbacks are untouched.
 */

import type {
  CharacterIdentity,
  IntakeRecord,
  AxisSelection,
  VariationAxis,
} from '../../intake/types';
import { VARIATION_AXIS_POOL, ROUND_AXIS_LADDER } from '../../intake/types';
import { resolvePalette, settledAxes } from '../../intake/settledAxes';
import type { Palette } from '../../intake/settledAxes';
import { getBaseNegativePrompt, validatePromptLength } from './councilService';
import { resolvePlacement } from '@/lib/placement';

export interface StructuredVariation {
  /** Which quadrant this variation occupies (questionnaire mode) or which compositional treatment it uses. */
  axisPosition: Record<string, string> | { composition: string };
  prompts: { simple?: string; detailed?: string; ultra?: string };
  negativePrompt?: string;
}

export interface StructuredEnhanceResult {
  /** Always exactly two variations — one round's pair of cuts (ADR-0049). */
  variations: StructuredVariation[];
  axisSelection: AxisSelection;
  metadata?: Record<string, unknown>;
}

export interface StructuredEnhanceOptions {
  /** The Council's discussion-update callback — the bot's narration channel (ADR-0015). */
  onDiscussionUpdate?: (update: unknown) => void;
}

interface PoleSpec {
  /** Short phrase for the simple prompt tier. */
  phrase: string;
  /** Expanded treatment for the detailed/ultra tiers. */
  detail: string;
  /** What this pole must NOT drift into — appended to the negative prompt. */
  negative: string;
}

const AXIS_POLES: Record<VariationAxis, [pole: string, pole: string]> = {
  'bold-fine': ['bold', 'fine'],
  'color-blackwork': ['color', 'blackwork'],
  'literal-abstract': ['literal', 'abstract'],
  'minimal-ornate': ['minimal', 'ornate'],
};

const POLES: Record<string, PoleSpec> = {
  bold: {
    phrase: 'bold heavy linework',
    detail: 'thick confident outlines, strong visual weight, statements lines that will age solidly',
    negative: 'thin faint lines, wispy delicate linework',
  },
  fine: {
    phrase: 'fine-line work',
    detail: 'delicate thin single-needle strokes, light airy linework, precise subtle detail',
    negative: 'thick heavy outlines, chunky bold linework',
  },
  color: {
    phrase: 'vibrant full-color palette',
    detail: 'saturated hues with painterly color blending and deliberate color story',
    negative: 'monochrome, black and grey only, desaturated',
  },
  blackwork: {
    phrase: 'pure blackwork',
    detail: 'black ink only, high-contrast solid blacks, stippled and hatched shading',
    negative: 'color ink, saturated hues, rainbow palette',
  },
  literal: {
    phrase: 'literal representational depiction',
    detail: 'immediately recognizable subject rendered faithfully and realistically',
    negative: 'abstract shapes, unrecognizable symbolic forms',
  },
  abstract: {
    phrase: 'abstract interpretation',
    detail: 'suggestive shapes and symbolic forms that evoke the subject rather than depict it',
    // Deliberately does NOT exclude figurative depiction: for named
    // characters/IP a recognizable figure is the point, and intake resolves
    // literal-abstract to literal in that case anyway — this negative only
    // guards the drift that matters (photorealism) when abstract IS chosen.
    negative: 'photorealism',
  },
  minimal: {
    phrase: 'minimal composition',
    detail: 'restrained detail, a single clear focal element, generous breathing room',
    negative: 'clutter, dense ornamentation, busy background',
  },
  ornate: {
    phrase: 'ornate richly detailed composition',
    detail: 'decorative embellishments, dense intricate texture, layered filigree detail',
    negative: 'empty sparse composition, plain undetailed areas',
  },
};

interface CompositionalTreatment {
  composition: string;
  phrase: string;
  detail: string;
}

/** Compositional-mode treatments: style locks, the four slots vary pose/framing/negative space (ADR-0012). */
const COMPOSITIONAL_TREATMENTS: CompositionalTreatment[] = [
  {
    composition: 'centered emblem',
    phrase: 'centered emblematic composition',
    detail: 'symmetrical framing, subject presented head-on as a self-contained emblem',
  },
  {
    composition: 'dynamic flow',
    phrase: 'dynamic flowing composition',
    detail: 'subject in motion along a sweeping diagonal axis, tapering at both ends',
  },
  // Both of these used to describe the render as sitting on a body ("untouched
  // skin") or bleeding off the canvas ("edges breaking the frame"). Presentation
  // is pinned to flash art on white, and the backdrop guard measures the border,
  // so each was asking for the render the guard rejects. The compositional
  // intent — sparse vs dense — survives; the framing is expressed in white
  // space instead of skin, and the crop stops short of the margin.
  {
    composition: 'negative space',
    phrase: 'open negative-space composition',
    detail: 'small off-center subject with generous untouched white space as part of the design',
  },
  {
    composition: 'close crop',
    phrase: 'tightly cropped close-up framing',
    detail: 'subject rendered large and close, held just inside a clean white margin',
  },
];

/*
 * The ensemble pool. Two of the default treatments cannot satisfy a
 * multi-character brief by construction, not by bad luck: `close crop` asks
 * for the subject "rendered large and close" — for a cast of four that is a
 * cropped face, which is exactly what the Kingdom Hearts reveal returned —
 * and `negative space` asks for a "small off-center subject", the opposite
 * of a group. Burning round slots on treatments that must fail leaves
 * the customer fewer real options.
 *
 * These four all hold multiple interacting figures and stay divergent from
 * each other along the dimension that matters here — how the group is
 * arranged: symmetric and static, interlocked and dense, stacked vertically,
 * or strung along a diagonal.
 */
const ENSEMBLE_TREATMENTS: CompositionalTreatment[] = [
  {
    composition: 'ensemble emblem',
    phrase: 'centered ensemble emblem composition',
    detail:
      'the full cast arranged symmetrically around a shared center, every figure whole and ' +
      'individually readable, together forming one self-contained emblem',
  },
  {
    composition: 'battle scene',
    phrase: 'connected battle-scene composition',
    detail:
      'the cast interlocked mid-clash, weapons and eyelines linking figure to figure so the ' +
      'group reads as one continuous scene rather than separate portraits',
  },
  {
    composition: 'stacked tiers',
    phrase: 'vertically tiered stacked composition',
    detail:
      'figures stacked in distinct tiers up the length of the design, largest at the base, ' +
      'each face clear of the figures around it',
  },
  {
    composition: 'flowing procession',
    phrase: 'flowing procession composition',
    detail:
      'the cast strung along a sweeping diagonal in motion, staggered in depth from the lead ' +
      'figure back through the trailing ones',
  },
];

/*
 * Sleeve substitutes. Placement guidance for a sleeve describes one
 * continuous run down a limb, and three of the treatments above argue with
 * that in the same prompt: an emblem is by definition self-contained, a
 * close crop is the opposite of limb-length, and a small off-center subject
 * abandons the run. Flux folds the whole prompt into one instruction, so a
 * prompt that asks for an emblem and for "not a standalone emblem" is the
 * same failure class as asking for four characters and forbidding multiple
 * people.
 *
 * Each of these expresses what a sleeve actually needs — vertical story
 * flow, connected transitions, focal hierarchy along the taper — and each
 * substitutes 1:1, so the count stays at four and the four stay divergent.
 */
const VERTICAL_STORY: CompositionalTreatment = {
  composition: 'vertical story',
  phrase: 'vertical story-flow composition',
  detail:
    'distinct beats reading top to bottom along the limb, each one whole, the eye ' +
    'travelling the full length in a single direction',
};

const CONNECTED_TRANSITIONS: CompositionalTreatment = {
  composition: 'connected transitions',
  phrase: 'connected transition composition',
  detail:
    'sections joined by continuous connective flow — smoke, water, cloud — so the run ' +
    'never breaks into separate unrelated patches',
};

const FOCAL_HIERARCHY: CompositionalTreatment = {
  composition: 'focal hierarchy',
  phrase: 'anchored focal-hierarchy composition',
  detail:
    'one dominant anchor set at the widest point, supporting elements scaling down and ' +
    'thinning along the taper',
};

/** Treatment → what replaces it when the brief is a sleeve. */
const SLEEVE_SUBSTITUTIONS: Record<string, CompositionalTreatment> = {
  'centered emblem': VERTICAL_STORY,
  'negative space': CONNECTED_TRANSITIONS,
  'close crop': FOCAL_HIERARCHY,
  // The ensemble pool's only sleeve conflict; its other three already run
  // along a limb happily.
  'ensemble emblem': CONNECTED_TRANSITIONS,
};

/**
 * Is this brief a sleeve? One place decides it, and that place is the shared
 * placement resolver — the same call that produces the sleeve composition
 * guidance these treatments have to agree with. Two independent readings of
 * "is this a sleeve" is exactly how a prompt ends up asking for a limb-length
 * run and a self-contained emblem in the same breath.
 *
 * The meaning is passed as the brief: the session that exposed this said
 * `placement: 'left arm'` and put "sleeve" only in the meaning. The resolver
 * also disqualifies the idiom ("wears his heart on his sleeve"), which a bare
 * /\bsleeve\b/ over the meaning would have swallowed.
 */
function isSleeveBrief(record: IntakeRecord): boolean {
  return resolvePlacement(record.placement, record.meaning).isSleeve;
}

/**
 * Which four compositional cuts a brief gets: never a treatment that its own
 * cast size or its own placement guidance contradicts.
 *
 * The cast size comes from the intake roster and nowhere else — re-deriving
 * it from the character catalog is what scored this same Kingdom Hearts
 * session as single-subject, since the catalog covers anime and Kingdom
 * Hearts is a game.
 */
function compositionalTreatments(record: IntakeRecord): CompositionalTreatment[] {
  const pool =
    (record.requestedCharacters?.length ?? 0) > 1
      ? ENSEMBLE_TREATMENTS
      : COMPOSITIONAL_TREATMENTS;
  if (!isSleeveBrief(record)) return pool;
  return pool.map(treatment => SLEEVE_SUBSTITUTIONS[treatment.composition] ?? treatment);
}

/** Keep the freeform meaning bounded so embedded prose can't blow the token budget. */
function truncateWords(text: string, maxWords: number): string {
  const words = (text || '').trim().split(/\s+/).filter(Boolean);
  if (words.length <= maxWords) return words.join(' ');
  return `${words.slice(0, maxWords).join(' ')}…`;
}

/** Drop a prompt tier rather than ship one that fails the shared length validation. */
function keepIfValid(prompt: string): string | undefined {
  return validatePromptLength(prompt).valid ? prompt : undefined;
}

/**
 * Pick which axis the first round diverges along (ADR-0012, ADR-0049).
 * Selection is logged, never silent: the returned rationale is emitted
 * through the discussion callback and included in the result.
 *
 * Under ADR-0049 the questionnaire axes are a fixed ladder walked one rung
 * per round (bold-fine → color-blackwork → literal-abstract →
 * minimal-ornate), so round one always spreads the ladder's first rung —
 * the customer's later REFINE rounds ask the remaining questions.
 */
export function selectAxes(record: IntakeRecord): AxisSelection {
  // A named cast is a composition problem before it is a style questionnaire.
  // A bold and a fine cut can make the same fatal mistake: crop or visually
  // demote part of the cast. Spend the round's two slots on layouts that can
  // prove every requested character fits instead.
  if ((record.requestedCharacters?.length ?? 0) > 1) {
    return {
      mode: 'compositional',
      axes: [],
      rationale:
        `Compositional mode: the customer named ${record.requestedCharacters!.length} distinct ` +
        'characters, so the two cuts vary ensemble staging and framing while keeping the cast, ' +
        'action, placement, and resolved style locked.',
    };
  }

  // The customer explicitly asked to SEE a split ("both color and
  // blackwork?") and the bot promised it — round one delivers THAT axis,
  // not the ladder's first rung; the ladder resumes on the remaining rungs.
  // The request also wins over a settled-axis skip (below): asking to see
  // the split is stronger, later evidence than the brief tags that settled
  // it — and the conversation already reopened the axis when it recorded
  // the request.
  if (record.requestedAxis) {
    return {
      mode: 'questionnaire',
      axes: [record.requestedAxis],
      rationale:
        `Questionnaire mode: the customer explicitly asked to see both poles of ` +
        `${record.requestedAxis}, so round one spreads it ahead of the fixed ADR-0049 ` +
        `ladder (${ROUND_AXIS_LADDER.join(' > ')}); later rounds walk the rungs not yet asked.`,
    };
  }

  if (record.ambiguousAxes.length === 0) {
    const styleDesc = record.styleTags.length > 0 ? record.styleTags.join(', ') : 'the resolved style';
    return {
      mode: 'compositional',
      axes: [],
      rationale:
        `Compositional mode: intake resolved every variation axis, so style locks to ${styleDesc} ` +
        'and the two slots vary pose, framing, and negative space instead — the reveal shifts from ' +
        'questionnaire to confidence proof (ADR-0012).',
    };
  }

  // Round one takes the ladder's first rung the brief did NOT already
  // settle (ADR-0049): a blackwork-resolved brief must never open on a
  // color-blackwork spread whose color cut contradicts its own palette
  // clause. Every axis still in ambiguousAxes is unsettled by construction,
  // so this branch (ambiguousAxes non-empty) always finds a rung; the
  // fallback only satisfies the type-checker.
  const settled = settledAxes(record);
  const first =
    ROUND_AXIS_LADDER.find(axis => !settled.includes(axis)) ?? ROUND_AXIS_LADDER[0];
  const skipNote =
    settled.length > 0
      ? ` — skipping ${settled.join(', ')}, already settled by the brief`
      : '';
  return {
    mode: 'questionnaire',
    axes: [first],
    rationale:
      `Questionnaire mode: round one spreads on ${first}, the first open rung of the fixed ` +
      `ADR-0049 ladder (${ROUND_AXIS_LADDER.join(' > ')})${skipNote}; the pick locks a pole ` +
      'and each REFINE round spreads the next open rung while holding everything already picked.',
  };
}

/*
 * Palette resolution (resolvePalette, re-imported from the intake module —
 * it now lives beside the record it reads, because the round-axis ladder
 * skips settled rungs off the same decision). The palette drives two things
 * here: the front-loaded palette clause and the negative prompt.
 * Presentation is NOT one of them — it is pinned to flash art for every
 * session, see presentationClause(). Flux weights the front of a prompt far
 * more heavily than a trailing negative, which is why the palette leads
 * rather than being folded into "Avoid:".
 */

/** Front-loaded palette clause — first words of every prompt tier. */
function paletteClause(palette: Palette): string {
  if (palette === 'color') return 'Vibrant color, clean ink saturation, tattoo-quality color rendering. ';
  if (palette === 'monochrome') return 'Monochrome, black and grey ink only, zero color. ';
  return '';
}

/**
 * Presentation is pinned to flash art on white for EVERY session, palette
 * included. Palette and presentation are separate decisions: the palette
 * clause already carries color vs monochrome, so presentation does not need
 * to encode it too.
 *
 * Flash art on white is a hard product dependency, not a preference: the
 * placement preview strips the near-white background to real alpha and
 * composites onto the user's own photo with a multiply blend. An on-skin
 * render has nothing to strip, so the preview would paste a stranger's arm
 * onto the user's body — which is why `assessBackdrop` refuses it outright.
 *
 * This clause is FRONT-LOADED, and it asserts what the image IS rather than
 * negating what it must not be. The previous version did the opposite on
 * both counts — it trailed the prompt ("...not photographed on skin") — and
 * measured 0/12 against the guard: every render came back as a photograph of
 * a tattoo on a forearm. Two mechanics, both already documented in ADR-0023
 * for the palette decision, explain it:
 *
 *   1. Early tokens win. The subject sentence opened "A ... tattoo on the
 *      left forearm", an explicit positive instruction to draw a limb at
 *      roughly token 10, while the correction sat at token 65. The ADR
 *      recorded the same defeat for color ("explicit positive color words
 *      beat a negative prompt every time"); placement is the presentation
 *      axis's chromatic anchor, so it is gone from the sentence — aspect
 *      ratio (`getAnatomicalAspectRatio`) and the composition guidance
 *      already carry placement, and they carry it without naming a body.
 *   2. Naming a thing summons it. "not photographed on skin" spends its two
 *      most concrete tokens on "photographed" and "skin". Exclusions belong
 *      in the negative prompt, which folds into an `Avoid:` clause for the
 *      Flux lane anyway.
 */
/*
 * "Centered with clean white margins" rather than "filling the frame": the
 * guard measures the BORDER, not the overall white fraction, so an artwork
 * bled to the edges fails it exactly as hard as a photograph does. The
 * margin is the thing being asked for.
 */
// Exported for the re-cut path (`designSession/internal/designState.ts`),
// which front-loads the same clause for the same reason and must not keep a
// second copy of it. Export only — nothing about the reveal changes.
export const PRESENTATION_LEAD =
  'Flash art tattoo design on a pure white background — a flat scan of the ' +
  'artwork alone, centered with clean white margins on all sides. ';

/**
 * Exclusions that keep the render a flat scan of artwork rather than a
 * photograph of an object. Every entry is a mode observed in real output:
 * on-skin photographs (the production prompt's failure), flash art shot as a
 * sheet of paper angled on a dark desk with pens beside it, and artwork
 * rendered on a black backdrop — the last two being what the 300-render
 * Vertex portfolio corpus fails on.
 */
const PRESENTATION_NEGATIVES =
  'photograph of a tattoo on skin, tattooed skin, human body, arm, leg, ' +
  'sheet of paper, desk, table, wooden surface, product mockup, still life, ' +
  'drop shadow, angled perspective view, black background, dark background, ' +
  'vignette, border frame';

/** Palette-specific negatives, appended to the shared base. */
function paletteNegatives(palette: Palette): string[] {
  // Deliberately no monochrome negatives on color sessions: negatives are
  // folded into the prompt for Flux/Krea, so the words would work against
  // the color the session just committed to.
  return palette === 'monochrome' ? ['color ink, saturated hues, rainbow palette'] : [];
}

interface PromptContext {
  styleDesc: string;
  placement: string;
  palette: Palette;
  subject?: string;
  meaningShort: string;
  aspectGuidance: string;
  flowToken: string;
  /** Closed style tags, verbatim — drives style-contradicting negatives. */
  styleTags: string[];
  /**
   * Size of the cast the customer actually named. Authoritative: the intake
   * already resolved this roster, so the negative-prompt builder must not
   * re-guess it from a catalog that only covers anime.
   *
   * Undefined — never 0 — when the record carries no roster, so the builder
   * falls back to catalog detection instead of asserting "no characters".
   */
  requestedCharacterCount?: number;
  /** Exact roster extracted by intake, in the customer's order. */
  requestedCharacters: string[];
  characterIdentities: CharacterIdentity[];
}

function buildContext(record: IntakeRecord): PromptContext {
  // Placement is a hard generation constraint (ADR-0009) AND the anchor of
  // the downstream placement-preview composite, which trusts the intake tag
  // by spec. This used to fall back silently to 'forearm', which is exactly
  // how an empty-placement brief once shipped a forearm render nobody asked
  // for. Both intake lanes now guarantee placement before enhancement — the
  // scripted route 400s without a placementAnswer, and the conversation
  // gates its turn-12 forced proposal on placement (ADR-0021 amendment) —
  // so an empty placement here is a broken caller. Refuse loudly.
  const placement = (record.placement ?? '').trim();
  if (!placement) {
    throw new Error(
      'enhanceStructured requires IntakeRecord.placement — refusing to guess a ' +
        'body part; every intake lane must resolve placement before enhancement.'
    );
  }
  // One resolver for composition and flow (and, elsewhere, the render aspect
  // ratio). Both fields used to come from exact-match lookups that answered
  // only for a bare "forearm"; a "left arm" session got 'balanced
  // composition' and 'body-part appropriate flow' — a tautology that told the
  // model nothing while occupying the slot where placement should have spoken.
  //
  // The meaning goes in as the sleeve signal: "a kingdom hearts sleeve" with
  // placement "left arm" is a sleeve request, and the placement tag alone
  // loses the scale of it. Meaning cannot influence anything else.
  const guidance = resolvePlacement(placement, record.meaning);
  const isEnsemble = (record.requestedCharacters?.length ?? 0) > 1;
  const aspectGuidance = isEnsemble
    ? guidance.composition.replace(
        'a clear focal hierarchy with one dominant subject supported by secondary elements above and below it',
        'a clear ensemble hierarchy with every named figure equally readable and none cropped, omitted, or reduced to background decoration'
      )
    : guidance.composition;
  return {
    styleDesc: record.styleTags.length > 0 ? record.styleTags.join(', ') : 'tattoo',
    placement,
    palette: resolvePalette(record.styleTags),
    subject: record.subject?.trim() || undefined,
    meaningShort: truncateWords(record.meaning, 60),
    aspectGuidance,
    flowToken: guidance.flow,
    styleTags: record.styleTags,
    requestedCharacterCount: record.requestedCharacters?.length || undefined,
    requestedCharacters: record.requestedCharacters ?? [],
    characterIdentities: record.characterIdentities ?? [],
  };
}

/*
 * Chromatic words to strip from a subject description on monochrome
 * sessions. The character database anchors are written for image fidelity
 * ("Goku ... orange gi with blue undershirt and belt"), and a blackwork
 * session front-loaded with "zero color" still came back with an orange gi
 * four times out of four: explicit positive color words beat a negative
 * prompt every time. Tonal words (black, white, grey, silver) stay — they
 * are exactly what a blackwork piece is made of.
 */
const CHROMATIC_WORDS = [
  'orange', 'blue', 'red', 'green', 'yellow', 'purple', 'violet', 'pink',
  'crimson', 'scarlet', 'magenta', 'teal', 'turquoise', 'golden', 'gold',
  'amber', 'emerald', 'azure', 'lavender', 'maroon', 'indigo', 'olive',
  'bronze', 'copper', 'salmon', 'lilac',
];

const CHROMATIC_PATTERN = new RegExp(`\\b(?:${CHROMATIC_WORDS.join('|')})\\b`, 'gi');

/** Drop chromatic words (and the punctuation they strand) from a phrase. */
export function stripChromaticWords(text: string): string {
  return text
    .replace(CHROMATIC_PATTERN, '')
    .replace(/\(\s*\)/g, '')
    .replace(/\s{2,}/g, ' ')
    .replace(/\s+([,;.])/g, '$1')
    .replace(/([,;])\s*(?=[,;])/g, '')
    .replace(/,\s*\)/g, ')')
    .trim();
}

/**
 * The subject clause every variation shares. When intake extracted a
 * concrete subject (a named character, franchise, or specific thing —
 * "Izuku Midoriya (Deku) from My Hero Academia, One For All lightning
 * around his fist"), the prompt DEPICTS it by name — never a mood
 * paraphrase, which fights the output for recognizable IP. Without one,
 * meaning informs phrasing verbatim-ish, as before.
 */
function naturalList(items: readonly string[]): string {
  if (items.length < 2) return items[0] ?? '';
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(', ')}, and ${items.at(-1)}`;
}

function characterIdentityClause(
  identities: readonly CharacterIdentity[]
): string {
  if (identities.length === 0) return '';
  // A name-only identity is a character whose franchise we could not verify
  // (see groundedCharacterIdentities). Speak the name alone — "Link — " is
  // worse than "Link", and inventing a franchise to fill the gap is worse
  // than both.
  return `Character identities: ${identities
    .map((identity) =>
      identity.series ? `${identity.name} — ${identity.series}` : identity.name
    )
    .join('; ')}.`;
}

function subjectClause(ctx: PromptContext): string {
  const identityClause = characterIdentityClause(ctx.characterIdentities);
  if (ctx.subject) {
    const subject = (
      ctx.palette === 'monochrome' ? stripChromaticWords(ctx.subject) : ctx.subject
    ).replace(/[.\s]+$/, '');
    if (ctx.requestedCharacters.length > 1) {
      const count = ctx.requestedCharacters.length;
      const countWord = count === 4 ? 'four' : String(count);
      const roster = naturalList(ctx.requestedCharacters);
      const identityPrefix = identityClause ? `${identityClause} ` : '';
      return (
        `depicting exactly ${countWord} distinct figures, one each of ${roster}: ${subject}.` +
        ` ${identityPrefix}No duplicates or omissions; all ${countWord} figures are fully visible and ` +
        'visibly interact in the requested action. Keep every character’s canonical costume, ' +
        'face, silhouette, powers, weapon, and signature props distinct and attached only to ' +
        'that named character; never swap, merge, or homogenize them.'
      );
    }
    return `depicting ${subject}.${identityClause ? ` ${identityClause}` : ''}`;
  }
  if (ctx.characterIdentities.length > 0) {
    return `depicting ${naturalList(ctx.characterIdentities.map((identity) => identity.name))}. ${identityClause}`;
  }
  return ctx.meaningShort ? `expressing "${ctx.meaningShort}"` : 'as a personal design';
}

function buildQuadrantVariation(
  axes: VariationAxis[],
  poles: string[],
  ctx: PromptContext
): StructuredVariation {
  const axisPosition: Record<string, string> = {};
  axes.forEach((axis, i) => {
    axisPosition[axis] = poles[i];
  });

  const specs = poles.map(pole => POLES[pole]);
  const phrases = specs.map(spec => spec.phrase).join(', ');
  const details = specs.map(spec => spec.detail).join('; ');

  const lead = paletteClause(ctx.palette) + PRESENTATION_LEAD;
  const simple = `${lead}A tattoo design in a ${ctx.styleDesc} style, ${subjectClause(ctx)} Rendered with ${phrases}.`;
  const detailed =
    `${simple} Treatment: ${details}. Composition follows ${ctx.aspectGuidance}.`;
  const ultra =
    `${detailed} Anatomical flow: ${ctx.flowToken}. ` +
    'Clean readable forms with deliberate focal hierarchy, composed to read at tattoo scale ' +
    'and remain legible as it ages — suitable for professional tattooing.';

  const negativePrompt = [
    getBaseNegativePrompt(ctx.subject ?? '', {
        requestedCharacterCount: ctx.requestedCharacterCount,
        styleTags: ctx.styleTags,
      }),
    ...specs.map(spec => spec.negative),
    ...paletteNegatives(ctx.palette),
    PRESENTATION_NEGATIVES,
  ].join(', ');

  return {
    axisPosition,
    prompts: {
      simple: keepIfValid(simple),
      detailed: keepIfValid(detailed),
      ultra: keepIfValid(ultra),
    },
    negativePrompt,
  };
}

function buildCompositionalVariation(
  treatment: CompositionalTreatment,
  ctx: PromptContext
): StructuredVariation {
  const lead = paletteClause(ctx.palette) + PRESENTATION_LEAD;
  const simple = `${lead}A tattoo design in a ${ctx.styleDesc} style, ${subjectClause(ctx)} Use a ${treatment.phrase}.`;
  const detailed =
    `${simple} Treatment: ${treatment.detail}. Composition follows ${ctx.aspectGuidance}.`;
  const ultra =
    `${detailed} Anatomical flow: ${ctx.flowToken}. ` +
    'Faithful to the locked style across all variations; only pose, framing, and negative space ' +
    'differ. Clean readable forms suitable for professional tattooing.';

  return {
    axisPosition: { composition: treatment.composition },
    prompts: {
      simple: keepIfValid(simple),
      detailed: keepIfValid(detailed),
      ultra: keepIfValid(ultra),
    },
    negativePrompt: [
      getBaseNegativePrompt(ctx.subject ?? '', {
        requestedCharacterCount: ctx.requestedCharacterCount,
        styleTags: ctx.styleTags,
      }),
      ...paletteNegatives(ctx.palette),
      PRESENTATION_NEGATIVES,
    ].join(', '),
  };
}

function resultMetadata(record: IntakeRecord): Record<string, unknown> {
  return {
    placement: record.placement,
    styleTags: record.styleTags,
    references: record.references,
    axisPool: VARIATION_AXIS_POOL,
    generatedAt: new Date().toISOString(),
    provider: 'template',
  };
}

/**
 * Which two compositional treatments a round shows: the pool taken two at a
 * time, wrapping once it runs out — a wrapped pair re-frames rather than
 * repeats, because by then the previous round's picked image rides along as
 * a reference (ADR-0049).
 */
function compositionalPair(
  record: IntakeRecord,
  roundNumber: number
): CompositionalTreatment[] {
  const pool = compositionalTreatments(record);
  const pairCount = Math.max(1, Math.floor(pool.length / 2));
  const offset = ((roundNumber - 1) % pairCount) * 2;
  return pool.slice(offset, offset + 2);
}

/**
 * Structured-input enhancement (ADR-0015): the first round's two
 * axis-divergent variations from an intake record (ADR-0049). Pure template
 * construction — never calls a provider.
 */
export async function enhanceStructured(
  record: IntakeRecord,
  opts: StructuredEnhanceOptions = {}
): Promise<StructuredEnhanceResult> {
  const axisSelection = selectAxes(record);

  // Selection is logged, never silent (ADR-0012): narrate through the
  // Council's discussion-update channel (ADR-0015).
  opts.onDiscussionUpdate?.({ type: 'axis-selection', ...axisSelection });

  const ctx = buildContext(record);

  let variations: StructuredVariation[];
  if (axisSelection.mode === 'questionnaire') {
    const [axis] = axisSelection.axes;
    const [pole0, pole1] = AXIS_POLES[axis];
    variations = [
      buildQuadrantVariation([axis], [pole0], ctx),
      buildQuadrantVariation([axis], [pole1], ctx),
    ];
  } else {
    variations = compositionalPair(record, 1).map(treatment =>
      buildCompositionalVariation(treatment, ctx)
    );
  }

  return { variations, axisSelection, metadata: resultMetadata(record) };
}

/** One later round's spread (see enhanceRoundStructured). */
export interface RoundSpread {
  /** 1-based round number — round 1 is enhanceStructured's reveal. */
  roundNumber: number;
  /**
   * The ladder axis this round spreads on, 'reroll' past the ladder, or
   * 'composition' for compositional sessions.
   */
  axis: VariationAxis | 'reroll' | 'composition';
  /**
   * Poles locked by earlier rounds' picks, keyed by axis. Every cut this
   * round produces holds all of them (ADR-0049).
   */
  lockedPoles: Partial<Record<VariationAxis, string>>;
}

/**
 * One REFINE round's two variations (ADR-0049): spread on the round's axis
 * while holding every previously picked pole; a 'reroll' round holds the
 * locked poles and draws twice. Same template machinery as the first
 * round — never calls a provider.
 */
export async function enhanceRoundStructured(
  record: IntakeRecord,
  spread: RoundSpread
): Promise<StructuredEnhanceResult> {
  const ctx = buildContext(record);
  const lockedAxes = Object.keys(spread.lockedPoles) as VariationAxis[];
  const lockedValues = lockedAxes.map(axis => spread.lockedPoles[axis]!);

  let variations: StructuredVariation[];
  let rationale: string;
  if (spread.axis === 'composition') {
    variations = compositionalPair(record, spread.roundNumber).map(treatment =>
      buildCompositionalVariation(treatment, ctx)
    );
    rationale =
      `Compositional round ${spread.roundNumber}: two fresh framings of the locked style, ` +
      'seeded by the previous pick (ADR-0049).';
  } else if (spread.axis === 'reroll') {
    // Past the ladder: both slots hold every locked pole and re-draw. The
    // reference image (the previous pick) is what differentiates the round.
    const build = () => buildQuadrantVariation([...lockedAxes], [...lockedValues], ctx);
    variations = [build(), build()];
    rationale =
      `Re-roll round ${spread.roundNumber}: every ladder axis is locked ` +
      `(${lockedAxes.join(', ')}), so both cuts re-draw on the locked poles (ADR-0049).`;
  } else {
    const [pole0, pole1] = AXIS_POLES[spread.axis];
    variations = [
      buildQuadrantVariation([spread.axis, ...lockedAxes], [pole0, ...lockedValues], ctx),
      buildQuadrantVariation([spread.axis, ...lockedAxes], [pole1, ...lockedValues], ctx),
    ];
    rationale =
      `Round ${spread.roundNumber} spreads on ${spread.axis} while holding ` +
      `${lockedAxes.length > 0 ? lockedAxes.map(axis => `${axis}:${spread.lockedPoles[axis]}`).join(', ') : 'nothing yet'} (ADR-0049).`;
  }

  return {
    variations,
    axisSelection: {
      mode: spread.axis === 'composition' ? 'compositional' : 'questionnaire',
      axes: spread.axis === 'composition' || spread.axis === 'reroll' ? [] : [spread.axis],
      rationale,
    },
    metadata: resultMetadata(record),
  };
}
