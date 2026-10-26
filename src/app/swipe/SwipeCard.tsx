"use client";

import { useState } from "react";

/**
 * The card that asks the customer to decide (spec 14). Leads with the
 * artist's gated hero work image; falls back to the monogram tile when no
 * displayable image exists or the image fails to load — never a broken box.
 * Pure render: decisions are the deck's business.
 */
export type SwipeCardModel = {
  id: string;
  name: string;
  slug: string;
  matchPercent: number;
  styles: string[];
  /** Honest, payload-backed "why" chips derived at search time. */
  reasonChips: string[];
  location?: string;
  instagram?: string;
  heroImage: string | null;
  /** Only ever set when the engine can measure it; omitted otherwise. */
  distanceMiles?: number;
  deck: "primary" | "broadened";
};

export function monogram(name: string): string {
  return name
    .split(/\s+/)
    .map((w) => w[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();
}

export default function SwipeCard({
  card,
  onPass,
  onPin,
  eager,
}: {
  card: SwipeCardModel;
  onPass: () => void;
  onPin: () => void;
  /** Load the image at once (top of the stack) rather than lazily. */
  eager: boolean;
}) {
  const [imageBroken, setImageBroken] = useState(false);
  const showImage = Boolean(card.heroImage) && !imageBroken;
  const whereLine = [
    card.location,
    typeof card.distanceMiles === "number" ? `${Math.round(card.distanceMiles)} mi away` : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <div
      role="region"
      aria-label={`${card.name}, ${card.matchPercent}% match`}
      className="relative w-full h-full border-2 hairline overflow-hidden bg-black flex flex-col"
    >
      {showImage ? (
        <div className="relative h-3/5 bg-bone overflow-hidden">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={card.heroImage as string}
            alt={`Work by ${card.name}`}
            className="absolute inset-0 w-full h-full object-cover"
            loading={eager ? "eager" : "lazy"}
            decoding="async"
            draggable={false}
            onError={() => setImageBroken(true)}
          />
        </div>
      ) : (
        /* Monogram tile — the honest fallback ArtistCard uses everywhere
           else, rather than a stock photo. Also what an unclaimed artist
           shows while SHOW_UNCLAIMED_PORTFOLIOS is off. */
        <div className="relative h-3/5 bg-pink flex items-center justify-center">
          <span className="font-display text-[96px] leading-none text-black/25 select-none">
            {monogram(card.name)}
          </span>
        </div>
      )}

      <div className="flex-1 p-6 flex flex-col justify-between bg-black">
        <div>
          {/* The chips lead: honest, payload-backed reasons in words. The raw
              match % stays but rides shotgun as a small tabular figure. */}
          {card.reasonChips.length > 0 && (
            <div className="mb-3 flex flex-wrap gap-1.5">
              {card.reasonChips.map((chip) => (
                <span
                  key={chip}
                  className="text-[10px] uppercase tracking-[0.18em] bg-pink text-black px-2 py-1 font-body font-bold"
                >
                  {chip}
                </span>
              ))}
            </div>
          )}
          <div className="flex items-baseline justify-between gap-3">
            <div className="font-display text-[24px] tracking-wide text-white">{card.name}</div>
            <div className="shrink-0 text-[10px] uppercase tracking-[0.18em] text-white/40 tabular-nums font-body">
              {card.matchPercent}% match
            </div>
          </div>
          <div className="mt-1 flex items-center justify-between gap-3">
            <div className="text-[10px] uppercase tracking-[0.2em] text-white/50 font-body">
              {whereLine || "—"}
            </div>
            <a
              href={`/artists/${encodeURIComponent(card.slug)}`}
              target="_blank"
              rel="noopener"
              className="shrink-0 text-[10px] uppercase tracking-[0.2em] text-white/70 hover:text-pink underline underline-offset-4 font-body"
            >
              View profile
            </a>
          </div>
          {/* Older persisted decks predate reasonChips — fall back to the
              plain style tags rather than nothing. */}
          {card.reasonChips.length === 0 && card.styles.length > 0 && (
            <div className="mt-3 flex flex-wrap gap-1.5">
              {card.styles.map((s) => (
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

        <div className="flex justify-between gap-3 mt-4">
          <button
            type="button"
            onClick={onPass}
            className="flex-1 min-h-[44px] border hairline text-white/60 hover:bg-white/10 py-3 text-[10px] uppercase tracking-widest font-body press"
          >
            Pass
          </button>
          <button
            type="button"
            onClick={onPin}
            className="flex-1 min-h-[44px] bg-pink text-black py-3 text-[10px] uppercase tracking-widest font-body press"
          >
            Pin
          </button>
        </div>
      </div>
    </div>
  );
}
