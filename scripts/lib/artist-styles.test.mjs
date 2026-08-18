import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { resolveCanonicalStyle } from '@/lib/style-vocabulary';
import {
  CANONICAL_STYLE_NAMES,
  ONTOLOGY_STYLE_LABELS,
  STYLE_PATTERNS,
  extractStyleEvidence,
  stylesFromBio,
  rejectSpuriousEvidence,
  isSafeArtistId,
  normalizeStyleRecord,
  normalizeGraphStyleList,
  normalizeOntologyStyleList,
  toStylePairs,
  resolveOntologyLabel,
  graphStyleName,
} from './artist-styles.mjs';

// Read the real vocabulary files — the same pair src/lib/style-vocabulary.ts
// reads — so growth of either one is caught here rather than in production.
const readData = (f) => JSON.parse(readFileSync(path.join(process.cwd(), 'data', f), 'utf8'));
const ONTOLOGY = readData('style-ontology.json');
const GRAPH_VOCABULARY = readData('graph-style-vocabulary.json');

describe('vocabulary lock', () => {
  // The whole enrichment lane is only useful if it writes names the graph and
  // the matcher already agree on. These are the tripwires for drift.
  it('emits only labels from data/style-ontology.json', () => {
    const labels = new Set(ONTOLOGY.tags.map((t) => t.label));
    expect(CANONICAL_STYLE_NAMES.filter((n) => !labels.has(n))).toEqual([]);
  });

  it('exports the complete approved ontology for generator and import paths', () => {
    expect(ONTOLOGY_STYLE_LABELS).toEqual(ONTOLOGY.tags.map((t) => t.label));
    expect(ONTOLOGY_STYLE_LABELS).toContain('Trash Polka');
    expect(ONTOLOGY_STYLE_LABELS).toContain('Sketch');
  });

  it('every rule is keyed by a real ontology tag id', () => {
    const ids = new Set(ONTOLOGY.tags.map((t) => t.id));
    expect(STYLE_PATTERNS.filter((r) => !ids.has(r.tag)).map((r) => r.tag)).toEqual([]);
  });

  it('has exactly one regex rule per emittable style', () => {
    expect(STYLE_PATTERNS.map((r) => r.style).sort()).toEqual([...CANONICAL_STYLE_NAMES].sort());
  });

  // The invariant PR #166 established and this lane must not undo: every name
  // MERGE is given is a spelling the graph already uses, so no Style node is
  // created and the vocabulary cannot re-split.
  it('maps every emittable style to a graph spelling, never a new one', () => {
    const graphNames = new Set(GRAPH_VOCABULARY.styles.flatMap((s) => s.graphNames));
    const ontologyLabels = new Set(ONTOLOGY.tags.map((t) => t.label));
    for (const label of CANONICAL_STYLE_NAMES) {
      const name = graphStyleName(label);
      expect(name, `${label} has no graph spelling`).toBeTruthy();
      // Either the graph's own spelling for a tag it already answers with, or
      // the ontology label for a tag whose node exists but carries no artists.
      expect(graphNames.has(name) || ontologyLabels.has(name)).toBe(true);
    }
  });

  it('never writes "Script" — it is an alias of Lettering (PR #166)', () => {
    expect(CANONICAL_STYLE_NAMES).not.toContain('Script');
    expect(resolveOntologyLabel('Script')).toBe('Lettering');
    expect(graphStyleName('Script')).toBe('Lettering');
  });

  it('writes the graph spelling for Japanese (one node since the #176 merge)', () => {
    expect(graphStyleName('Japanese')).toBe('Japanese');
  });

  // Anything this lane writes must be resolvable by the matcher, or the edge is
  // unreachable from the UI.
  it('every written name resolves in src/lib/style-vocabulary.ts', () => {
    for (const label of CANONICAL_STYLE_NAMES) {
      const name = graphStyleName(label);
      const resolved = resolveCanonicalStyle(name);
      // Tags the graph has no artists for yet (Lettering, Minimalist) are not
      // matchable until sync-graph-style-vocabulary.mjs is re-run after import.
      const matchableYet = GRAPH_VOCABULARY.styles.some((s) => s.graphNames.includes(name));
      if (matchableYet) expect(resolved, `${name} does not resolve`).toBeTruthy();
    }
  });
});

describe('generator/import normalization', () => {
  it('canonicalizes aliases for Supabase and de-duplicates them', () => {
    expect(
      normalizeOntologyStyleList(
        ['Old School', 'Traditional', 'Photo Realism', 'Japanese (Irezumi)'],
        'fixture',
      ),
    ).toEqual(['Traditional', 'Realism', 'Japanese']);
  });

  it('uses the graph spelling for Neo4j without inventing a second tag', () => {
    expect(
      normalizeGraphStyleList(
        ['Japanese', 'Old School', 'Photo Realism', 'Trash Polka'],
        'fixture',
      ),
    ).toEqual(['Japanese', 'Traditional', 'Realism', 'Trash Polka']);
  });

  it('fails loudly when a write path receives an unapproved style', () => {
    expect(() => normalizeOntologyStyleList(['Fine Line', 'Vaporwave'], 'fixture')).toThrow(
      /outside data\/style-ontology\.json: Vaporwave/,
    );
    expect(() => normalizeGraphStyleList(['Steampunk'], 'fixture')).toThrow(
      /outside data\/style-ontology\.json: Steampunk/,
    );
  });
});

describe('extractStyleEvidence', () => {
  it('tags a plain self-declared bio and keeps the matched text as evidence', () => {
    const hits = extractStyleEvidence('Black & Grey Realism | Fine Line Tattoos');
    expect(hits.map((h) => h.style)).toEqual(['Black & Grey', 'Fine Line', 'Realism']);
    expect(hits.find((h) => h.style === 'Black & Grey').match).toBe('Black & Grey');
  });

  it('handles the separator styles real bios use', () => {
    expect(stylesFromBio('Anime||Japanese||Fine-line||Walk-Ins')).toEqual(['Fine Line', 'Japanese', 'Anime']);
    expect(stylesFromBio('FINE LINE * ILLUSTRATIVE * TRADITIONAL')).toEqual(['Traditional', 'Fine Line', 'Illustrative']);
    expect(stylesFromBio('black&grey')).toEqual(['Black & Grey']);
    expect(stylesFromBio('Black and Gray Tattoos')).toEqual(['Black & Grey']);
  });

  it('does not emit Traditional when the only evidence is neo-traditional', () => {
    expect(stylesFromBio('Colorful Neotraditional & Illustrative Tattoos')).toEqual([
      'Neo-Traditional',
      'Illustrative',
    ]);
  });

  it('keeps Traditional when the bio claims both independently', () => {
    expect(stylesFromBio('American Traditional and Neo-Traditional')).toEqual([
      'Traditional',
      'Neo-Traditional',
    ]);
  });

  it('returns nothing for an empty or style-free bio', () => {
    expect(extractStyleEvidence('')).toEqual([]);
    expect(extractStyleEvidence('   ')).toEqual([]);
    expect(extractStyleEvidence(null)).toEqual([]);
    expect(extractStyleEvidence('Books open. DM to book. Deposits required.')).toEqual([]);
  });

  it('is deterministic — same bio, same tags, in rule order', () => {
    const bio = 'Traditional, Fine Line, Realism';
    expect(stylesFromBio(bio)).toEqual(stylesFromBio(bio));
    expect(stylesFromBio(bio)).toEqual(['Traditional', 'Fine Line', 'Realism']);
  });
});

describe('rejectSpuriousEvidence', () => {
  const guard = (bio) => {
    const { kept, rejected } = rejectSpuriousEvidence(bio, extractStyleEvidence(bio));
    return { kept: kept.map((k) => k.style), rejected: rejected.map((r) => `${r.style}:${r.reason}`) };
  };

  it('drops a style the artist explicitly disclaims', () => {
    expect(guard('San Antonio | No tribal | DM to book')).toEqual({
      kept: [],
      rejected: ['Tribal:negated'],
    });
    expect(guard('$150hr deposit. I do not do script')).toEqual({
      kept: [],
      rejected: ['Lettering:negated'],
    });
    expect(guard('We do NOT offer fine line or micro tattoos')).toEqual({
      kept: [],
      rejected: ['Fine Line:negated'],
    });
  });

  it('does not treat ❌/🚫 bullets or an unrelated "NO" as negation', () => {
    // "❌" here is a bullet in front of a style LIST, not a disclaimer.
    expect(guard('❌Geometric / Ornamental').kept).toEqual(['Geometric']);
    // The "NO" belongs to "NO DMS"; an emoji separates it from the claim.
    expect(guard('❌NO DMS❌🌸SOFT TRAD🌸🍥ANIME🍥').kept).toEqual(['Anime']);
  });

  it('drops Tribal when the only evidence is the shop name "Tribal Rites"', () => {
    expect(guard('Tattoo Artist at Tribal Rites 🎨 Loveland, Colorado')).toEqual({
      kept: [],
      rejected: ['Tribal:proper-noun-collision'],
    });
  });

  it('keeps Tribal when a real claim sits alongside the shop name', () => {
    expect(guard('Polynesian tribal tattoos | Tribal Rites Co. Boulder CO').kept).toEqual(['Tribal']);
  });

  it('drops the brand and tribal-enrollment collisions', () => {
    expect(guard('TRIBAL GEAR AND SULLEN AUTHORIZED DEALER').kept).toEqual([]);
    expect(guard('Army vet ⚡️Sho-Ban tribal member 🦬 Tattoo Artist').kept).toEqual([]);
  });

  it('leaves ordinary bios untouched and never invents a tag', () => {
    const bio = 'Fine Line • Blackwork • Color • lettering';
    const before = extractStyleEvidence(bio);
    const { kept, rejected } = rejectSpuriousEvidence(bio, before);
    expect(kept).toEqual(before);
    expect(rejected).toEqual([]);
  });
});

describe('isSafeArtistId', () => {
  it('accepts scraper ids and rejects junk', () => {
    expect(isSafeArtistId('artist_inkbysam')).toBe(true);
    expect(isSafeArtistId('artist_mp.tatt')).toBe(true);
    expect(isSafeArtistId('../etc/passwd')).toBe(false);
    expect(isSafeArtistId('a/b')).toBe(false);
    expect(isSafeArtistId('has space')).toBe(false);
    expect(isSafeArtistId('')).toBe(false);
    expect(isSafeArtistId(null)).toBe(false);
    expect(isSafeArtistId(42)).toBe(false);
  });
});

describe('normalizeStyleRecord', () => {
  it('keeps canonical styles, de-duplicates, and fixes casing', () => {
    expect(
      normalizeStyleRecord({ artistId: 'artist_x', styles: ['fine line', 'Fine Line', 'REALISM'] }),
    ).toEqual({ artistId: 'artist_x', styles: ['Fine Line', 'Realism'] });
  });

  it('drops styles outside the controlled vocabulary', () => {
    expect(
      normalizeStyleRecord({ artistId: 'artist_x', styles: ['Steampunk', 'Vaporwave', 'Realism'] }),
    ).toEqual({ artistId: 'artist_x', styles: ['Realism'] });
  });

  it('resolves an older spelling to its current label', () => {
    // The committed artifact was harvested before PR #166 folded "script" into
    // `lettering`; it must keep working without being regenerated.
    expect(normalizeStyleRecord({ artistId: 'artist_x', styles: ['Script'] })).toEqual({
      artistId: 'artist_x',
      styles: ['Lettering'],
    });
    // …and an alias plus its label collapse to one entry, not two.
    expect(normalizeStyleRecord({ artistId: 'artist_x', styles: ['Script', 'Lettering'] })).toEqual({
      artistId: 'artist_x',
      styles: ['Lettering'],
    });
  });

  it('returns null when the row is unusable', () => {
    expect(normalizeStyleRecord({ artistId: 'artist_x', styles: [] })).toBeNull();
    expect(normalizeStyleRecord({ artistId: 'artist_x', styles: ['Steampunk'] })).toBeNull();
    expect(normalizeStyleRecord({ styles: ['Realism'] })).toBeNull();
    expect(normalizeStyleRecord({ artistId: '../x', styles: ['Realism'] })).toBeNull();
    expect(normalizeStyleRecord(null)).toBeNull();
  });
});

describe('toStylePairs', () => {
  it('flattens records into the (artistId, style) rows the graph stores', () => {
    expect(
      toStylePairs([
        { artistId: 'a1', styles: ['Realism', 'Anime'] },
        { artistId: 'a2', styles: ['Lettering'] },
      ]),
    ).toEqual([
      { artistId: 'a1', style: 'Realism' },
      { artistId: 'a1', style: 'Anime' },
      { artistId: 'a2', style: 'Lettering' },
    ]);
  });

  // The seam that keeps the vocabulary from re-splitting: the artifact records
  // the ontology label, the graph gets its own spelling.
  it('translates the ontology label into the graph spelling', () => {
    expect(toStylePairs([{ artistId: 'a1', styles: ['Japanese'] }])).toEqual([
      { artistId: 'a1', style: 'Japanese' },
    ]);
  });
});
