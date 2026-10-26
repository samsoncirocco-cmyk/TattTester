import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const { rateLimitMock, infoMock } = vi.hoisted(() => ({
  rateLimitMock: vi.fn(),
  infoMock: vi.fn(),
}));

vi.mock("@/lib/rate-limit", () => ({
  rateLimit: rateLimitMock,
  rateLimitResponse: () => new Response("limited", { status: 429 }),
}));

vi.mock("@/lib/logger", () => ({
  logger: { info: infoMock, error: vi.fn() },
}));

import { POST } from "./route";

afterEach(() => {
  rateLimitMock.mockReset();
  infoMock.mockReset();
});

function post(body: unknown) {
  return new NextRequest("http://localhost/api/v1/funnel", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/v1/funnel", () => {
  it("logs an allowlisted event and stores nothing in the response", async () => {
    rateLimitMock.mockResolvedValue({ allowed: true, limit: 60, remaining: 59, reset: 0 });
    const res = await POST(post({ event: "landing", path: "/", email: "nope@example.com" }));
    expect(res.status).toBe(204);
    expect(infoMock).toHaveBeenCalledWith(
      expect.objectContaining({ event_type: "funnel", funnel_event: "landing", path: "/" })
    );
    const logged = JSON.stringify(infoMock.mock.calls);
    expect(logged).not.toContain("nope@example.com");
  });

  it("refuses an unknown event", async () => {
    rateLimitMock.mockResolvedValue({ allowed: true, limit: 60, remaining: 59, reset: 0 });
    const res = await POST(post({ event: "purchased", path: "/" }));
    expect(res.status).toBe(400);
    expect(infoMock).not.toHaveBeenCalled();
  });
});
