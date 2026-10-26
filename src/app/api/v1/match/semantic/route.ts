import { NextRequest, NextResponse } from 'next/server';
import { verifyApiAuthWithUser } from '@/lib/api-auth';
import { rateLimit, rateLimitResponse } from '@/lib/rate-limit';
import { findMatchingArtists, type MatchResult } from '@/features/match-pulse/services/hybridMatchService';
import { validatePreferences } from './validate';

export const runtime = 'nodejs';

export async function POST(req: NextRequest) {
    // Auth check
    const { error: authError, user } = await verifyApiAuthWithUser(req);
    if (authError) return authError;

    // Each uncached search costs an embedding call plus graph queries; the
    // limiter existed but was never wired to this route.
    const limit = await rateLimit(req, 'semantic-match', user.uid);
    if (!limit.allowed) return rateLimitResponse(limit);

    try {
        let body;
        try {
            body = await req.json();
        } catch {
            return NextResponse.json({ error: 'Invalid JSON body.', code: 'INVALID_PREFERENCES' }, { status: 400 });
        }
        const {
            query,
            location,
            style_preferences = [],
            max_results = 10,
        } = body;

        const validated = validatePreferences(body);
        if (!validated.ok) {
            return NextResponse.json({ error: validated.error, code: 'INVALID_PREFERENCES' }, { status: 400 });
        }

        // Build preferences object
        const preferences = {
            location: location || null,
            styles: style_preferences,
            budget: validated.budget,
            distance: validated.radius,
            hasPortfolio: validated.hasPortfolio
        };

        // Execute hybrid matching
        const startTime = Date.now();
        const result: MatchResult = await findMatchingArtists(query, preferences, max_results);
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
