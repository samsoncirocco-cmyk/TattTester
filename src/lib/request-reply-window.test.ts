import { describe, expect, it } from "vitest";
import { REQUEST_REPLY_HOURS, requestReplyPromise } from "./request-reply-window";

describe("request reply window (REA gap #3)", () => {
  it("promises 48 hours — not the unrendered 24 the API used to say", () => {
    expect(REQUEST_REPLY_HOURS).toBe(48);
  });

  it("names the artist as the replier when the profile is claimed", () => {
    const copy = requestReplyPromise("Nadia Ink", true);
    expect(copy).toContain("Nadia Ink replies within 48 hours");
  });

  it("names TattTester as the replier for an unclaimed profile (relay path)", () => {
    const copy = requestReplyPromise("Nadia Ink", false);
    expect(copy).toContain("TattTester relays your request");
    expect(copy).toContain("within 48 hours");
    // Never promise that an artist who has not joined will answer.
    expect(copy).not.toContain("Nadia Ink replies");
  });

  it("stays out of the money sentence (ADR-0036 copy law untouched)", () => {
    for (const claimed of [true, false]) {
      const copy = requestReplyPromise("Nadia Ink", claimed);
      expect(copy).not.toMatch(/deposit|fee|\$/);
    }
  });
});
