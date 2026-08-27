import { NextRequest, NextResponse } from 'next/server';
import { Ratelimit } from '@upstash/ratelimit';
import { Redis } from '@upstash/redis';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type LimitType =
  | 'semantic-match'
  | 'council'
  | 'generation'
  | 'estimate'
  | 'artist-claim'
  | 'sms-inbound'
  | 'converse-anon'
  | 'default';

interface RateLimitResult {
  allowed: boolean;
  limit: number;
  remaining: number;
  reset: number; // epoch seconds
}

// ---------------------------------------------------------------------------
// Per-endpoint rate limit windows
// ---------------------------------------------------------------------------

const LIMIT_CONFIG: Record<LimitType, { requests: number; window: string }> = {
  'semantic-match': { requests: 100, window: '1 h' },
  council:          { requests: 20,  window: '1 h' },
  generation:       { requests: 10,  window: '1 m' },
  estimate:         { requests: 30,  window: '1 m' },
  'artist-claim':   { requests: 5,   window: '1 h' },
  // SketchBot SMS inbound (TAT-49): per-phone, keyed on the sender's number,
  // not the request IP (every Twilio webhook arrives from Twilio's IPs).
  // Env-tunable because it is a REQUIRED spend guardrail — conversation
  // turns cost real model money.
  'sms-inbound':    {
    requests: Number(process.env.SKETCHBOT_SMS_MSGS_PER_HOUR) || 30,
    window: '1 h',
  },
  // SketchBot's web conversation for a SIGNED-OUT visitor, keyed on IP
  // (there is no uid to key on). Conversation turns are open to strangers
  // on purpose — the gate belongs in front of generation, not hello — but
  // they still cost real model money, so an open door is not an open bar.
  // A signed-in caller keeps the ordinary 'default' allowance, keyed on
  // their uid, and is unaffected by a noisy shared IP. Env-tunable for the
  // same reason the SMS limit is: it is a spend guardrail, not a UX knob.
  'converse-anon':  {
    requests: Number(process.env.SKETCHBOT_ANON_TURNS_PER_HOUR) || 40,
    window: '1 h',
  },
  default:          { requests: 60,  window: '1 m' },
};

// ---------------------------------------------------------------------------
// Upstash-backed limiters (created lazily, one per endpoint)
// ---------------------------------------------------------------------------

let upstashLimiters: Map<LimitType, Ratelimit> | null = null;
let warnedNoRedis = false;

function getUpstashLimiters(): Map<LimitType, Ratelimit> | null {
  if (upstashLimiters) return upstashLimiters;

  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) {
    // The in-memory fallback below only counts requests seen by THIS
    // serverless instance — on Vercel, concurrent traffic spreads across
    // multiple instances, each with its own empty counter, so the real
    // enforced limit is far weaker than LIMIT_CONFIG promises. That gap
    // must be visible, not silent (see budget-tracker.ts for the same
    // "log on degrade" pattern this was missing).
    if (!warnedNoRedis) {
      console.warn(
        '[RateLimit] UPSTASH_REDIS_REST_URL/UPSTASH_REDIS_REST_TOKEN not configured — ' +
          'falling back to a per-instance in-memory limiter. This does not enforce a ' +
          'shared limit across serverless instances.',
      );
      warnedNoRedis = true;
    }
    return null;
  }

  const redis = new Redis({ url, token });

  upstashLimiters = new Map();
  for (const [key, cfg] of Object.entries(LIMIT_CONFIG)) {
    upstashLimiters.set(
      key as LimitType,
      new Ratelimit({
        redis,
        limiter: Ratelimit.slidingWindow(cfg.requests, cfg.window as Parameters<typeof Ratelimit.slidingWindow>[1]),
        prefix: `tatt:rl:${key}`,
      }),
    );
  }
  return upstashLimiters;
}

// ---------------------------------------------------------------------------
// In-memory fallback (local dev without Redis)
// ---------------------------------------------------------------------------

interface MemoryEntry {
  tokens: number;
  resetAt: number; // epoch ms
}

const memoryStore = new Map<string, MemoryEntry>();

function windowMs(limitType: LimitType): number {
  const w = LIMIT_CONFIG[limitType].window;
  if (w.endsWith('h')) return parseInt(w) * 3_600_000;
  if (w.endsWith('m')) return parseInt(w) * 60_000;
  return 60_000;
}

function checkMemory(identifier: string, limitType: LimitType): RateLimitResult {
  const cfg = LIMIT_CONFIG[limitType];
  const win = windowMs(limitType);
  const key = `${limitType}:${identifier}`;
  const now = Date.now();

  let entry = memoryStore.get(key);
  if (!entry || now >= entry.resetAt) {
    entry = { tokens: cfg.requests, resetAt: now + win };
    memoryStore.set(key, entry);
  }

  if (entry.tokens > 0) {
    entry.tokens -= 1;
    return {
      allowed: true,
      limit: cfg.requests,
      remaining: entry.tokens,
      reset: Math.ceil(entry.resetAt / 1000),
    };
  }

  return {
    allowed: false,
    limit: cfg.requests,
    remaining: 0,
    reset: Math.ceil(entry.resetAt / 1000),
  };
}

// ---------------------------------------------------------------------------
// Identifier extraction
// ---------------------------------------------------------------------------

function getIdentifier(req: NextRequest, userId?: string): string {
  // Prefer a verified user id when the caller supplies one; fall back to IP.
  if (userId && userId.trim()) return `user:${userId.trim()}`;
  return (
    req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
    req.headers.get('x-real-ip') ||
    (req as unknown as { ip?: string }).ip ||
    'anonymous'
  );
}

// ---------------------------------------------------------------------------
// Public API  (maintains original signature for compatibility)
// ---------------------------------------------------------------------------

/**
 * Check rate limit for a request.
 * Returns `true` when the request is allowed, `false` when rate-limited.
 */
export async function checkRateLimit(
  req: NextRequest,
  limitType: string,
  userId?: string,
): Promise<boolean> {
  const lt = limitType as LimitType;
  // Fail closed: an unknown limit type is a caller bug; deny rather than
  // silently allow unlimited traffic.
  if (!(lt in LIMIT_CONFIG)) return false;

  const identifier = getIdentifier(req, userId);
  const limiters = getUpstashLimiters();

  if (limiters) {
    const limiter = limiters.get(lt)!;
    const { success } = await limiter.limit(identifier);
    return success;
  }

  // Fallback: in-memory
  const result = checkMemory(identifier, lt);
  return result.allowed;
}

// ---------------------------------------------------------------------------
// Enhanced API  (returns headers + supports 429 response creation)
// ---------------------------------------------------------------------------

export async function rateLimit(
  req: NextRequest,
  limitType: LimitType,
  userId?: string,
): Promise<RateLimitResult> {
  // Fail closed: an unknown limit type is a caller bug; deny the request
  // rather than granting unlimited access.
  if (!(limitType in LIMIT_CONFIG)) {
    return { allowed: false, limit: 0, remaining: 0, reset: 0 };
  }

  const identifier = getIdentifier(req, userId);
  const limiters = getUpstashLimiters();

  if (limiters) {
    const limiter = limiters.get(limitType)!;
    const { success, limit, remaining, reset } = await limiter.limit(identifier);
    return {
      allowed: success,
      limit,
      remaining,
      reset: Math.ceil(reset / 1000),
    };
  }

  return checkMemory(identifier, limitType);
}

/**
 * Attach standard rate-limit headers to a response.
 */
export function withRateLimitHeaders(
  response: NextResponse,
  result: RateLimitResult,
): NextResponse {
  response.headers.set('X-RateLimit-Limit', String(result.limit));
  response.headers.set('X-RateLimit-Remaining', String(result.remaining));
  response.headers.set('X-RateLimit-Reset', String(result.reset));
  return response;
}

/**
 * Build a 429 Too Many Requests response with Retry-After.
 */
export function rateLimitResponse(result: RateLimitResult): NextResponse {
  const retryAfter = Math.max(0, result.reset - Math.ceil(Date.now() / 1000));
  const res = NextResponse.json(
    { error: 'Too Many Requests', retryAfter },
    { status: 429 },
  );
  res.headers.set('Retry-After', String(retryAfter));
  return withRateLimitHeaders(res, result);
}

// Re-export for convenience
export { LIMIT_CONFIG };
