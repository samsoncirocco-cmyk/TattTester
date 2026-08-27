/**
 * Which of an artist's images is the one to lead with (#365).
 *
 * ## The bug this exists to fix
 *
 * Three surfaces — the homepage featured grid, the `/artists` roster card, and
 * the profile hero — all showed `portfolioImages[0]`. That index is not a
 * choice. It is whatever the shop-site importer happened to append first, and
 * across the live graph it is very often not tattoo work at all:
 *
 * | what sits in slot 0 | artists |
 * |---|---|
 * | a deliberately blurred placeholder thumbnail | 965 |
 * | an image under 150px on its longest side | 674 |
 * | a banner / strip (aspect ≥ 2.5:1) | 175 |
 * | a file that names itself logo / icon / reviews / badge | 106 |
 *
 * That is **1,920 of 8,305 artists (23%)** whose most prominent image is
 * affirmatively not a tattoo — measured against the live graph on 2026-08-17,
 * before any of the softer cases below. Three of the four *homepage* cards were
 * in that state: one led with a 1024×192 site banner, one with a 74×98 blurred
 * thumb, one with the artist's headshot while twelve files named `*_Gallery_*`
 * sat behind it.
 *
 * ## Why the answer is in the URL
 *
 * These images come from shop websites, not from Instagram — WordPress, Wix,
 * Squarespace and Webflow all encode the rendered dimensions, and Wix encodes
 * its transforms, directly in the URL. `…/Javi-uai-193x258.webp` is a portrait
 * crop; `…/w_74,h_98,…,blur_2,…` is a blurred 74-pixel thumbnail; `Asset-49-
 * 1024x192.png` is a banner. So the ranking is a **pure function of the URL
 * string**: no vision model, no network call, no cost, no new pipeline, and it
 * re-evaluates for free every time the importer refreshes an artist.
 *
 * A vision pass over the pixels would catch more (issue #63). This catches the
 * embarrassing majority for nothing, and the two compose — a later vision score
 * can override this ordering without any caller changing.
 *
 * ## Conservative on purpose
 *
 * This picks a *hero*; it never removes an image from a portfolio, and it never
 * decides who is listed. It also declines to be clever: slot 0 is kept unless
 * it is **affirmatively** bad, so 4,510 of 8,305 artists keep the image they
 * have today. The three interventions, in order of confidence:
 *
 * 1. `disqualifyingReason()` — hard evidence this is not a photograph of work
 *    (blur transform, thumbnail dimensions, banner aspect, chrome filename,
 *    vector format). 1,580 artists.
 * 2. `looksLikeAPerson()` — a portrait crop or a filename saying headshot /
 *    staff / bio. A face is not a portfolio piece, but it *is* the artist, so
 *    this only demotes; it never disqualifies. 283 artists.
 * 3. Out-evidenced — slot 0 carries no positive signal while a sibling file
 *    names itself gallery / portfolio / tattoo or carries a camera filename
 *    (`IMG_1776`). This is what rescues `Ed_2026.png` when `Ed_Gallery_1.jpeg`
 *    is sitting right behind it. 1,592 artists.
 *
 * ## Returning null is a feature
 *
 * When every image an artist has is disqualified — 340 artists, mostly shops
 * whose import captured only chrome — this returns `null` and the surface
 * renders its monogram tile. `ArtistCard` and the profile hero already handle
 * that state, and it is the honest one: an empty tile says "no work shown",
 * a banner says "this is their tattoo work" and is false. Losing a photo is
 * cheaper than lying about whose work it is, which is the same trade
 * `featured-artists.ts` makes when the takedown gate fails closed.
 *
 * ## Scope
 *
 * Callers must pass images that have already been through
 * `filterPortfolioForDisplay` — this module knows nothing about the TAT-31
 * consent gate and must never be used to reintroduce a withheld photograph.
 */

/**
 * Site furniture. Matched against the filename only, on word-ish boundaries so
 * `logos` hits and `biological` does not. `asset` earns its place here because
 * Squarespace and Webflow exports name their chrome `Asset-49`, `Asset-42`.
 */
const CHROME_WORDS =
  /(^|[^a-z])(logos?|favicons?|banners?|headers?|footers?|icons?|sprites?|badges?|placeholders?|arrows?|watermarks?|sponsors?|yelp|googlereviews?|customer-?reviews?|reviews?|stars?|maps?|bg|backgrounds?|assets?)([^a-z]|$)/;

/**
 * A photograph of a human, not of work. Demoted, never disqualified: for an
 * artist whose import captured nothing else, their own face beats a blank tile.
 */
const PERSON_WORDS =
  /(^|[^a-z])(headshots?|portraits?|profiles?|avatars?|teams?|staff|about|bios?|artist-?photos?|selfies?|pfp)([^a-z]|$)/;

/** The file says, in its own name, that it is the work. */
const WORK_WORDS =
  /(^|[^a-z])(gallery|galleries|portfolios?|tattoos?|inked?|works?|flash|pieces?|designs?|sleeves?|healed)([^a-z]|$)/;

/**
 * An untouched camera or phone filename — `IMG_1776`, `DSC_0042`, `PXL_2023…`.
 * Shop sites rename their chrome and leave the photographs alone, so this is a
 * quietly reliable "somebody uploaded a photo" tell.
 */
const CAMERA_FILENAME = /(^|[^a-z0-9])(img|dsc|dscf|dscn|pxl|photo|fullsizerender)[-_]?\d/;

/** Rendered dimensions and transforms, as the CDN wrote them into the URL. */
export type ImageFacts = {
  /** Lowercased final path segment, percent-decoded. */
  filename: string;
  width: number | null;
  height: number | null;
  /** Wix `blur_N` — a placeholder the site itself never meant to be seen sharp. */
  blurred: boolean;
  /** Lowercased extension without the dot, `""` when the URL carries none. */
  extension: string;
};

/**
 * Read what the URL admits about itself. Returns `null` when the string is not
 * a parseable absolute URL — the CDN heuristics simply have nothing to say
 * about it, which is not the same as having something bad to say. See
 * `disqualifyingReason`.
 */
export function imageFacts(url: unknown): ImageFacts | null {
  if (typeof url !== "string") return null;
  // Six rows in the live graph carry a leading newline from the importer.
  // Trimming here costs nothing and keeps them readable rather than opaque.
  const trimmed = url.trim();
  let filename = "";
  try {
    const parsed = new URL(trimmed);
    const segments = parsed.pathname.split("/").filter(Boolean);
    filename = decodeURIComponent(segments[segments.length - 1] ?? "").toLowerCase();
  } catch {
    return null;
  }

  // Three dimension dialects, most specific first. WordPress appends
  // `-800x600` to the filename; Wix uses `fill/w_188,h_188`; Squarespace and
  // friends use query params.
  let width: number | null = null;
  let height: number | null = null;
  const wordpress = trimmed.match(/[-_/](\d{2,5})x(\d{2,5})(?=[.\-_/]|$)/);
  const wix = [trimmed.match(/[?,/]w_(\d{2,5})/), trimmed.match(/[?,/]h_(\d{2,5})/)] as const;
  const query = [
    trimmed.match(/[?&]w(?:idth)?=(\d{2,5})/),
    trimmed.match(/[?&]h(?:eight)?=(\d{2,5})/),
  ] as const;
  if (wordpress) {
    width = Number(wordpress[1]);
    height = Number(wordpress[2]);
  } else if (wix[0] && wix[1]) {
    width = Number(wix[0][1]);
    height = Number(wix[1][1]);
  } else if (query[0] && query[1]) {
    width = Number(query[0][1]);
    height = Number(query[1][1]);
  }

  return {
    filename,
    width,
    height,
    blurred: /[?,/]blur_\d/.test(trimmed),
    extension: filename.match(/\.([a-z0-9]+)$/)?.[1] ?? "",
  };
}

/**
 * Why this image cannot be anyone's hero, or `null` if it can.
 *
 * Every branch is *affirmative* evidence. An image with no dimensions in its
 * URL and an unremarkable name is not disqualified — absence of signal is not
 * evidence of chrome, and treating it as such would empty honest cards.
 */
export function disqualifyingReason(facts: ImageFacts | null): string | null {
  // No facts means the URL did not parse — a relative or odd `src` the CDN
  // heuristics cannot read. That is *absence* of evidence, not evidence of
  // chrome: the browser will still render it, so it stays eligible and simply
  // scores neutral. Non-string junk is excluded by the caller, which is where
  // "cannot be rendered at all" actually belongs.
  if (!facts) return null;
  if (facts.blurred) return "blurred-placeholder";
  if (facts.extension === "svg" || facts.extension === "gif") return "not-a-photograph";
  if (facts.width && facts.height) {
    const aspect = facts.width / facts.height;
    if (aspect >= 2.5 || aspect <= 0.4) return "banner-aspect";
    if (Math.max(facts.width, facts.height) < 150) return "thumbnail-sized";
  }
  if (CHROME_WORDS.test(facts.filename)) return "site-chrome";
  return null;
}

/** Does this read as a photograph of the artist rather than of their work? */
export function looksLikeAPerson(facts: ImageFacts | null): boolean {
  if (!facts) return false;
  if (PERSON_WORDS.test(facts.filename)) return true;
  // Shop sites crop staff portraits tall and gallery tiles square. 193×258 is
  // the artist; 258×258 beside it is the tattoo.
  if (facts.width && facts.height && facts.width / facts.height < 0.8) return true;
  return false;
}

/** Does the file affirmatively claim, by name, to be tattoo work? */
export function looksLikeWork(facts: ImageFacts | null): boolean {
  if (!facts) return false;
  return WORK_WORDS.test(facts.filename) || CAMERA_FILENAME.test(facts.filename);
}

/**
 * Preference among images that are all already eligible. Ordering only — a
 * negative score never disqualifies, it just loses to a better sibling.
 */
export function heroScore(facts: ImageFacts | null): number {
  if (!facts) return -Infinity;
  let score = 0;
  if (WORK_WORDS.test(facts.filename)) score += 6;
  if (CAMERA_FILENAME.test(facts.filename)) score += 4;
  if (PERSON_WORDS.test(facts.filename)) score -= 6;
  // PNG is the format of logos and exported graphics; photographs arrive as
  // JPEG or WebP. Weak on its own, decisive between two otherwise equal files.
  if (facts.extension === "png") score -= 3;
  if (facts.extension === "jpg" || facts.extension === "jpeg" || facts.extension === "webp") score += 1;
  if (facts.width && facts.height) {
    const aspect = facts.width / facts.height;
    if (aspect >= 0.85 && aspect <= 1.18) score += 2;
    else if (aspect < 0.8) score -= 2;
    if (Math.max(facts.width, facts.height) >= 400) score += 1;
  }
  return score;
}

/** What `pickHeroImage` did, for scripts and reports that need to explain it. */
export type HeroChoice = {
  url: string | null;
  /** Index into the input array, or `null` when nothing was eligible. */
  index: number | null;
  outcome:
    | "kept"
    | "replaced-disqualified"
    | "replaced-person-photo"
    | "replaced-out-evidenced"
    | "kept-nothing-better"
    | "no-eligible-image";
};

/**
 * Choose the image to lead with, and say why.
 *
 * Deliberately biased toward doing nothing: slot 0 survives unless it is
 * disqualified, reads as a photo of a person, or is out-evidenced by a sibling
 * that names itself as work.
 */
export function chooseHeroImage(images: readonly unknown[]): HeroChoice {
  const entries = images.map((url, index) => {
    const facts = imageFacts(url);
    const reason = typeof url === "string" ? disqualifyingReason(facts) : "not-a-string";
    return { url: url as string, index, facts, reason };
  });

  const eligible = entries.filter((entry) => !entry.reason);
  if (eligible.length === 0) {
    return { url: null, index: null, outcome: "no-eligible-image" };
  }

  const first = entries[0];
  const notPeople = eligible.filter((entry) => !looksLikeAPerson(entry.facts));
  const evidenced = notPeople.filter((entry) => looksLikeWork(entry.facts));

  const firstIsFine =
    !first.reason &&
    !looksLikeAPerson(first.facts) &&
    // A slot 0 with no positive signal only loses to a sibling that has one.
    (looksLikeWork(first.facts) || evidenced.length === 0);
  if (firstIsFine) return { url: first.url, index: 0, outcome: "kept" };

  const pool = evidenced.length > 0 ? evidenced : notPeople;
  if (pool.length === 0) {
    // Everything left is a person photo. If slot 0 is at least eligible, the
    // artist's own face beats an empty tile; if it is not, nothing is.
    return first.reason
      ? { url: eligible[0].url, index: eligible[0].index, outcome: "replaced-disqualified" }
      : { url: first.url, index: 0, outcome: "kept-nothing-better" };
  }

  const best = [...pool].sort(
    (a, b) => heroScore(b.facts) - heroScore(a.facts) || a.index - b.index,
  )[0];

  const outcome: HeroChoice["outcome"] = first.reason
    ? "replaced-disqualified"
    : looksLikeAPerson(first.facts)
      ? "replaced-person-photo"
      : "replaced-out-evidenced";
  return { url: best.url, index: best.index, outcome };
}

/**
 * The hero URL, or `null` when the artist has no image worth leading with.
 *
 * The single seam the homepage, the roster grid and the profile page all read
 * through, so the same artist cannot wear a different photograph depending on
 * which page you landed on — the invariant `featured-artists.ts` established
 * with `[0]`, kept while `[0]` stops being the answer.
 */
export function pickHeroImage(images: readonly unknown[] | null | undefined): string | null {
  if (!Array.isArray(images) || images.length === 0) return null;
  return chooseHeroImage(images).url;
}
