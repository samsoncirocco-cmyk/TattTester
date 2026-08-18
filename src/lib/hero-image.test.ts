import { describe, expect, it } from "vitest";
import {
  chooseHeroImage,
  disqualifyingReason,
  heroScore,
  imageFacts,
  looksLikeAPerson,
  looksLikeWork,
  pickHeroImage,
} from "./hero-image";

/**
 * Every URL below is a real row from the live graph (2026-08-17), not a
 * fixture invented to make the rules pass. The four `HOMEPAGE_*` constants are
 * literally what the four featured cards were rendering when #365 was filed.
 */
const HOMEPAGE_ED = [
  "https://evolutioninkstudio.com/wp-content/uploads/2026/03/Ed_2026.png",
  "https://evolutioninkstudio.com/wp-content/uploads/2026/03/Ed_Gallery_1.jpeg",
  "https://evolutioninkstudio.com/wp-content/uploads/2026/03/Ed_Gallery_10.jpeg",
];
const HOMEPAGE_PHAM = [
  "https://hyperinkers.com/wp-content/uploads/2024/05/Asset-49-1024x192.png",
  "https://hyperinkers.com/wp-content/uploads/2026/02/customer-reviews.png",
  "https://hyperinkers.com/wp-content/uploads/2025/07/cover-up-tattoo-san-antonio.jpg",
];
const HOMEPAGE_BRIAN = [
  "https://static.wixstatic.com/media/235f28_1a89d8fd0d8e44aabc8626bdfe43b257~mv2.jpg/v1/fill/w_74,h_98,al_c,q_80,usm_0.66_1.00_0.01,blur_2,enc_avif,quality_auto/235f28_1a89d8fd0d8e44aabc8626bdfe43b257~mv2.jpg",
  "https://static.wixstatic.com/media/235f28_963f908beebf4427b531e1b29df99b78.jpg/v1/fill/w_188,h_188,q_90,enc_avif,quality_auto/235f28_963f908beebf4427b531e1b29df99b78.jpg",
];
const GOLDEN_RULE_JAVI = [
  "https://goldenruletattoo.com/wp-content/uploads/2023/09/Javi-uai-193x258.webp",
  "https://goldenruletattoo.com/wp-content/uploads/2023/09/Javi-Golden-Rule-Tattoo-Portfolio-Jav4-uai-258x258.webp",
];

describe("imageFacts", () => {
  it("reads WordPress dimensions off the end of the filename", () => {
    const facts = imageFacts(GOLDEN_RULE_JAVI[0]);
    expect(facts).toMatchObject({ width: 193, height: 258, extension: "webp" });
  });

  it("reads Wix w_/h_ transform dimensions and its blur flag", () => {
    const facts = imageFacts(HOMEPAGE_BRIAN[0]);
    expect(facts).toMatchObject({ width: 74, height: 98, blurred: true });
  });

  it("does not mistake a Wix transform without blur for a blurred one", () => {
    expect(imageFacts(HOMEPAGE_BRIAN[1])?.blurred).toBe(false);
  });

  it("reads width/height query parameters", () => {
    expect(imageFacts("https://ex.com/a.jpg?w=800&h=800")).toMatchObject({
      width: 800,
      height: 800,
    });
  });

  it("returns null for anything that is not a parseable absolute URL", () => {
    expect(imageFacts("/relative/path.jpg")).toBeNull();
    expect(imageFacts(null)).toBeNull();
    expect(imageFacts(42)).toBeNull();
  });

  it("survives the leading newline six live rows carry from the importer", () => {
    const facts = imageFacts(
      "\n\nhttps://cdn.shopify.com/s/files/1/1088/0648/files/WANDS-NAVIGATION-IMAGE-DROP-DOWN-728x860_large.jpg?v=1650634697",
    );
    expect(facts).toMatchObject({ width: 728, height: 860 });
  });

  it("leaves dimensions null rather than guessing when the URL carries none", () => {
    expect(imageFacts("https://ex.com/uploads/tattoo.jpg")).toMatchObject({
      width: null,
      height: null,
    });
  });
});

describe("disqualifyingReason", () => {
  it("rejects a blurred placeholder", () => {
    expect(disqualifyingReason(imageFacts(HOMEPAGE_BRIAN[0]))).toBe("blurred-placeholder");
  });

  it("rejects a banner by aspect ratio", () => {
    expect(disqualifyingReason(imageFacts(HOMEPAGE_PHAM[0]))).toBe("banner-aspect");
  });

  it("rejects a thumbnail by size", () => {
    expect(disqualifyingReason(imageFacts("https://ex.com/a-80x80.jpg"))).toBe("thumbnail-sized");
  });

  it("rejects files that name themselves as site chrome", () => {
    for (const name of ["logo.png", "favicon.png", "customer-reviews.png", "Asset-42.png"]) {
      expect(disqualifyingReason(imageFacts(`https://ex.com/u/${name}`))).toBe("site-chrome");
    }
  });

  it("rejects vector and animated formats", () => {
    expect(disqualifyingReason(imageFacts("https://ex.com/a.svg"))).toBe("not-a-photograph");
  });

  it("does NOT reject a string it cannot parse as a URL", () => {
    // The browser will happily render a relative src. Absence of CDN evidence
    // is not evidence of chrome, and disqualifying it would empty real cards
    // — including every fixture the featured-artists tests are written with.
    expect(disqualifyingReason(imageFacts("/uploads/piece.jpg"))).toBeNull();
    expect(disqualifyingReason(imageFacts("one.jpg"))).toBeNull();
  });

  it("does NOT reject an unremarkable photo with no dimensions in its URL", () => {
    expect(disqualifyingReason(imageFacts("https://ex.com/uploads/2024/06/piece.jpg"))).toBeNull();
  });

  it("does not fire chrome words on words that merely contain them", () => {
    // "biological" contains "bio", "starfish" contains "star" — word-ish
    // boundaries keep an honest filename honest.
    expect(disqualifyingReason(imageFacts("https://ex.com/starfish.jpg"))).toBeNull();
    expect(looksLikeAPerson(imageFacts("https://ex.com/biological.jpg"))).toBe(false);
  });

  it("treats a portrait crop as a person, not as a disqualification", () => {
    const facts = imageFacts(GOLDEN_RULE_JAVI[0]);
    expect(disqualifyingReason(facts)).toBeNull();
    expect(looksLikeAPerson(facts)).toBe(true);
  });
});

describe("looksLikeWork", () => {
  it("accepts a filename that names itself gallery or portfolio", () => {
    expect(looksLikeWork(imageFacts(HOMEPAGE_ED[1]))).toBe(true);
    expect(looksLikeWork(imageFacts(GOLDEN_RULE_JAVI[1]))).toBe(true);
  });

  it("accepts untouched camera filenames", () => {
    for (const name of ["IMG_1776.jpg", "DSC_0042.jpg", "PXL_20230101_120000.jpg"]) {
      expect(looksLikeWork(imageFacts(`https://ex.com/u/${name}`))).toBe(true);
    }
  });

  it("rejects an unremarkable name", () => {
    expect(looksLikeWork(imageFacts("https://ex.com/u/ed_2026.png"))).toBe(false);
  });
});

describe("heroScore", () => {
  it("prefers a square gallery tile over a tall portrait crop", () => {
    expect(heroScore(imageFacts(GOLDEN_RULE_JAVI[1]))).toBeGreaterThan(
      heroScore(imageFacts(GOLDEN_RULE_JAVI[0])),
    );
  });

  it("prefers a photograph format over a graphics format", () => {
    expect(heroScore(imageFacts("https://ex.com/a.jpg"))).toBeGreaterThan(
      heroScore(imageFacts("https://ex.com/a.png")),
    );
  });
});

describe("chooseHeroImage — the four homepage cards from #365", () => {
  it("swaps a headshot for the gallery file sitting behind it", () => {
    expect(chooseHeroImage(HOMEPAGE_ED)).toMatchObject({
      url: HOMEPAGE_ED[1],
      index: 1,
      outcome: "replaced-out-evidenced",
    });
  });

  it("swaps a 1024x192 site banner for the artist's actual work", () => {
    expect(chooseHeroImage(HOMEPAGE_PHAM)).toMatchObject({
      url: HOMEPAGE_PHAM[2],
      outcome: "replaced-disqualified",
    });
  });

  it("swaps a 74x98 blurred thumbnail for the full-size tile", () => {
    expect(chooseHeroImage(HOMEPAGE_BRIAN)).toMatchObject({
      url: HOMEPAGE_BRIAN[1],
      outcome: "replaced-disqualified",
    });
  });

  it("swaps a portrait crop for the square portfolio tile", () => {
    expect(chooseHeroImage(GOLDEN_RULE_JAVI)).toMatchObject({
      url: GOLDEN_RULE_JAVI[1],
      outcome: "replaced-person-photo",
    });
  });
});

describe("chooseHeroImage — restraint", () => {
  it("keeps slot 0 when it is unremarkable and nothing else claims to be work", () => {
    const images = ["https://ex.com/u/one.jpg", "https://ex.com/u/two.jpg"];
    expect(chooseHeroImage(images)).toMatchObject({ url: images[0], index: 0, outcome: "kept" });
  });

  it("keeps slot 0 when it already names itself as work, even if a sibling scores higher", () => {
    const images = [
      "https://ex.com/u/tattoo-one.png",
      "https://ex.com/u/gallery-IMG_1776-800x800.jpg",
    ];
    expect(chooseHeroImage(images)).toMatchObject({ index: 0, outcome: "kept" });
  });

  it("keeps a lone headshot rather than emptying the card", () => {
    const images = ["https://eliteinktattoos.com/wp-content/uploads/2020/07/devon_400sq.jpg"];
    expect(chooseHeroImage(images)).toMatchObject({ index: 0, outcome: "kept" });
  });

  it("keeps an eligible person photo when every sibling is also a person", () => {
    const images = ["https://ex.com/u/headshot.jpg", "https://ex.com/u/portrait.jpg"];
    expect(chooseHeroImage(images)).toMatchObject({ index: 0, outcome: "kept-nothing-better" });
  });

  it("falls back to a person photo when slot 0 is disqualified and only people remain", () => {
    const images = ["https://ex.com/u/logo.png", "https://ex.com/u/headshot.jpg"];
    expect(chooseHeroImage(images)).toMatchObject({
      url: images[1],
      outcome: "replaced-disqualified",
    });
  });
});

describe("chooseHeroImage — returning nothing", () => {
  it("returns no image when every candidate is disqualified", () => {
    const images = ["https://ex.com/u/logo.png", "https://ex.com/u/banner-1200x200.png"];
    expect(chooseHeroImage(images)).toMatchObject({
      url: null,
      index: null,
      outcome: "no-eligible-image",
    });
  });

  it("does not let a non-string entry become anyone's hero", () => {
    const images = [null, "https://ex.com/u/IMG_2001.jpg"];
    expect(chooseHeroImage(images)).toMatchObject({
      url: images[1],
      outcome: "replaced-disqualified",
    });
  });

  it("keeps an unparseable-but-renderable src rather than emptying the card", () => {
    expect(chooseHeroImage(["one.jpg", "two.jpg"])).toMatchObject({
      url: "one.jpg",
      outcome: "kept",
    });
  });
});

describe("pickHeroImage", () => {
  it("returns null for empty, missing or non-array input", () => {
    expect(pickHeroImage([])).toBeNull();
    expect(pickHeroImage(null)).toBeNull();
    expect(pickHeroImage(undefined)).toBeNull();
    expect(pickHeroImage("not-an-array" as unknown as string[])).toBeNull();
  });

  it("is a pure function of the URLs — same input, same answer", () => {
    expect(pickHeroImage(HOMEPAGE_ED)).toBe(pickHeroImage([...HOMEPAGE_ED]));
  });

  it("never invents a URL that was not in the input", () => {
    for (const images of [HOMEPAGE_ED, HOMEPAGE_PHAM, HOMEPAGE_BRIAN, GOLDEN_RULE_JAVI]) {
      const picked = pickHeroImage(images);
      expect(picked === null || images.includes(picked)).toBe(true);
    }
  });
});
