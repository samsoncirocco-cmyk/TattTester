import { NextRequest, NextResponse } from 'next/server';
import { verifyApiAuth } from '@/lib/api-auth';
// @ts-ignore
import { getHybridArtistMatches } from '@/features/match-pulse/services/matchService.js';
// @ts-ignore
import { updateMatches } from '@/services/firebase-match-service';

export const runtime = 'nodejs';

export async function POST(req: NextRequest) {
    const authError = await verifyApiAuth(req);
    if (authError) return authError;

    try {
        const body = await req.json();
        const {
            userId,
            designId,
            prompt,
            style,
            bodyPart,
            location,
            budget,
            embeddingVector
        } = body;

        if (!userId || !designId) {
            return NextResponse.json({ error: 'Missing required fields: userId, designId' }, { status: 400 });
        }

        const context = {
            style,
            bodyPart,
            location,
            budget,
            prompt,
            layerCount: 0,
            embeddingVector
        };

        const matchResults: any = await getHybridArtistMatches(context, {
            embeddingVector,
            limit: 20
        });

        const payload = {
            designId,
            artists: matchResults.matches || []
        };

        await updateMatches(userId, payload);

        return NextResponse.json({
            matchId: designId,
            artists: matchResults.matches || [],
            firebasePath: `/matches/${userId}/current`,
            processingTime: matchResults.processingTime || null
        });

    } catch (error: any) {
        console.error('[MatchUpdate] Failed:', error);
        return NextResponse.json({ error: 'Match update failed', message: error.message }, { status: 500 });
    }
}
