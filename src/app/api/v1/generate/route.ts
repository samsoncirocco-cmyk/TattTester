import { NextRequest, NextResponse } from 'next/server';
import { verifyApiAuth } from '@/lib/api-auth';
import { generate, routeGeneration } from '@/services/generation';
import { rateLimit, rateLimitResponse } from '@/lib/rate-limit';
import { checkBudget, recordSpend, VERTEX_IMAGEN_COST_CENTS } from '@/lib/budget-tracker';
import { createRequestLogger } from '@/lib/logger';
import { DEMO_MOCK_IMAGES } from '@/lib/demo-images';
import { observeRenderedImage } from '@/lib/observeRender';
import { verifyFirebaseToken } from '@/lib/auth-dal';
import {
    GenerationCreditsExhaustedError,
    releaseGenerationCredit,
    reserveGenerationCredit,
    type GenerationCreditReservation,
} from '@/lib/generation-credits';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Thin adapter over the generation module (ADR-0001). Vertex retry, the
// relaxed-safety fallback, and the vertex → replicate-sdxl fallback (gated on
// REPLICATE_API_TOKEN) all live INSIDE generate() now — this route only does
// auth/rate/budget policy, spend recording, and response-shape mapping.

// Spend on a replicate-sdxl fallback result (~1 cent), matching the old
// route's flat fallback cost.
const REPLICATE_FALLBACK_COST_CENTS = 1;
// Primary Replicate (style-routed Flux/Krea) — per image, same rate the
// design-session ledger uses for Replicate purchases.
const REPLICATE_COST_CENTS = 1;

/** Derive outputFormat from a data-URL mime type (Gemini may return jpeg/png/…). */
function outputFormatFromImages(images: string[] | undefined): string {
    const match = images?.[0]?.match(/^data:image\/([^;]+);/i);
    return match?.[1]?.toLowerCase() || 'png';
}

export async function POST(req: NextRequest) {
    const reqLogger = createRequestLogger('generate');

    // Auth check
    const authError = await verifyApiAuth(req);
    if (authError) return authError;

    const user = await verifyFirebaseToken(req);
    if (!user) {
        return NextResponse.json({ error: 'Authentication required', code: 'AUTH_REQUIRED' }, { status: 401 });
    }

    // ─── DEMO MODE ─────────────────────────────────────────────────────────
    if (process.env.NEXT_PUBLIC_DEMO_MODE === 'true') {
        const body = await req.json().catch(() => ({}));
        const sampleCount = Math.min(Number(body.sampleCount || body.num_outputs || 4), 4);
        await new Promise(r => setTimeout(r, 1500));
        return NextResponse.json({
            success: true,
            images: DEMO_MOCK_IMAGES.slice(0, sampleCount),
            metadata: {
                generatedAt: new Date().toISOString(),
                prompt: body.prompt || 'demo',
                model: 'demo-mode',
                provider: 'demo',
                demoMode: true,
            }
        });
    }

    const rateResult = await rateLimit(req, 'generation');
    if (!rateResult.allowed) {
        return rateLimitResponse(rateResult);
    }

    const budgetResult = await checkBudget();
    if (!budgetResult.allowed) {
        return NextResponse.json(
            { error: 'Budget limit reached', spentCents: budgetResult.spentCents },
            { status: 402 }
        );
    }

    const body = await req.json().catch(() => ({}));

    let creditReservation: GenerationCreditReservation | null = null;
    let generationSucceeded = false;
    try {
        const {
            prompt,
            negativePrompt,
            style,
            bodyPart,
            size,
            sampleCount,
            num_outputs,
            aspectRatio,
            safetyFilterLevel,
            personGeneration,
            outputFormat,
            seed
            // modelId is deliberately not destructured: a caller cannot pin the
            // provider here (#287). Pulling it out again is the first step back
            // toward forwarding it.
        } = body;

        if (!prompt || typeof prompt !== 'string' || prompt.trim().length < 3) {
            return NextResponse.json({ error: 'Prompt is required', code: 'INVALID_PROMPT' }, { status: 400 });
        }

        const requestedCount = Number(sampleCount || num_outputs || 1);
        if (Number.isNaN(requestedCount) || requestedCount < 1 || requestedCount > 4) {
            return NextResponse.json({ error: 'sampleCount must be between 1 and 4', code: 'INVALID_SAMPLE_COUNT' }, { status: 400 });
        }

        creditReservation = await reserveGenerationCredit(user.uid);

        const result = await generate({
            prompt: prompt.trim(),
            negativePrompt: negativePrompt?.trim(),
            numImages: requestedCount,
            aspectRatio: aspectRatio || '1:1',
            safetyFilterLevel,
            personGeneration,
            outputFormat,
            seed,
            // Route by style rather than pinning Vertex. This used to hardcode
            // modelId 'imagen3', which made every call here go to Google no
            // matter what modelRoutingRules.js said — so taking realism off
            // Google in the routing table did not cover this endpoint. Passing
            // the style lets the one routing table decide, here and everywhere
            // else, and the replicate-result branch below already handles a
            // non-Vertex outcome.
            style,
            bodyPart,
            retry: {
                maxRetries: 2,
                baseDelayMs: 400
            },
            fallback: {
                safetyFilterLevel: 'block_only_high'
            }
        });
        generationSucceeded = true;

        // The pixel guard, on the lane that reserves a customer credit and
        // renders directly. #389 armed it inside the design-session
        // orchestrator, which this endpoint does not go through — so it bought
        // renders nothing measured (#392). Measure-and-log only, exactly as
        // there: the credit is already reserved and the bytes already billed,
        // so a verdict must never cost the caller their generation.
        //
        // warnOnFail is FALSE here on purpose. The design-session lanes pin the
        // ADR-0023 flash-art presentation, so a failing backdrop verdict there
        // is a real defect. This endpoint renders whatever prompt the caller
        // sends, so the backdrop expectation was never asserted — a low
        // fraction is an observation, not a violation, and warning on it would
        // train people to ignore the event. The measurement is recorded either
        // way; only the level differs.
        await Promise.all(
            (result.images ?? []).map((image, index) =>
                observeRenderedImage(image, {
                    eventType: 'generate_api.render_guard',
                    fields: { uid: user.uid, image_index: index },
                    warnOnFail: false,
                })
            )
        );

        // ─── Cross-provider fallback result ───────────────────────────────
        // The module fell back to Replicate after a Vertex failure.
        // Primary Replicate (style-routed Flux/Krea) also has
        // provider === 'replicate' but fallbackUsed === false — that path
        // must keep the full success shape and per-image spend below.
        if (result.metadata.provider === 'replicate' && result.metadata.fallbackUsed) {
            await recordSpend(REPLICATE_FALLBACK_COST_CENTS);

            reqLogger.complete('generation.fallback.replicate.success', {
                model: result.metadata.model,
                image_count: result.images.length,
            });

            return NextResponse.json({
                success: true,
                images: result.images,
                metadata: {
                    generatedAt: new Date().toISOString(),
                    prompt: prompt.trim(),
                    model: result.metadata.model,
                    provider: 'replicate',
                    fallback: true,
                    fallbackReason: result.metadata.fallbackReason || 'VERTEX_FAILED',
                },
                credits: creditReservation,
            });
        }

        // Primary success — Vertex or style-routed Replicate.
        const imagesGenerated = result.images?.length || requestedCount;
        const spendCents =
            result.metadata.provider === 'replicate'
                ? REPLICATE_COST_CENTS * imagesGenerated
                : VERTEX_IMAGEN_COST_CENTS * imagesGenerated;
        await recordSpend(spendCents);

        return NextResponse.json({
            success: true,
            images: result.images,
            metadata: {
                generatedAt: new Date().toISOString(),
                prompt: prompt.trim(),
                negativePrompt: negativePrompt?.trim() || null,
                model: result.metadata.model,
                provider: result.metadata.provider,
                style: style || null,
                bodyPart: bodyPart || null,
                size: size || null,
                aspectRatio: aspectRatio || '1:1',
                outputFormat: outputFormatFromImages(result.images),
                durationMs: result.metadata.durationMs,
                attempts: result.metadata.attempts,
                safetyFilterLevel: result.metadata.safetyFilterLevel,
                personGeneration: result.metadata.personGeneration,
                seed: result.metadata.seed ?? null,
                fallbackUsed: result.metadata.fallbackUsed
            },
            credits: creditReservation,
        });

    } catch (error: unknown) {
        if (creditReservation && !generationSucceeded) {
            await releaseGenerationCredit(user.uid, creditReservation).catch((releaseError) => {
                console.error('[Generation] failed to return unused generation credit:', releaseError);
            });
        }
        const generationError = error as { code?: string; message?: string; details?: { retry_after?: number } };
        // Log the model that was actually attempted. This used to be a
        // hardcoded 'imagen-3.0-generate-001', which mislabels every request
        // now that the route style-routes instead of pinning Vertex (#287) —
        // a Flux failure logged as an Imagen failure sends you debugging the
        // wrong provider. The caller cannot pin a modelId here, so the
        // style-routed primary is the whole answer.
        const modelForLog = routeGeneration({
            prompt: typeof body.prompt === 'string' ? body.prompt : '',
            style: body.style,
            bodyPart: body.bodyPart
        }).modelId;
        reqLogger.error('generation.failed', error instanceof Error ? error : new Error('Generation failed'), {
            model: modelForLog,
            error_code: generationError.code || 'GENERATION_FAILED',
        });

        if (error instanceof GenerationCreditsExhaustedError || generationError.code === 'GENERATION_CREDITS_EXHAUSTED') {
            return NextResponse.json({
                error: 'You have used your free generations. Buy 25 more cuts to keep designing.',
                code: 'GENERATION_CREDITS_EXHAUSTED',
            }, { status: 402 });
        }

        if (generationError.code === 'VERTEX_QUOTA_EXCEEDED') {
            return NextResponse.json({
                error: 'Vertex AI quota exceeded',
                code: 'VERTEX_QUOTA_EXCEEDED',
                details: generationError.details || null
            }, { status: 429 });
        }

        if (generationError.code === 'VERTEX_NOT_CONFIGURED' || generationError.code === 'GCS_NOT_CONFIGURED') {
            return NextResponse.json({
                error: 'Generation service not configured',
                code: generationError.code,
                message: generationError.message
            }, { status: 500 });
        }

        if (generationError.code === 'INVALID_PROMPT') {
            return NextResponse.json({
                error: generationError.message,
                code: generationError.code
            }, { status: 400 });
        }

        return NextResponse.json({
            error: 'Generation failed',
            code: generationError.code || 'GENERATION_FAILED',
            message: generationError.message
        }, { status: 500 });
    }
}
