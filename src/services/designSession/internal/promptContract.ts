/**
 * The prompt contract — does the rendered prompt still say what the state says?
 *
 * ## Why this file exists
 *
 * `designState.ts` made a re-cut a pure function of the state object, and
 * ADR-0060 added one safety net over that render: `rosterOmissions`. It asks a
 * single question — "does every named character in `state.roster` actually
 * appear in the prompt we are about to pay for?" — and it is a good question.
 * It is also the only question that net asks.
 *
 * A customer asked for "an astronaut with a cracked visor". No IP character,
 * so `roster` was empty, so `rosterOmissions` returned `[]`, so the guard went
 * green — while the entire subject of the piece had fallen out of the rendered
 * prompt. Two renders came back as an unrelated eagle, both billed against
 * `BUDGET_MAX_SPEND_CENTS`, and the only thing that noticed was the customer.
 *
 * The defect was never in the roster check. It was in the *scope* of the
 * check: a guard that only validates one field silently blesses every other
 * field the state asserts. This module generalizes the idea from "the roster"
 * to "everything the state claims is true about this design". If the state
 * says the palette is full color, the prompt has to say colour somewhere. If
 * the state says the piece is a sleeve on the forearm, the prompt has to place
 * it there. An assertion that does not survive into the prompt is a detectable
 * contradiction, and it is worth detecting BEFORE the provider call, because
 * afterwards it costs money to discover and a customer to report.
 *
 * ## NOTHING CALLS THIS YET — read this before trusting it
 *
 * This module is BUILT AND TESTED BUT NOT WIRED IN. Its call site is the
 * pre-spend point in the re-cut lane (`internal/orchestrator.ts`, immediately
 * before `generate()`), and that file is owned by a concurrent workstream, so
 * arming the guard is a deliberate follow-up rather than part of this change.
 * Until that lands, the only thing running this check is the post-hoc review
 * cron (`internal/sessionReview.ts`), which re-asks the question AFTER the
 * money was spent.
 *
 * Which means: the astronaut hole described above is still open in the product
 * today. Everything below is written in the present tense because it describes
 * what the function does when it is called — not how often it is called, which
 * is currently once per session, a day late, by a cron.
 *
 * ## What this module is not
 *
 * It is not a semantic judge. It does not decide whether the prompt is *good*,
 * whether the composition is sensible, or whether the model will obey. It
 * answers exactly one narrow, mechanical question per asserted field — did the
 * words survive the render — because that question can be answered with total
 * confidence and zero spend, and it is the question the eagle failure needed
 * answered.
 *
 * ## The subject field, and why the read is structural
 *
 * `DesignState` on `origin/main` has no `subject` field. That absence *is* the
 * astronaut defect, and it is being fixed separately; `designState.ts` is
 * owned elsewhere and is not edited from here. So this module reads a subject
 * structurally — if the state carries one, it is checked; if it does not, the
 * report says so in as many words rather than quietly reporting "no subject
 * violations", which is precisely the reassuring silence that shipped the bug.
 * `subjectAssertion` distinguishes the three states a caller actually needs to
 * tell apart: `'not-asserted'`, `'present'`, `'missing'`.
 *
 * A caller that treats `'not-asserted'` as equivalent to `'present'` has
 * rebuilt the original hole. The type makes that a deliberate act.
 *
 * ## Matching discipline
 *
 * Whole word, case-insensitive — the same rule `rosterOmissions` already
 * proved, for the same reason it chose it: a prompt containing "Sorapunk" has
 * not mentioned Sora. The roster check here literally delegates to
 * `rosterOmissions` rather than reimplementing it, so the two can never drift.
 * Multi-word assertions ("full color", "tattoo sleeve on the forearm") are
 * checked term by term against that same rule, and the violation names the
 * exact terms that vanished — "palette" is not an actionable report,
 * "palette 'full color': prompt never says 'full'" is.
 */

import { rosterOmissions } from './designState';
import type { DesignState } from './designState';

/* ── The report ──────────────────────────────────────────────────────────── */

/**
 * The state fields this module knows how to hold a prompt to.
 *
 * This list covers every field `DesignState` declares today — all ten — plus
 * `subject`, which is listed even though `DesignState` may not carry it yet
 * (see the module header). That completeness is not decoration: a guard that
 * checks eight of ten fields silently blesses the other two, which is the
 * exact shape of the roster-only defect this file exists to close.
 *
 * The three that were easiest to forget, and the reason each is here:
 * `identities`, `exclusions` and `directives` all render into
 * `renderStatePrompt` ("Character identities: …", "Avoid: …", "Customer
 * direction: …"), so a prompt rewrite can drop them exactly as easily as it
 * can drop the roster. `exclusions` in particular is checked NEGATIVELY — see
 * `NEGATORS` — because "avoid X" surviving as "X" is worse than it vanishing.
 *
 * ADDING A FIELD TO `DesignState` MEANS ADDING IT HERE. There is no way for
 * this module to notice a field it was never told about, and the failure is
 * silent by construction.
 */
export type PromptContractField =
  | 'subject'
  | 'roster'
  | 'identities'
  | 'medium'
  | 'palette'
  | 'composition'
  | 'action'
  | 'aspect'
  | 'visualTarget'
  | 'exclusions'
  | 'directives';

/** One thing the state asserts that the prompt does not say — or denies. */
export interface PromptContractViolation {
  /** Which state field made the claim. */
  field: PromptContractField;
  /** The asserted value, verbatim, as the state holds it. */
  value: string;
  /**
   * The significant terms of `value` that appear nowhere in the prompt as
   * whole words. For `roster` this is the omitted names themselves; for a
   * prose field it is the words that went missing, which is what tells a
   * reader whether the field was dropped outright or quietly contradicted.
   */
  missing: string[];
  /**
   * Terms the prompt DOES say, but with the opposite polarity to the state.
   *
   * A word being present is not the same as an assertion surviving. State
   * `palette: "blackwork, no color"` against a prompt reading "blackwork lines
   * with full color fills" contains both of the state's terms, so a presence-
   * only check reports a clean bill of health over a flat contradiction — the
   * roster-only silence rebuilt one field over. Here `color` lands in
   * `contradicted` instead: the state excludes it and the prompt commands it.
   *
   * The reverse case counts too. A state asserting `"full color"` against a
   * prompt saying "no color" has its term present, negated, and contradicted.
   */
  contradicted: string[];
}

/**
 * Whether the design's subject survived — and, crucially, whether there was
 * one to survive.
 *
 * - `'not-asserted'` — the state carries no subject. NOT a clean bill of
 *   health: on a pre-ADR-0060 state, or on `origin/main`'s `DesignState`,
 *   this is what the astronaut session reported right up until it billed two
 *   renders of an eagle.
 * - `'present'` — a subject was asserted and every significant term of it is
 *   in the prompt.
 * - `'missing'` — a subject was asserted and did not fully survive. There is
 *   a matching `subject` violation in `violations`.
 */
export type SubjectAssertion = 'not-asserted' | 'present' | 'missing';

export interface PromptContractReport {
  /** Every assertion the prompt failed to carry, in field order. */
  violations: PromptContractViolation[];
  /** The subject's fate, including the "there wasn't one" case. */
  subjectAssertion: SubjectAssertion;
  /**
   * The fields the state asserted AND this module was able to verify — meaning
   * the field held at least one significant term to look for.
   * A caller logging a green result should log this too: "0 violations" over
   * one checked field and "0 violations" over eight are very different claims
   * about how much was verified.
   */
  checkedFields: PromptContractField[];
  /**
   * Fields the state asserted that could not be verified at all, because once
   * the connective words were dropped nothing load-bearing remained — a
   * `visualTarget` of "with the it" has no term a prompt could carry.
   *
   * These are reported rather than folded into `checkedFields`, because a
   * field counted as checked when zero terms were actually looked for is a
   * false claim of coverage, and false coverage is what this module exists to
   * end. Practically it means a state field got filled with noise upstream.
   */
  unverifiableFields: PromptContractField[];
}

/* ── Matching ────────────────────────────────────────────────────────────── */

/**
 * Words carried along by prose that say nothing about the design. They are
 * dropped before matching so that "a tattoo sleeve on the forearm" is held to
 * *tattoo*, *sleeve* and *forearm* — the load-bearing words — and not to
 * whether the prompt happened to phrase it with "the".
 *
 * `no` and `not` are NOT in here. They used to be, and dropping them is how a
 * state asserting "blackwork, no color" reported clean against a prompt
 * commanding "full color fills": both surviving terms were present, so a
 * presence-only check saw nothing wrong. Negators are load-bearing words —
 * they are handled by `NEGATORS` below rather than discarded.
 */
const IGNORED_TERMS = new Set([
  'a', 'an', 'and', 'or', 'the', 'of', 'with', 'on', 'in', 'at', 'to', 'for',
  'is', 'are', 'be', 'as', 'by', 'from', 'that', 'this', 'it',
  'its', 'into', 'onto', 'over', 'under', 'their', 'they', 'them',
]);

/**
 * Words that flip the polarity of what follows them.
 *
 * A design brief says as much by exclusion as by instruction — "no color",
 * "avoid flat cel-shaded outlines" — and an exclusion that survives into the
 * prompt with its negator stripped is worse than one that vanishes: it becomes
 * a positive command to render the thing the customer refused. So negation is
 * read on BOTH sides. In a state value, a negator makes every later term in
 * its clause a thing the prompt must deny. In a prompt, a negator within
 * `NEGATION_WINDOW` words before a term means that occurrence denies it.
 *
 * The set is deliberately tight. A word like "free" would be a plausible
 * negator ("color-free") and is left out, because "free-flowing linework"
 * would then silently negate whatever followed it — a false clean bill of
 * health, which is the one outcome this module must never produce cheaply.
 */
const NEGATORS = new Set([
  'no', 'not', 'never', 'none', 'without', 'zero', 'avoid', 'avoiding',
  'exclude', 'excludes', 'excluding', 'excluded', 'sans', 'non',
]);

/**
 * How many words before a term are searched for a negator in running prose.
 *
 * Two, and the narrowness is the point. "Monochrome, zero color, pure
 * blackwork" negates *color* and asserts *blackwork*; a wider reach would read
 * the whole sentence as negative and report a contradiction against a prompt
 * that is doing exactly what the state asked. Sentence and semicolon
 * boundaries stop the search regardless of the count.
 */
const NEGATION_WINDOW = 2;

/**
 * The other shape a negation takes: a LABEL introducing a list, as
 * `renderStatePrompt` emits for exclusions — "Avoid: flat cel-shaded outlines,
 * harsh gradients." Here the negation is meant to reach every item, across
 * commas, to the end of the clause, so the word-window rule would wrongly
 * clear everything after the first comma. Recognised by the colon, which is
 * what makes it a label rather than a phrase.
 */
const LABEL_NEGATOR = new RegExp(`\\b(?:${[...NEGATORS].join('|')})\\b\\s*:`, 'i');

/**
 * Punctuation shaved off the ENDS of a token only — quotes, brackets, commas,
 * dashes used as separators. Interior punctuation is left alone on purpose:
 * "9:11" and "true-to-life" are single terms and matching them whole is the
 * point. Written as an explicit character set rather than a Unicode property
 * escape because the compile target is es5 and `\p{L}` needs the `u` flag.
 */
const EDGE_PUNCTUATION_LEADING = /^[\s"'`([{<.,;:!?/\\|*_~\u2018\u2019\u201c\u201d\u2013\u2014-]+/;
const EDGE_PUNCTUATION_TRAILING = /[\s"'`)\]}>.,;:!?/\\|*_~\u2018\u2019\u201c\u201d\u2013\u2014-]+$/;

/** One requirement a prompt must satisfy, and which way round it points. */
export interface ContractTerm {
  /** The word, in the state's own casing. */
  term: string;
  /** True when the state asserts the ABSENCE of this term. */
  negated: boolean;
}

/**
 * Split an asserted value into the polarised terms a prompt must satisfy for
 * the assertion to have survived.
 *
 * Clauses are split on commas and semicolons, and a negator flips every later
 * term in ITS OWN clause only: "blackwork, no color" asks for *blackwork* and
 * against *color*, which is exactly what the customer said and what a single
 * flat term list cannot express.
 *
 * `forceNegated` exists for `exclusions`, whose entries are negative by their
 * nature rather than by their wording — the state stores "flat cel-shaded
 * outlines", not "no flat cel-shaded outlines", and the field name is the
 * negator.
 *
 * Punctuation is stripped from the ends only: "9:11" and "true-to-life" are
 * single terms and matching them whole is the point, while "blackwork," is
 * plainly the word blackwork. Order is preserved and duplicates collapse,
 * because a value naming the same word twice is still one requirement.
 */
export function contractAssertions(value: string, forceNegated = false): ContractTerm[] {
  const seen = new Set<string>();
  const terms: ContractTerm[] = [];
  // Only commas and semicolons split a clause — never a period, which would
  // tear "9.5:1" in half.
  for (const clause of (value || '').split(/[,;]/)) {
    let negated = forceNegated;
    for (const raw of clause.split(/\s+/)) {
      const term = raw.replace(EDGE_PUNCTUATION_LEADING, '').replace(EDGE_PUNCTUATION_TRAILING, '');
      if (!term) continue;
      const key = term.toLowerCase();
      if (NEGATORS.has(key)) {
        negated = true;
        continue;
      }
      if (IGNORED_TERMS.has(key)) continue;
      if (seen.has(key)) continue;
      seen.add(key);
      terms.push({ term, negated });
    }
  }
  return terms;
}

/**
 * The bare terms of a value, polarity discarded. Kept because plenty of
 * callers only want to know "what words is this field made of"; anything
 * DECIDING whether an assertion survived must use `contractAssertions`, or it
 * reads "no color" as a request for colour.
 */
export function contractTerms(value: string): string[] {
  return contractAssertions(value).map((assertion) => assertion.term);
}

/** Escape a state value so it matches as literal text, not as a pattern. */
function escapeForRegExp(term: string): string {
  return term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Whole-word, case-insensitive containment — `rosterOmissions`' rule, stated
 * once so every field in this module is held to exactly the same standard.
 *
 * The word boundaries are the whole point: "Sorapunk" does not mention Sora,
 * and "colorless" does not satisfy a state that asserts color. The escaping is
 * equally load-bearing and much easier to delete by accident: an unescaped
 * aspect of "9.5:1" turns into a pattern whose `.` matches any character, so
 * a prompt framed at "9x5:1" satisfies it and the guard reports clean.
 */
export function mentionsTerm(prompt: string, term: string): boolean {
  const escaped = escapeForRegExp(term.trim());
  if (!escaped) return false;
  return new RegExp(`\\b${escaped}\\b`, 'i').test(prompt || '');
}

/**
 * How a prompt treats a term.
 *
 * - `absent` — the word is not in the prompt at all.
 * - `negated` — every occurrence sits behind a negator ("no color").
 * - `asserted` — at least one occurrence is a plain positive mention.
 *
 * `asserted` wins over `negated` on purpose: a prompt that says "no color" in
 * one clause and "full color fills" in another IS commanding colour, and the
 * charitable reading is the one that costs money.
 */
export type TermPolarity = 'absent' | 'negated' | 'asserted';

/** True when the occurrence at `index` sits inside a negation's reach. */
function isNegatedAt(text: string, index: number): boolean {
  // Sentence and semicolon boundaries end a negation's reach — "no duplicates
  // and no omissions; all three figures are visible" does not negate figures.
  const clause = text.slice(0, index).split(/[.;]/).pop() ?? '';
  if (LABEL_NEGATOR.test(clause)) return true;
  const words = clause.toLowerCase().match(/[a-z0-9'-]+/g) ?? [];
  return words.slice(-NEGATION_WINDOW).some((word) => NEGATORS.has(word));
}

/** Read every whole-word occurrence of `term` and report the polarity. */
export function termPolarity(prompt: string, term: string): TermPolarity {
  const escaped = escapeForRegExp(term.trim());
  if (!escaped) return 'absent';
  const text = prompt || '';
  const pattern = new RegExp(`\\b${escaped}\\b`, 'gi');
  let found = false;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    found = true;
    if (!isNegatedAt(text, match.index)) return 'asserted';
    // A zero-width match would spin forever; nudge past it.
    if (match.index === pattern.lastIndex) pattern.lastIndex += 1;
  }
  return found ? 'negated' : 'absent';
}

/** What a value asked for and did not get, split by how it failed. */
interface FieldOutcome {
  missing: string[];
  contradicted: string[];
  /** False when the value held no significant term, so nothing was verified. */
  verified: boolean;
}

/**
 * Hold one asserted value to one prompt.
 *
 * Both polarities fail two ways, and the distinction is what makes the report
 * actionable: a term that vanished is a DROPPED assertion (the prompt forgot),
 * while a term present with the wrong polarity is a CONTRADICTED one (the
 * prompt argues back). The first is usually a renderer bug; the second is
 * usually two parts of the pipeline disagreeing about the design.
 */
function checkValue(prompt: string, value: string, forceNegated = false): FieldOutcome {
  const missing: string[] = [];
  const contradicted: string[] = [];
  const assertions = contractAssertions(value, forceNegated);
  for (const { term, negated } of assertions) {
    const polarity = termPolarity(prompt, term);
    if (polarity === 'absent') missing.push(term);
    else if (negated ? polarity === 'asserted' : polarity === 'negated') contradicted.push(term);
  }
  return { missing, contradicted, verified: assertions.length > 0 };
}

/* ── The structural subject read ─────────────────────────────────────────── */

/**
 * Read a subject off a state that may or may not have one.
 *
 * Deliberately structural rather than typed: `DesignState` does not declare
 * `subject` today and this module must not be the thing that forces it to.
 * `scene` is accepted as an alias because the field is being added elsewhere
 * and the contract check should not silently go blind over a naming choice —
 * blindness over a field nobody wired up is the original defect, exactly.
 */
export function assertedSubject(state: DesignState): string | undefined {
  const loose = state as DesignState & { subject?: unknown; scene?: unknown };
  for (const candidate of [loose.subject, loose.scene]) {
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
  }
  return undefined;
}

/* ── The check ───────────────────────────────────────────────────────────── */

/**
 * Hold a rendered prompt to everything its state asserts.
 *
 * Pure: no I/O, no clock, no spend. Intended to run immediately before the
 * provider call, on the exact string that will be sent — a check against a
 * prompt that is later modified is a check of nothing.
 */
export function checkPromptContract(state: DesignState, prompt: string): PromptContractReport {
  const text = prompt || '';
  const violations: PromptContractViolation[] = [];
  const checkedFields: PromptContractField[] = [];
  const unverifiableFields: PromptContractField[] = [];

  /** Record one asserted value's outcome, keeping coverage honest either way. */
  const hold = (field: PromptContractField, value: string, negated = false): FieldOutcome => {
    const outcome = checkValue(text, value, negated);
    if (outcome.verified) checkedFields.push(field);
    else unverifiableFields.push(field);
    if (outcome.missing.length > 0 || outcome.contradicted.length > 0) {
      violations.push({
        field,
        value,
        missing: outcome.missing,
        contradicted: outcome.contradicted,
      });
    }
    return outcome;
  };

  const subject = assertedSubject(state);
  let subjectAssertion: SubjectAssertion = 'not-asserted';
  if (subject) {
    const outcome = hold('subject', subject);
    subjectAssertion =
      outcome.missing.length > 0 || outcome.contradicted.length > 0 ? 'missing' : 'present';
  }

  if (state.roster.length > 0) {
    checkedFields.push('roster');
    // Delegated on purpose: ADR-0060 owns the roster rule and this module must
    // never become a second, subtly different opinion about it.
    const omitted = rosterOmissions(state, text);
    if (omitted.length > 0) {
      violations.push({
        field: 'roster',
        value: state.roster.join(', '),
        missing: omitted,
        contradicted: [],
      });
    }
  }

  // Identities are the roster's evidence — the name AND the source it was
  // verified against. A prompt that keeps "Sora" but drops "Kingdom Hearts"
  // has kept the name and lost the character, which is how a session ends up
  // rendering a generic spiky-haired boy.
  if (state.identities.length > 0) {
    hold(
      'identities',
      state.identities
        .map((identity) => (identity.series ? `${identity.name} ${identity.series}` : identity.name))
        .join(', ')
    );
  }

  const prose: { field: PromptContractField; value: string | undefined }[] = [
    { field: 'medium', value: state.medium },
    { field: 'palette', value: state.palette },
    { field: 'composition', value: state.composition },
    { field: 'action', value: state.action },
    { field: 'aspect', value: state.aspect },
    { field: 'visualTarget', value: state.visualTarget },
  ];

  for (const { field, value } of prose) {
    const asserted = (value ?? '').trim();
    if (!asserted) continue;
    hold(field, asserted);
  }

  // ADR-0010 directions, in the customer's own words. They render near the
  // FRONT of the prompt precisely because they are the newest thing the
  // customer said, so a rewrite that drops them undoes the correction the
  // customer just paid a turn to make.
  if (state.directives.length > 0) {
    hold('directives', state.directives.join(', '));
  }

  // Exclusions are checked NEGATIVELY: the prompt must deny them, not merely
  // mention them. "Avoid: flat cel-shaded outlines" surviving a rewrite as
  // "flat cel-shaded outlines" is not a partial success, it is the opposite of
  // what the customer asked for, and a presence check calls it clean.
  if (state.exclusions.length > 0) {
    hold('exclusions', state.exclusions.join(', '), true);
  }

  return { violations, subjectAssertion, checkedFields, unverifiableFields };
}

/**
 * The violations alone, for callers that only need the go/no-go list.
 *
 * Note what this shape cannot tell you: an empty array from a state with no
 * subject looks identical to an empty array from a state whose subject
 * rendered perfectly. That ambiguity is the astronaut bug in miniature, so
 * anything deciding whether it is safe to spend should read the full report.
 */
export function promptContractViolations(
  state: DesignState,
  prompt: string
): PromptContractViolation[] {
  return checkPromptContract(state, prompt).violations;
}

/* ── Explaining it ───────────────────────────────────────────────────────── */

/**
 * One line a human can act on, naming the field, the asserted value and the
 * words that vanished. Written for a log line and for an operator, not for a
 * customer — it deliberately quotes the internal state value.
 */
export function explainViolation(violation: PromptContractViolation): string {
  const quoted = (terms: string[]) => terms.map((term) => `"${term}"`).join(', ');
  const clauses: string[] = [];
  if (violation.missing.length > 0) {
    clauses.push(`the prompt never says ${quoted(violation.missing)}`);
  }
  if (violation.contradicted.length > 0) {
    // Named separately from "missing" on purpose — a dropped word is usually a
    // renderer forgetting, a contradicted one is two parts of the pipeline
    // disagreeing about the design, and they are fixed in different places.
    clauses.push(`the prompt contradicts it on ${quoted(violation.contradicted)}`);
  }
  if (clauses.length === 0) clauses.push('the prompt does not carry it');
  return `${violation.field}: state asserts "${violation.value}" but ${clauses.join(', and ')}.`;
}

/**
 * The whole report as human lines, including the honest empty cases — a state
 * that asserted nothing and a state that asserted things and kept them all say
 * different things here, on purpose.
 */
export function explainPromptContract(report: PromptContractReport): string {
  const unverifiable =
    report.unverifiableFields.length > 0
      ? ` ${report.unverifiableFields.join(', ')} held no checkable term and ` +
        'was NOT verified.'
      : '';
  if (report.violations.length === 0) {
    const checked = report.checkedFields.length;
    const subject =
      report.subjectAssertion === 'not-asserted' ? ' No subject was asserted to check.' : '';
    return (
      `Prompt carries all ${checked} asserted field${checked === 1 ? '' : 's'}.` +
      `${subject}${unverifiable}`
    );
  }
  return report.violations.map(explainViolation).join(' ') + unverifiable;
}
