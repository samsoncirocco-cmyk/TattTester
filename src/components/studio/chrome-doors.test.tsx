// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import StudioShell from "./StudioShell";
import PunkFooter from "./PunkFooter";

vi.mock("next/navigation", () => ({
  usePathname: () => "/design",
}));

afterEach(cleanup);

/**
 * The site chrome must not advertise the Studio.
 *
 * A nav or footer entry is by definition a cold entry, and the refinery is
 * entered from a picked design (ADR-0038) and is never part of the main
 * journey (ADR-0017). The design library is its door: every saved cut
 * carries "Fix it in the Studio". /studio itself still answers bookmarks
 * and direct URLs — see src/app/studio/page.test.tsx — it just isn't
 * offered to people who have nothing to refine.
 */
describe("site chrome does not advertise the Studio", () => {
  it("keeps the Studio out of the main nav, and keeps the library door in", () => {
    render(<StudioShell>{null}</StudioShell>);

    expect(screen.getByRole("link", { name: /skip to content/i }).getAttribute("href")).toBe(
      "#content"
    );
    expect(screen.queryByRole("link", { name: /^studio$/i })).toBeNull();
    expect(
      screen.getAllByRole("link", { name: /my designs/i }).length,
    ).toBeGreaterThan(0);
  });

  it("keeps the Studio out of the footer", () => {
    render(<PunkFooter />);

    expect(screen.queryByRole("link", { name: /studio/i })).toBeNull();
    expect(
      screen.getByRole("link", { name: /design session/i }).getAttribute("href"),
    ).toBe("/design");
  });
});
