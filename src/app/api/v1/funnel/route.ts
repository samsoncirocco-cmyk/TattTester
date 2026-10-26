import { NextRequest, NextResponse } from "next/server";
import { logger } from "@/lib/logger";
import { rateLimit, rateLimitResponse } from "@/lib/rate-limit";
import { isFunnelEvent } from "@/lib/funnel";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_PATH = 200;

/**
 * POST /api/v1/funnel — one allowlisted first-run event.
 * Logged, not stored. No prompt text, no user id, no vendor forward.
 */
export async function POST(req: NextRequest) {
  try {
    const rateResult = await rateLimit(req, "default");
    if (!rateResult.allowed) return rateLimitResponse(rateResult);

    const body = (await req.json().catch(() => null)) as { event?: unknown; path?: unknown } | null;
    if (!body || !isFunnelEvent(body.event)) {
      return NextResponse.json({ error: "Unknown funnel event" }, { status: 400 });
    }
    const path = typeof body.path === "string" ? body.path.slice(0, MAX_PATH) : "";
    if (path && !path.startsWith("/")) {
      return NextResponse.json({ error: "Invalid path" }, { status: 400 });
    }

    logger.info({
      event_type: "funnel",
      funnel_event: body.event,
      path,
    });
    return new NextResponse(null, { status: 204 });
  } catch (error) {
    logger.error({ event_type: "funnel.failed", err: error });
    return new NextResponse(null, { status: 204 });
  }
}
