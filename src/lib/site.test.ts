import { describe, expect, it } from "vitest";
import { SITE_DESCRIPTION, SITE_TITLE } from "./site";

describe("public site metadata", () => {
  it("keeps the live TattTester mark and drops the stale AR promise", () => {
    expect(SITE_TITLE).toBe("TattTester — Think it. Ink it.");
    expect(SITE_DESCRIPTION).not.toMatch(/coming soon/i);
    expect(SITE_DESCRIPTION).not.toMatch(/vetted/i);
    expect(SITE_DESCRIPTION.toLowerCase()).toContain("before anything is permanent");
  });
});
