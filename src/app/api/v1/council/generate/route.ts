/**
 * /api/v1/council/generate
 *
 * NOTE (ticket 04, ADR-0002): this route runs its own inline
 * brief → composition → style → prompt pipeline, duplicating what the
 * council module (src/services/council) does via enhance(). It is slated
 * for consolidation onto the council module in a later ticket; do not
 * extend the inline pipeline here.
 *
 * Port of ~/tatt_council.py (killua) to a Next.js server route.
 *
 * Pipeline:
 *   brief → composition → style → prompt → image (Flux 1.1 Pro) → critic
 *
 * Subject-research is intentionally omitted here. The candidate-picker UI
 * (see docs/council-plan.md) will collect customer-chosen references and
 * pass them in via the `references` field below; until then the pipeline
 * runs text-only.
 *
 * Input  (POST JSON):
 *   { customerText: string,            // required, plain-English idea
 *     references?: string[],           // optional, image URLs
 *     placementHint?: string }         // optional
 *
 * Output (JSON):
 *   {
 *     success: true,
 *     images: string[],                // Replicate output URLs
 *     metadata: { generatedAt, model, provider, brief, ... },
 *     critic: { verdict, issues[], suggestion },
 *     // ... (mirrors /api/generate shape where it makes sense)
 *   }
 */

import { NextRequest, NextResponse } from 'next/server';
import OpenAI from 'openai';
import { verifyApiAuth } from '@/lib/api-auth';
import { rateLimit, rateLimitResponse } from '@/lib/rate-limit';
import { checkBudget, recordSpend } from '@/lib/budget-tracker';
import { observeRenderedImage } from '@/lib/observeRender';
import { getAnatomicalAspectRatio } from '@/services/generation/internal/routing';
import { ONTOLOGY_TAG_IDS } from '@/lib/style-vocabulary';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Estimated cost of one council pipeline run, in cents. Covers the OpenRouter
// LLM calls (brief/composition/style/prompt/critic on Haiku) plus one Flux 1.1
// Pro image generation (~$0.04). Override via COUNCIL_PIPELINE_COST_CENTS.
const COUNCIL_PIPELINE_COST_CENTS =
  Number(process.env.COUNCIL_PIPELINE_COST_CENTS) || 10;

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const FAST_MODEL  = 'anthropic/claude-haiku-4-5';
const VISION_MODEL = 'anthropic/claude-haiku-4-5';
const FLUX_PRO    = 'black-forest-labs/flux-1.1-pro';
const FLUX_REDUX  = 'black-forest-labs/flux-redux-dev';

function or() {
  // Read at request time so env var changes are picked up without a rebuild.
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error('OPENROUTER_API_KEY not set');
  return new OpenAI({
    apiKey,
    baseURL: 'https://openrouter.ai/api/v1',
  });
}

function replicateToken(): string {
  const t = process.env.REPLICATE_API_TOKEN || process.env.REPLICATE_API_KEY;
  if (!t) throw new Error('REPLICATE_API_TOKEN not set');
  return t;
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function stripFences(s: string): string {
  s = s.trim();
  if (s.startsWith('```')) {
    const inner = s.split('\n').slice(1).join('\n').replace(/```\s*$/, '').trim();
    return inner.startsWith('json') ? inner.slice(4).trimStart() : inner;
  }
  return s;
}

async function llm(system: string, user: string, model = FAST_MODEL): Promise<string> {
  const r = await or().chat.completions.create({
    model,
    messages: [
      { role: 'system', content: system },
      { role: 'user',   content: user },
    ],
  });
  return (r.choices[0]?.message?.content ?? '').trim();
}

async function llmJson<T = any>(system: string, user: string, model = FAST_MODEL): Promise<T> {
  return JSON.parse(stripFences(await llm(system, user, model)));
}

async function llmVision(system: string, userText: string, imageUrl: string, model = VISION_MODEL): Promise<string> {
  const r = await or().chat.completions.create({
    model,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: [
        { type: 'text', text: userText },
        { type: 'image_url', image_url: { url: imageUrl } },
      ] as any },
    ],
  });
  return (r.choices[0]?.message?.content ?? '').trim();
}

// ---------------------------------------------------------------------------
// Agents
// ---------------------------------------------------------------------------

const BRIEF_SYSTEM = `You are a tattoo intake specialist. Parse the customer's
plain English request into a structured brief. Output JSON ONLY, no prose,
no fences.

Fields (all required):
{
  "placement":     one of: sleeve, half-sleeve, forearm, upper-arm, chest, back, thigh, calf, hand, foot, ribs, neck, finger, other,
  "style":         one of: ${ONTOLOGY_TAG_IDS.join(', ')}, mixed,
  "subject_type":  one of: named-characters, real-person, animals, objects, abstract, typography, scene, none,
  "subjects":      list of strings; empty for typography or pure abstract,
  "relationships": short string describing how subjects relate,
  "vibes":         list of 1-4 mood adjectives,
  "needs_reference": true if subjects include named characters or real public figures the image model would not draw accurately from text alone; false otherwise
}

If the customer didn't specify placement or style, infer the most likely one
and add a "notes" field listing what you inferred.`;

async function briefAgent(customerText: string) {
  return llmJson<any>(BRIEF_SYSTEM, customerText);
}

const COMPOSITION_SYSTEM = `You are a tattoo composition expert. Given a brief
(placement + subjects + relationships) design the spatial layout.

Output ONE paragraph (no markdown, no headings). Describe:
- focal point (where the eye lands first)
- where each subject sits
- how the eye travels across the piece
- what fills connective space (action lines, energy, foliage, smoke, etc.)
- how detail tapers at edges

Placement rules: sleeve/half-sleeve = vertical wrapping; forearm = rectangular;
chest = wide and symmetrical; back = full scene; hand/foot = small simple shapes;
lettering = typography flow not character placement.`;

async function compositionAgent(customerText: string, brief: any): Promise<string> {
  return llm(COMPOSITION_SYSTEM, `Customer: ${customerText}\n\nBrief: ${JSON.stringify(brief, null, 2)}`);
}

const STYLE_SYSTEM = `You are a tattoo style director. Given the brief's style
tag and subject type, write ONE paragraph (no markdown) describing visual
treatment: outline weight + color, palette, shading, texture, background
(always black or transparent — never busy).`;

async function styleAgent(brief: any): Promise<string> {
  return llm(STYLE_SYSTEM, JSON.stringify(brief, null, 2));
}

const PROMPT_SYSTEM = `You are an expert at writing prompts for Flux image
models. Flux wants comma-separated noun phrases, not flowery prose.

Output ONE Flux prompt. No explanation, no markdown fences.

Required ordering:
1. Global style line (tattoo style + outline + palette + shading)
2. Composition plan (one short sentence)
3. Subject clauses — for any named character lead with a source-style anchor
   (e.g. "in My Hero Academia anime style by Kohei Horikoshi")
4. Connective elements
5. Hard constraints: "no photorealism, no busy background, black background"

Aim for 100-200 words. No newlines.`;

async function promptAgent(brief: any, composition: string, style: string, references: string[]): Promise<string> {
  return llm(
    PROMPT_SYSTEM,
    `BRIEF:\n${JSON.stringify(brief, null, 2)}\n\nCOMPOSITION:\n${composition}\n\nSTYLE:\n${style}\n\nREFERENCES:\n${references.length ? references.join('\n') : '(none)'}`
  );
}

const CRITIC_SYSTEM = `You are a tattoo design critic. You will see a generated
image and the brief it was supposed to satisfy. Judge:
1. Does the image match the BRIEF (placement, style, subjects, vibes)?
2. Are all named subjects present and identifiable?
3. Does the composition fit the placement?
4. Is the style applied (e.g. fine-line should not look thick)?

Output JSON ONLY:
{
  "verdict": "ok" | "revise",
  "issues": [list of short specific problems, empty if ok],
  "suggestion": short string of what to change in the next prompt (empty if ok)
}`;

async function criticAgent(brief: any, imageUrl: string) {
  const raw = await llmVision(
    CRITIC_SYSTEM,
    `BRIEF:\n${JSON.stringify(brief, null, 2)}\n\nJudge the attached image.`,
    imageUrl
  );
  return JSON.parse(stripFences(raw));
}

// ---------------------------------------------------------------------------
// Image generation via Replicate
// ---------------------------------------------------------------------------

// Placement → aspect ratio is ADR-0023's map, and there is exactly one of
// it. This route used to carry a second, whole-string-equality copy with
// landscape 4:3 for chest/back, so the same placement got a different shape
// depending on which entry point served it.
function aspectFor(placement: string): string {
  // Sleeves are the one case the shared map has no word for — a sleeve is a
  // coverage area rather than a body part, and it is always portrait.
  if (/\bsleeves?\b/i.test(placement)) return '9:16';
  if (/\b(foot|feet|finger)s?\b/i.test(placement)) return '1:1';
  return getAnatomicalAspectRatio(placement);
}

async function replicateRun(model: string, input: Record<string, any>, max429Retries = 3): Promise<string> {
  const url = `https://api.replicate.com/v1/models/${model}/predictions`;
  for (let attempt = 0; attempt <= max429Retries; attempt++) {
    const r = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${replicateToken()}`,
        'Content-Type': 'application/json',
        'Prefer': 'wait',
      },
      body: JSON.stringify({ input }),
    });
    if (r.status === 429 && attempt < max429Retries) {
      const j = await r.json().catch(() => ({}));
      const wait = (Number(j.retry_after) || 2) + 1;
      await new Promise(res => setTimeout(res, wait * 1000));
      continue;
    }
    if (!r.ok) {
      const body = await r.text();
      throw new Error(`Replicate ${r.status}: ${body}`);
    }
    const j = await r.json();
    return Array.isArray(j.output) ? j.output[0] : j.output;
  }
  throw new Error('Replicate: exhausted 429 retries');
}

async function generateImage(prompt: string, brief: any, references: string[]) {
  const aspect = aspectFor(brief.placement);
  const haveRef = references.length > 0;
  if (haveRef) {
    return {
      model: FLUX_REDUX,
      url: await replicateRun(FLUX_REDUX, {
        redux_image: references[0],
        aspect_ratio: aspect,
        output_format: 'png',
      }),
    };
  }
  return {
    model: FLUX_PRO,
    url: await replicateRun(FLUX_PRO, {
      prompt,
      aspect_ratio: aspect,
      output_format: 'png',
      safety_tolerance: 2,
      prompt_upsampling: true,
    }),
  };
}

// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------

export async function POST(request: NextRequest) {
  // Auth check (async Firebase verify from hardening)
  const authError = await verifyApiAuth(request);
  if (authError) return authError;

  // Rate limiting (council pipeline is expensive: multiple LLM calls + image gen)
  const rateResult = await rateLimit(request, 'council');
  if (!rateResult.allowed) {
    return rateLimitResponse(rateResult);
  }

  // Budget check before running the paid pipeline
  const budgetResult = await checkBudget();
  if (!budgetResult.allowed) {
    return NextResponse.json(
      { error: 'Budget limit reached', spentCents: budgetResult.spentCents },
      { status: 402 }
    );
  }

  try {
    const body = await request.json();
    const customerText: string = (body?.customerText ?? body?.prompt ?? '').toString().trim();
    const references: string[] = Array.isArray(body?.references) ? body.references.filter(Boolean) : [];

    if (!customerText || customerText.length < 3) {
      return NextResponse.json(
        { error: 'customerText is required (plain-English tattoo idea)', code: 'INVALID_INPUT' },
        { status: 400 }
      );
    }

    const brief        = await briefAgent(customerText);
    const composition  = await compositionAgent(customerText, brief);
    const style        = await styleAgent(brief);
    const finalPrompt  = await promptAgent(brief, composition, style, references);
    const image        = await generateImage(finalPrompt, brief, references);
    // This lane buys a Flux render and its own prompt pins a clean backdrop
    // ("background always black or transparent — never busy"). The other paid
    // lanes measure that through observeRenderedImage; this one did not
    // (#396). Measure-and-log only — the bytes are already billed, so a
    // verdict must never fail the request. warnOnFail is true because this
    // prompt, unlike /api/v1/generate's caller-supplied one, asserts the
    // ADR-0023 presentation. Replicate returns a hosted URL, so the guard
    // records that it could not see the pixels rather than pretending it did.
    await observeRenderedImage(image.url, {
      eventType: 'council_generate.render_guard',
      fields: { model: image.model, provider: 'replicate' },
      warnOnFail: true,
    });
    const critique     = await criticAgent(brief, image.url);

    // Record estimated pipeline spend after a successful run.
    await recordSpend(COUNCIL_PIPELINE_COST_CENTS);

    return NextResponse.json({
      success: true,
      images: [image.url],
      uploads: [],
      metadata: {
        generatedAt: new Date().toISOString(),
        provider: 'replicate',
        model:    image.model,
        council:  {
          brief,
          composition,
          style,
          finalPrompt,
          references,
        },
      },
      critic: critique,
    });
  } catch (err: any) {
    const code = err?.code || 'GENERATION_FAILED';
    const status = code === 'INVALID_INPUT' ? 400 : 500;
    return NextResponse.json(
      { error: err?.message || 'council generation failed', code },
      { status }
    );
  }
}
