/**
 * AI-verify scraped artists' portfolio images via Gemini Vision.
 *
 * Reads data/national-artists-clean.json (the live scrape output — see
 * scripts/import-national-to-neo4j.js for the same source), sends each
 * artist's first few portfolioImages to Gemini, and writes verdicts to
 * data/gemini_validation.json keyed by artist id. Resumable: artists
 * already present in the output are skipped, so repeated runs only pay
 * for artists that are new since the last pass.
 *
 * Requires GEMINI_API_KEY in .env.
 *
 * Usage:
 *   node scripts/validate_artists_gemini.js [--limit N] [--images-per-artist N]
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import dotenv from 'dotenv';

dotenv.config();

const { GEMINI_API_KEY } = process.env;
if (!GEMINI_API_KEY) {
  console.error('❌ GEMINI_API_KEY must be set in .env');
  process.exit(1);
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '../data');
const INPUT_FILE = join(DATA_DIR, 'national-artists-clean.json');
const OUTPUT_FILE = join(DATA_DIR, 'gemini_validation.json');
const MODEL = 'gemini-flash-latest';

const args = process.argv.slice(2);
const limitIdx = args.indexOf('--limit');
const LIMIT = limitIdx >= 0 ? parseInt(args[limitIdx + 1], 10) : Infinity;
const imgIdx = args.indexOf('--images-per-artist');
const IMAGES_PER_ARTIST = imgIdx >= 0 ? parseInt(args[imgIdx + 1], 10) : 3;
const DELAY_MS = 4000;
const MAX_RETRIES = 4;

const PROMPT = `Analyze these tattoo portfolio images from one artist. Respond with ONLY JSON, no markdown fences:
{
  "isTattooArtist": boolean,
  "styles": string[],
  "avgQuality": number
}
- isTattooArtist: true if at least half the images show real tattoos on human skin (not flash art, not merch, not an unrelated business).
- styles: up to 3 tattoo styles present, e.g. "Traditional", "Realism", "Blackwork", "Fine Line".
- avgQuality: technical quality 1-10 across the images (linework, shading, healing/execution — not subject matter taste).`;

function loadOutput() {
  if (existsSync(OUTPUT_FILE)) {
    try {
      return JSON.parse(readFileSync(OUTPUT_FILE, 'utf8'));
    } catch {
      console.warn(`[validate] ${OUTPUT_FILE} unreadable, starting fresh`);
    }
  }
  return {};
}

function saveOutput(results) {
  writeFileSync(OUTPUT_FILE, JSON.stringify(results, null, 2));
}

function guessMimeFromUrl(url) {
  const ext = url.split('.').pop().split('?')[0].toLowerCase();
  return { webp: 'image/webp', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png' }[ext] || 'image/jpeg';
}

async function fetchImageAsInlineData(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const contentType = (res.headers.get('content-type') || '').split(';')[0];
  const mimeType = contentType.startsWith('image/') ? contentType : guessMimeFromUrl(url);
  const buf = Buffer.from(await res.arrayBuffer());
  return { inline_data: { mime_type: mimeType, data: buf.toString('base64') } };
}

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function callGemini(parts, attempt = 1) {
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${GEMINI_API_KEY}`;
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ contents: [{ parts }] }),
    signal: AbortSignal.timeout(30000),
  });

  if (res.status === 429 || res.status === 503) {
    if (attempt > MAX_RETRIES) throw new Error(`Gemini ${res.status} after ${MAX_RETRIES} retries`);
    const backoff = 2000 * 2 ** (attempt - 1);
    await sleep(backoff);
    return callGemini(parts, attempt + 1);
  }
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Gemini ${res.status}: ${body.slice(0, 300)}`);
  }
  return res.json();
}

async function analyzeArtist(artist) {
  const urls = (artist.portfolioImages || []).slice(0, IMAGES_PER_ARTIST);
  const parts = [{ text: PROMPT }];
  for (const url of urls) {
    try {
      parts.push(await fetchImageAsInlineData(url));
    } catch {
      // one bad image shouldn't sink the whole artist — skip it
    }
  }
  const imagesAttached = parts.length - 1;
  if (imagesAttached === 0) {
    return { verified: false, reason: 'no fetchable portfolio images', images_reviewed: 0 };
  }

  const data = await callGemini(parts);
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error('empty Gemini response');

  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error(`unparseable Gemini response: ${text.slice(0, 200)}`);
  const parsed = JSON.parse(jsonMatch[0]);

  return {
    verified: !!parsed.isTattooArtist,
    reason: parsed.isTattooArtist ? undefined : 'Gemini: insufficient tattoo content',
    styles: Array.isArray(parsed.styles) ? parsed.styles.slice(0, 3) : [],
    quality_score:
      typeof parsed.avgQuality === 'number' ? Math.max(0, Math.min(10, parsed.avgQuality)) / 10 : null,
    images_reviewed: imagesAttached,
  };
}

async function main() {
  const data = JSON.parse(readFileSync(INPUT_FILE, 'utf8'));
  const results = loadOutput();

  const candidates = data.artists
    .filter((a) => (a.portfolioImages || []).length > 0 && (!results[a.id] || results[a.id].error))
    .slice(0, LIMIT);

  console.log(
    `[validate] ${candidates.length} artists to review (${Object.keys(results).length} already done, model=${MODEL}, images/artist=${IMAGES_PER_ARTIST})`
  );

  let verified = 0;
  let rejected = 0;
  let errors = 0;

  for (let i = 0; i < candidates.length; i++) {
    const artist = candidates[i];
    process.stdout.write(`[${i + 1}/${candidates.length}] ${artist.name} (${artist.city}, ${artist.state})... `);
    try {
      const verdict = await analyzeArtist(artist);
      results[artist.id] = { ...verdict, checked_at: new Date().toISOString() };
      if (verdict.verified) {
        verified++;
        console.log(`✅ ${verdict.styles.join(', ') || '(no style)'} q=${verdict.quality_score ?? 'n/a'}`);
      } else {
        rejected++;
        console.log(`❌ ${verdict.reason || 'not verified'}`);
      }
    } catch (e) {
      errors++;
      results[artist.id] = { error: e.message, checked_at: new Date().toISOString() };
      console.log(`⚠️  ${e.message}`);
    }

    if ((i + 1) % 20 === 0) saveOutput(results);
    await sleep(DELAY_MS);
  }

  saveOutput(results);

  console.log(`\nDone. verified=${verified} rejected=${rejected} errors=${errors}`);
  console.log(`Output: ${OUTPUT_FILE}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
