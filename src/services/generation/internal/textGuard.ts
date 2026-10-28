/**
 * The unrequested-lettering guard (#297).
 *
 * WHY THIS EXISTS: every image model measured writes words into roughly one
 * render in five, and it is not a property of any one provider. Measured on
 * the same corpus through the real prompt path (#293), n≈20 per arm:
 *
 *   Gemini 3.1 Flash Image   30% of renders contained lettering
 *   Imagen 4 via Replicate   22%
 *   Flux dev                 20%   ← the lane in production
 *
 * The words are not noise. Renders came back carrying `GOKU`, `VEGETA`,
 * `PLUS ULTRA!`, `BANG!` — the model labelling what it drew, comic-panel
 * style — and one carried a scraped Instagram handle, `@jennalittle_me`.
 *
 * So no routing choice fixes this; only a gate does. A customer who approves
 * a design with a word in it wears that word permanently.
 *
 * TWO THINGS THIS DELIBERATELY IS NOT:
 *
 * 1. **Not a bare OCR check.** Script tattoos, memorial names and banner text
 *    are ordinary tattoo work; a gate that rejected them would break the
 *    product to protect it. So the vision call reads the lettering and a
 *    separate test on the request decides whether it belongs. That test is a
 *    TypeSafe Noul when `TYPESAFE_LETTERING` is on, and the keyword list in
 *    `requestsLettering` otherwise. The two jobs stay split: the vision call
 *    never sees the request. Asking one image model to do both failed, because
 *    with pixels in front of it the model reads lettering as a defect no
 *    matter what the prompt says. The Noul sees only the prompt.
 *
 * 2. **Not fail-closed.** Any provider, budget or parse failure returns
 *    `clean` with `screened: false`. A vision outage must not stop a customer
 *    getting their design — the guard removes a defect, it is not a
 *    correctness barrier, and blocking renders on it would trade a cosmetic
 *    problem for an outage. Every skip is visible in the verdict rather than
 *    silently indistinguishable from a pass.
 */
import { envBool, envFloat, envInt, envString } from '@/config/envSchema';
import { typesafeModel } from '@/services/typesafe';
import { logger } from '@/lib/logger';
import { getGcpAccessToken } from '@/lib/google-auth-edge';
import { buildVertexEndpoint } from '@/lib/vertex-endpoint';
import { checkBudget, recordSpend, VISION_ANALYSIS_COST_CENTS } from '@/lib/budget-tracker';

/** Same env chain as vision, with the render provider's `tatt-pro` default. */
function vertexProjectId(): string {
  return (
    process.env.NEXT_PUBLIC_VERTEX_AI_PROJECT_ID ||
    process.env.GCP_PROJECT_ID ||
    process.env.VERTEX_PROJECT_ID ||
    'tatt-pro'
  );
}

/** Same override the reference-analysis pass uses; kept independent of it. */
export const DEFAULT_GUARD_MODEL = 'gemini-3.1-flash-lite';

function guardModel(): string {
  return process.env.TEXT_GUARD_MODEL || process.env.VISION_MODEL || DEFAULT_GUARD_MODEL;
}

export interface TextVerdict {
  /** True when the image carries lettering the request did not ask for. */
  intruded: boolean;
  /** The offending words, for logs and for the re-roll decision's audit trail. */
  words: string[];
  /**
   * False when the check did not actually run — budget, provider or parse
   * failure. `intruded: false, screened: false` is "unknown", not "clean",
   * and callers must not report it as a pass.
   */
  screened: boolean;
  /** Why it did not run, when it did not. */
  skipReason?: 'budget' | 'provider' | 'parse' | 'disabled';
}

const CLEAN: TextVerdict = { intruded: false, words: [], screened: true };

// Fetch bounds (#327). The guard runs in front of every render now that it
// defaults on, so neither call may hold a reveal hostage: expiry throws,
// screenForText's catch degrades to a skipped verdict. Image fetch is a
// third-party object store serving a file that already exists — 15s is
// generous. The vision call does real inference — 30s matches the bound the
// #318 harness proved out.
const IMAGE_FETCH_TIMEOUT_MS = 15_000;
const VISION_CALL_TIMEOUT_MS = 30_000;

function skipped(skipReason: TextVerdict['skipReason']): TextVerdict {
  return { intruded: false, words: [], screened: false, skipReason };
}

/**
 * Does the request ask for writing to appear in the artwork?
 *
 * Keyword fallback for the lettering Noul. Used when `TYPESAFE_LETTERING` is
 * off, and when the Noul cannot answer (missing key, timeout, HTTP error,
 * parse error, or a budget denial). The list misses phrasings — "in memory
 * of my grandmother Margaret" asks for a name and matches nothing here — and
 * that miss re-rolls a legitimate tattoo. The Noul exists to close those
 * misses. This list stays so a TypeSafe outage cannot change the guard's
 * answer, and so the flag-off path stays the one ADR-0047 measured.
 *
 * The first three versions of this guard asked ONE vision call to do both
 * jobs — read the lettering and decide whether it was requested — and it
 * failed the same way each time. The Noul does not reopen that. It never
 * receives the image.
 *
 * A missed phrasing on this fallback flags a legitimate script tattoo, which
 * costs a re-roll and a metadata flag. Nothing here withholds a design.
 */
const LETTERING_REQUESTED = [
  'lettering', 'letters', 'text', 'script', 'calligraphy', 'typography', 'font',
  'banner', 'scroll', 'ribbon', 'quote', 'inscription', 'inscribed', 'written',
  'writing', 'word', 'words', 'name reading', 'reading "', "reading '",
  'the name', 'the date', 'spelled', 'spelling', 'cursive',
];

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Negations that strip lettering needles so "no text" / "without lettering"
 * / "no text or lettering" / "remove all text" do not disable the intrusion
 * gate. Whole-word only — "no texture" stays. Removal verbs matter because
 * critique re-cuts append `Requested change: "…"` verbatim, and customers
 * ask to drop accidental labels with "remove"/"drop", not only "no"/"without".
 * `names?`/`dates?` cover the "the name"/"the date" needles the same way.
 * The trailing (or|and|nor|…) chain is required so a second disjunct cannot
 * survive the first replace and rematch a needle.
 */
const LETTERING_TERM =
  'lettering|letters|text|script|calligraphy|typography|font|banner|scroll|ribbon|quote|inscription|inscribed|written|writing|words?|cursive|names?|dates?';

const LETTERING_NEGATED = new RegExp(
  `\\b(?:no|without|sans|avoid|excluding|remove|drop|eliminate|delete|erase)\\s+(?:(?:any|all|the)\\s+)?(?:${LETTERING_TERM})(?:(?:\\s*(?:,|/|and|or|nor)\\s*)+(?:(?:any|all|the)\\s+)?(?:${LETTERING_TERM}))*\\b`,
  'g'
);

/**
 * Style-tag embeddings are not lettering requests. structuredMode builds
 * "in a ${styleDesc} style" / "style locks to ${styleDesc}" from intake
 * tags, and the lettering ontology id (aliases: script, calligraphy,
 * typography) is a real styleTag — matching those would disable the guard
 * for figure-only designs that merely named a style.
 */
const STYLE_DESCRIPTOR =
  /\bin an?\s+[\w][\w\s,/&+-]*?\s+styles?\b|\bstyle locks to\s+[\w+-]+(?:,\s*[\w+-]+)*/g;

export function requestsLettering(prompt: string): boolean {
  // Drop negated phrases and style-descriptor shells so declining lettering
  // or naming a style cannot match a needle.
  const haystack = prompt
    .toLowerCase()
    .replace(LETTERING_NEGATED, ' ')
    .replace(STYLE_DESCRIPTOR, ' ');
  return LETTERING_REQUESTED.some((needle) => {
    // Quote-anchored needles are phrase prefixes ("reading \"…"), not words.
    if (needle.includes('"') || needle.includes("'")) {
      return haystack.includes(needle);
    }
    // Whole-word match so "texture"/"sword"/"description" do not count as
    // requesting lettering via the needles "text"/"word"/"script".
    return new RegExp(`\\b${escapeRegExp(needle)}\\b`).test(haystack);
  });
}

/** Same endpoint the shared TypeSafe client uses. */
export const TYPESAFE_SYSTEMONE_URL = 'https://api.typesafe.ai/v1/systemone';

const DEFAULT_TYPESAFE_TIMEOUT_MS = 8_000;

/**
 * Flat cents recorded against the global spend cap after a 2xx. Jev's list
 * price is about $0.042 per million input tokens, so this call is a fraction
 * of a cent. One cent is the same deliberate over-estimate vision analysis
 * uses. Timeouts and transport errors are not metered.
 */
export const LETTERING_NOUL_COST_CENTS = 1;

/** TypeSafe's starting yes-line. A Noul has no separate confidence. */
export const DEFAULT_LETTERING_NOUL_THRESHOLD = 0.7;

/** TypeSafe's starting no-line. Between this and the yes-line, abstain to the keyword check. */
export const LETTERING_NOUL_NO = 0.3;

/**
 * The question, phrased so a high value means the customer wants writing in
 * the tattoo. "A name" means a name to letter, which `criteria` pins down so
 * a character's name does not read as a banner.
 */
export const LETTERING_NOUL_QUESTION =
  'Does this request ask for text, a name, lettering or a script?';

/**
 * Decide whether the request asked for writing.
 *
 * The Noul runs only when the flag is on, a key is set, and the spend cap
 * allows the call. Every other case — flag off, missing key, timeout, HTTP
 * or parse error, budget denial — returns the keyword answer. A metering
 * write failure after a 2xx still uses the Noul: the call already happened.
 * The key is never written to a log.
 */
export async function letteringWasRequested(prompt: string): Promise<boolean> {
  if (!letteringNoulEnabled()) return requestsLettering(prompt);

  const key = typesafeApiKey();
  if (!key) {
    logLettering({ fallback: 'missing_key' }, 'warn');
    return requestsLettering(prompt);
  }

  try {
    const budget = await checkBudget();
    if (!budget.allowed) {
      logLettering({ fallback: 'budget' }, 'warn');
      return requestsLettering(prompt);
    }
  } catch (error) {
    logLettering({ fallback: 'budget', error: redact(errorText(error), key) }, 'warn');
    return requestsLettering(prompt);
  }

  const started = Date.now();
  try {
    const response = await fetch(TYPESAFE_SYSTEMONE_URL, {
      method: 'POST',
      signal: AbortSignal.timeout(typesafeTimeoutMs()),
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: typesafeModel(),
        state: prompt,
        questions: {
          requests_lettering: {
            type: 'noul',
            instructions: LETTERING_NOUL_QUESTION,
            criteria: {
              true: 'The customer wants readable writing in the tattoo: words, a personal name, a date, a quote, lettering, calligraphy, or another script.',
              false: 'Names of subjects or characters, and style words such as script or calligraphy, say what to draw. They are not a request to letter text. A refusal such as "no text" or "remove the lettering" is not a request for writing.',
            },
          },
        },
      }),
    });

    if (!response.ok) {
      // Drain the body so a key echoed by an error page cannot reach a log.
      await response.text().catch(() => undefined);
      logLettering({
        fallback: 'http',
        status: response.status,
        durationMs: Date.now() - started,
      }, 'warn');
      return requestsLettering(prompt);
    }

    await recordLetteringSpend(key);

    let payload: unknown;
    try {
      payload = await response.json();
    } catch (error) {
      logLettering({
        fallback: 'parse',
        error: redact(errorText(error), key),
        durationMs: Date.now() - started,
      }, 'warn');
      return requestsLettering(prompt);
    }

    const noul = readNoul(payload);
    if (noul === undefined) {
      logLettering({ fallback: 'parse', durationMs: Date.now() - started }, 'warn');
      return requestsLettering(prompt);
    }

    const threshold = letteringThreshold();
    const asked = letteringFromNoul(noul, prompt, threshold);
    logLettering({ noul, threshold, asked, durationMs: Date.now() - started });
    return asked;
  } catch (error) {
    logLettering({
      fallback: isTimeoutError(error) ? 'timeout' : 'error',
      error: redact(errorText(error), key),
      durationMs: Date.now() - started,
    }, 'warn');
    return requestsLettering(prompt);
  }
}

function letteringNoulEnabled(): boolean {
  try {
    return envBool('TYPESAFE_LETTERING');
  } catch {
    return false;
  }
}

function typesafeApiKey(): string | undefined {
  try {
    const key = envString('TYPESAFE_API_KEY');
    return key || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Yes at or above the yes-line, no at or below 0.3, and the keyword check
 * in the unsure band. A Noul has no separate confidence, so the middle is
 * abstention rather than a confident no.
 */
export function letteringFromNoul(noul: number, prompt: string, yes = DEFAULT_LETTERING_NOUL_THRESHOLD): boolean {
  const yesLine = Number.isFinite(yes) && yes > LETTERING_NOUL_NO && yes <= 1
    ? yes
    : DEFAULT_LETTERING_NOUL_THRESHOLD;
  if (noul >= yesLine) return true;
  if (noul <= LETTERING_NOUL_NO) return false;
  return requestsLettering(prompt);
}

function typesafeTimeoutMs(): number {
  try {
    const value = envInt('TYPESAFE_TIMEOUT_MS');
    if (value === undefined || !Number.isFinite(value) || value < 1) return DEFAULT_TYPESAFE_TIMEOUT_MS;
    return value;
  } catch {
    return DEFAULT_TYPESAFE_TIMEOUT_MS;
  }
}

function letteringThreshold(): number {
  try {
    const value = envFloat('TYPESAFE_LETTERING_THRESHOLD');
    if (value === undefined || !Number.isFinite(value) || value < 0 || value > 1) {
      return DEFAULT_LETTERING_NOUL_THRESHOLD;
    }
    return value;
  } catch {
    return DEFAULT_LETTERING_NOUL_THRESHOLD;
  }
}

function readNoul(payload: unknown): number | undefined {
  if (!isRecord(payload) || !isRecord(payload.answers)) return undefined;
  const answer = payload.answers.requests_lettering;
  if (!isRecord(answer)) return undefined;
  const noul = answer.noul;
  if (typeof noul !== 'number' || !Number.isFinite(noul) || noul < 0 || noul > 1) return undefined;
  return noul;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

async function recordLetteringSpend(key: string): Promise<void> {
  try {
    await recordSpend(LETTERING_NOUL_COST_CENTS);
  } catch (error) {
    logger.warn({
      event_type: 'generation.text_guard.lettering_noul',
      fallback: 'spend_unrecorded',
      error: redact(errorText(error), key),
    });
  }
}

function logLettering(fields: Record<string, unknown>, level: 'info' | 'warn' = 'info'): void {
  const payload: Record<string, unknown> = { event_type: 'generation.text_guard.lettering_noul' };
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) payload[key] = value;
  }
  logger[level](payload);
}

function isTimeoutError(error: unknown): boolean {
  if (!error || typeof error !== 'object' || !('name' in error)) return false;
  const name = String((error as { name?: string }).name);
  return name === 'TimeoutError' || name === 'AbortError';
}

function errorText(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, 200);
}

function redact(message: string, key: string): string {
  if (!key || !message.includes(key)) return message;
  return message.split(key).join('[redacted]');
}

/**
 * Pure OCR: what legible lettering is in this artwork?
 *
 * No mention of the request, because that is what contaminated the earlier
 * versions. One job, and the one vision models are reliable at.
 */
function buildPrompt(): string {
  return [
    'List every piece of legible lettering in this tattoo design — words,',
    'letters, numbers, or characters in any script.',
    '',
    'Decorative marks are not lettering. Logos, crests and emblems without',
    'readable characters are not lettering. Illegible squiggles are not',
    'lettering. Report only characters you can actually read.',
    '',
    'Reply as JSON: {"words": [string]}',
  ].join('\n');
}

/**
 * Resolve a provider image into Vertex inlineData.
 *
 * Vertex/Gemini render paths return data URLs (sometimes JPEG); Replicate
 * returns HTTPS URLs. Bare base64 also appears. Fetch remote URLs so the
 * vision call always gets real image bytes.
 */
async function resolveImagePayload(
  image: string
): Promise<{ data: string; mimeType: string } | null> {
  if (image.startsWith('data:')) {
    const comma = image.indexOf(',');
    if (comma < 0) return null;
    const header = image.slice('data:'.length, comma);
    const data = image.slice(comma + 1);
    if (!data) return null;
    const mimeType = header.split(';')[0]?.trim() || 'image/png';
    return { data, mimeType };
  }

  if (/^https?:\/\//i.test(image)) {
    // Bounded (#327): this fetches a THIRD-PARTY host (Replicate's object
    // store), in front of every render now that the guard defaults on. A
    // slow host must degrade through the skip path, not hold the customer's
    // reveal until the function ceiling kills it. Expiry throws, the
    // screenForText catch returns skipped — the degrade the guard already
    // knows how to do.
    const response = await fetch(image, { signal: AbortSignal.timeout(IMAGE_FETCH_TIMEOUT_MS) });
    if (!response.ok) return null;
    const bytes = Buffer.from(await response.arrayBuffer());
    if (!bytes.byteLength) return null;
    const contentType = response.headers.get('content-type')?.split(';')[0]?.trim();
    const mimeType =
      contentType && contentType.startsWith('image/') ? contentType : 'image/png';
    return { data: bytes.toString('base64'), mimeType };
  }

  // Bare base64 — providers that omit the data-URL wrapper.
  if (!image) return null;
  return { data: image, mimeType: 'image/png' };
}

/**
 * Screen one render. Never throws.
 *
 * `image` may be a data URL, bare base64, or an HTTPS URL (Replicate).
 */
export async function screenForText(
  image: string,
  requestPrompt: string
): Promise<TextVerdict> {
  const budget = await checkBudget().catch(() => ({ allowed: false }));
  if (!budget.allowed) return skipped('budget');

  try {
    const payload = await resolveImagePayload(image);
    if (!payload) return skipped('parse');

    const model = guardModel();
    // Bounded (#327): a hung vision call degrades to skipped, same as above.
    const response = await fetch(buildVertexEndpoint(vertexProjectId(), model), {
      signal: AbortSignal.timeout(VISION_CALL_TIMEOUT_MS),
      method: 'POST',
      headers: {
        Authorization: `Bearer ${await getGcpAccessToken()}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        contents: [
          {
            role: 'user',
            parts: [
              { inlineData: { mimeType: payload.mimeType, data: payload.data } },
              { text: buildPrompt() },
            ],
          },
        ],
        generationConfig: { responseMimeType: 'application/json', temperature: 0.2 },
      }),
    });

    if (!response.ok) {
      logger.warn({ event_type: 'generation.text_guard.provider_failed', status: response.status });
      return skipped('provider');
    }

    const data = await response.json();
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) return skipped('parse');

    const parsed = JSON.parse(text);
    await recordSpend(VISION_ANALYSIS_COST_CENTS);

    const words: string[] = Array.isArray(parsed.words)
      ? parsed.words.filter((w: unknown) => typeof w === 'string' && w.trim())
      : [];

    /*
     * The comparison happens here, not in the vision model: lettering is
     * intruded unless the request asked for writing at all. The Noul (or the
     * keyword fallback) sees the prompt only. Words are reported either way
     * so a reviewer can see what was in the image. No OCR words means the
     * request judgment cannot change the verdict, so the Noul is not called.
     */
    const asked = words.length > 0 ? await letteringWasRequested(requestPrompt) : false;
    return {
      intruded: words.length > 0 && !asked,
      words,
      screened: true,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn({
      event_type: 'generation.text_guard.failed',
      error: redact(message, typesafeApiKey() ?? ''),
    });
    return skipped('parse');
  }
}

/** A result is clean when every image screened clean (unknown skips are not). */
export function isClean(verdicts: TextVerdict[]): boolean {
  return verdicts.every((v) => v.screened && !v.intruded);
}

export { CLEAN as CLEAN_VERDICT };
