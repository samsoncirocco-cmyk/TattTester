import { describe, expect, it } from "vitest";
import {
  INTENTS,
  RATES,
  appliedLine,
  filtersInPlay,
  intentToFilters,
  parseIntentParam,
  parseRateParam,
  rateToBudget,
} from "./intentFilters";

describe("intentToFilters", () => {
  it("asks for shown work only for a big piece or a cover-up", () => {
    expect(intentToFilters("first")).toEqual({ hasPortfolio: false });
    expect(intentToFilters("big")).toEqual({ hasPortfolio: true });
    expect(intentToFilters("coverup")).toEqual({ hasPortfolio: true });
    expect(intentToFilters("exploring")).toEqual({ hasPortfolio: false });
    expect(intentToFilters(null)).toEqual({ hasPortfolio: false });
  });

  it("is total over every pill", () => {
    for (const i of INTENTS) expect(typeof intentToFilters(i.id).hasPortfolio).toBe("boolean");
  });
});

describe("rateToBudget", () => {
  it("maps pills to dollars per hour, with no limit as null", () => {
    expect(rateToBudget("150")).toBe(150);
    expect(rateToBudget("250")).toBe(250);
    expect(rateToBudget("400")).toBe(400);
    expect(rateToBudget("any")).toBeNull();
    for (const r of RATES) expect(rateToBudget(r.id)).toBe(r.budget);
  });
});

describe("URL params", () => {
  it("ignores unknown values instead of failing", () => {
    expect(parseIntentParam("big")).toBe("big");
    expect(parseIntentParam("sleeve-of-doom")).toBeNull();
    expect(parseIntentParam(null)).toBeNull();
    expect(parseRateParam("250")).toBe("250");
    expect(parseRateParam("9999")).toBe("any");
    expect(parseRateParam(undefined)).toBe("any");
  });
});

describe("copy", () => {
  it("says only what was applied", () => {
    expect(appliedLine(null, "any")).toBe("");
    expect(appliedLine("big", "any")).toBe("Showing artists with portfolios.");
    expect(appliedLine("first", "150")).toBe(
      "Rates are a guide — artists who haven't listed one are still shown.",
    );
    expect(appliedLine("coverup", "400")).toContain("Showing artists with portfolios.");
    expect(filtersInPlay("coverup", "150")).toBe("with portfolios, up to $150/hr");
    expect(filtersInPlay(null, "any")).toBe("");
  });
});
