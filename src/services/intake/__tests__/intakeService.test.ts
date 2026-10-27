/**
 * Intake extraction module tests (ADR-0009, ADR-0010, ADR-0012).
 *
 * Providers are fully mocked — no live calls. The ontology comes from a
 * local fixture (never the real data/style-ontology.json, which is owned
 * by another workstream) via the STYLE_ONTOLOGY_PATH override.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { extractIntake, VARIATION_AXIS_POOL } from '../index';
import {
  buildOntologyIndex,
  loadOntology,
  resetOntologyCache,
  resolveTag,
  resolveTags,
  OntologyFormatError,
} from '../internal/ontology';

vi.mock('@/lib/google-auth-edge', () => ({
  getGcpAccessToken: vi.fn().mockResolvedValue('test-gcp-token'),
}));

const FIXTURE_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'style-ontology.fixture.json'
);

// Every env var the module reads for provider selection — cleared per test
// so cases are hermetic regardless of the developer's local .env.
const PROVIDER_ENV_KEYS = [
  'OPENROUTER_API_KEY',
  'INTAKE_EXTRACTION_MODEL',
  'GOOGLE_APPLICATION_CREDENTIALS_JSON',
  'GCP_SERVICE_ACCOUNT_KEY',
  'GCP_SERVICE_ACCOUNT_EMAIL',
  'GCP_PRIVATE_KEY',
  'NEXT_PUBLIC_VERTEX_AI_PROJECT_ID',
  'GCP_PROJECT_ID',
  'VERTEX_PROJECT_ID',
  'GEMINI_MODEL',
  'GCP_REGION',
  'TYPESAFE_API_KEY',
  'TYPESAFE_INTAKE',
  'TYPESAFE_MODEL',
  'TYPESAFE_TIMEOUT_MS',
];

let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  savedEnv = {};
  for (const key of [...PROVIDER_ENV_KEYS, 'STYLE_ONTOLOGY_PATH']) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  process.env.STYLE_ONTOLOGY_PATH = FIXTURE_PATH;
  resetOntologyCache();
});

afterEach(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

function stubFetchNever() {
  const fetchMock = vi.fn(() => {
    throw new Error('unexpected network call in offline test');
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function openRouterResponse(payload: unknown) {
  return {
    ok: true,
    json: async () => ({
      choices: [{ message: { content: JSON.stringify(payload) } }],
    }),
  };
}

describe('ontology', () => {
  it('loads the fixture and resolves aliases to canonical ids', async () => {
    const index = await loadOntology();
    expect(index.version).toBe(1);
    expect(resolveTag(index, 'Old School')).toBe('american-traditional');
    expect(resolveTag(index, 'Fine Line')).toBe('fine-line'); // label
    expect(resolveTag(index, 'single needle')).toBe('fine-line'); // alias
    expect(resolveTag(index, 'blackwork')).toBe('blackwork'); // id passthrough
  });

  it('rejects unknown tags', async () => {
    const index = await loadOntology();
    expect(resolveTag(index, 'trash-polka')).toBeNull();
    expect(resolveTag(index, '')).toBeNull();
  });

  it('resolveTags drops unknowns and collapses alias duplicates', async () => {
    const index = await loadOntology();
    expect(
      resolveTags(index, ['fineline', 'Fine Line', 'trash-polka', 'irezumi'])
    ).toEqual(['fine-line', 'japanese']);
  });

  it('buildOntologyIndex rejects malformed ontologies', () => {
    expect(() => buildOntologyIndex(null)).toThrow(OntologyFormatError);
    expect(() => buildOntologyIndex({ tags: [] })).toThrow(OntologyFormatError);
    expect(() =>
      buildOntologyIndex({ version: 1, updated: 'x', tags: [{ id: 'a' }] })
    ).toThrow(OntologyFormatError);
  });
});

describe('extractIntake — heuristic fallback (no provider configured)', () => {
  it('carries a recognized character source without an LLM', async () => {
    stubFetchNever();

    const record = await extractIntake({
      placementAnswer: 'left forearm',
      meaningAnswer: 'Goku from Dragon Ball charging a Kamehameha',
    });

    expect(record.characterIdentities).toContainEqual({
      name: 'Goku',
      series: 'Dragon Ball',
    });
  });

  it('extracts offline without any network call', async () => {
    const fetchMock = stubFetchNever();

    const record = await extractIntake({
      placementAnswer: 'On my left forearm, I think',
      meaningAnswer:
        'A fine line hummingbird for my grandmother — delicate, not heavy. Something like https://pin.it/abc123',
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(record.placement).toBe('left forearm');
    expect(record.styleTags).toEqual(['fine-line']);
    // Meaning survives verbatim (trimmed only) — never flattened.
    expect(record.meaning).toBe(
      'A fine line hummingbird for my grandmother — delicate, not heavy. Something like https://pin.it/abc123'
    );
    expect(record.references).toEqual(['https://pin.it/abc123']);
    // "fine"/"delicate" resolve bold-fine; the rest stay ambiguous.
    expect(record.ambiguousAxes).toEqual([
      'color-blackwork',
      'literal-abstract',
      'minimal-ornate',
    ]);
  });

  it('detects resolved axes from the answers (ambiguity detection)', async () => {
    stubFetchNever();

    const record = await extractIntake({
      placementAnswer: 'ribs',
      meaningAnswer: 'A bold traditional eagle, black and grey, keep it simple',
    });

    expect(record.placement).toBe('ribcage');
    expect(record.styleTags).toEqual(['american-traditional']);
    // bold → bold-fine, black and grey → color-blackwork, simple → minimal-ornate
    expect(record.ambiguousAxes).toEqual(['literal-abstract']);
  });

  it('leaves every axis ambiguous when the answers commit to nothing', async () => {
    stubFetchNever();

    const record = await extractIntake({
      placementAnswer: 'not sure yet, somewhere on my leg',
      meaningAnswer: 'a bird for my grandmother',
    });

    expect(record.placement).toBe('leg');
    expect(record.styleTags).toEqual([]);
    expect(record.ambiguousAxes).toEqual([...VARIATION_AXIS_POOL]);
  });
});

describe('extractIntake — LLM path (providers mocked)', () => {
  it('grounds a game character to the explicitly named source', async () => {
    process.env.OPENROUTER_API_KEY = 'test-key';
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      openRouterResponse({
        placement: 'left arm',
        styleTags: ['color'],
        subject: 'Sora holding his Keyblade',
        characterIdentities: [
          { name: 'Sora', series: 'Kingdom Hearts' },
          { name: 'Sora', series: 'No Game No Life' },
        ],
        references: [],
        ambiguousAxes: [],
      })
    ));

    const record = await extractIntake({
      placementAnswer: 'left arm',
      meaningAnswer: 'Sora from Kingdom Hearts holding his Keyblade',
    });

    expect(record.characterIdentities).toEqual([
      { name: 'Sora', series: 'Kingdom Hearts' },
    ]);
  });

  it('accepts a canonical source when the customer used a known alias', async () => {
    process.env.OPENROUTER_API_KEY = 'test-key';
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      openRouterResponse({
        placement: 'left arm',
        styleTags: ['color'],
        subject: 'Sora holding his Keyblade',
        characterIdentities: [{ name: 'Sora', series: 'Kingdom Hearts' }],
        references: [],
        ambiguousAxes: [],
      })
    ));

    const record = await extractIntake({
      placementAnswer: 'left arm',
      meaningAnswer: 'KH Sora holding his Keyblade',
    });

    expect(record.characterIdentities).toEqual([
      { name: 'Sora', series: 'Kingdom Hearts' },
    ]);
  });

  it('rejects names that appear only inside unrelated words', async () => {
    process.env.OPENROUTER_API_KEY = 'test-key';
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      openRouterResponse({
        placement: 'face',
        styleTags: ['color'],
        subject: 'One Piece inspired spring scene',
        characterIdentities: [
          { name: 'Ace', series: 'One Piece' },
          { name: 'Rin', series: 'One Piece' },
        ],
        references: [],
        ambiguousAxes: [],
      })
    ));

    const record = await extractIntake({
      placementAnswer: 'face placement',
      meaningAnswer: 'a spring scene inspired by One Piece',
    });

    expect(record.characterIdentities).toBeUndefined();
  });

  it('uses catalog evidence instead of a provider-swapped crossover mapping', async () => {
    process.env.OPENROUTER_API_KEY = 'test-key';
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      openRouterResponse({
        placement: 'left arm',
        styleTags: ['color'],
        subject: 'Gon and Yusuke fighting side by side',
        characterIdentities: [
          { name: 'Gon', series: 'Yu Yu Hakusho' },
          { name: 'Yusuke', series: 'Hunter x Hunter' },
        ],
        references: [],
        ambiguousAxes: [],
      })
    ));

    const record = await extractIntake({
      placementAnswer: 'left arm',
      meaningAnswer: 'Gon from Hunter x Hunter and Yusuke from Yu Yu Hakusho',
    });

    expect(record.characterIdentities).toEqual([
      { name: 'Gon', series: 'Hunter x Hunter' },
      { name: 'Yusuke', series: 'Yu Yu Hakusho' },
    ]);
  });

  it('repairs a provider that collapses a crossover into one source', async () => {
    process.env.OPENROUTER_API_KEY = 'test-key';
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      openRouterResponse({
        placement: 'left arm',
        styleTags: ['color'],
        subject: 'Gon and Yusuke fighting side by side',
        characterIdentities: [
          { name: 'Gon', series: 'Hunter x Hunter' },
          { name: 'Yusuke', series: 'Hunter x Hunter' },
        ],
        references: [],
        ambiguousAxes: [],
      })
    ));

    const record = await extractIntake({
      placementAnswer: 'left arm',
      meaningAnswer: 'Gon from HxH and Yusuke from YYH',
    });

    expect(record.characterIdentities).toEqual([
      { name: 'Gon', series: 'Hunter x Hunter' },
      { name: 'Yusuke', series: 'Yu Yu Hakusho' },
    ]);
  });

  it('omits an uncorroborated mapping in a multi-source request', async () => {
    process.env.OPENROUTER_API_KEY = 'test-key';
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      openRouterResponse({
        placement: 'left arm',
        styleTags: ['color'],
        subject: 'Aqua and Link fighting side by side',
        characterIdentities: [
          { name: 'Aqua', series: 'Kingdom Hearts' },
          { name: 'Link', series: 'Kingdom Hearts' },
        ],
        references: [],
        ambiguousAxes: [],
      })
    ));

    const record = await extractIntake({
      placementAnswer: 'left arm',
      meaningAnswer: 'Aqua from Kingdom Hearts and Link from Legend of Zelda',
    });

    expect(record.characterIdentities).toBeUndefined();
  });

  it('happy path: uses OpenRouter output, resolving aliases and rejecting unknown tags', async () => {
    process.env.OPENROUTER_API_KEY = 'test-key';
    const fetchMock = vi.fn().mockResolvedValue(
      openRouterResponse({
        placement: 'forearm',
        styleTags: ['Old School', 'fine line', 'trash-polka'],
        references: ['https://example.com/ref.jpg'],
        ambiguousAxes: ['color-blackwork', 'not-an-axis'],
      })
    );
    vi.stubGlobal('fetch', fetchMock);

    const record = await extractIntake({
      placementAnswer: 'my forearm',
      meaningAnswer: 'For my grandmother, warm not somber',
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toContain('openrouter.ai');
    // Aliases resolved to canonical ids; unknown tag rejected outright.
    expect(record.styleTags).toEqual(['american-traditional', 'fine-line']);
    // Non-pool axis entries are filtered out.
    expect(record.ambiguousAxes).toEqual(['color-blackwork']);
    expect(record.placement).toBe('forearm');
    expect(record.references).toEqual(['https://example.com/ref.jpg']);
    // Meaning always comes from the user's answer, never the model.
    expect(record.meaning).toBe('For my grandmother, warm not somber');
  });

  it('a named subject survives, and forces literal-abstract out of the ambiguous axes', async () => {
    process.env.OPENROUTER_API_KEY = 'test-key';
    const fetchMock = vi.fn().mockResolvedValue(
      openRouterResponse({
        placement: 'forearm',
        styleTags: [],
        subject:
          'Izuku Midoriya (Deku) from My Hero Academia, determined expression, One For All lightning crackling around his fist',
        references: [],
        // Model incorrectly lists literal-abstract despite naming a subject —
        // the merge enforces the rule regardless.
        ambiguousAxes: ['literal-abstract', 'color-blackwork'],
      })
    );
    vi.stubGlobal('fetch', fetchMock);

    const record = await extractIntake({
      placementAnswer: 'forearm',
      meaningAnswer: 'my love of my hero academia and its characters',
    });

    expect(record.subject).toContain('Izuku Midoriya');
    expect(record.ambiguousAxes).toEqual(['color-blackwork']);
    // Meaning still verbatim — subject does not replace it.
    expect(record.meaning).toBe('my love of my hero academia and its characters');
  });

  it('no subject: field stays undefined and axes pass through', async () => {
    process.env.OPENROUTER_API_KEY = 'test-key';
    const fetchMock = vi.fn().mockResolvedValue(
      openRouterResponse({
        placement: 'forearm',
        styleTags: [],
        subject: null,
        references: [],
        ambiguousAxes: ['literal-abstract'],
      })
    );
    vi.stubGlobal('fetch', fetchMock);

    const record = await extractIntake({
      placementAnswer: 'forearm',
      meaningAnswer: 'strength through hard times',
    });

    expect(record.subject).toBeUndefined();
    expect(record.ambiguousAxes).toEqual(['literal-abstract']);
  });

  it('prefers Vertex when configured and validates its tags too', async () => {
    process.env.NEXT_PUBLIC_VERTEX_AI_PROJECT_ID = 'tatt-test';
    process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON = '{"project_id":"tatt-test"}';
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        candidates: [
          {
            content: {
              parts: [
                {
                  text: JSON.stringify({
                    placement: 'left shoulder',
                    styleTags: ['irezumi', 'bogus-style'],
                    references: [],
                    ambiguousAxes: ['bold-fine', 'minimal-ornate'],
                  }),
                },
              ],
            },
          },
        ],
      }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const record = await extractIntake({
      placementAnswer: 'shoulder, left side',
      meaningAnswer: 'A koi for perseverance',
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toContain('aiplatform.googleapis.com');
    expect(record.styleTags).toEqual(['japanese']);
    expect(record.placement).toBe('left shoulder');
    expect(record.ambiguousAxes).toEqual(['bold-fine', 'minimal-ornate']);
  });

  it('falls back to the heuristic when the configured provider fails', async () => {
    process.env.OPENROUTER_API_KEY = 'test-key';
    const fetchMock = vi.fn().mockRejectedValue(new Error('network down'));
    vi.stubGlobal('fetch', fetchMock);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const record = await extractIntake({
      placementAnswer: 'inner wrist',
      meaningAnswer: 'A tiny blackwork semicolon, minimal',
    });

    expect(fetchMock).toHaveBeenCalled();
    expect(record.placement).toBe('wrist');
    expect(record.styleTags).toEqual(['blackwork']);
    expect(record.meaning).toBe('A tiny blackwork semicolon, minimal');
    expect(record.ambiguousAxes).toEqual(['bold-fine', 'literal-abstract']);
    warnSpy.mockRestore();
  });

  it('falls back to the heuristic when the provider returns unparseable output', async () => {
    process.env.OPENROUTER_API_KEY = 'test-key';
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: 'sorry, no JSON today' } }],
      }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const record = await extractIntake({
      placementAnswer: 'calf',
      meaningAnswer: 'watercolor fox, colorful and playful',
    });

    expect(record.placement).toBe('calf');
    expect(record.styleTags).toEqual(['watercolor']);
    expect(record.ambiguousAxes).toEqual([
      'bold-fine',
      'literal-abstract',
      'minimal-ornate',
    ]);
  });
});
