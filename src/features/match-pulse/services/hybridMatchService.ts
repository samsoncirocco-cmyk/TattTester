/**
 * Hybrid Vector-Graph Matching Service
 *
 * Combines Neo4j graph traversal with vector similarity search
 * to enable semantic artist discovery beyond keyword matching.
 * With TYPESAFE_RERANK on, the scored shortlist is reordered by fit to
 * the brief after candidate generation. The flag defaults off.
 */

import { searchSimilar } from '@/services/vectorDbService';
import { VECTOR_DB_CONFIG } from '@/config/vectorDbConfig';
import { findMatchingArtists as findGraphArtists, findArtistsByEmbeddingIds, isNeo4jEnabled } from './neo4jService';
import {
    calculateCompositeScore,
    generateMatchReasoning,
    mergeResults,
    DEFAULT_WEIGHTS
} from '@/utils/scoreAggregation';
import { fetchWithAbort } from '@/services/fetchWithAbort';
import { generateQueryEmbedding as generateVertexEmbedding } from '@/services/embeddingService';
import { buildSemanticBrief, rerankArtistCandidates, rerankCacheKeyParts } from '@/services/matching/typesafeRerank';

// Type Definitions
export interface QueryPreferences {
    location?: string | null;
    styles?: string[];
    budget?: number | null;
    keywords?: string[];
    distance?: number;
    hasPortfolio?: boolean;
}

export interface VectorSearchResult {
    id: string | number;
    visualSimilarity: number;
    source: 'vector';
}

export interface GraphSearchResult {
    id: string | number;
    graphScore: number;
    source: 'graph';
    [key: string]: any;
}

export interface ScoreSignals {
    visualSimilarity: number;
    styleAlignment: number;
    location: number;
    rating: number;
    budget: number;
    randomVariety: number;
}

export interface MatchedArtist {
    id: string | number;
    name?: string;
    city?: string;
    styles?: string[];
    hourlyRate?: number;
    rating?: number;
    compositeScore: number;
    score: number;
    matchScore: number;
    scoreBreakdown: Record<string, unknown>;
    reasons: string[];
    visualSimilarity?: number;
    source?: 'vector' | 'graph';
    [key: string]: any;
}

export interface MatchResult {
    matches: MatchedArtist[];
    /** Broader results shown separately when `matches` is thin — never
     *  merged into `matches` itself. Empty when the primary set wasn't thin. */
    broadened: MatchedArtist[];
    broadenedReason?: string;
    totalCandidates: number;
    queryInfo: {
        query: string;
        visualConcepts: string[];
        keywords: string[];
        vectorResultCount: number;
        graphResultCount: number;
        /** True when the vector half was unavailable (graph-only results). */
        degraded: boolean;
        /** 'live' = real Neo4j graph; 'mock' = built-in demo artists. */
        graphSource: 'live' | 'mock';
    };
    performance: {
        totalTime: number;
        vectorTime: number;
        mergeTime: number;
    };
}

interface ParsedQuery {
    visualConcepts: string[];
    keywords: string[];
}

interface CacheEntry {
    data: MatchResult;
    timestamp: number;
}

// Simple in-memory cache for query results (5 minute TTL)
const queryCache = new Map<string, CacheEntry>();
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

/**
 * Parse user query to extract visual concepts and keywords
 */
function parseQuery(query: string): ParsedQuery {
    if (!query || typeof query !== 'string') {
        return { visualConcepts: [], keywords: [] };
    }

    // Split query into tokens
    const tokens = query.toLowerCase().trim().split(/\s+/);

    // For MVP, treat all tokens as both visual concepts and keywords
    // In production, could use NLP to distinguish visual vs. semantic terms
    return {
        visualConcepts: tokens,
        keywords: tokens
    };
}

/**
 * Generate embedding for query text using Vertex AI text-embedding-005
 * Converts natural language queries into 768-dimensional semantic vectors
 */
async function generateQueryEmbedding(query: string): Promise<number[]> {
    try {
        // Call Vertex AI embedding service
        const embedding = await generateVertexEmbedding(query);

        // Validate dimensions match config
        if (embedding.length !== VECTOR_DB_CONFIG.DIMENSIONS) {
            throw new Error(
                `Embedding dimension mismatch: expected ${VECTOR_DB_CONFIG.DIMENSIONS}, got ${embedding.length}`
            );
        }

        return embedding;
    } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        console.error('[HybridMatch] Embedding generation failed:', message);
        throw new Error(`Failed to generate query embedding: ${message}`);
    }
}

// Vector infrastructure (Vertex embeddings + Supabase pgvector) may be
// entirely absent. Cap how long the vector half may take so it can never
// hang the request — on timeout we proceed graph-only.
const VECTOR_SOFT_TIMEOUT_MS = 3000;

/**
 * Execute vector similarity search
 */
async function executeVectorSearch(query: string, topK: number = 20): Promise<VectorSearchResult[]> {
    try {
        // Generate query embedding
        const queryEmbedding = await generateQueryEmbedding(query);

        // Search for similar artists
        const results = await searchSimilar(queryEmbedding, topK);

        return results.map(result => ({
            id: result.id,
            visualSimilarity: result.score,
            source: 'vector' as const
        }));
    } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        console.error('[HybridMatch] Vector search failed:', message);
        return [];
    }
}

/**
 * Vector search that fails soft: resolves [] on timeout instead of
 * hanging or rejecting, so graph-only matching always proceeds.
 */
async function executeVectorSearchSoft(query: string, topK: number = 20): Promise<VectorSearchResult[]> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<VectorSearchResult[]>((resolve) => {
        timer = setTimeout(() => {
            console.warn(`[HybridMatch] Vector search exceeded ${VECTOR_SOFT_TIMEOUT_MS}ms — degrading to graph-only`);
            resolve([]);
        }, VECTOR_SOFT_TIMEOUT_MS);
    });

    try {
        return await Promise.race([executeVectorSearch(query, topK), timeout]);
    } finally {
        clearTimeout(timer);
    }
}

/**
 * Execute graph query for artist matching
 */
async function executeGraphQuery(preferences: QueryPreferences): Promise<GraphSearchResult[]> {
    try {
        const results = await findGraphArtists(preferences);

        return results.map((artist: any) => ({
            ...artist,
            graphScore: artist.matchScore || 0,
            source: 'graph' as const
        }));
    } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        console.error('[HybridMatch] Graph query failed:', message);
        return [];
    }
}

/**
 * Calculate location score
 */
function calculateLocationScore(artist: MatchedArtist, preferences: QueryPreferences): number {
    if (!preferences.location || !artist.city) {
        return 0.5; // Neutral if no location data
    }

    const userLocation = preferences.location.toLowerCase();
    const artistCity = artist.city.toLowerCase();

    if (artistCity === userLocation) {
        return 1.0; // Perfect match
    } else if (artistCity.includes(userLocation) || userLocation.includes(artistCity)) {
        return 0.75; // Partial match
    } else {
        return 0.25; // Different location
    }
}

/**
 * Calculate budget score
 */
function calculateBudgetScore(artist: MatchedArtist, preferences: QueryPreferences): number {
    if (!preferences.budget || !artist.hourlyRate) {
        return 0.5; // Neutral if no budget data
    }

    const rate = artist.hourlyRate;
    const budget = preferences.budget;

    if (rate <= budget) {
        return 1.0; // Within budget
    } else if (rate <= budget * 1.5) {
        return 0.5; // Slightly over budget
    } else {
        return 0.2; // Over budget
    }
}

/**
 * Calculate rating score (shop/artist rating, 0-5 stars -> 0-1).
 * Neutral when the artist has no published rating — never penalize
 * real artists the graph hasn't collected reviews for yet.
 */
function calculateRatingScore(artist: MatchedArtist): number {
    if (artist.rating == null || Number.isNaN(artist.rating)) {
        return 0.5;
    }
    return Math.max(0, Math.min(1, artist.rating / 5));
}

/**
 * Calculate style alignment score
 */
function calculateStyleScore(artist: MatchedArtist, preferences: QueryPreferences): number {
    if (!preferences.styles || preferences.styles.length === 0 || !artist.styles) {
        return 0.5; // Neutral if no style preferences
    }

    const matchingStyles = artist.styles.filter(style =>
        preferences.styles!.some(prefStyle =>
            prefStyle.toLowerCase() === style.toLowerCase()
        )
    );

    return matchingStyles.length / Math.max(preferences.styles.length, 1);
}

/**
 * Score a set of merged vector+graph candidates against the (original,
 * unrelaxed) user preferences and return them sorted best-first.
 */
function scoreArtists(
    mergedResults: any[],
    preferences: QueryPreferences,
    weights: typeof DEFAULT_WEIGHTS
): MatchedArtist[] {
    return mergedResults
        .map((artist: any): MatchedArtist => {
            const signals: ScoreSignals = {
                visualSimilarity: artist.visualSimilarity || 0,
                styleAlignment: calculateStyleScore(artist, preferences),
                location: calculateLocationScore(artist, preferences),
                rating: calculateRatingScore(artist),
                budget: calculateBudgetScore(artist, preferences),
                randomVariety: Math.random()
            };
            const { score, breakdown } = calculateCompositeScore(signals, weights) as { score: number; breakdown: Record<string, unknown> };
            const reasons = generateMatchReasoning(signals, artist, preferences);
            return {
                ...artist,
                compositeScore: score,
                score: Math.round(score * 100),
                matchScore: score,
                scoreBreakdown: breakdown,
                reasons
            };
        })
        .sort((a, b) => b.compositeScore - a.compositeScore);
}

// Below this many primary matches, broaden the search by relaxing the
// style/location filters instead of silently padding the primary set.
const THIN_RESULT_THRESHOLD = 4;
const MAX_BROADENED_RESULTS = 8;

/**
 * Find matching artists using hybrid vector-graph approach
 */
export async function findMatchingArtists(
    query: string,
    preferences: QueryPreferences = {},
    maxResults: number = 10
): Promise<MatchResult> {
    const startTime = performance.now();
    // Live Aura round-trips (plus a possible vector attempt) routinely take
    // longer than the old 500ms budget; keep a hard ceiling well above the
    // vector soft timeout so real graph queries are never killed mid-flight.
    const TIMEOUT_MS = 10000;

    // Check cache first. The rerank flag is part of the key so toggling it
    // cannot serve a shortlist ordered by the other mode.
    const cacheKey = JSON.stringify({ query, preferences, maxResults, typesafeRerank: rerankCacheKeyParts() });
    const cached = queryCache.get(cacheKey);

    if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
        console.log('[HybridMatch] Returning cached results');
        return cached.data;
    }

    console.log('[HybridMatch] Executing hybrid search:', { query, preferences });

    // Create timeout promise
    const timeoutPromise = new Promise<never>((_, reject) => {
        setTimeout(() => {
            reject(new Error(`Query timeout: exceeded ${TIMEOUT_MS}ms limit`));
        }, TIMEOUT_MS);
    });

    try {
        // Parse query
        const { visualConcepts, keywords } = parseQuery(query);

        // Execute with timeout
        const drafted = await Promise.race([
            (async (): Promise<MatchResult & { ranked: MatchedArtist[] }> => {
                const vectorStart = performance.now();

                // Execute vector and graph queries in parallel
                const [vectorResults, graphResults] = await Promise.all([
                    executeVectorSearchSoft(query, 20),
                    executeGraphQuery({
                        ...preferences,
                        keywords: keywords
                    })
                ]);

                const vectorTime = performance.now() - vectorStart;
                const mergeStart = performance.now();

                console.log(`[HybridMatch] Vector results: ${vectorResults.length}, Graph results: ${graphResults.length}`);

                // Merge results by artist ID
                const mergedResults = mergeResults(vectorResults, graphResults, 'id');

                console.log(`[HybridMatch] Merged results: ${mergedResults.length}`);

                // Graph-only degradation: when the vector half returned
                // nothing, zero its weight so real graph signals aren't
                // deflated by a uniformly-absent visualSimilarity.
                const vectorDegraded = vectorResults.length === 0;
                const weights = vectorDegraded
                    ? { ...DEFAULT_WEIGHTS, visualSimilarity: 0 }
                    : DEFAULT_WEIGHTS;

                // Calculate composite scores for each artist
                const scoredArtists = scoreArtists(mergedResults, preferences, weights);

                const mergeTime = performance.now() - mergeStart;

                // Top N by composite score
                const topMatches = scoredArtists.slice(0, maxResults);

                // Thin primary results with active style/location filters —
                // broaden by relaxing those filters, never by padding the
                // primary set itself. Broadened matches are still scored
                // against the ORIGINAL preferences (so a "broadened" artist
                // that happens to match everything still ranks accordingly)
                // and are always kept in a separate, clearly-labeled list.
                let broadened: MatchedArtist[] = [];
                let broadenedReason: string | undefined;
                // Every filter the relaxed call drops (it passes only
                // keywords) can be the reason a result is thin — including
                // the portfolio and rate filters spec 15 made live. Name the
                // ones in play so the client can say what was loosened.
                const relaxedFilters: string[] = [];
                if (preferences.styles && preferences.styles.length > 0) relaxedFilters.push('style');
                if (preferences.location) relaxedFilters.push('location');
                if (preferences.hasPortfolio) relaxedFilters.push('portfolio');
                if (preferences.budget) relaxedFilters.push('rate');
                const hasRelaxableFilters = relaxedFilters.length > 0;
                if (topMatches.length < THIN_RESULT_THRESHOLD && hasRelaxableFilters) {
                    const relaxedGraphResults = await executeGraphQuery({
                        keywords
                    });
                    const relaxedMerged = mergeResults(vectorResults, relaxedGraphResults, 'id');
                    const primaryIds = new Set(topMatches.map((m) => String(m.id)));
                    broadened = scoreArtists(relaxedMerged, preferences, weights)
                        .filter((m) => !primaryIds.has(String(m.id)))
                        .slice(0, MAX_BROADENED_RESULTS);
                    if (broadened.length > 0) {
                        broadenedReason = `Also nearby / similar — fewer than a handful of exact matches for your filters (relaxed: ${relaxedFilters.join(', ')})`;
                    }
                }

                const totalTime = performance.now() - startTime;

                // Log performance
                console.log(`[PERF] Semantic Match: ${totalTime.toFixed(0)}ms (vector: ${vectorTime.toFixed(0)}ms, merge: ${mergeTime.toFixed(0)}ms)`);

                // Warn if slow
                if (totalTime > 400) {
                    console.warn(`[PERF] Slow query detected: ${totalTime.toFixed(0)}ms - approaching ${TIMEOUT_MS}ms timeout`);
                }

                return {
                    matches: topMatches,
                    ranked: scoredArtists,
                    broadened,
                    broadenedReason,
                    totalCandidates: mergedResults.length,
                    queryInfo: {
                        query,
                        visualConcepts,
                        keywords,
                        vectorResultCount: vectorResults.length,
                        graphResultCount: graphResults.length,
                        degraded: vectorDegraded,
                        graphSource: (isNeo4jEnabled() && process.env.NEXT_PUBLIC_DEMO_MODE !== 'true')
                            ? 'live' as const
                            : 'mock' as const
                    },
                    performance: {
                        totalTime: Math.round(totalTime),
                        vectorTime: Math.round(vectorTime),
                        mergeTime: Math.round(mergeTime)
                    }
                };
            })(),
            timeoutPromise
        ]);

        // Rerank outside the search timeout. A slow TypeSafe call must not
        // fail candidate generation; a failure here keeps the scored order.
        const brief = buildSemanticBrief(query, preferences);
        let ordered = drafted.ranked;
        let broadened = drafted.broadened;
        try {
            ordered = await rerankArtistCandidates(brief, drafted.ranked);
            broadened = await rerankArtistCandidates(brief, drafted.broadened);
        } catch {
            console.warn('[HybridMatch] Brief rerank failed closed');
            ordered = drafted.ranked;
            broadened = drafted.broadened;
        }

        const result: MatchResult = {
            matches: ordered.slice(0, maxResults),
            broadened,
            broadenedReason: drafted.broadenedReason,
            totalCandidates: drafted.totalCandidates,
            queryInfo: drafted.queryInfo,
            performance: drafted.performance,
        };

        // Cache the result
        queryCache.set(cacheKey, {
            data: result,
            timestamp: Date.now()
        });

        // Clean up old cache entries
        cleanCache();

        return result;

    } catch (error) {
        const totalTime = performance.now() - startTime;
        const message = error instanceof Error ? error.message : 'Unknown error';

        // Check if it's a timeout error
        if (message.includes('timeout')) {
            console.error(`[HybridMatch] Query timeout after ${totalTime.toFixed(0)}ms:`, { query, preferences });
            throw new Error(`Search timeout: Query exceeded ${TIMEOUT_MS}ms limit. Try simplifying your search.`);
        }

        console.error('[HybridMatch] Error in findMatchingArtists:', message);
        throw new Error(`Hybrid matching failed: ${message}`);
    }
}

/**
 * Clean up expired cache entries
 */
function cleanCache(): void {
    const now = Date.now();
    queryCache.forEach((value, key) => {
        if (now - value.timestamp > CACHE_TTL) {
            queryCache.delete(key);
        }
    });
}

/**
 * Clear the query cache (useful for testing or manual refresh)
 */
export function clearCache(): void {
    queryCache.clear();
    console.log('[HybridMatch] Cache cleared');
}

/**
 * Get cache statistics
 */
export function getCacheStats(): { size: number; ttl: number; entries: string[] } {
    return {
        size: queryCache.size,
        ttl: CACHE_TTL,
        entries: Array.from(queryCache.keys())
    };
}
