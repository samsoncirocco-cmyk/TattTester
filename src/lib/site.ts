/**
 * Public marketing strings shared by the root layout, the homepage, and
 * Open Graph tags. One place so a title and a share card cannot drift.
 *
 * Brand: the live site and ADR-0004/0036 say TattTester. Do not flip this
 * back to TatT from a marketing pass — the name conflict is an owner
 * decision, and the deployed mark is already TattTester.
 */
export const SITE_NAME = "TattTester";

export const SITE_TITLE = "TattTester — Think it. Ink it.";

export const SITE_DESCRIPTION =
  "Describe a tattoo idea, get two design directions, and find an artist — before anything is permanent.";

export const CANONICAL_ORIGIN = `https://${process.env.CANONICAL_HOST ?? "tatttester.com"}`;

/** JPEG share image. Social crawlers are happier with JPEG than WebP. */
export const OG_IMAGE_PATH = "/images/hero-og.jpg";

export const OG_IMAGE = {
  url: OG_IMAGE_PATH,
  width: 1024,
  height: 1024,
  alt: "Tattoo in progress at the studio",
} as const;
