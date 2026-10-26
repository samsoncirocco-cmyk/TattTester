import { NextRequest, NextResponse } from 'next/server';
import { verifyApiAuth } from '@/lib/api-auth';
import { findMatchingArtists, type MatchResult } from '@/features/match-pulse/services/hybridMatchService';
import { parseSemanticMatchRequest } from './request';

export const runtime = 'nodejs';

export async function POST(req: NextRequest) {
    // Auth check
    const authError = await verifyApiAuth(req);
    if (authError) return authError;

    let body: unknown;
    try {
        body = await req.json();
    } catch {
        return NextResponse.json(
            { error: 'Request body must be JSON', code: 'INVALID_JSON' },
            { status: 400 }
        );
    }

    const parsed = parseSemanticMatchRequest(body);
    if (!parsed.ok) {
        return NextResponse.json({ error: parsed.error, code: parsed.code }, { status: 400 });
    }

    try {
        const { query, location, styles, budget, distance, hasPortfolio, maxResults } = parsed.value;

        const preferences = {
            location,
            styles,
            budget,
            distance,
            hasPortfolio,
        };

        // Execute hybrid matching
        const startTime = Date.now();
        const result: MatchResult = await findMatchingArtists(query, preferences, maxResults);
        const duration = Date.now() - startTime;

        console.log(`[API] Semantic match completed in ${duration}ms, found ${result.matches.length} matches`);

        return NextResponse.json({
            success: true,
            matches: result.matches,
            broadened: result.broadened,
            broadened_reason: result.broadenedReason,
            total_candidates: result.totalCandidates,
            query_info: result.queryInfo,
            performance: {
                duration_ms: duration
            }
        });

    } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        console.error('[API] Semantic match error:', message);
        return NextResponse.json({ error: 'Semantic matching failed', details: message }, { status: 500 });
    }
}
