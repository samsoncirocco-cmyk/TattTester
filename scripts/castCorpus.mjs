/**
 * The multi-character corpus and its scorer.
 *
 * WHY THIS EXISTS: `measure-backdrop` scores presentation — is the render
 * flash art on white, or a photograph of skin. It is the only automated
 * quality gate we have, and it is blind to whether the design is CORRECT.
 * A lettering render that reads "shpler" scores 1.000. So would a four-hero
 * sleeve that drew one hero.
 *
 * Multi-character failure is the oldest documented defect in this repo
 * (docs/sleeve-forge-plan.md: every multi-character render on 2026-05-19/20
 * either dropped characters or smushed them into one). It has never had a
 * measurement. This is that measurement.
 *
 * The scorer is the PRODUCTION vision prompt, reused rather than rewritten:
 * it already asks "which recognizable characters are actually in this
 * image", and it is explicitly instructed never to guess. That conservatism
 * is what we want — a scorer that hallucinates the requested cast back at us
 * would report success on exactly the renders we are hunting.
 */
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { ANALYSIS_PROMPT } from '../src/services/vision/internal/referenceAnalysis.ts';
import { PROJECT_ID, REGION } from './renderLanes.mjs';

const VISION_MODEL = process.env.VISION_MODEL || 'gemini-2.5-flash';

/**
 * Named casts of 2–5. Each record is shaped exactly like the IntakeRecord the
 * conversation engine produces, so `enhanceStructured` builds the same
 * prompts production would.
 *
 * `cast` is the ground truth the render is scored against — the names the
 * customer actually asked for.
 *
 * IMPORTANT: `requestedCharacters` and `characterIdentities` must be filled
 * in, exactly as the conversation engine fills them from a real session. The
 * ensemble prompt in structuredMode only fires when requestedCharacters has
 * more than one entry — it is what adds "exactly N distinct figures", the
 * per-character "Name — Series" identity clause, and the instruction never to
 * merge or homogenize them. A record carrying only a free-text subject falls
 * back to a much weaker prompt, which is NOT what production sends. The first
 * run of this corpus made that mistake and measured the degraded path.
 */
export const CAST_RECORDS = [
  {
    id: 'kingdom-hearts-4',
    cast: ['Sora', 'Riku', 'Kairi', 'Roxas'],
    record: {
      requestedCharacters: ['Sora', 'Riku', 'Kairi', 'Roxas'],
      characterIdentities: [{ name: 'Sora', series: 'Kingdom Hearts' }, { name: 'Riku', series: 'Kingdom Hearts' }, { name: 'Kairi', series: 'Kingdom Hearts' }, { name: 'Roxas', series: 'Kingdom Hearts' }],
      placement: 'left forearm, elbow to wrist',
      styleTags: ['anime', 'color'],
      meaning: 'the friends who got me through my teens',
      subject: 'Sora, Riku, Kairi and Roxas from Kingdom Hearts together',
      references: [],
      ambiguousAxes: [],
    },
  },
  {
    id: 'dragon-ball-3',
    cast: ['Goku', 'Vegeta', 'Piccolo'],
    record: {
      requestedCharacters: ['Goku', 'Vegeta', 'Piccolo'],
      characterIdentities: [{ name: 'Goku', series: 'Dragon Ball Z' }, { name: 'Vegeta', series: 'Dragon Ball Z' }, { name: 'Piccolo', series: 'Dragon Ball Z' }],
      placement: 'upper arm',
      styleTags: ['anime', 'color'],
      meaning: 'rivalry that makes you better',
      subject: 'Goku, Vegeta and Piccolo from Dragon Ball Z standing together',
      references: [],
      ambiguousAxes: [],
    },
  },
  {
    id: 'naruto-2',
    cast: ['Naruto', 'Sasuke'],
    record: {
      requestedCharacters: ['Naruto', 'Sasuke'],
      characterIdentities: [{ name: 'Naruto', series: 'Naruto' }, { name: 'Sasuke', series: 'Naruto' }],
      placement: 'calf',
      styleTags: ['anime', 'blackwork'],
      meaning: 'the friend who was also my rival',
      subject: 'Naruto and Sasuke from Naruto facing each other',
      references: [],
      ambiguousAxes: [],
    },
  },
  {
    id: 'mha-5',
    cast: ['Deku', 'Bakugo', 'Todoroki', 'Uraraka', 'All Might'],
    record: {
      requestedCharacters: ['Deku', 'Bakugo', 'Todoroki', 'Uraraka', 'All Might'],
      characterIdentities: [{ name: 'Deku', series: 'My Hero Academia' }, { name: 'Bakugo', series: 'My Hero Academia' }, { name: 'Todoroki', series: 'My Hero Academia' }, { name: 'Uraraka', series: 'My Hero Academia' }, { name: 'All Might', series: 'My Hero Academia' }],
      placement: 'back',
      styleTags: ['anime', 'color'],
      meaning: 'the class that became a family',
      subject:
        'Deku, Bakugo, Todoroki, Uraraka and All Might from My Hero Academia together',
      references: [],
      ambiguousAxes: [],
    },
  },
  // Non-anime control: if Flux drops Western comic characters too, the
  // problem is multi-subject composition, not anime knowledge specifically.
  {
    id: 'batman-2',
    cast: ['Batman', 'Joker'],
    record: {
      requestedCharacters: ['Batman', 'Joker'],
      characterIdentities: [{ name: 'Batman', series: 'DC Comics' }, { name: 'Joker', series: 'DC Comics' }],
      placement: 'thigh',
      styleTags: ['neo-traditional', 'blackwork'],
      meaning: 'two sides of the same person',
      subject: 'Batman and the Joker from DC Comics facing each other',
      references: [],
      ambiguousAxes: [],
    },
  },
];

/**
 * Alternate names the vision model legitimately returns for the same person.
 * Without these the scorer marks a CORRECT render wrong — the first run
 * scored "Izuku Midoriya" as a miss against a request for "Deku", which is
 * the same character. Substring matching already covers the common case
 * ("Bakugo" ⊂ "Katsuki Bakugo"); this table is only for names that share no
 * substring at all.
 */
const ALIASES = [
  ['deku', 'izuku midoriya'],
  ['all might', 'toshinori yagi'],
];

function canon(name) {
  return name.toLowerCase().replace(/[^a-z0-9 ]/g, '').trim();
}

/** Loose match, plus the alias table for names that do not overlap at all. */
function namesMatch(requested, seen) {
  const a = canon(requested);
  const b = canon(seen);
  const aKey = a.replace(/ /g, '');
  const bKey = b.replace(/ /g, '');
  if (aKey === bKey || bKey.includes(aKey) || aKey.includes(bKey)) return true;
  return ALIASES.some(
    (pair) =>
      (pair.includes(a) && pair.some((p) => b.includes(p) || p.includes(b))) ||
      (pair.includes(b) && pair.some((p) => a.includes(p) || p.includes(a)))
  );
}

export { namesMatch };

/** Ask the production vision prompt which characters are actually present. */
export async function readCast(accessToken, base64Png) {
  const endpoint = `https://${REGION}-aiplatform.googleapis.com/v1/projects/${PROJECT_ID}/locations/${REGION}/publishers/google/models/${VISION_MODEL}:generateContent`;
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [
        {
          role: 'user',
          parts: [
            { inlineData: { mimeType: 'image/png', data: base64Png } },
            { text: ANALYSIS_PROMPT },
          ],
        },
      ],
      generationConfig: { responseMimeType: 'application/json', temperature: 0.2 },
    }),
  });
  if (!res.ok) throw new Error(`Vision ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text ?? '{}';
  const parsed = JSON.parse(text);
  return {
    characters: (parsed.characters ?? []).map((c) => c?.name).filter(Boolean),
    subjects: parsed.subjects ?? [],
    summary: parsed.summary ?? '',
  };
}

/**
 * Does the render contain lettering nobody asked for?
 *
 * This is the second axis of the bake-off, and it exists because cast
 * completeness alone would pick the wrong winner. Gemini was taken off the
 * routing table for writing banner text into artwork — measured 2 of 2
 * through the real prompt path — while scoring well on subject fidelity. A
 * customer approving a design with a word in it wears that word permanently,
 * so an arm that wins on casts and loses here has not won.
 *
 * Deliberately narrow: lettering that is part of the requested subject (a
 * name tattoo, a banner the customer asked for) is not intrusion. None of the
 * cast records request text, so on this corpus any lettering is intrusion.
 */
export async function readTextIntrusion(accessToken, base64Png) {
  const endpoint = `https://${REGION}-aiplatform.googleapis.com/v1/projects/${PROJECT_ID}/locations/${REGION}/publishers/google/models/${VISION_MODEL}:generateContent`;
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [
        {
          role: 'user',
          parts: [
            { inlineData: { mimeType: 'image/png', data: base64Png } },
            {
              text:
                'Does this tattoo design contain any written words, letters, or numbers ' +
                '— banners, scrolls, signatures, captions, or lettering of any kind? ' +
                'Reply as JSON: {"hasText": boolean, "words": [string]}. ' +
                'Report only legible words. Do not report decorative marks that are not letters.',
            },
          ],
        },
      ],
      generationConfig: { responseMimeType: 'application/json', temperature: 0.2 },
    }),
  });
  if (!res.ok) throw new Error(`Vision(text) ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  const parsed = JSON.parse(data.candidates?.[0]?.content?.parts?.[0]?.text ?? '{}');
  return { hasText: Boolean(parsed.hasText), words: parsed.words ?? [] };
}

/**
 * Score one directory of renders against its cast.
 *
 * The headline number is CAST COMPLETENESS: of the characters the customer
 * asked for, what fraction did the render actually contain. A render naming
 * one of four scores 0.25, which is the number the May test runs described
 * in prose and never quantified.
 */
export async function scoreCastDir(dir, accessToken) {
  const manifest = JSON.parse(await readFile(path.join(dir, 'manifest.json'), 'utf8'));
  const files = (await readdir(dir)).filter((f) => f.endsWith('.png')).sort();
  const results = [];

  for (const file of files) {
    const entry = manifest.find((m) => m.name === file);
    if (!entry?.cast) continue;
    const bytes = await readFile(path.join(dir, file));
    let seen;
    let text = { hasText: null, words: [] };
    try {
      seen = await readCast(accessToken, bytes.toString('base64'));
      text = await readTextIntrusion(accessToken, bytes.toString('base64'));
    } catch (error) {
      results.push({ file, cast: entry.cast, error: error.message });
      continue;
    }
    const found = entry.cast.filter((wanted) =>
      seen.characters.some((got) => namesMatch(wanted, got))
    );
    results.push({
      file,
      recordId: entry.recordId,
      cast: entry.cast,
      found,
      extra: seen.characters.filter(
        (got) => !entry.cast.some((wanted) => namesMatch(wanted, got))
      ),
      completeness: entry.cast.length ? found.length / entry.cast.length : 0,
      hasText: text.hasText,
      words: text.words,
      summary: seen.summary,
    });
  }
  return results;
}

export function summarizeCast(results) {
  const scored = results.filter((r) => r.completeness !== undefined);
  const total = scored.length;
  const complete = scored.filter((r) => r.completeness === 1).length;
  const none = scored.filter((r) => r.completeness === 0).length;
  const mean = total ? scored.reduce((s, r) => s + r.completeness, 0) / total : 0;
  const withText = scored.filter((r) => r.hasText === true);

  const byRecord = {};
  for (const r of scored) {
    byRecord[r.recordId] ??= { total: 0, sum: 0, complete: 0 };
    byRecord[r.recordId].total++;
    byRecord[r.recordId].sum += r.completeness;
    if (r.completeness === 1) byRecord[r.recordId].complete++;
  }
  return {
    total,
    complete,
    none,
    meanCompleteness: mean,
    textIntrusions: withText.length,
    intrudedWords: [...new Set(withText.flatMap((r) => r.words ?? []))],
    byRecord,
  };
}
