import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  GENERATED_STYLE_LABELS,
  formatForNeo4j,
  formatForSupabase,
} from './generate-tattoo-artists-data.js';
import {
  normalizeGraphStyleList,
  normalizeOntologyStyleList,
} from './lib/artist-styles.mjs';

const readJson = (relativePath) =>
  JSON.parse(readFileSync(path.join(process.cwd(), relativePath), 'utf8'));

const fixture = {
  id: 'artist-fixture',
  name: 'Fixture Artist',
  shop_name: 'Fixture Shop',
  location_city: 'Phoenix',
  location_region: 'Arizona',
  location_country: 'United States',
  has_multiple_locations: false,
  profile_url: 'https://example.com/fixture',
  is_curated: false,
  created_at: '2026-07-28T00:00:00.000Z',
  styles: ['Old School', 'Photo Realism', 'Japanese'],
  color_palettes: [],
  specializations: [],
};

describe('synthetic artist generator vocabulary', () => {
  it('samples every approved ontology label instead of a handwritten list', () => {
    const ontology = readJson('data/style-ontology.json');
    expect(GENERATED_STYLE_LABELS).toEqual(ontology.tags.map((tag) => tag.label));
    expect(GENERATED_STYLE_LABELS).toContain('Trash Polka');
    expect(GENERATED_STYLE_LABELS).toContain('Sketch');
  });

  it('emits ontology labels to Supabase and graph spellings to Neo4j', () => {
    expect(formatForSupabase([fixture])[0].styles).toEqual([
      'Traditional',
      'Realism',
      'Japanese',
    ]);

    const graph = formatForNeo4j([fixture]);
    expect(graph.nodes.styles.map((style) => style.name).sort()).toEqual([
      'Japanese',
      'Realism',
      'Traditional',
    ]);
    expect(graph.relationships.SPECIALIZES_IN.map((relationship) => relationship.to).sort()).toEqual([
      'Japanese',
      'Realism',
      'Traditional',
    ]);
  });
});

describe('checked-in generated artifacts', () => {
  it('keeps every style in the canonical Neo4j import source resolvable', () => {
    const data = readJson('src/data/artists.json');
    expect(() =>
      normalizeGraphStyleList(
        data.styles.filter((style) => style !== 'All Styles'),
        'artists.json style index',
      ),
    ).not.toThrow();
    for (const artist of data.artists) {
      expect(() =>
        normalizeGraphStyleList(artist.styles, `artists.json:${artist.id}`),
      ).not.toThrow();
    }
  });

  it.each([
    'generated/tattoo-artists-supabase.json',
    'generated/tattoo-artists-batch-50.json',
  ])('%s stores only canonical ontology labels', (file) => {
    const artists = readJson(file);
    for (const artist of artists) {
      expect(artist.styles).toEqual(
        normalizeOntologyStyleList(artist.styles, `${file}:${artist.id}`),
      );
    }
  });

  it('keeps Neo4j nodes and relationships on graph-controlled spellings', () => {
    const graph = readJson('generated/tattoo-artists-neo4j.json');
    const styleNames = graph.nodes.styles.map((style) => style.name);
    expect(styleNames).toEqual(normalizeGraphStyleList(styleNames, 'Neo4j style nodes'));
    for (const relationship of graph.relationships.SPECIALIZES_IN) {
      expect([relationship.to]).toEqual(
        normalizeGraphStyleList([relationship.to], `Neo4j artist ${relationship.from}`),
      );
    }
  });
});
