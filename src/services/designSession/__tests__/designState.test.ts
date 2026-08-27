/**
 * The design state object (ADR-0060).
 *
 * Pinned against the session that caused the ADR — 2026-08-05, "a kingdom
 * hearts sleeve with roxas and sora fight link from zelda and boswer from
 * mario". Every failure in that transcript gets a test here, in the
 * customer's own words, so the fix is provably the fix and not a fix for
 * something adjacent.
 *
 * Pure module: no mocks, no session store, no provider.
 */
import { describe, it, expect } from 'vitest';
import {
  MAX_DIRECTIVES,
  PRESENTATION_LEAD,
  applyCritique,
  deriveDesignState,
  hydrateDesignState,
  renderStatePrompt,
  rosterOmissions,
  stateOmissions,
  withPickedCut,
} from '../internal/designState';
import type { DesignState } from '../internal/designState';
import type { IntakeRecord } from '../../intake/types';
import { resolvePalette } from '../../intake/settledAxes';
import {
  PRESENTATION_LEAD as COUNCIL_PRESENTATION_LEAD,
  stripChromaticWords,
} from '../../council';

/** The failing session's intake, as it would have been extracted. */
function smashIntake(overrides: Partial<IntakeRecord> = {}): IntakeRecord {
  return {
    placement: 'left arm',
    styleTags: ['anime', 'illustrative'],
    meaning: 'a kingdom hearts sleeve',
    subject: 'Roxas and Sora fighting Link and Bowser',
    requestedCharacters: ['Roxas', 'Sora', 'Link', 'Bowser'],
    characterIdentities: [
      { name: 'Roxas', series: 'Kingdom Hearts' },
      { name: 'Sora', series: 'Kingdom Hearts' },
      { name: 'Link', series: 'The Legend of Zelda' },
      { name: 'Bowser', series: 'Super Mario' },
    ],
    references: [],
    ambiguousAxes: [],
    ...overrides,
  };
}

describe('deriveDesignState — the state a session starts with', () => {
  it('carries every requested character, in mention order', () => {
    expect(deriveDesignState(smashIntake()).roster).toEqual([
      'Roxas',
      'Sora',
      'Link',
      'Bowser',
    ]);
  });

  it('reads the sleeve out of the meaning, not just the placement tag', () => {
    // "a kingdom hearts sleeve" with placement "left arm" is a sleeve request;
    // the placement tag alone loses the scale of it.
    expect(deriveDesignState(smashIntake()).medium).toBe('tattoo sleeve on the left arm');
  });

  it('is a plain tattoo when nothing says sleeve', () => {
    const state = deriveDesignState(
      smashIntake({ meaning: 'for my grandfather', placement: 'forearm' })
    );
    expect(state.medium).toBe('tattoo on the forearm');
  });

  it('falls back to the identity names when no roster was extracted', () => {
    const state = deriveDesignState(smashIntake({ requestedCharacters: undefined }));
    expect(state.roster).toEqual(['Roxas', 'Sora', 'Link', 'Bowser']);
  });

  it('reads a monochrome palette off the style tags', () => {
    expect(deriveDesignState(smashIntake({ styleTags: ['blackwork'] })).palette).toBe(
      'blackwork, no color'
    );
    expect(deriveDesignState(smashIntake({ styleTags: ['neo-traditional'] })).palette).toBe(
      'full color'
    );
  });

  it('leaves the palette unset when intake resolved no style at all', () => {
    // Unset renders as nothing. A guessed field renders as confidently as a
    // known one, which is the failure this object exists to stop.
    expect(deriveDesignState(smashIntake({ styleTags: [] })).palette).toBeUndefined();
  });

  it('does not invent a visual target or an action out of the prose', () => {
    const state = deriveDesignState(smashIntake());
    expect(state.visualTarget).toBeUndefined();
    expect(state.action).toBeUndefined();
  });
});

describe('the roster is non-negotiable (ADR-0060)', () => {
  it('renders all four characters, which is the whole original defect', () => {
    // The proposal came back "roxas and sora" — two of four, silently.
    const prompt = renderStatePrompt(deriveDesignState(smashIntake()));
    for (const name of ['Roxas', 'Sora', 'Link', 'Bowser']) {
      expect(prompt).toContain(name);
    }
    expect(prompt).toContain('exactly four distinct figures');
    expect(prompt).toContain('No duplicates and no omissions');
  });

  it('"you dropped some of the characters i mentioned" needs no state change', () => {
    // The customer should never have had to say this. Re-rendering the state
    // already carries all four — the turn changes nothing and fixes it anyway.
    const state = deriveDesignState(smashIntake());
    const { state: after } = applyCritique(state, 'you dropped some of the characters i mentioned');
    expect(after.roster).toEqual(state.roster);
    expect(renderStatePrompt(after)).toContain('Bowser');
  });

  it('no critique removes a name from the roster', () => {
    const state = deriveDesignState(smashIntake());
    for (const message of ['no bowser', 'drop the link', 'get rid of the sora', 'without roxas']) {
      expect(applyCritique(state, message).state.roster).toEqual(state.roster);
    }
  });

  it('rosterOmissions catches a prompt that names fewer than the state does', () => {
    const state = deriveDesignState(smashIntake());
    // The exact contradiction ADR-0060 says is detectable: four in state, two
    // in the prompt.
    expect(rosterOmissions(state, 'a color anime piece on your sleeve — Roxas and Sora')).toEqual([
      'Link',
      'Bowser',
    ]);
  });

  it('rosterOmissions is empty for the prompt the state actually renders', () => {
    const state = deriveDesignState(smashIntake());
    expect(rosterOmissions(state, renderStatePrompt(state))).toEqual([]);
  });

  it('rosterOmissions matches whole words, so a substring is not a hit', () => {
    const state: DesignState = {
      ...deriveDesignState(smashIntake()),
      roster: ['Sora'],
    };
    expect(rosterOmissions(state, 'a Sorapunk sleeve')).toEqual(['Sora']);
    expect(rosterOmissions(state, 'a sleeve with sora in it')).toEqual([]);
  });
});

describe('a chosen composition becomes state', () => {
  it('the picked cut\'s composition sticks to every later render', () => {
    const state = withPickedCut(deriveDesignState(smashIntake()), {
      axisPosition: { composition: 'the totem' },
    });
    expect(state.composition).toBe('the totem');
    expect(renderStatePrompt(state)).toContain('Composition: the totem.');
  });

  it('a round cut with no composition axis leaves the field alone', () => {
    const state = deriveDesignState(smashIntake());
    expect(withPickedCut(state, { axisPosition: { 'bold-fine': 'bold' } })).toEqual(state);
  });

  it('composition comes from the resolved cut, never from parsing the words', () => {
    // The failing turn was "the totem is the one i like most ... 9:11", and the
    // system answered "re-cut cut one with that" — cut one was *the run*.
    //
    // The fix is NOT to grep the sentence for "totem". `resolveCritiqueTarget`
    // already owns which cut a message names, and it is the only thing that
    // should: parsing composition words here would have made "can you run it
    // again" set the composition to *the run*. So applyCritique deliberately
    // leaves composition alone, and withPickedCut takes it from the cut the
    // resolver actually returned.
    const message = 'the totem is the one i like most can i get it as a 9:11 image this time';
    expect(applyCritique(deriveDesignState(smashIntake()), message).state.composition).toBeUndefined();

    const resolved = withPickedCut(deriveDesignState(smashIntake()), {
      axisPosition: { composition: 'stacked tiers' },
    });
    const { state } = applyCritique(resolved, message);
    expect(state.composition).toBe('stacked tiers');
    expect(state.aspect).toBe('9:11');
    expect(renderStatePrompt(state)).toContain('Composition: stacked tiers.');
  });

  it('a common word that happens to be a cut name does not become composition', () => {
    // "the run" is a real cut name. "can you run it again" is not a request for
    // it, and a table of composition words could not tell the difference.
    const { state } = applyCritique(deriveDesignState(smashIntake()), 'can you run it again');
    expect(state.composition).toBeUndefined();
  });
});

describe('one turn can move more than one field', () => {
  it('"9:11 with the unreal engine changes" sets aspect AND the visual target', () => {
    const { state, changed } = applyCritique(
      deriveDesignState(smashIntake()),
      'can i get it as a 9:11 image this time with the unreal engine changes i mentioned'
    );
    expect(state.aspect).toBe('9:11');
    expect(state.visualTarget).toContain('physically based materials');
    expect(changed).toEqual(expect.arrayContaining(['aspect', 'visualTarget']));
  });

  it('an aspect with spaces in it still parses', () => {
    expect(applyCritique(deriveDesignState(smashIntake()), 'make it 9 : 11').state.aspect).toBe(
      '9:11'
    );
  });
});

describe('style words are translated, not pasted (ADR-0060)', () => {
  it('"more like an unreal engine 5 look" becomes concrete controls', () => {
    // Asked three times in the failing session and never landed, because three
    // words at the tail of a 400-word prompt weigh nothing.
    const { state } = applyCritique(
      deriveDesignState(smashIntake()),
      'i was thinking more like an unreal engine 5 look'
    );
    expect(state.visualTarget).toContain('physically based materials');
    expect(state.visualTarget).toContain('cinematic lighting');
    expect(state.visualTarget).toContain('volumetric effects');
    expect(state.exclusions).toContain('flat cel-shaded outlines');
    // And it is not at the tail, which is where the old append put it and
    // where the lane weighted it near zero: it renders ahead of the
    // exclusions, the free-text directives, and the closing boilerplate.
    const prompt = renderStatePrompt(state);
    const target = prompt.indexOf('physically based materials');
    expect(target).toBeGreaterThan(-1);
    expect(target).toBeLessThan(prompt.indexOf('Avoid:'));
    expect(target).toBeLessThan(prompt.indexOf('Clean readable forms'));
  });

  it('asking twice leaves ONE value, not two competing sentences', () => {
    // This is the entire difference from the old append. The prompt used to
    // grow; now the field is set.
    let state = deriveDesignState(smashIntake());
    state = applyCritique(state, 'more like an unreal engine 5 look').state;
    state = applyCritique(state, 'i said unreal engine 5').state;
    const prompt = renderStatePrompt(state);
    expect(prompt.match(/physically based materials/g)).toHaveLength(1);
    expect(state.exclusions.filter((e) => e === 'flat cel-shaded outlines')).toHaveLength(1);
  });

  it('a later style request supersedes an earlier one instead of fighting it', () => {
    let state = deriveDesignState(smashIntake());
    state = applyCritique(state, 'more like a watercolor look').state;
    state = applyCritique(state, 'actually more like an unreal engine 5 look').state;
    expect(state.visualTarget).toContain('physically based materials');
    expect(state.visualTarget).not.toContain('watercolor');
  });

  it('an untranslated style word asks rather than pasting', () => {
    const { unresolvedStyle, changed } = applyCritique(
      deriveDesignState(smashIntake()),
      'more like a vaporwave brutalist look'
    );
    expect(unresolvedStyle).toBe('more like a vaporwave brutalist look');
    expect(changed).toEqual([]);
  });

  it('an untranslated style word does not become a directive', () => {
    // Pasting it is exactly what the ADR rejects — it would render as an
    // unweighted phrase and read to the customer as if it had been applied.
    const { state } = applyCritique(deriveDesignState(smashIntake()), 'give it a mumblecore look');
    expect(renderStatePrompt(state)).not.toContain('mumblecore');
  });

  it('a translated style word raises no question', () => {
    expect(
      applyCritique(deriveDesignState(smashIntake()), 'more like a watercolor look').unresolvedStyle
    ).toBeUndefined();
  });
});

describe('palette, action and exclusions', () => {
  it('"less color" quiets the palette', () => {
    const { state } = applyCritique(deriveDesignState(smashIntake()), 'too colorful');
    expect(state.palette).toContain('less saturation');
  });

  it('"fight" sets the action', () => {
    expect(applyCritique(deriveDesignState(smashIntake()), 'have them fighting').state.action).toBe(
      'fighting'
    );
  });

  it('a negative critique becomes an exclusion, deduplicated', () => {
    let state = deriveDesignState(smashIntake());
    state = applyCritique(state, 'no background clutter').state;
    state = applyCritique(state, 'no background clutter').state;
    expect(state.exclusions.filter((e) => e === 'background clutter')).toHaveLength(1);
    expect(renderStatePrompt(state)).toContain('Avoid: background clutter.');
  });
});

describe('directives — the words that resolve to no field', () => {
  it('are kept verbatim rather than lost (ADR-0010)', () => {
    const { state, changed } = applyCritique(
      deriveDesignState(smashIntake()),
      'his jacket is the wrong one'
    );
    expect(state.directives).toEqual(['his jacket is the wrong one']);
    expect(changed).toEqual(['directives']);
    expect(renderStatePrompt(state)).toContain(
      'Customer direction: "his jacket is the wrong one".'
    );
  });

  it('still translate the complaints the old cue table knew', () => {
    // These came across from `adjustPromptForCritique`. Losing them on the way
    // to a state object would have been a silent downgrade — the table was
    // never the problem, only where its output went.
    const state = deriveDesignState(smashIntake());
    expect(applyCritique(state, 'too busy').state.directives[0]).toContain('negative space');
    expect(applyCritique(state, 'make the keyblades bigger').state.directives[0]).toContain(
      'scaled up'
    );
    expect(applyCritique(state, 'too dark').state.directives[0]).toContain('softer contrast');
  });

  it('keep the customer\'s words alongside the technical reading', () => {
    const { state } = applyCritique(deriveDesignState(smashIntake()), 'too busy');
    expect(state.directives[0]).toContain('too busy');
  });

  it('newest wins — a later direction renders ahead of an earlier one', () => {
    // The old append buried later corrections behind earlier ones. This is the
    // ordering that stops that.
    let state = deriveDesignState(smashIntake());
    state = applyCritique(state, 'his jacket is the wrong one').state;
    state = applyCritique(state, 'tilt the whole thing left').state;
    const prompt = renderStatePrompt(state);
    expect(prompt.indexOf('tilt the whole thing left')).toBeLessThan(
      prompt.indexOf('his jacket is the wrong one')
    );
  });

  it('repeating a direction does not duplicate it', () => {
    let state = deriveDesignState(smashIntake());
    state = applyCritique(state, 'his jacket is the wrong one').state;
    state = applyCritique(state, 'his jacket is the wrong one').state;
    expect(state.directives).toEqual(['his jacket is the wrong one']);
  });

  it('are capped, so a long session cannot silt up the prompt', () => {
    let state = deriveDesignState(smashIntake());
    for (const words of ['aaa one', 'bbb two', 'ccc three', 'ddd four', 'eee five']) {
      state = applyCritique(state, words).state;
    }
    expect(state.directives).toHaveLength(MAX_DIRECTIVES);
    expect(state.directives[0]).toBe('eee five');
    expect(state.directives).not.toContain('aaa one');
  });

  it('a turn that resolved to a real field adds no directive', () => {
    const { state } = applyCritique(deriveDesignState(smashIntake()), 'make it 9:11');
    expect(state.directives).toEqual([]);
  });
});

describe('the prompt is a pure function of the state', () => {
  it('the same state yields the same prompt', () => {
    const state = deriveDesignState(smashIntake());
    expect(renderStatePrompt(state)).toBe(renderStatePrompt(state));
  });

  it('applyCritique never mutates the state it was given', () => {
    const state = deriveDesignState(smashIntake());
    const before = JSON.stringify(state);
    applyCritique(state, 'make it 9:11 with an unreal engine 5 look and no clutter');
    expect(JSON.stringify(state)).toBe(before);
  });

  it('a state with no characters still renders a usable prompt', () => {
    const state = deriveDesignState({
      placement: 'forearm',
      styleTags: [],
      meaning: 'for my grandfather',
      references: [],
      ambiguousAxes: [],
    });
    const prompt = renderStatePrompt(state);
    // A dedication is not a scene, so it is expressed rather than depicted —
    // the same line `subjectClause` draws. "depicting for my grandfather" is
    // not a sentence.
    expect(prompt).toContain('A tattoo design expressing "for my grandfather".');
    // The placement still reaches the prompt; it just no longer opens it.
    expect(prompt).toContain('Composed for a tattoo on the forearm.');
  });

  it('one character reads as one character, not as a list of one', () => {
    const state = deriveDesignState(
      smashIntake({ requestedCharacters: ['Sora'], characterIdentities: [] })
    );
    expect(renderStatePrompt(state)).toContain('A tattoo design depicting Sora');
    expect(renderStatePrompt(state)).not.toContain('exactly one distinct figures');
  });

  it('speaks a name-only identity as a name, never inventing a series', () => {
    // The grounding fix from #346 holds here too: blank series means "we could
    // not verify it", not "there is none".
    const state = deriveDesignState(
      smashIntake({
        requestedCharacters: ['Sora', 'Kirby'],
        characterIdentities: [
          { name: 'Sora', series: 'Kingdom Hearts' },
          { name: 'Kirby', series: '' },
        ],
      })
    );
    const prompt = renderStatePrompt(state);
    expect(prompt).toContain('Sora — Kingdom Hearts');
    expect(prompt).toContain('; Kirby.');
    expect(prompt).not.toContain('Kirby — ');
  });
});

/**
 * Session 2026-08-25 — "an astronaut on the moon whose glass mask cracked,
 * gasping for his last breath, galaxy and stars behind", on the back, in
 * color with clean lines.
 *
 * The reveal was right. The first re-cut was a black-and-grey eagle on a
 * woman's back, from this prompt:
 *
 *   A tattoo on the back. Palette: blackwork, no color. Customer direction:
 *   "The bold one". Clean readable forms with deliberate focal hierarchy...
 *
 * Three defects in one sentence: the idea is gone, the prompt asks for a
 * photograph of skin, and a line-weight tag turned a color piece monochrome.
 * The tests above all use a roster of named IP characters, which is exactly
 * why this shipped — every guard in the module was vacuous for a brief with
 * nobody to name.
 */
function astronautIntake(overrides: Partial<IntakeRecord> = {}): IntakeRecord {
  return {
    placement: 'back',
    styleTags: ['color', 'fine-line'],
    meaning: 'an astronaut on the moon whose glass mask cracked, gasping for his last breath, galaxy and stars behind',
    subject: 'an astronaut on the moon whose glass mask cracked, gasping for his last breath, galaxy and stars behind',
    references: [],
    ambiguousAxes: [],
    ...overrides,
  };
}

describe('the subject is the design (2026-08-25)', () => {
  it('a brief with no named character still has a state that holds its idea', () => {
    const state = deriveDesignState(astronautIntake());
    expect(state.roster).toEqual([]);
    expect(state.subject).toContain('astronaut on the moon');
  });

  it('falls back to the meaning when intake extracted no structured subject', () => {
    const state = deriveDesignState(astronautIntake({ subject: undefined }));
    expect(state.subject).toContain('glass mask cracked');
  });

  it('renders the idea — the defect was a prompt with no astronaut in it', () => {
    const prompt = renderStatePrompt(deriveDesignState(astronautIntake()));
    for (const fragment of ['astronaut', 'moon', 'glass mask cracked', 'galaxy and stars']) {
      expect(prompt).toContain(fragment);
    }
  });

  it('leads with the idea, ahead of everything the broken prompt led with', () => {
    // Early tokens win. The subject goes first because it is the design; the
    // palette, the customer's direction and the boilerplate all follow it.
    const state = applyCritique(deriveDesignState(astronautIntake()), 'The bold one').state;
    const prompt = renderStatePrompt(state);
    const subject = prompt.indexOf('astronaut');
    expect(subject).toBeGreaterThan(-1);
    expect(subject).toBeLessThan(prompt.indexOf('Palette:'));
    expect(subject).toBeLessThan(prompt.indexOf('Customer direction:'));
    expect(subject).toBeLessThan(prompt.indexOf('Clean readable forms'));
  });

  it('sits alongside a roster rather than replacing it', () => {
    // Both, the way `subjectClause` does it: the roster is the lossless cast
    // list, the subject is the prose that says what they are doing.
    const prompt = renderStatePrompt(deriveDesignState(smashIntake()));
    expect(prompt).toContain(
      'one each of Roxas, Sora, Link, and Bowser: Roxas and Sora fighting Link and Bowser.'
    );
    expect(prompt).toContain('No duplicates and no omissions');
  });

  it('hydrates a state persisted before the field existed', () => {
    const legacy: DesignState = {
      ...deriveDesignState(astronautIntake()),
      subject: undefined,
    };
    expect(hydrateDesignState(legacy, astronautIntake()).subject).toContain('astronaut');
  });

  it('hydration returns the same object when there is nothing to fill', () => {
    const state = deriveDesignState(astronautIntake());
    expect(hydrateDesignState(state, astronautIntake())).toBe(state);
    // And an intake with no idea in it cannot invent one.
    const bare: DesignState = { ...state, subject: undefined };
    expect(hydrateDesignState(bare, { ...astronautIntake(), subject: undefined, meaning: '' })).toBe(
      bare
    );
  });
});

describe('the prompt asks for artwork, not a photograph of skin (ADR-0023)', () => {
  it('is the Council\'s clause itself, not a lookalike of it', () => {
    // One string, two lanes. The trim is the only difference: the Council
    // concatenates, this module joins.
    expect(PRESENTATION_LEAD).toBe(COUNCIL_PRESENTATION_LEAD.trim());
    expect(PRESENTATION_LEAD).toContain('pure white background');
  });

  it('front-loads the flash-art presentation the AR preview depends on', () => {
    // The placement preview strips near-white to alpha; an on-skin render has
    // nothing to strip, so `assessBackdrop` refuses it. The reveal path was
    // fixed for this; the re-cut path never was.
    const prompt = renderStatePrompt(deriveDesignState(astronautIntake()));
    expect(prompt.startsWith(PRESENTATION_LEAD)).toBe(true);
  });

  it('never opens with "A tattoo on the <placement>" — that measured 0/12', () => {
    for (const state of [
      deriveDesignState(astronautIntake()),
      deriveDesignState(smashIntake()),
      deriveDesignState(smashIntake({ requestedCharacters: ['Sora'], characterIdentities: [] })),
    ]) {
      const prompt = renderStatePrompt(state);
      expect(prompt).not.toMatch(/^A tattoo on the/);
      expect(prompt).not.toContain('A tattoo on the back.');
    }
  });

  it('keeps the placement, demoted to a composition instruction at the tail', () => {
    // Losing it entirely would cost the sleeve/back distinction, which nothing
    // else in the state carries. It just no longer sits at token five.
    const prompt = renderStatePrompt(deriveDesignState(astronautIntake()));
    expect(prompt).toContain('Composed for a tattoo on the back.');
    expect(prompt.indexOf('Composed for a tattoo on the back.')).toBeGreaterThan(
      prompt.indexOf('astronaut')
    );
  });
});

describe('the palette is one decision, not two (2026-08-25)', () => {
  it('"color and clean lines" is a COLOR piece', () => {
    // The reveal rendered full color. The re-cut came back monochrome because
    // this module kept a private copy of the palette rule with the precedence
    // missing — 'fine-line' outvoted the word "color" the customer said.
    expect(deriveDesignState(astronautIntake()).palette).toBe('full color');
    expect(renderStatePrompt(deriveDesignState(astronautIntake()))).toContain(
      'Palette: full color.'
    );
  });

  it('color wins a tag conflict, because that is resolvePalette\'s rule', () => {
    expect(deriveDesignState(astronautIntake({ styleTags: ['blackwork', 'color'] })).palette).toBe(
      'full color'
    );
    expect(deriveDesignState(astronautIntake({ styleTags: ['fine-line', 'watercolor'] })).palette).toBe(
      'full color'
    );
  });

  it('monochrome tags still mean monochrome, line-weight tags included', () => {
    // 'fine-line' reading monochrome on its own is not the bug and is not
    // fixed here: it is what the reveal does today, and the two lanes agreeing
    // is worth more than this module having a private opinion.
    for (const tags of [['blackwork'], ['black-and-grey'], ['dotwork'], ['fine-line'], ['geometric']]) {
      expect(deriveDesignState(astronautIntake({ styleTags: tags })).palette).toBe(
        'blackwork, no color'
      );
    }
  });

  it('still answers for tags the closed ontology never resolved', () => {
    // 'tribal' is an ontology id resolvePalette has never listed; the local
    // fallback is what covers it, and prose-shaped variants besides.
    expect(deriveDesignState(astronautIntake({ styleTags: ['tribal'] })).palette).toBe(
      'blackwork, no color'
    );
    expect(deriveDesignState(astronautIntake({ styleTags: ['black and grey'] })).palette).toBe(
      'blackwork, no color'
    );
  });

  it('never disagrees with the resolver the reveal uses', () => {
    // The regression that matters. Any tag set resolvePalette has an opinion
    // about must get that same opinion here — one rule, one answer, no second
    // copy to drift.
    const TAG_SETS = [
      ['color'],
      ['color', 'fine-line'],
      ['blackwork'],
      ['blackwork', 'color'],
      ['fine-line'],
      ['black-and-grey'],
      ['dotwork'],
      ['geometric'],
      ['watercolor'],
      ['neo-traditional'],
      ['new-school'],
      ['anime', 'illustrative'],
    ];
    for (const tags of TAG_SETS) {
      const resolved = resolvePalette(tags);
      if (resolved === 'unresolved') continue;
      expect(deriveDesignState(astronautIntake({ styleTags: tags })).palette).toBe(
        resolved === 'color' ? 'full color' : 'blackwork, no color'
      );
    }
  });

  it('a brief that resolved no style at all still commits to nothing', () => {
    expect(deriveDesignState(astronautIntake({ styleTags: [] })).palette).toBeUndefined();
  });
});

describe('a monochrome design does not front-load color words', () => {
  it('strips the chromatic words out of the subject prose', () => {
    // The Council measured this: a blackwork session front-loaded with "zero
    // color" still came back with an orange gi 4/4, because explicit positive
    // color words beat a negative every time. The re-cut now front-loads
    // subject prose, so it inherits the same exposure — and the same fix,
    // imported rather than copied.
    const state = deriveDesignState(
      astronautIntake({
        styleTags: ['blackwork'],
        subject: 'a red fox under a golden moon with emerald eyes',
      })
    );
    const prompt = renderStatePrompt(state);
    expect(prompt).toContain('Palette: blackwork, no color.');
    expect(prompt).toContain('fox');
    // Word boundaries: "centered" in the presentation lead contains "red".
    for (const word of ['red', 'golden', 'emerald']) {
      expect(prompt).not.toMatch(new RegExp(`\\b${word}\\b`, 'i'));
    }
  });

  it('strips exactly what the Council strips', () => {
    // Same function, not a lookalike: the strip is imported from the Council,
    // so this pins the wiring rather than a second copy of the word list.
    const SUBJECTS = [
      'a red fox under a golden moon with emerald eyes',
      'Son Goku in an orange gi with a blue undershirt and belt',
      'a black wolf in white snow',
      'crimson koi, teal water, indigo sky',
      'an astronaut on the moon whose glass mask cracked',
    ];
    for (const subject of SUBJECTS) {
      const state = deriveDesignState(astronautIntake({ styleTags: ['blackwork'], subject }));
      expect(renderStatePrompt(state)).toContain(stripChromaticWords(subject));
    }
  });

  it('leaves a color design\'s subject exactly as the customer said it', () => {
    const state = deriveDesignState(
      astronautIntake({ styleTags: ['color'], subject: 'a red fox under a golden moon' })
    );
    expect(renderStatePrompt(state)).toContain('a red fox under a golden moon');
  });

  it('keeps tonal words, which are what a blackwork piece is made of', () => {
    const state = deriveDesignState(
      astronautIntake({ styleTags: ['blackwork'], subject: 'a black wolf in white snow' })
    );
    expect(renderStatePrompt(state)).toContain('a black wolf in white snow');
  });

  it('the omission guard reads the stripped subject, not the raw field', () => {
    // Otherwise the guard would report a dropped subject every single time the
    // renderer correctly removed a color word.
    const state = deriveDesignState(
      astronautIntake({
        styleTags: ['blackwork'],
        subject: 'a red fox under a golden moon with emerald eyes',
      })
    );
    expect(stateOmissions(state, renderStatePrompt(state)).subject).toBeUndefined();
    // And it still fires when the prose really is gone.
    expect(stateOmissions(state, 'A tattoo design.').subject).toContain('fox');
  });
});

describe('a picked pole is a decision, and decisions become state (ADR-0049)', () => {
  it('picking the color cut carries color into the re-cut', () => {
    // A re-cut never goes through the Council, so this field is the only thing
    // that can carry the pole the customer chose. Losing it is the astronaut
    // defect in a different field.
    const state = withPickedCut(deriveDesignState(astronautIntake({ styleTags: ['blackwork'] })), {
      axisPosition: { 'color-blackwork': 'color' },
    });
    expect(state.palette).toBe('full color');
    expect(renderStatePrompt(state)).toContain('Palette: full color.');
  });

  it('picking the blackwork cut carries blackwork just the same', () => {
    const state = withPickedCut(deriveDesignState(astronautIntake()), {
      axisPosition: { 'color-blackwork': 'blackwork' },
    });
    expect(state.palette).toBe('blackwork, no color');
  });

  it('a pick outranks the palette the style tags derived', () => {
    // Later, stronger evidence: they saw both and chose.
    const derived = deriveDesignState(astronautIntake());
    expect(derived.palette).toBe('full color');
    expect(
      withPickedCut(derived, { axisPosition: { 'color-blackwork': 'blackwork' } }).palette
    ).toBe('blackwork, no color');
  });

  it('carries composition and palette from the same pick', () => {
    const state = withPickedCut(deriveDesignState(astronautIntake()), {
      axisPosition: { composition: 'the totem', 'color-blackwork': 'blackwork' },
    });
    expect(state.composition).toBe('the totem');
    expect(state.palette).toBe('blackwork, no color');
  });

  it('leaves bold-fine alone — there is no field for it to land in', () => {
    const state = deriveDesignState(astronautIntake());
    expect(withPickedCut(state, { axisPosition: { 'bold-fine': 'fine' } })).toBe(state);
  });

  it('a picked palette also strips the subject, end to end', () => {
    const state = withPickedCut(
      deriveDesignState(astronautIntake({ subject: 'a red fox under a golden moon' })),
      { axisPosition: { 'color-blackwork': 'blackwork' } }
    );
    const prompt = renderStatePrompt(state);
    expect(prompt).toContain('fox');
    expect(prompt).not.toMatch(/\bred\b/i);
    expect(prompt).not.toMatch(/\bgolden\b/i);
  });
});

describe('a dropped subject is as detectable as a dropped roster member', () => {
  it('rosterOmissions is vacuous when nobody was named — hence the sibling', () => {
    const state = deriveDesignState(astronautIntake());
    // The broken prompt, verbatim. Zero omissions: the spend guard waved it
    // through, and the customer paid for an eagle.
    const broken =
      'A tattoo on the back. Palette: blackwork, no color. Customer direction: "The bold one".';
    expect(rosterOmissions(state, broken)).toEqual([]);
    expect(stateOmissions(state, broken).subject).toContain('astronaut on the moon');
  });

  it('is clean for the prompt the state actually renders', () => {
    const state = applyCritique(deriveDesignState(astronautIntake()), 'The bold one').state;
    expect(stateOmissions(state, renderStatePrompt(state))).toEqual({
      roster: [],
      subject: undefined,
    });
  });

  it('still reports a dropped roster member, exactly as before', () => {
    const state = deriveDesignState(smashIntake());
    const half = 'a color anime piece on your sleeve — Roxas and Sora';
    expect(stateOmissions(state, half).roster).toEqual(['Link', 'Bowser']);
  });

  it('says nothing about a state that has no subject to drop', () => {
    const state: DesignState = { ...deriveDesignState(smashIntake()), subject: undefined };
    expect(stateOmissions(state, renderStatePrompt(state)).subject).toBeUndefined();
  });
});
