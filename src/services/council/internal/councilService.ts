/**
 * LLM Council API Service (Consolidated)
 *
 * Single entry point for council prompt enhancement with Vertex AI, OpenRouter,
 * and safe fallbacks.
 */
/* eslint-disable @typescript-eslint/no-explicit-any --
   Ported legacy implementation (ticket 04): moved verbatim into the module.
   The public contract is typed at the boundary (../index.ts); tightening the
   internals is deliberately out of scope for the move. */

import { buildCharacterMap, getAllCharacterNames } from '../../../config/characterDatabase.js';
import { envString } from '@/config/envSchema';
import { selectModelWithFallback, getModelPromptEnhancements } from '../../../utils/styleModelMapping.js';
import { COUNCIL_SKILL_PACK } from '../../../config/councilSkillPack';
import { resolvePlacement } from '@/lib/placement';
import { getGcpAccessToken } from '@/lib/google-auth-edge';
import { logEvent } from '@/lib/observability';
import {
  isTypesafeCouncilEnabled,
  redactSecret,
  tryTypedCouncil,
  type GeneratedDraft,
} from './typesafeJudge';

const COUNCIL_API_URL = process.env.NEXT_PUBLIC_COUNCIL_API_URL || process.env.COUNCIL_API_URL;
const DEMO_MODE = process.env.NEXT_PUBLIC_COUNCIL_DEMO_MODE === 'true' || process.env.NEXT_PUBLIC_DEMO_MODE === 'true';

/**
 * Structured error thrown when ALL real providers (Vertex AI + OpenRouter +
 * external Council API) AND the in-memory cache are exhausted. Callers should
 * catch this and surface a clear "temporarily unavailable" message — NEVER
 * silently substitute mock data.
 */
export class CouncilProviderError extends Error {
  provider: string;
  cause?: Error;
  retryAfterMs?: number;
  constructor(
    message: string,
    opts: { provider?: string; cause?: Error; retryAfterMs?: number } = {}
  ) {
    super(message);
    this.name = 'CouncilProviderError';
    this.provider = opts.provider || 'all_providers_exhausted';
    this.cause = opts.cause;
    this.retryAfterMs = opts.retryAfterMs ?? 60_000;
  }
}

/* ──────────────────────────────────────────────────────────────────────────
 * In-memory response cache (TTL 1h, capacity 500, lazy eviction)
 *
 * Used as a brief shock-absorber so transient Vertex AI hiccups don't reach
 * users on identical-shaped requests. On a healthy hit we return cached data
 * with `cacheHit: true`. On total provider failure we re-check the cache as
 * the last line of defense before throwing CouncilProviderError.
 * ────────────────────────────────────────────────────────────────────────── */
const CACHE_TTL_MS = 60 * 60 * 1000;
const CACHE_MAX_ENTRIES = 500;
type CacheEntry = { value: any; expiresAt: number };
const councilCache: Map<string, CacheEntry> = new Map();

function cacheKey(parts: {
  fn: string;
  userIdea?: string;
  style?: string;
  bodyPart?: string;
  complexity?: string;
  prompt?: string;
}): string {
  const norm = (s?: string) => (s || '').trim().toLowerCase().replace(/\s+/g, ' ');
  return [
    parts.fn,
    norm(parts.userIdea),
    norm(parts.style),
    norm(parts.bodyPart),
    norm(parts.complexity),
    norm(parts.prompt)
  ].join('|');
}

function cacheGet(key: string): any | undefined {
  const entry = councilCache.get(key);
  if (!entry) return undefined;
  if (entry.expiresAt < Date.now()) {
    councilCache.delete(key);
    return undefined;
  }
  // Refresh LRU position
  councilCache.delete(key);
  councilCache.set(key, entry);
  return entry.value;
}

function cacheSet(key: string, value: any) {
  // Evict oldest entries when at capacity (Map iterates in insertion order)
  while (councilCache.size >= CACHE_MAX_ENTRIES) {
    const oldest = councilCache.keys().next().value;
    if (oldest === undefined) break;
    councilCache.delete(oldest);
  }
  councilCache.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS });
}

function requireCouncilApiUrl(): string {
  if (!COUNCIL_API_URL) {
    throw new Error('External Council API is not configured');
  }
  const url = COUNCIL_API_URL.replace(/\/$/, '');
  const isLocalUrl = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/i.test(url);
  if (isLocalUrl && (process.env.VERCEL || process.env.NODE_ENV === 'production')) {
    throw new Error('External Council API points to localhost in production');
  }
  return url;
}

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const OPENROUTER_API_URL = 'https://openrouter.ai/api/v1/chat/completions';
const OPENROUTER_SITE_URL = process.env.OPENROUTER_SITE_URL || process.env.NEXT_PUBLIC_APP_URL || 'https://tatt-app.vercel.app';

const PROJECT_ID = process.env.NEXT_PUBLIC_VERTEX_AI_PROJECT_ID || process.env.GCP_PROJECT_ID || 'tatt-pro';
const REGION = process.env.GCP_REGION || 'us-central1';
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';

/**
 * Legacy serial council, used only when TYPESAFE_COUNCIL is off or TypeSafe
 * errors, times out, or has no key. These model ids are outdated on purpose:
 * rollback has to be the path that already shipped. The typed path drafts
 * once with COUNCIL_GENERATOR_MODEL (default google/gemini-2.5-flash) or
 * with GEMINI_MODEL on Vertex.
 */
const COUNCIL_MEMBERS = {
  creative: {
    model: 'anthropic/claude-3.5-sonnet',
    role: 'Creative Director',
    focus: 'Artistic vision, composition, and aesthetic appeal',
    estimatedCostUsd: 0.03
  },
  technical: {
    model: 'openai/gpt-4-turbo',
    role: 'Technical Expert',
    focus: 'Tattoo-specific technical details and feasibility',
    estimatedCostUsd: 0.03
  },
  style: {
    model: 'google/gemini-1.5-pro', // Updated 2026-03-17: fixed model ID format
    role: 'Style Specialist',
    focus: 'Style authenticity and cultural accuracy',
    estimatedCostUsd: 0.02
  }
};

function councilGeneratorModel(): string {
  return envString('COUNCIL_GENERATOR_MODEL') || 'google/gemini-2.5-flash';
}

const CHARACTER_MAP = buildCharacterMap() as Record<string, string>;
const CHARACTER_NAMES = getAllCharacterNames() as string[];

// 1) Token estimation (cheap approximation; avoids heavy tokenizers client-side)
export function estimateTokenCount(text: string): number {
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  return Math.ceil(words * 1.3); // ~1.3 tokens per word (rough GPT-2-ish heuristic)
}

// 2) Prompt validation with max token limit
export function validatePromptLength(
  prompt: string,
  maxTokens: number = 450
): { valid: boolean; error?: string; suggestion?: string; tokenCount: number } {
  const tokenCount = estimateTokenCount(prompt || '');
  if (tokenCount > maxTokens) {
    return {
      valid: false,
      tokenCount,
      error: `Prompt too long (${tokenCount} tokens, max ${maxTokens})`,
      suggestion: 'Simplify your description or disable council enhancement'
    };
  }
  return { valid: true, tokenCount };
}

/**
 * 3) Body-specific composition guidance (biases composition during prompt
 * enhancement).
 *
 * This used to be an exact-match object lookup, so it answered only for a
 * bare "forearm" or "chest" — never "left arm", "left forearm", "inner
 * forearm" or "sleeve", which is what intake actually produces. Every real
 * session got the literal string 'balanced composition' back and the prompt
 * ended "Composition follows balanced composition."
 *
 * Now a thin wrapper over the shared resolver, which matches phrases inside
 * the string the way generation routing always did.
 */
export function getAspectRatioGuidance(bodyPart: string): string {
  return resolvePlacement(bodyPart).composition;
}

function parseJsonFromText(text: string) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    // Try to extract the first valid JSON object
  }

  const firstBrace = text.indexOf('{');
  if (firstBrace === -1) return null;
  let depth = 0;
  for (let i = firstBrace; i < text.length; i += 1) {
    const char = text[i];
    if (char === '{') depth += 1;
    if (char === '}') depth -= 1;
    if (depth === 0) {
      const candidate = text.slice(firstBrace, i + 1);
      try {
        return JSON.parse(candidate);
      } catch {
        return null;
      }
    }
  }
  return null;
}

function detectStencilMode(userIdea = '', negativePrompt = '') {
  try {
    const combined = `${userIdea} ${negativePrompt}`.toLowerCase();
    return (COUNCIL_SKILL_PACK.stencilKeywords || []).some(keyword => combined.includes(keyword));
  } catch (error) {
    console.warn('[CouncilService] Error detecting stencil mode:', error);
    return false;
  }
}

function detectCharacters(text = '') {
  try {
    return CHARACTER_NAMES.filter(name =>
      new RegExp(`\\b${name}\\b`, 'i').test(text)
    );
  } catch (error) {
    console.warn('[CouncilService] Error detecting characters:', error);
    return [];
  }
}

function addIfMissing(prompt: string, token: string) {
  if (!token || !prompt) return prompt;
  try {
    const promptLower = prompt.toLowerCase();
    const tokenLower = token.toLowerCase();

    if (promptLower.includes(tokenLower)) {
      return prompt;
    }

    return `${prompt}, ${token}`;
  } catch (error) {
    console.warn('[CouncilService] Error in addIfMissing:', error);
    return prompt;
  }
}

function applyCouncilSkillPack(prompts: Record<string, string>, negativePrompt: string, context: any) {
  try {
    if (!prompts || typeof prompts !== 'object') {
      console.warn('[CouncilService] Invalid prompts object, skipping skill pack application');
      return { prompts: prompts || {}, negativePrompt: negativePrompt || '' };
    }

    if (!context || typeof context !== 'object') {
      console.warn('[CouncilService] Invalid context object, using defaults');
      context = { bodyPart: 'forearm', isStencilMode: false, characterMatches: [] };
    }

    const bodyPartKey = typeof context.bodyPart === 'string' ? context.bodyPart : '';
    const flowToken = bodyPartKey ? resolvePlacement(bodyPartKey).flow : '';
    const spatialKeywords = COUNCIL_SKILL_PACK.spatialKeywords || [];

    const hardenedPrompts = Object.entries(prompts).reduce((acc, [level, prompt]) => {
      if (typeof prompt !== 'string') {
        console.warn(`[CouncilService] Invalid prompt at level ${level}, skipping`);
        acc[level] = prompt;
        return acc;
      }

      let hardened = prompt;
      hardened = addIfMissing(hardened, flowToken);
      hardened = addIfMissing(hardened, COUNCIL_SKILL_PACK.aestheticAnchors);

      const promptCharacters = detectCharacters(hardened);
      const characters = promptCharacters.length > 0 ? promptCharacters : (context.characterMatches || []);

      if (characters.length >= 2) {
        const lower = hardened.toLowerCase();
        const hasPositioning = spatialKeywords.some(keyword => lower.includes(keyword));

        if (!hasPositioning) {
          hardened = `${characters[0]} on the left, ${characters[1]} on the right, ${hardened}`;
          console.log('[CouncilService] Forced positional anchoring for layer-safety');
        }
      }

      acc[level] = hardened;
      return acc;
    }, {} as Record<string, string>);

    let hardenedNegative = negativePrompt || '';

    if (context.isStencilMode) {
      const shield = COUNCIL_SKILL_PACK.negativeShield;
      const lower = hardenedNegative.toLowerCase();

      if (!lower.includes('shading') || !lower.includes('gradients')) {
        hardenedNegative = hardenedNegative
          ? `${shield}, ${hardenedNegative}`
          : shield;
      }
    }

    return { prompts: hardenedPrompts, negativePrompt: hardenedNegative };
  } catch (error) {
    console.error('[CouncilService] Error applying skill pack:', error);
    return { prompts: prompts || {}, negativePrompt: negativePrompt || '' };
  }
}

function enhanceCharacterDescription(userIdea: string) {
  const sortedNames = Object.keys(CHARACTER_MAP).sort((a, b) => b.length - a.length);
  const matchedCharacters: { name: string; description: string }[] = [];

  for (const characterName of sortedNames) {
    const regex = new RegExp(`\\b${characterName}\\b`, 'gi');
    if (regex.test(userIdea)) {
      matchedCharacters.push({
        name: characterName,
        description: CHARACTER_MAP[characterName]
      });
    }
  }

  if (matchedCharacters.length > 1) {
    const characterDescriptions = matchedCharacters.map((char, index) => {
      const position = index === 0 ? 'FIRST CHARACTER' : index === 1 ? 'SECOND CHARACTER' : `CHARACTER ${index + 1}`;
      return `${position}: ${char.description}`;
    });
    return characterDescriptions.join('. ');
  }

  let enhanced = userIdea;
  for (const characterName of sortedNames) {
    const regex = new RegExp(`\\b${characterName}\\b`, 'gi');
    enhanced = enhanced.replace(regex, CHARACTER_MAP[characterName]);
  }

  return enhanced;
}

const MOCK_RESPONSES = {
  simple: (userIdea: string, style: string) =>
    `A ${style} style tattoo of ${userIdea} with clean lines and bold composition`,

  detailed: (userIdea: string, style: string) => {
    const hasCharacters = CHARACTER_NAMES.some(name =>
      new RegExp(`\\b${name}\\b`, 'i').test(userIdea)
    );
    const enhanced = hasCharacters ? enhanceCharacterDescription(userIdea) : userIdea;

    return `A ${style} style tattoo featuring ${enhanced}, rendered with intricate detail and expert shading. ${hasCharacters ? 'Characters depicted with distinctive features, dynamic poses, and recognizable costumes/attributes. ' : ''}The composition emphasizes dynamic movement and visual balance, with careful attention to linework quality and traditional ${style} aesthetic principles. Designed for optimal placement and visual impact.`;
  },

  ultra: (userIdea: string, style: string, bodyPart: string) => {
    const hasCharacters = CHARACTER_NAMES.some(name =>
      new RegExp(`\\b${name}\\b`, 'i').test(userIdea)
    );

    const characterMatches = CHARACTER_NAMES.filter(name =>
      new RegExp(`\\b${name}\\b`, 'i').test(userIdea)
    );
    const characterCount = characterMatches.length;
    const isMultiCharacter = characterCount > 1;

    if (hasCharacters) {
      const compositionGuide = isMultiCharacter
        ? 'CRITICAL: This is a SINGLE UNIFIED TATTOO featuring multiple characters fighting/battling/interacting together in ONE cohesive scene. Characters are engaged in dynamic combat with each other, positioned in confrontational poses showing action and conflict. The composition shows both characters TOGETHER in the same space, creating a dramatic battle scene with energy and movement between them. While each character maintains their unique visual identity and recognizable features, they are part of ONE complete tattoo design, not separate images. Characters face each other or interact directly, with overlapping action lines, energy effects, or environmental elements connecting them. '
        : '';

      return `A photorealistic ${style} style tattoo featuring ${enhanceCharacterDescription(userIdea)}, masterfully composed for ${bodyPart} placement. ${compositionGuide}Character details: dynamic action poses with detailed facial expressions showing intensity and emotion, distinctive clothing and signature accessories rendered with precise linework, anatomically accurate proportions with muscular definition and flowing movement. The composition captures each character's unique fighting style and personality through body language and positioning, with characters clearly interacting and engaged in battle. Background elements frame the action without overwhelming the characters. Technical execution includes: hyper-detailed linework with gradient shading from deep blacks to subtle grays, creating dimensional depth and texture. Dramatic contrast between positive and negative space, flowing composition that wraps naturally around body contours. The style authentically captures traditional ${style} techniques with bold outlines, selective color placement, and atmospheric effects. Lighting and perspective create a three-dimensional effect, with focal points strategically positioned for maximum visual impact. The overall aesthetic balances intricate character detail with clean, readable forms suitable for professional tattooing.`;
    }

    return `A photorealistic ${style} style tattoo of ${userIdea}, masterfully composed for ${bodyPart} placement. The design features hyper-detailed linework with gradient shading from deep blacks to subtle grays, creating dimensional depth and texture. Artistic elements include: dramatic contrast between positive and negative space, flowing composition that wraps naturally around body contours, and carefully balanced visual weight. The style authentically captures traditional ${style} techniques with bold outlines, selective color placement, and atmospheric background elements. Lighting and perspective create a three-dimensional effect, with focal points strategically positioned for maximum visual impact. The overall aesthetic balances intricate character detail with clean, readable forms suitable for professional tattooing.`;
  },

  negative: (userIdea = '', options: NegativePromptOptions = {}) =>
    buildNegativeList(userIdea, options).join(', ')
};

/** Negatives for a single-subject piece. */
const SINGLE_SUBJECT_NEGATIVES = [
  'blurry', 'low quality', 'distorted', 'watermark', 'text', 'signature',
  'cartoon', 'childish', 'unrealistic anatomy', 'multiple people',
  'cluttered background', 'oversaturated', 'low contrast', 'pixelated',
  'amateur', 'messy linework'
];

/**
 * Negatives for a cast of two or more. Drops `multiple people` — the whole
 * request IS multiple people — and guards the real ensemble failure mode
 * instead: figures melting into each other.
 */
const ENSEMBLE_NEGATIVES = [
  'blurry', 'low quality', 'distorted', 'watermark', 'text', 'signature',
  'unrealistic anatomy', 'merged bodies', 'conjoined figures',
  'fused characters', 'morphed faces', 'duplicate limbs',
  'cluttered background', 'oversaturated', 'low contrast', 'pixelated',
  'amateur', 'messy linework', 'body horror', 'abstract',
  'deformed proportions'
];

/**
 * Style tags whose entire point is a drawn, illustrated look. `cartoon` as a
 * negative argues with the style the session just committed to — and for the
 * Flux lane negatives are folded into the prompt as an `Avoid:` clause, so
 * the contradiction is fed to the model in a single breath.
 */
const ILLUSTRATIVE_STYLE_TAGS = [
  'anime', 'illustrative', 'new school', 'neo traditional', 'cartoon',
  'manga', 'comic'
];

/** Negatives dropped when a style tag directly contradicts them. */
const STYLE_CONTRADICTIONS: { negative: string; contradictedBy: string[] }[] = [
  { negative: 'cartoon', contradictedBy: ILLUSTRATIVE_STYLE_TAGS },
  { negative: 'childish', contradictedBy: ILLUSTRATIVE_STYLE_TAGS }
];

export interface NegativePromptOptions {
  /**
   * Authoritative cast size, from `IntakeRecord.requestedCharacters`.
   *
   * Supply this whenever the caller has it. Without it the cast is
   * re-derived by regex against the character catalog, which only covers
   * anime — a Kingdom Hearts cast (a game) matches nothing, the request
   * reads as single-subject, and `multiple people` lands in a prompt that
   * just asked for four of them. That is exactly how a four-character
   * sleeve came back as one cropped face.
   */
  requestedCharacterCount?: number;
  /** Session style tags; negatives they contradict are dropped. */
  styleTags?: string[];
}

function buildNegativeList(userIdea: string, options: NegativePromptOptions): string[] {
  const detectedCount = CHARACTER_NAMES.filter(name =>
    new RegExp(`\\b${name}\\b`, 'i').test(userIdea)
  ).length;
  // Trust the intake's roster over re-detection; fall back to detection only
  // for legacy callers that never resolved one.
  const castSize = options.requestedCharacterCount ?? detectedCount;

  const negatives = castSize > 1 ? ENSEMBLE_NEGATIVES : SINGLE_SUBJECT_NEGATIVES;
  const tags = (options.styleTags ?? []).map(tag => tag.toLowerCase().trim());

  return negatives.filter(negative => {
    const rule = STYLE_CONTRADICTIONS.find(entry => entry.negative === negative);
    if (!rule) return true;
    return !tags.some(tag => rule.contradictedBy.includes(tag));
  });
}

/**
 * Base negative prompt shared with the structured-input mode (ADR-0015).
 * Kept as a thin wrapper so both modes draw from the same negative-prompt
 * craft instead of drifting apart.
 */
export function getBaseNegativePrompt(
  userIdea = '',
  options: NegativePromptOptions = {}
): string {
  return MOCK_RESPONSES.negative(userIdea, options);
}

function buildCouncilSystemPrompt({ bodyPart, isStencilMode }: { bodyPart: string; isStencilMode: boolean }) {
  const { composition: aspectRatioGuidance, flow: flowToken } = resolvePlacement(bodyPart);
  const stencilRule = isStencilMode
    ? 'STENCIL INTEGRITY: prioritize binary line-art and avoid gradients or soft shading.'
    : 'STENCIL INTEGRITY: only apply stencil rules when requested.';

  return [
    'You are a Senior Tattoo Architect on the TatT AI Council.',
    'Your goal is to produce elite, tattoo-ready prompts.',
    `COMPOSITION (ASPECT RATIO): ${aspectRatioGuidance}`,
    `POSITIONAL ANCHORING: ${COUNCIL_SKILL_PACK.positionalInstructions}`,
    `ANATOMICAL FLOW: ${flowToken}`,
    `AESTHETIC ANCHORS: ${COUNCIL_SKILL_PACK.aestheticAnchors}`,
    stencilRule
  ].join('\n');
}

async function callOpenRouter(model: string, systemPrompt: string, userPrompt: string, maxTokens = 500) {
  if (!OPENROUTER_API_KEY) {
    throw new Error('OPENROUTER_API_KEY not configured in environment variables');
  }

  const response = await fetch(OPENROUTER_API_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${OPENROUTER_API_KEY}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': OPENROUTER_SITE_URL,
      'X-Title': 'TatTester - AI Tattoo Design'
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ],
      temperature: 0.7,
      max_tokens: maxTokens
    })
  });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(`OpenRouter API error: ${error.error?.message || response.statusText}`);
  }

  const data = await response.json();
  return data.choices[0].message.content;
}

async function enhancePromptWithOpenRouter({
  userIdea,
  style = 'traditional',
  bodyPart = 'forearm',
  onDiscussionUpdate = null,
  isStencilMode = false,
  requestId
}: any) {
  const startTime = Date.now();
  const councilSystemPrompt = buildCouncilSystemPrompt({ bodyPart, isStencilMode });
  const flowToken = resolvePlacement(bodyPart).flow;
  const stencilHint = isStencilMode ? 'Stencil mode: prioritize clean, high-contrast linework.' : '';

  if (onDiscussionUpdate) {
    onDiscussionUpdate('Creative Director: Analyzing artistic vision...');
  }

  const creativePrompt = await callOpenRouter(
    COUNCIL_MEMBERS.creative.model,
    `${councilSystemPrompt}\nYou are a Creative Director specializing in tattoo design. Your role is to enhance user ideas into vivid, artistic prompts for AI image generation.`,
    `Enhance this tattoo idea into a detailed prompt for ${style} style tattoo on ${bodyPart}:
      
User idea: "${userIdea}"
Flow guidance: "${flowToken}"
${stencilHint}

Generate THREE versions:
1. SIMPLE (1 sentence): Clean, minimal enhancement
2. DETAILED (2-3 sentences): Rich artistic details
3. ULTRA (4-5 sentences): Photorealistic composition guide

Return as JSON:
{
  "simple": "...",
  "detailed": "...",
  "ultra": "..."
}`
  );

  const creativeResult = parseJsonFromText(creativePrompt);
  if (!creativeResult) {
    throw new Error('Failed to parse OpenRouter creative response');
  }

  if (onDiscussionUpdate) {
    onDiscussionUpdate('Technical Expert: Refining for tattoo execution...');
  }

  const technicalPrompt = await callOpenRouter(
    COUNCIL_MEMBERS.technical.model,
    `${councilSystemPrompt}\nYou are a Technical Expert in tattoo design. Your role is to ensure prompts are technically feasible and optimized for actual tattooing.`,
    `Review and refine this DETAILED prompt for technical accuracy:

"${creativeResult.detailed}"

Consider:
- Line weight and detail level for ${bodyPart} placement
- Color saturation and contrast
- Skin tone compatibility
- Aging and longevity

Return the refined prompt as plain text (not JSON).`
  );

  if (onDiscussionUpdate) {
    onDiscussionUpdate('Style Specialist: Ensuring style authenticity...');
  }

  const stylePrompt = await callOpenRouter(
    COUNCIL_MEMBERS.style.model,
    `${councilSystemPrompt}\nYou are a Style Specialist with deep knowledge of tattoo styles and cultural traditions. Your role is to ensure style authenticity.`,
    `Review this ULTRA prompt for ${style} style authenticity:

"${creativeResult.ultra}"

Enhance it with:
- Style-specific techniques and characteristics
- Cultural authenticity (if applicable)
- Traditional vs modern interpretations
- Signature elements of ${style} style

Return the enhanced prompt as plain text (not JSON).`
  );

  const negativePrompt = await callOpenRouter(
    COUNCIL_MEMBERS.technical.model,
    `${councilSystemPrompt}\nYou are a Technical Expert. Generate a negative prompt (things to avoid) for tattoo image generation.`,
    `For this tattoo idea: "${userIdea}"

Generate a negative prompt listing things to AVOID in the image generation. Focus on:
- Technical flaws (blurry, distorted, low quality)
- Inappropriate elements for tattoos
- Style-specific things to avoid

Return as a comma-separated list.`
  );

  const enhancementTime = Date.now() - startTime;
  const estimatedCost = Object.values(COUNCIL_MEMBERS).reduce((sum, member) => sum + member.estimatedCostUsd, 0);

  logEvent('council.result', {
    requestId,
    provider: 'openrouter',
    durationMs: enhancementTime,
    estimatedCostUsd: estimatedCost
  });

  return {
    prompts: {
      simple: creativeResult.simple,
      detailed: technicalPrompt.trim(),
      ultra: stylePrompt.trim()
    },
    negativePrompt: negativePrompt.trim(),
    metadata: {
      userIdea,
      style,
      bodyPart,
      generatedAt: new Date().toISOString(),
      enhancementTime,
      councilMembers: Object.keys(COUNCIL_MEMBERS).map(key => COUNCIL_MEMBERS[key as keyof typeof COUNCIL_MEMBERS].role),
      provider: 'openrouter',
      estimatedCostUsd: estimatedCost
    }
  };
}

function isOpenRouterConfigured() {
  return !!OPENROUTER_API_KEY;
}

async function enhancePromptWithVertexAI({
  userIdea,
  style = 'traditional',
  bodyPart = 'forearm',
  onDiscussionUpdate = null,
  isStencilMode = false,
  requestId,
  revisionNotes = ''
}: any) {
  if (onDiscussionUpdate) {
    setTimeout(() => onDiscussionUpdate('Gemini AI: Analyzing your tattoo concept...'), 300);
    setTimeout(() => onDiscussionUpdate('Gemini AI: Considering style and placement...'), 800);
    setTimeout(() => onDiscussionUpdate('Gemini AI: Generating detailed prompts...'), 1400);
  }

  const startTime = Date.now();
  const accessToken = await getGcpAccessToken();
  const projectId = resolveVertexProjectId() || PROJECT_ID;
  const endpoint = `https://${REGION}-aiplatform.googleapis.com/v1/projects/${projectId}/locations/${REGION}/publishers/google/models/${GEMINI_MODEL}:generateContent`;

  const aspectGuidance = getAspectRatioGuidance(bodyPart);
  const systemPrompt = `You are an expert tattoo design consultant. Your role is to enhance user ideas into detailed, professional tattoo prompts.

Style: ${style}
Body Part: ${bodyPart}
Composition guidance: ${aspectGuidance}
Stencil Mode: ${isStencilMode ? 'Yes (line art only)' : 'No (full color)'}

Generate THREE versions of the prompt:
1. SIMPLE: Basic description (1 sentence)
2. DETAILED: Rich description with composition details (2-3 sentences)
3. ULTRA: Comprehensive prompt with anatomical flow, character details, and technical specifications (4-5 sentences)

Also generate a NEGATIVE PROMPT to avoid unwanted elements.

Return as JSON:
{
  "simple": "...",
  "detailed": "...",
  "ultra": "...",
  "negativePrompt": "..."
}`;

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      contents: [{
        role: 'user',
        parts: [{ text: `${systemPrompt}\n\nUser Idea: ${userIdea}${revisionNotes ? `\n\nRevise the draft. Fix these problems and do not add lettering or real people the user did not name:\n${revisionNotes}` : ''}` }]
      }],
      generationConfig: {
        responseMimeType: 'application/json'
      }
    })
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Gemini API Error: ${response.status} - ${errText}`);
  }

  const data = await response.json();
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error('No content generated from Gemini');

  const prompts = parseJsonFromText(text);
  if (!prompts) {
    throw new Error('Failed to parse Gemini response');
  }

  const enhancementTime = Date.now() - startTime;

  logEvent('council.result', {
    requestId,
    provider: 'vertex-ai',
    durationMs: enhancementTime,
    estimatedCostUsd: 0
  });

  return {
    prompts: {
      simple: prompts.simple,
      detailed: prompts.detailed,
      ultra: prompts.ultra
    },
    negativePrompt: prompts.negativePrompt,
    metadata: {
      model: GEMINI_MODEL,
      userIdea,
      style,
      bodyPart,
      isStencilMode,
      generatedAt: new Date().toISOString(),
      enhancementTime,
      provider: 'vertex-ai',
      estimatedCostUsd: 0
    }
  };
}

/**
 * Resolve the Vertex project id from any of the names in use across the
 * stack (the Imagen client reads VERTEX_PROJECT_ID; older code used
 * NEXT_PUBLIC_VERTEX_AI_PROJECT_ID / GCP_PROJECT_ID), falling back to
 * the project_id inside the service-account JSON itself.
 */
export function resolveVertexProjectId(): string | null {
  const direct =
    process.env.NEXT_PUBLIC_VERTEX_AI_PROJECT_ID ||
    process.env.GCP_PROJECT_ID ||
    process.env.VERTEX_PROJECT_ID;
  if (direct) return direct;
  const credJson = process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON || process.env.GCP_SERVICE_ACCOUNT_KEY;
  if (credJson) {
    try {
      return JSON.parse(credJson).project_id ?? null;
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * One current-model draft: simple, detailed, ultra, and the negative prompt.
 * Vertex Gemini when that lane is on and configured; otherwise a single
 * OpenRouter call to COUNCIL_GENERATOR_MODEL. Never the legacy trio.
 */
async function generateSingleDraft({
  userIdea,
  style,
  bodyPart,
  isStencilMode,
  requestId,
  revisionNotes
}: {
  userIdea: string;
  style: string;
  bodyPart: string;
  isStencilMode: boolean;
  requestId: string;
  revisionNotes?: string;
}): Promise<GeneratedDraft> {
  const useVertex = (process.env.COUNCIL_VERTEX_AI_ENABLED ?? process.env.NEXT_PUBLIC_VERTEX_AI_ENABLED) !== 'false';
  if (useVertex && isVertexAIConfigured()) {
    const result = await enhancePromptWithVertexAI({
      userIdea,
      style,
      bodyPart,
      onDiscussionUpdate: null,
      isStencilMode,
      requestId,
      revisionNotes
    });
    return {
      prompts: {
        simple: result.prompts.simple,
        detailed: result.prompts.detailed,
        ultra: result.prompts.ultra
      },
      negativePrompt: result.negativePrompt || '',
      generator: 'vertex',
      generatorModel: GEMINI_MODEL
    };
  }

  if (!isOpenRouterConfigured()) {
    throw new Error('No single council generator is configured');
  }

  const councilSystemPrompt = buildCouncilSystemPrompt({ bodyPart, isStencilMode });
  const flowToken = resolvePlacement(bodyPart).flow;
  const stencilHint = isStencilMode ? 'Stencil mode: prioritize clean, high-contrast linework.' : '';
  const revisionBlock = revisionNotes
    ? `\n\nProblems to fix:\n${revisionNotes}`
    : '';
  const content = await callOpenRouter(
    councilGeneratorModel(),
    `${councilSystemPrompt}\nYou draft one tattoo prompt. Return JSON only. Do not role-play a panel of experts.`,
    `Write one tattoo prompt set for ${style} style on ${bodyPart}.

User request: "${userIdea}"
Flow guidance: "${flowToken}"
${stencilHint}${revisionBlock}

Return JSON:
{
  "simple": "one sentence",
  "detailed": "two or three sentences",
  "ultra": "four or five sentences",
  "negativePrompt": "comma-separated things to avoid"
}`,
    900
  );
  const parsed = parseJsonFromText(content);
  if (!parsed?.simple || !parsed?.detailed || !parsed?.ultra) {
    throw new Error('Failed to parse council generator response');
  }
  return {
    prompts: {
      simple: String(parsed.simple),
      detailed: String(parsed.detailed),
      ultra: String(parsed.ultra)
    },
    negativePrompt: String(parsed.negativePrompt || ''),
    generator: 'openrouter',
    generatorModel: councilGeneratorModel()
  };
}

function isVertexAIConfigured() {
  const credJson = process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON || process.env.GCP_SERVICE_ACCOUNT_KEY;
  const credPair = process.env.GCP_SERVICE_ACCOUNT_EMAIL && process.env.GCP_PRIVATE_KEY;
  return Boolean(resolveVertexProjectId() && (credJson || credPair));
}

export async function enhancePrompt({
  userIdea,
  style = 'traditional',
  bodyPart = 'forearm',
  onDiscussionUpdate = null,
  isStencilMode = null
}: any) {
  const startTime = Date.now();
  const requestId = `council_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const characterMatches = detectCharacters(userIdea);
  const resolvedStencilMode = isStencilMode === null
    ? detectStencilMode(userIdea)
    : Boolean(isStencilMode);

  const validation = validatePromptLength(userIdea);
  if (!validation.valid) {
    const error: any = new Error(validation.error);
    error.code = 'PROMPT_TOO_LONG';
    error.suggestion = validation.suggestion;
    error.tokenCount = validation.tokenCount;
    throw error;
  }

  // ── Cache lookup (skipped in DEMO_MODE so the demo path stays deterministic)
  const cKey = cacheKey({
    fn: 'enhancePrompt',
    userIdea,
    style,
    bodyPart,
    complexity: `${resolvedStencilMode}|ts:${isTypesafeCouncilEnabled() ? '1' : '0'}`
  });
  if (!DEMO_MODE) {
    const cached = cacheGet(cKey);
    if (cached) {
      logEvent('council.result', {
        requestId,
        provider: 'cache',
        durationMs: Date.now() - startTime,
        estimatedCostUsd: 0,
        cacheHit: true
      });
      return { ...cached, cacheHit: true };
    }
  }

  // Track underlying failures so we can attach them to CouncilProviderError.cause
  const providerErrors: Error[] = [];
  const modelSelectionPromise = selectModelWithFallback(style, userIdea, bodyPart);

  logEvent('council.request', {
    requestId,
    userIdeaLength: userIdea?.length || 0,
    style,
    bodyPart,
    stencil: resolvedStencilMode
  });

  if (!DEMO_MODE) {
    try {
      if (isTypesafeCouncilEnabled()) {
        const typed = await tryTypedCouncil({
          requestId,
          userIdea,
          style,
          bodyPart,
          isStencilMode: resolvedStencilMode,
          onDiscussionUpdate,
          generateDraft: async (revisionNotes) => {
            const raw = await generateSingleDraft({
              userIdea,
              style,
              bodyPart,
              isStencilMode: resolvedStencilMode,
              requestId,
              revisionNotes
            });
            const hardened = applyCouncilSkillPack(
              raw.prompts,
              raw.negativePrompt,
              { bodyPart, isStencilMode: resolvedStencilMode, characterMatches }
            );
            return {
              prompts: {
                simple: hardened.prompts.simple,
                detailed: hardened.prompts.detailed,
                ultra: hardened.prompts.ultra
              },
              negativePrompt: hardened.negativePrompt,
              generator: raw.generator,
              generatorModel: raw.generatorModel
            };
          }
        });
        if (typed) {
          cacheSet(cKey, typed);
          return typed;
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error('[CouncilService] Typed council unavailable, using legacy path:', redactSecret(message, process.env.TYPESAFE_API_KEY));
    }
  }

  const USE_VERTEX_AI = (process.env.COUNCIL_VERTEX_AI_ENABLED ?? process.env.NEXT_PUBLIC_VERTEX_AI_ENABLED) !== 'false';
  if (USE_VERTEX_AI && !DEMO_MODE) {
    try {
      if (isVertexAIConfigured()) {
        const result: any = await enhancePromptWithVertexAI({
          userIdea,
          style,
          bodyPart,
          onDiscussionUpdate,
          isStencilMode: resolvedStencilMode,
          requestId
        });

        const modelSelection: any = await modelSelectionPromise;
        result.modelSelection = {
          modelId: modelSelection.modelId,
          modelName: modelSelection.modelName,
          reasoning: modelSelection.reasoning,
          estimatedTime: modelSelection.estimatedTime,
          cost: 0,
          isFallback: modelSelection.isFallback || false
        };

        const hardened = applyCouncilSkillPack(
          result.prompts,
          result.negativePrompt,
          { bodyPart, isStencilMode: resolvedStencilMode, characterMatches }
        );

        const finalResult = { ...result, ...hardened };
        cacheSet(cKey, finalResult);
        return finalResult;
      }
      providerErrors.push(new Error('Vertex AI is not configured'));
    } catch (error) {
      console.error('[CouncilService] Vertex AI failed, trying fallback:', error);
      providerErrors.push(error instanceof Error ? error : new Error(String(error)));
    }
  }

  const USE_OPENROUTER = (process.env.COUNCIL_USE_OPENROUTER ?? process.env.NEXT_PUBLIC_USE_OPENROUTER) === 'true';
  if (USE_OPENROUTER && !DEMO_MODE) {
    try {
      if (isOpenRouterConfigured()) {
        const result: any = await enhancePromptWithOpenRouter({
          userIdea,
          style,
          bodyPart,
          onDiscussionUpdate,
          isStencilMode: resolvedStencilMode,
          requestId
        });

        const modelSelection: any = await modelSelectionPromise;
        result.modelSelection = {
          modelId: modelSelection.modelId,
          modelName: modelSelection.modelName,
          reasoning: modelSelection.reasoning,
          estimatedTime: modelSelection.estimatedTime,
          cost: modelSelection.cost,
          isFallback: modelSelection.isFallback || false
        };

        const hardened = applyCouncilSkillPack(
          result.prompts,
          result.negativePrompt,
          { bodyPart, isStencilMode: resolvedStencilMode, characterMatches }
        );

        const finalResult = { ...result, ...hardened };
        cacheSet(cKey, finalResult);
        return finalResult;
      }
      providerErrors.push(new Error('OpenRouter is not configured'));
    } catch (error) {
      console.error('[CouncilService] OpenRouter failed, falling back:', error);
      providerErrors.push(error instanceof Error ? error : new Error(String(error)));
    }
  }

  if (DEMO_MODE) {
    return new Promise((resolve) => {
      if (onDiscussionUpdate) {
        setTimeout(() => onDiscussionUpdate('Creative Director: Analyzing style and composition...'), 500);
        setTimeout(() => onDiscussionUpdate('Technical Expert: Considering placement constraints...'), 1200);
        setTimeout(() => onDiscussionUpdate('Style Specialist: Adding artistic refinements...'), 2000);
        setTimeout(() => onDiscussionUpdate('Model Selector: Choosing optimal AI model...'), 2400);
        setTimeout(() => onDiscussionUpdate('Composition Guru: Finalizing visual balance...'), 2800);
      }

      setTimeout(async () => {
        const modelSelection: any = await modelSelectionPromise;
        const prompts = {
          simple: MOCK_RESPONSES.simple(userIdea, style),
          detailed: MOCK_RESPONSES.detailed(userIdea, style),
          ultra: MOCK_RESPONSES.ultra(userIdea, style, bodyPart)
        };
        const negativePrompt = MOCK_RESPONSES.negative(userIdea);
        const hardened = applyCouncilSkillPack(
          prompts,
          negativePrompt,
          { bodyPart, isStencilMode: resolvedStencilMode, characterMatches }
        );

        resolve({
          prompts: hardened.prompts,
          negativePrompt: hardened.negativePrompt,
          modelSelection: {
            modelId: modelSelection.modelId,
            modelName: modelSelection.modelName,
            reasoning: modelSelection.reasoning,
            estimatedTime: modelSelection.estimatedTime,
            cost: modelSelection.cost,
            isFallback: modelSelection.isFallback || false
          },
          metadata: {
            userIdea,
            style,
            bodyPart,
            generatedAt: new Date().toISOString(),
            enhancementTime: Date.now() - startTime
          }
        });
      }, 3200);
    });
  }

  try {
    const councilApiUrl = requireCouncilApiUrl();
    const modelSelection: any = await modelSelectionPromise;

    const response = await fetch(`${councilApiUrl}/prompt-generation`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        user_idea: userIdea,
        style_preference: style,
        body_part: bodyPart,
        detail_level: 'all',
        onDiscussionUpdate: onDiscussionUpdate ? 'stream' : 'none'
      })
    });

    if (!response.ok) {
      throw new Error(`Council API error: ${response.status} ${response.statusText}`);
    }

    const data = await response.json();
    const enhancementTime = Date.now() - startTime;

    const ultraPrompt = data.enhanced_prompts.ultra || data.enhanced_prompts.comprehensive;
    const modelEnhancements: any = getModelPromptEnhancements(
      modelSelection.modelId,
      ultraPrompt,
      true
    );

    const prompts = {
      simple: data.enhanced_prompts.simple || data.enhanced_prompts.minimal,
      detailed: data.enhanced_prompts.detailed || data.enhanced_prompts.standard,
      ultra: modelEnhancements.enhancedPrompt
    };
    const negativePrompt = modelEnhancements.negativePrompt || data.negative_prompt || MOCK_RESPONSES.negative(userIdea);
    const hardened = applyCouncilSkillPack(
      prompts,
      negativePrompt,
      { bodyPart, isStencilMode: resolvedStencilMode, characterMatches }
    );

    const finalResult = {
      prompts: hardened.prompts,
      negativePrompt: hardened.negativePrompt,
      modelSelection: {
        modelId: modelSelection.modelId,
        modelName: modelSelection.modelName,
        reasoning: modelSelection.reasoning,
        estimatedTime: modelSelection.estimatedTime,
        cost: modelSelection.cost,
        isFallback: modelSelection.isFallback || false
      },
      metadata: {
        userIdea,
        style,
        bodyPart,
        generatedAt: new Date().toISOString(),
        councilVersion: data.version || 'v1',
        enhancementTime
      }
    };
    cacheSet(cKey, finalResult);
    return finalResult;

  } catch (error) {
    console.error('[CouncilService] Enhancement failed:', error);
    providerErrors.push(error instanceof Error ? error : new Error(String(error)));

    // Last-line-of-defense: re-check cache before hard-failing
    const cached = cacheGet(cKey);
    if (cached) {
      logEvent('council.result', {
        requestId,
        provider: 'cache-rescue',
        durationMs: Date.now() - startTime,
        estimatedCostUsd: 0,
        cacheHit: true,
        rescued: true
      }, 'warn');
      return { ...cached, cacheHit: true };
    }

    logEvent('council.result', {
      requestId,
      provider: 'none',
      durationMs: Date.now() - startTime,
      estimatedCostUsd: 0,
      failed: true,
      providerErrors: providerErrors.map(e => e.message)
    }, 'error');

    const primaryProviderError =
      providerErrors.find(error => !error.message.startsWith('External Council API')) ||
      providerErrors[providerErrors.length - 1];

    throw new CouncilProviderError(
      'all_providers_exhausted: AI Council temporarily unavailable',
      {
        provider: 'all_providers_exhausted',
        cause: primaryProviderError,
        retryAfterMs: 60_000
      }
    );
  }
}

export async function refinePrompt({ currentPrompt, refinementRequest }: any) {
  console.log('[CouncilService] Refining prompt:', { currentPrompt, refinementRequest });

  if (DEMO_MODE) {
    return new Promise((resolve) => {
      setTimeout(() => {
        resolve({
          refinedPrompt: `${currentPrompt} ${refinementRequest}`,
          suggestions: [
            'Consider adding more flowing elements',
            'Soften the line weight for a delicate feel',
            'Add floral or organic accents'
          ]
        });
      }, 2000);
    });
  }

  try {
    const councilApiUrl = requireCouncilApiUrl();
    const response = await fetch(`${councilApiUrl}/prompt-refinement`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        current_prompt: currentPrompt,
        refinement_request: refinementRequest
      })
    });

    if (!response.ok) {
      throw new Error(`Council API error: ${response.status}`);
    }

    return await response.json();

  } catch (error) {
    console.error('[CouncilService] Refinement failed:', error);
    throw error;
  }
}

export async function getStyleRecommendations(style: string) {
  console.log('[CouncilService] Getting style recommendations:', style);

  if (DEMO_MODE) {
    return {
      keyCharacteristics: [
        'Bold, clean lines',
        'Limited color palette',
        'Strong contrast'
      ],
      commonElements: [
        'Nautical themes',
        'Vintage Americana',
        'Classic iconography'
      ],
      promptTips: [
        'Emphasize outline quality',
        'Specify traditional color scheme',
        'Reference classic flash art'
      ]
    };
  }

  const cKey = cacheKey({ fn: 'getStyleRecommendations', style });
  const cached = cacheGet(cKey);
  if (cached) {
    return { ...cached, cacheHit: true };
  }

  try {
    const councilApiUrl = requireCouncilApiUrl();
    const response = await fetch(`${councilApiUrl}/style-recommendations/${style}`);

    if (!response.ok) {
      throw new Error(`Council API error: ${response.status}`);
    }

    const data = await response.json();
    cacheSet(cKey, data);
    return data;

  } catch (error) {
    console.error('[CouncilService] Style recommendations failed:', error);
    // Last-line-of-defense cache re-check before hard-fail
    const rescue = cacheGet(cKey);
    if (rescue) return { ...rescue, cacheHit: true };
    throw new CouncilProviderError(
      'all_providers_exhausted: style recommendations unavailable',
      {
        provider: 'council_api',
        cause: error instanceof Error ? error : new Error(String(error)),
        retryAfterMs: 60_000
      }
    );
  }
}

export async function validatePrompt(prompt: string) {
  console.log('[CouncilService] Validating prompt:', prompt);

  if (DEMO_MODE) {
    return {
      score: 85,
      isValid: true,
      suggestions: [
        'Great detail level',
        'Could specify line weight',
        'Consider adding shading direction'
      ]
    };
  }

  const cKey = cacheKey({ fn: 'validatePrompt', prompt });
  const cached = cacheGet(cKey);
  if (cached) {
    return { ...cached, cacheHit: true };
  }

  try {
    const councilApiUrl = requireCouncilApiUrl();
    const response = await fetch(`${councilApiUrl}/prompt-validation`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ prompt })
    });

    if (!response.ok) {
      throw new Error(`Council API error: ${response.status}`);
    }

    const data = await response.json();
    cacheSet(cKey, data);
    return data;

  } catch (error) {
    console.error('[CouncilService] Validation failed:', error);
    // Last-line-of-defense cache re-check before hard-fail
    const rescue = cacheGet(cKey);
    if (rescue) return { ...rescue, cacheHit: true };
    throw new CouncilProviderError(
      'all_providers_exhausted: prompt validation unavailable',
      {
        provider: 'council_api',
        cause: error instanceof Error ? error : new Error(String(error)),
        retryAfterMs: 60_000
      }
    );
  }
}
