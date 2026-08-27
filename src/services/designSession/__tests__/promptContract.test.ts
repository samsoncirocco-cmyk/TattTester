/**
 * The prompt contract (`internal/promptContract.ts`).
 *
 * ## The fixture rule for this file, and why it has one
 *
 * `designState.test.ts` has forty tests and one fixture. That fixture,
 * `smashIntake`, sets a subject AND four `requestedCharacters` — so in every
 * one of those forty tests the subject and the roster say the same thing, and
 * not one of them can tell a subject check from a roster check. That is not a
 * stylistic complaint: it is why the astronaut session shipped. A guard that
 * only ever looked at the roster passed every test, because no test existed in
 * which the roster was empty and the subject was not.
 *
 * So: no shared do-everything fixture here. Each test builds the narrowest
 * state that can distinguish the thing it is testing, and the four cases that
 * matter are kept structurally apart —
 *
 *   - subject, no characters  (the astronaut case; zero prior coverage)
 *   - characters, no subject
 *   - both, agreeing
 *   - both asserted, one of them dropped from the prompt
 *
 * Several tests below assert on `checkPromptContract` over states with an
 * EMPTY roster. Those are the load-bearing ones: narrow the contract back to
 * roster-only and they fail, which is the whole point of writing them.
 *
 * Pure module: no mocks, no store, no provider.
 */
import { describe, it, expect } from 'vitest';
import {
  assertedSubject,
  checkPromptContract,
  contractTerms,
  explainPromptContract,
  explainViolation,
  mentionsTerm,
  promptContractViolations,
} from '../internal/promptContract';
import { renderStatePrompt } from '../internal/designState';
import type { DesignState } from '../internal/designState';

/**
 * A bare state — nothing asserted but the medium, which `DesignState` requires.
 * Every fixture below starts here and adds only the fields its case is about,
 * so no test can pass on the strength of a field it did not mean to set.
 */
function bareState(overrides: Partial<DesignState> = {}): DesignState {
  return {
    roster: [],
    identities: [],
    medium: 'tattoo on the forearm',
    exclusions: [],
    directives: [],
    ...overrides,
  };
}

/**
 * A state carrying a subject. `DesignState` does not declare `subject` on
 * `origin/main` — that absence is defect #1 and is being fixed elsewhere — so
 * the field is attached structurally here, exactly as the module reads it.
 */
function withSubject(state: DesignState, subject: string): DesignState {
  return { ...state, subject } as DesignState;
}

describe('the astronaut case — a subject, no characters', () => {
  const state = withSubject(
    bareState({ medium: 'tattoo on the forearm' }),
    'an astronaut with a cracked visor'
  );

  // The prompt below is written out by hand, deliberately. It is what
  // `renderStatePrompt` produced on origin/main BEFORE the subject field
  // existed — the exact string that bought two unrelated eagles. Building it
  // by calling the renderer would have made this test depend on the defect:
  // it passed only while the bug was live, and went green-but-meaningless the
  // moment the renderer was fixed (which is what happened when #380 landed).
  // A guard's test must not be written against the broken thing it guards.
  const subjectlessPrompt =
    'Flash art tattoo design on a pure white background — a flat scan of the ' +
    'artwork alone, centered with clean white margins on all sides. ' +
    'Palette: full color. Composed for a tattoo on the forearm.';

  it('flags the subject when the rendered prompt has dropped it entirely', () => {
    expect(subjectlessPrompt).not.toMatch(/astronaut/i);

    const report = checkPromptContract(state, subjectlessPrompt);
    expect(report.subjectAssertion).toBe('missing');
    expect(report.violations).toHaveLength(1);
    expect(report.violations[0].field).toBe('subject');
    expect(report.violations[0].value).toBe('an astronaut with a cracked visor');
    expect(report.violations[0].missing).toEqual(['astronaut', 'cracked', 'visor']);
  });

  it('is exactly the case a roster-only guard reports clean', () => {
    // The regression pin. `rosterOmissions` over an empty roster is [], which
    // is why two renders were paid for. The contract must NOT be silent here.
    expect(state.roster).toEqual([]);
    expect(promptContractViolations(state, subjectlessPrompt).length).toBeGreaterThan(0);
  });

  it('passes once the subject survives into the prompt', () => {
    const prompt =
      'A tattoo on the forearm depicting an astronaut with a cracked visor. ' +
      'Clean readable forms suitable for professional tattooing.';
    const report = checkPromptContract(state, prompt);
    expect(report.violations).toEqual([]);
    expect(report.subjectAssertion).toBe('present');
    expect(report.checkedFields).toContain('subject');
  });

  it('flags a partial survival — the subject named but the detail lost', () => {
    const prompt = 'A tattoo on the forearm depicting an astronaut.';
    const report = checkPromptContract(state, prompt);
    expect(report.subjectAssertion).toBe('missing');
    expect(report.violations[0].missing).toEqual(['cracked', 'visor']);
  });
});

describe('characters, no subject', () => {
  const state = bareState({
    roster: ['Roxas', 'Sora'],
    medium: 'tattoo sleeve on the left arm',
  });

  it('reports no subject assertion rather than a clean subject', () => {
    const report = checkPromptContract(state, renderStatePrompt(state));
    expect(report.subjectAssertion).toBe('not-asserted');
    expect(report.checkedFields).not.toContain('subject');
  });

  it('still holds the prompt to the roster', () => {
    const prompt = 'A tattoo sleeve on the left arm depicting Roxas.';
    const report = checkPromptContract(state, prompt);
    expect(report.violations).toHaveLength(1);
    expect(report.violations[0].field).toBe('roster');
    expect(report.violations[0].missing).toEqual(['Sora']);
  });

  it('passes when the state renders itself', () => {
    expect(promptContractViolations(state, renderStatePrompt(state))).toEqual([]);
  });
});

describe('both a subject and characters', () => {
  const state = withSubject(
    bareState({ roster: ['Roxas', 'Sora'], medium: 'tattoo sleeve on the left arm' }),
    'Roxas and Sora fighting on a clocktower'
  );

  it('agrees when the prompt carries both', () => {
    const prompt =
      'A tattoo sleeve on the left arm depicting exactly two distinct figures, ' +
      'one each of Roxas and Sora, fighting on a clocktower.';
    const report = checkPromptContract(state, prompt);
    expect(report.violations).toEqual([]);
    expect(report.subjectAssertion).toBe('present');
    expect(report.checkedFields).toEqual(expect.arrayContaining(['subject', 'roster', 'medium']));
  });

  it('separates the two — roster intact, scene gone', () => {
    // The failure the single-fixture test file cannot express: every name is
    // present, so the roster check is green, and the scene still vanished.
    const prompt =
      'A tattoo sleeve on the left arm depicting exactly two distinct figures, ' +
      'one each of Roxas and Sora.';
    const report = checkPromptContract(state, prompt);
    expect(report.violations.map((violation) => violation.field)).toEqual(['subject']);
    expect(report.violations[0].missing).toEqual(['fighting', 'clocktower']);
  });

  it('separates the two the other way — scene intact, a name gone', () => {
    const prompt = 'A tattoo sleeve on the left arm of Roxas fighting on a clocktower.';
    const report = checkPromptContract(state, prompt);
    const fields = report.violations.map((violation) => violation.field);
    expect(fields).toEqual(['subject', 'roster']);
    expect(report.violations[1].missing).toEqual(['Sora']);
  });
});

describe('palette', () => {
  it('flags a state that says full color against a blackwork prompt', () => {
    const state = bareState({ palette: 'full color' });
    const prompt = 'A tattoo on the forearm. Palette: blackwork, no color.';
    const report = checkPromptContract(state, prompt);
    expect(report.violations).toHaveLength(1);
    expect(report.violations[0].field).toBe('palette');
    expect(report.violations[0].value).toBe('full color');
    expect(report.violations[0].missing).toEqual(['full']);
  });

  it('flags the reverse — blackwork asserted, a full-colour prompt', () => {
    const state = bareState({ palette: 'blackwork, no color' });
    const prompt = 'A tattoo on the forearm. Palette: full color.';
    const report = checkPromptContract(state, prompt);
    expect(report.violations[0].missing).toEqual(['blackwork']);
    // Not incidental: 'color' IS in the prompt, and the state said NOT color.
    // Presence is not survival, and this is the half of the assertion that a
    // prompt happening to omit the word 'blackwork' would otherwise cover for.
    expect(report.violations[0].contradicted).toEqual(['color']);
  });

  it('catches a direct contradiction even when every term is present', () => {
    // The exact silence the negation handling exists to end: state says NO
    // color, prompt commands full color fills, both of the state's surviving
    // terms appear, and a presence-only check calls the whole thing clean.
    const state = bareState({ palette: 'blackwork, no color' });
    const prompt =
      'A tattoo on the forearm. Palette: blackwork lines with full color fills.';
    const report = checkPromptContract(state, prompt);
    expect(report.violations).toHaveLength(1);
    expect(report.violations[0].field).toBe('palette');
    expect(report.violations[0].missing).toEqual([]);
    expect(report.violations[0].contradicted).toEqual(['color']);
    expect(explainPromptContract(report)).toContain('contradicts');
  });

  it('accepts a negated assertion the prompt also negates', () => {
    const state = bareState({ palette: 'blackwork, no color' });
    const prompt = 'A tattoo on the forearm. Monochrome, zero color, pure blackwork.';
    expect(promptContractViolations(state, prompt)).toEqual([]);
  });

  it('flags a positive assertion the prompt negates', () => {
    // Mirror image, and the one a naive "is the word there" check gets wrong
    // in the friendliest-looking way: the state asked for colour and the
    // prompt says the word 'color' — while forbidding it.
    const state = bareState({ palette: 'full color' });
    const report = checkPromptContract(state, 'A full-bleed tattoo on the forearm, no color.');
    expect(report.violations[0].contradicted).toEqual(['color']);
  });

  it('does not let a negator reach across a sentence boundary', () => {
    // "no color" ends at the period. The next sentence's 'color' is a plain
    // positive mention, and reading it as negated would hand back a false
    // clean bill on a state that asked for colour.
    const state = bareState({ palette: 'full color' });
    const prompt = 'A tattoo on the forearm with no linework. Full color throughout.';
    expect(promptContractViolations(state, prompt)).toEqual([]);
  });

  it('passes when the palette survives verbatim', () => {
    const state = bareState({ palette: 'blackwork, no color' });
    expect(promptContractViolations(state, renderStatePrompt(state))).toEqual([]);
  });

  it('is checked with an empty roster, so roster-only cannot cover it', () => {
    const state = bareState({ palette: 'full color' });
    expect(state.roster).toEqual([]);
    expect(checkPromptContract(state, 'A tattoo on the forearm.').checkedFields).toContain(
      'palette'
    );
  });
});

describe('placement and medium', () => {
  it('flags a sleeve that rendered as an unplaced tattoo', () => {
    const state = bareState({ medium: 'tattoo sleeve on the forearm' });
    const prompt = 'A tattoo depicting a wolf.';
    const report = checkPromptContract(state, prompt);
    expect(report.violations).toHaveLength(1);
    expect(report.violations[0].field).toBe('medium');
    expect(report.violations[0].missing).toEqual(['sleeve', 'forearm']);
  });

  it('flags a placement that moved', () => {
    const state = bareState({ medium: 'tattoo on the ribs' });
    const report = checkPromptContract(state, 'A tattoo on the forearm depicting a wolf.');
    expect(report.violations[0].missing).toEqual(['ribs']);
  });
});

describe('the other asserted fields', () => {
  it('flags composition, action, aspect and visual target together', () => {
    const state = bareState({
      composition: 'totem',
      action: 'mid-combat',
      aspect: '9:11',
      visualTarget: 'cinematic framing',
    });
    // The medium DID survive into this prompt, so it is checked and clean —
    // which is the distinction the report has to be able to draw.
    const report = checkPromptContract(state, 'A tattoo on the forearm.');
    expect(report.checkedFields).toContain('medium');
    expect(report.violations.map((violation) => violation.field)).toEqual([
      'composition',
      'action',
      'aspect',
      'visualTarget',
    ]);
  });

  it('checks nothing it was not told — an unset field is not a violation', () => {
    const state = bareState();
    const report = checkPromptContract(state, renderStatePrompt(state));
    expect(report.violations).toEqual([]);
    expect(report.checkedFields).toEqual(['medium']);
  });

  it('carries a full state through its own render clean', () => {
    const state = withSubject(
      bareState({
        roster: ['Bowser'],
        medium: 'tattoo sleeve on the left arm',
        composition: 'totem',
        action: 'mid-combat',
        aspect: '9:11',
        palette: 'full color',
        visualTarget: 'cinematic framing and dramatic key lighting',
      }),
      'Bowser mid-combat'
    );
    const report = checkPromptContract(state, renderStatePrompt(state));
    expect(report.violations).toEqual([]);
    expect(report.subjectAssertion).toBe('present');
  });
});

describe('the fields that were easiest to forget', () => {
  it('holds the prompt to character identities, not just to names', () => {
    // Keeping "Sora" and losing "Kingdom Hearts" keeps the name and loses the
    // character. The roster check cannot see this: the name is right there.
    const state = bareState({
      roster: ['Sora'],
      identities: [{ name: 'Sora', series: 'Kingdom Hearts' }],
    });
    const report = checkPromptContract(state, 'A tattoo on the forearm depicting Sora.');
    expect(report.violations.map((violation) => violation.field)).toEqual(['identities']);
    expect(report.violations[0].missing).toEqual(['Kingdom', 'Hearts']);
    expect(report.checkedFields).toContain('identities');
  });

  it('holds the prompt to ADR-0010 customer directions', () => {
    const state = bareState({ directives: ['make it bigger'] });
    const report = checkPromptContract(state, 'A tattoo on the forearm.');
    expect(report.violations.map((violation) => violation.field)).toEqual(['directives']);
    expect(report.violations[0].missing).toEqual(['make', 'bigger']);
  });

  it('holds the prompt to exclusions NEGATIVELY — mentioning one is not carrying it', () => {
    // The failure a presence check cannot see: the customer said no flat
    // cel-shaded outlines, the rewrite kept the words and dropped the "avoid",
    // and the prompt now commands the thing they refused.
    const state = bareState({ exclusions: ['flat cel-shaded outlines'] });
    const inverted = 'A tattoo on the forearm with flat cel-shaded outlines.';
    const report = checkPromptContract(state, inverted);
    expect(report.violations.map((violation) => violation.field)).toEqual(['exclusions']);
    expect(report.violations[0].missing).toEqual([]);
    expect(report.violations[0].contradicted).toEqual(['flat', 'cel-shaded', 'outlines']);
  });

  it('accepts an exclusion the prompt actually excludes, across a list', () => {
    const state = bareState({ exclusions: ['flat cel-shaded outlines', 'harsh gradients'] });
    // The shape renderStatePrompt emits: one "Avoid:" label over a comma list.
    // A negator scoped to the next word or two would clear everything after
    // the first comma and report a contradiction on a correct prompt.
    const prompt = 'A tattoo on the forearm. Avoid: flat cel-shaded outlines, harsh gradients.';
    expect(promptContractViolations(state, prompt)).toEqual([]);
  });

  it('flags an exclusion the prompt dropped entirely', () => {
    const state = bareState({ exclusions: ['harsh gradients'] });
    const report = checkPromptContract(state, 'A tattoo on the forearm.');
    expect(report.violations[0].field).toBe('exclusions');
    expect(report.violations[0].missing).toEqual(['harsh', 'gradients']);
  });

  it('carries all ten DesignState fields through their own render clean', () => {
    // The exhaustiveness pin. The module header claims it covers every field
    // DesignState declares; this is the assertion that makes the claim
    // falsifiable rather than decorative. Add a field to DesignState, populate
    // it here, and this fails until PromptContractField and
    // checkPromptContract learn about it.
    // No subject: `DesignState` does not declare one, and this assertion is
    // about the ten fields it DOES declare all surviving their own render.
    const state = bareState({
      roster: ['Sora', 'Roxas'],
      identities: [{ name: 'Sora', series: 'Kingdom Hearts' }],
      medium: 'tattoo sleeve on the left arm',
      composition: 'totem',
      aspect: '9:11',
      palette: 'blackwork, no color',
      visualTarget: 'cinematic framing',
      action: 'mid-combat',
      exclusions: ['harsh gradients'],
      directives: ['make it bigger'],
    });
    const declared = Object.keys(state);
    expect(declared).toHaveLength(10);

    const report = checkPromptContract(state, renderStatePrompt(state));
    expect(report.violations).toEqual([]);
    expect(report.unverifiableFields).toEqual([]);
    for (const field of declared) {
      expect(report.checkedFields).toContain(field);
    }
  });
});

describe('coverage the report refuses to overstate', () => {
  it('does not count a field it could not verify as checked', () => {
    // A value made only of connective words has nothing a prompt could carry,
    // so calling it "checked" is a false claim of coverage — which is the one
    // thing this module exists to stop producing.
    const state = bareState({ visualTarget: 'with the it' });
    const report = checkPromptContract(state, 'A tattoo on the forearm.');
    expect(report.checkedFields).not.toContain('visualTarget');
    expect(report.unverifiableFields).toEqual(['visualTarget']);
    expect(report.violations).toEqual([]);
  });

  it('says out loud that a field went unverified', () => {
    const state = bareState({ palette: 'the of' });
    expect(explainPromptContract(checkPromptContract(state, 'A tattoo on the forearm.'))).toBe(
      'Prompt carries all 1 asserted field. No subject was asserted to check. ' +
        'palette held no checkable term and was NOT verified.'
    );
  });
});

describe('whole-word matching — the rosterOmissions discipline', () => {
  it('does not let "Sorapunk" count as Sora', () => {
    const state = bareState({ roster: ['Sora'] });
    const prompt = 'A tattoo on the forearm in a Sorapunk aesthetic.';
    const report = checkPromptContract(state, prompt);
    expect(report.violations[0].field).toBe('roster');
    expect(report.violations[0].missing).toEqual(['Sora']);
  });

  it('does not let "colorless" satisfy a state asserting color', () => {
    const state = bareState({ palette: 'full color' });
    const prompt = 'A full colorless tattoo on the forearm.';
    const report = checkPromptContract(state, prompt);
    expect(report.violations[0].missing).toEqual(['color']);
  });

  it('does not let a subject term match inside a longer word', () => {
    const state = withSubject(bareState(), 'a cracked visor');
    const report = checkPromptContract(state, 'A tattoo on the forearm with a visored helmet.');
    expect(report.subjectAssertion).toBe('missing');
    expect(report.violations[0].missing).toEqual(['cracked', 'visor']);
  });

  it('matches case-insensitively', () => {
    const state = bareState({ roster: ['Sora'] });
    expect(promptContractViolations(state, 'A tattoo on the forearm of SORA.')).toEqual([]);
  });

  it('treats an INTERIOR regex metacharacter in a value as literal text', () => {
    // This test exists to pin `mentionsTerm`'s escaping, and it has to be able
    // to fail when the escaping is deleted. ':' cannot do that — it is not a
    // metacharacter, so '9:11' matches identically escaped or not, and a test
    // built on it certifies nothing while carrying a name that says it does.
    // '.' can: unescaped it is a wildcard, and '9x5:1' satisfies it.
    const state = bareState({ aspect: '9.5:1' });
    expect(mentionsTerm('Framed at 9.5:1.', '9.5:1')).toBe(true);
    expect(mentionsTerm('Framed at 9x5:1.', '9.5:1')).toBe(false);
    expect(
      promptContractViolations(state, 'A tattoo on the forearm. Framed at 9x5:1.')
    ).toHaveLength(1);
  });
});

describe('term extraction', () => {
  it('keeps the load-bearing words and drops the connective tissue', () => {
    expect(contractTerms('a tattoo sleeve on the forearm')).toEqual([
      'tattoo',
      'sleeve',
      'forearm',
    ]);
  });

  it('strips edge punctuation but keeps a term whole', () => {
    expect(contractTerms('blackwork, no color')).toEqual(['blackwork', 'color']);
    expect(contractTerms('photographic realism — true-to-life texture')).toEqual([
      'photographic',
      'realism',
      'true-to-life',
      'texture',
    ]);
  });

  it('collapses a repeated word into one requirement', () => {
    expect(contractTerms('color on color')).toEqual(['color']);
  });
});

describe('the structural subject read', () => {
  it('finds nothing on a state that has no subject field', () => {
    expect(assertedSubject(bareState())).toBeUndefined();
  });

  it('reads a subject when one is attached', () => {
    expect(assertedSubject(withSubject(bareState(), 'an astronaut'))).toBe('an astronaut');
  });

  it('accepts "scene" as the alias, so a naming choice cannot blind the guard', () => {
    const state = { ...bareState(), scene: 'a cracked visor' } as DesignState;
    expect(assertedSubject(state)).toBe('a cracked visor');
  });

  it('treats an empty or non-string subject as not asserted', () => {
    expect(assertedSubject(withSubject(bareState(), '   '))).toBeUndefined();
    expect(assertedSubject({ ...bareState(), subject: 42 } as unknown as DesignState)).toBeUndefined();
  });
});

describe('explanations', () => {
  it('names the field, the asserted value and the missing words', () => {
    const state = bareState({ palette: 'full color' });
    const [violation] = promptContractViolations(state, 'A tattoo on the forearm. Palette: blackwork.');
    expect(explainViolation(violation)).toBe(
      'palette: state asserts "full color" but the prompt never says "full", "color".'
    );
  });

  it('says how much was verified when nothing is wrong', () => {
    const state = bareState();
    const report = checkPromptContract(state, renderStatePrompt(state));
    expect(explainPromptContract(report)).toBe(
      'Prompt carries all 1 asserted field. No subject was asserted to check.'
    );
  });

  it('does not claim a subject was checked when one was present and fine', () => {
    const state = withSubject(bareState(), 'an astronaut');
    const report = checkPromptContract(state, 'A tattoo on the forearm depicting an astronaut.');
    expect(explainPromptContract(report)).toBe('Prompt carries all 2 asserted fields.');
  });
});
