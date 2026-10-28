import { NextRequest, NextResponse } from 'next/server';
import { searchDesignCandidates } from '@/services/matching/designSearch';
import type { Design } from '@/services/designLibraryService';
import { verifyApiAuthWithUser } from '@/lib/api-auth';
import { rateLimit, rateLimitResponse } from '@/lib/rate-limit';

export const dynamic = 'force-dynamic';

/**
 * Server design search. The browser sends the keyword shortlist it already
 * built. This route reranks that list when TYPESAFE_RERANK is on and never
 * returns a provider key. An empty or failed rerank keeps the submitted order.
 */
export async function POST(req: NextRequest) {
  // A rerank can make a paid TypeSafe call, so only a signed-in, rate-limited caller reaches it.
  const { error: authError, user } = await verifyApiAuthWithUser(req);
  if (authError) return authError;
  const limit = await rateLimit(req, 'semantic-match', user.uid);
  if (!limit.allowed) return rateLimitResponse(limit);

  const body = await req.json().catch(() => ({}));
  const brief = typeof body?.brief === 'string' ? body.brief.slice(0, 500) : '';
  const designs = Array.isArray(body?.designs) ? body.designs.map(asDesign).filter(Boolean) as Design[] : [];
  if (!brief.trim() || designs.length === 0) {
    return NextResponse.json({ ids: designs.map((design) => design.id), applied: false });
  }

  try {
    const ranked = await searchDesignCandidates(brief, designs);
    const ids = ranked.map((design) => design.id).filter((id) => designs.some((design) => design.id === id));
    if (ids.length === 0) {
      return NextResponse.json({ ids: designs.map((design) => design.id), applied: false });
    }
    const seen = new Set(ids);
    for (const design of designs) {
      if (!seen.has(design.id)) ids.push(design.id);
    }
    return NextResponse.json({ ids, applied: ids.join(',') !== designs.map((design) => design.id).join(',') });
  } catch {
    return NextResponse.json({ ids: designs.map((design) => design.id), applied: false });
  }
}

function asDesign(value: unknown): Design | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  if (typeof record.id !== 'string' || !record.id.trim()) return null;
  const userInput = record.userInput && typeof record.userInput === 'object'
    ? record.userInput as Design['userInput']
    : {
        subject: typeof record.subject === 'string' ? record.subject : '',
        style: typeof record.style === 'string' ? record.style : '',
        bodyPart: typeof record.placement === 'string' ? record.placement : '',
      };
  return {
    id: record.id,
    imageUrl: '',
    metadata: { savedAt: '' },
    userInput,
    favorite: false,
    notes: typeof record.notes === 'string' ? record.notes : '',
    tags: Array.isArray(record.tags) ? record.tags.filter((tag): tag is string => typeof tag === 'string') : [],
  };
}
