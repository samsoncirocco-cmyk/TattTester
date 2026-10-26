import type { MetadataRoute } from "next";
import { CANONICAL_ORIGIN } from "@/lib/site";

/** Public pages a first-time visitor can land on. No console, no bookings. */
const PATHS = [
  "/",
  "/design",
  "/about",
  "/artists",
  "/gallery",
  "/pricing",
  "/visualize",
  "/image2ink",
  "/legal/privacy",
  "/legal/terms",
];

export default function sitemap(): MetadataRoute.Sitemap {
  return PATHS.map((path) => ({
    url: path === "/" ? `${CANONICAL_ORIGIN}/` : `${CANONICAL_ORIGIN}${path}`,
    changeFrequency: path === "/" || path === "/design" ? "weekly" : "monthly",
    priority: path === "/" ? 1 : path === "/design" ? 0.9 : 0.6,
  }));
}
