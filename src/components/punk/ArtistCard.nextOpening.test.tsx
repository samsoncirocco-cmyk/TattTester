// @vitest-environment jsdom
// Spec 4: the roster card shows a next-opening chip only when one is known.
import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import ArtistCard from "./ArtistCard";

const base = { slug: "sam-ink-artist_1", name: "Sam Ink", city: "Austin, TX", color: "bg-pink", style: "blackwork" };

describe("ArtistCard next opening (spec 4)", () => {
  it("renders the chip when provided", () => {
    const { getByTestId } = render(<ArtistCard {...base} nextOpening="Nov 3" />);
    expect(getByTestId("next-opening").textContent).toBe("Next opening Nov 3");
  });

  it("renders nothing when absent — never 'unavailable'", () => {
    const { queryByTestId, container } = render(<ArtistCard {...base} />);
    expect(queryByTestId("next-opening")).toBeNull();
    expect(container.textContent).not.toMatch(/unavailable/i);
    // Cards carry no money (spec 4 open question 1).
    expect(container.textContent).not.toMatch(/\$/);
  });
});
