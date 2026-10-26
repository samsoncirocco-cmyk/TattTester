"use client";

import Link from "next/link";
import FavoriteButton from "@/components/punk/FavoriteButton";
import { useFavorites } from "@/lib/tattStorage";

/**
 * Shared artist card — captures the inlined 3:4 tile + name + meta
 * pattern used on /artists and the home featured grid.
 *
 * Variant matrix:
 *   - `compact`  : single style label below the tile (home grid)
 *   - `default`  : single style label inside the tile (/artists)
 *   - `match`    : style chip array below + optional match% sticker +
 *                  pink border when favorited + "Pinned" label
 *                  (built for the retired /matches page, ADR-0029;
 *                  no current call site)
 */
type CommonProps = {
  slug: string;
  name: string;
  city: string;
  color: string;            // tailwind bg class, e.g. "bg-pink"
  image?: string;           // portfolio image URL; when set, replaces the color block
  handle?: string;          // instagram handle; no-photo tiles render a monogram + handle sticker so the color block reads deliberate, not like a failed image
  href?: string;            // defaults to /artists/${slug}
  external?: boolean;       // opens href in a new tab (e.g. Instagram profiles)
  showFavorite?: boolean;   // defaults to false; /artists passes true
  favoriteSize?: number;    // forwards to FavoriteButton
  favoritePosition?: "top-right" | "top-left";
  /**
   * Pre-formatted day of the artist's next opening ("Nov 3"), from the cached
   * hint (src/lib/next-opening). Absent = say nothing: a missing value may only
   * mean we have not computed one, never that the artist is unavailable.
   */
  nextOpening?: string;
};

type CompactProps = CommonProps & {
  variant: "compact";
  style: string;
};

type DefaultProps = CommonProps & {
  variant?: "default";
  style: string;
};

type MatchProps = CommonProps & {
  variant: "match";
  styles: string[];
  matchPercent?: number;
  /** When set, renders a "Book" action under the card (e.g. /book?artistId=…). */
  bookHref?: string;
};

type Props = CompactProps | DefaultProps | MatchProps;

function isMatch(p: Props): p is MatchProps {
  return p.variant === "match";
}

export default function ArtistCard(props: Props) {
  const {
    slug,
    name,
    city,
    color,
    image,
    handle,
    href = `/artists/${slug}`,
    external = false,
    showFavorite = false,
    favoriteSize,
    favoritePosition = "top-right",
    nextOpening,
  } = props;

  const { favorites, hydrated } = useFavorites();
  const isFav = isMatch(props) && hydrated && favorites.includes(slug);

  const tileBorder = isFav ? "border-2 border-pink" : "border-2 hairline";

  return (
    <div className="relative group">
      <Link
        href={href}
        className="block press"
        {...(external ? { target: "_blank", rel: "noopener noreferrer" } : {})}
      >
        <div
          className={`aspect-[3/4] ${image ? "bg-bone" : color} ${tileBorder} relative overflow-hidden`}
        >
          {image ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={image}
              alt={`${name} portfolio work`}
              className="absolute inset-0 w-full h-full object-cover"
              loading="lazy"
              decoding="async"
            />
          ) : (
            <>
              <div className="absolute inset-0 bg-gradient-to-b from-transparent to-black/60 mix-blend-multiply" />
              {handle && (
                <>
                  <div className="absolute inset-0 flex items-center justify-center">
                    <span className="font-display text-[88px] leading-none text-black/25 select-none">
                      {name
                        .split(/\s+/)
                        .map((w) => w[0])
                        .slice(0, 2)
                        .join("")
                        .toUpperCase()}
                    </span>
                  </div>
                  {/* Long handles used to run under the match% sticker.
                      Cap the width so the two never collide; the arrow
                      stays pinned while the handle itself truncates. */}
                  <div
                    className={`absolute top-3 left-3 sticker px-2 py-1 -rotate-3 flex items-center gap-1 ${
                      isMatch(props) && typeof props.matchPercent === "number"
                        ? "max-w-[calc(100%-5.5rem)]"
                        : "max-w-[calc(100%-1.5rem)]"
                    }`}
                  >
                    <span className="font-body text-[10px] uppercase tracking-[0.18em] truncate">
                      {handle}
                    </span>
                    <span className="font-body text-[10px] shrink-0">→</span>
                  </div>
                </>
              )}
            </>
          )}

          {/* match% sticker — match variant only. Inlined to keep the md
              primary size against sm padding; sizes track StickerPricetag. */}
          {isMatch(props) && typeof props.matchPercent === "number" && (
            <div className="absolute top-3 right-3 sticker px-2 py-1 z-10">
              <div className="font-display text-[14px] tracking-widest leading-none">
                {props.matchPercent}%
              </div>
              <div className="font-body text-[10px] uppercase tracking-widest leading-none mt-0.5">
                Match
              </div>
            </div>
          )}

          {/* "Pinned" badge — match variant only, when favorited */}
          {isMatch(props) && isFav && (
            <span className="absolute bottom-3 left-3 text-[10px] uppercase tracking-[0.2em] text-pink font-body">
              ★ Pinned
            </span>
          )}

          {/* style label inside tile — default + compact variants show it
             bottom-left. Over a photo it sits on a cream chip for
             legibility; over a color block it stays bare text. Match
             variant uses chips outside. */}
          {!isMatch(props) && (
            <span
              className={`absolute bottom-3 left-3 text-[10px] uppercase tracking-[0.2em] font-body ${
                image ? "bg-cream text-black px-2 py-1" : "text-white/80"
              }`}
            >
              {props.style}
            </span>
          )}
        </div>

        <div className="mt-3">
          <div className="font-display text-[20px] tracking-wide text-white group-hover:text-pink">
            {name}
          </div>
          <div className="text-[10px] uppercase tracking-[0.2em] text-white/50 font-body mt-1">
            {city}
          </div>
          {nextOpening && (
            <div
              data-testid="next-opening"
              className="text-[10px] uppercase tracking-[0.2em] text-pink font-body mt-1"
            >
              Next opening {nextOpening}
            </div>
          )}

          {/* style chips — match variant only */}
          {isMatch(props) && props.styles && (
            <div className="mt-3 flex flex-wrap gap-1.5">
              {props.styles.map((s) => (
                <span
                  key={s}
                  className="text-[10px] uppercase tracking-[0.18em] text-white/70 border hairline px-2 py-1 font-body"
                >
                  {s}
                </span>
              ))}
            </div>
          )}
        </div>
      </Link>

      {/* Book action — match variant only, separate link so it never
          nests inside the profile anchor. Carries the real artistId. */}
      {isMatch(props) && props.bookHref && (
        <Link
          href={props.bookHref}
          className="mt-3 inline-flex items-center text-[10px] uppercase tracking-[0.2em] text-white/70 hover:text-black hover:bg-pink border hairline px-3 py-2 press font-body"
        >
          Book&nbsp;the&nbsp;chair&nbsp;<span className="ml-1">▸</span>
        </Link>
      )}

      {showFavorite && (
        <FavoriteButton
          slug={slug}
          label={name}
          size={favoriteSize}
          className={`absolute ${
            favoritePosition === "top-left" ? "top-3 left-3" : "top-2 right-2"
          } z-10`}
        />
      )}
    </div>
  );
}
