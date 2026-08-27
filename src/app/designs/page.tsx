"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import StudioShell from "@/components/studio/StudioShell";
import SlashHeadline from "@/components/punk/SlashHeadline";
import {
  useBookings,
  useDesigns,
  useFavorites,
  type TattDesign,
} from "@/lib/tattStorage";
import { useMatchStore } from "@/store/useMatchStore";
import {
  deriveTasteProfile,
  pinnedArtistStyles,
  smartMatchUrlForTaste,
} from "@/lib/taste-profile";
import { ManageBillingButton } from "@/components/billing/BillingButtons";
import DesignJourneyRail from "./DesignJourneyRail";
import { deriveDesignTitle, getDesignJourney } from "./designJourney";

function formatEdited(ts: number): string {
  const diff = Date.now() - ts;
  const mins = Math.round(diff / 60_000);
  if (mins < 1) return "Just now";
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs} hr${hrs === 1 ? "" : "s"} ago`;
  const days = Math.round(hrs / 24);
  if (days === 1) return "Yesterday";
  if (days < 7) return `${days} days ago`;
  if (days < 30) return `${Math.round(days / 7)} week${days < 14 ? "" : "s"} ago`;
  return `${Math.round(days / 30)} mo ago`;
}

/**
 * "Your ink identity (so far)" — the emerging-taste read at the top of
 * the library. Computes ENTIRELY client-side from data already on this
 * device: the local design library plus pinned artists whose styles the
 * persisted match deck happens to know (ADR-0022, log now / personalize
 * later). No new APIs, no server-side taste profile — any cross-session
 * or global profile belongs to the SMS/global-taste lane, not here.
 * Hidden outright below two local data points: no cold-start fakery.
 */
function TasteCard({ designs, hydrated }: { designs: TattDesign[]; hydrated: boolean }) {
  const { favorites, hydrated: favoritesHydrated } = useFavorites();
  const matches = useMatchStore((s) => s.matches);
  const matchesHydrated = useMatchStore((s) => s.hasHydrated);

  const profile = useMemo(() => {
    if (!hydrated || !favoritesHydrated) return null;
    const pins = matchesHydrated ? pinnedArtistStyles(matches, favorites) : [];
    return deriveTasteProfile(designs, pins);
  }, [designs, hydrated, favorites, favoritesHydrated, matches, matchesHydrated]);

  if (!profile) return null;

  const unit = profile.pinCount > 0 ? "saves & pins" : "saves";

  return (
    <section
      aria-label="Your ink identity so far"
      className="mt-10 border-2 hairline px-6 py-6 md:px-8 md:py-7"
    >
      <div className="flex items-center justify-between gap-4 text-[10px] uppercase tracking-[0.25em] font-body">
        <span className="text-white/50">
          <span className="text-pink">●</span>&nbsp;&nbsp;Your ink identity (so far)
        </span>
        {profile.earlyRead && (
          <span className="text-white/40 tabular-nums">
            early read — {profile.dataPoints} {unit} in
          </span>
        )}
      </div>
      <p className="mt-4 font-display text-[26px] md:text-[34px] leading-[1.05] text-white">
        {profile.line}
        <span className="text-pink">.</span>
      </p>
      <div className="mt-5 flex flex-wrap items-center gap-3">
        {profile.topStyles.map(({ style, count }) => (
          <span
            key={style}
            className="border-2 hairline px-3 py-1.5 text-[10px] uppercase tracking-[0.2em] text-white/70 font-body tabular-nums"
          >
            {style} <span className="text-pink">×{count}</span>
          </span>
        ))}
        {profile.palette && (
          <span className="border-2 hairline px-3 py-1.5 text-[10px] uppercase tracking-[0.2em] text-white/70 font-body">
            {profile.palette === "blackwork" ? "black ink, mostly" : "color, mostly"}
          </span>
        )}
        <Link
          href={smartMatchUrlForTaste(profile)}
          className="ml-auto border-2 hairline press inline-flex items-center justify-center px-6 py-3 font-display text-[20px] leading-none tracking-[0.02em] text-white hover:text-black hover:bg-pink hover:border-pink"
        >
          Find artists who match your taste
          <span className="ml-2 text-[14px]">▸</span>
        </Link>
      </div>
    </section>
  );
}
export default function DesignsPage() {
  const { designs, hydrated, removeDesign, removeDesigns } = useDesigns();
  const { bookings } = useBookings();
  const count = designs.length;
  const showEmpty = hydrated && count === 0;
  const latestDesign = designs[0];
  const latestJourney = latestDesign
    ? getDesignJourney(latestDesign, bookings)
    : null;

  // Multi-select delete — pruning a whole batch of cuts without one
  // confirm dialog per tile. Quick single delete (the ✕) still works
  // outside of select mode.
  const [selectMode, setSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  const exitSelectMode = () => {
    setSelectMode(false);
    setSelectedIds(new Set());
  };

  const toggleSelected = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleDeleteSelected = () => {
    if (selectedIds.size === 0) return;
    const n = selectedIds.size;
    if (!confirm(`Delete ${n} design${n === 1 ? "" : "s"}? This can't be undone.`)) return;
    removeDesigns(Array.from(selectedIds));
    exitSelectMode();
  };

  return (
    <StudioShell>
      <div className="px-6 md:px-12 pt-6 pb-4 border-b hairline">
        <div className="max-w-6xl mx-auto flex items-center justify-between text-[10px] uppercase tracking-[0.25em] text-white/50 tabular-nums font-body">
          <span>
            <span className="text-pink">●</span>&nbsp;&nbsp;My&nbsp;Designs
          </span>
          <span>
            Saved:&nbsp;<span className="text-pink">{hydrated ? count : "—"}</span>
          </span>
        </div>
      </div>

      <div className="px-6 md:px-12 py-16 md:py-20">
        <div className="max-w-6xl mx-auto">
          <div className="flex items-end justify-between gap-6 flex-wrap">
            <SlashHeadline
              before="Your"
              slashed="cuts"
              sizeClassName="text-[48px] md:text-[88px] leading-[0.88]"
            />
            <div className="flex items-center gap-3">
              {!showEmpty && (
                selectMode ? (
                  <>
                    <button
                      onClick={handleDeleteSelected}
                      disabled={selectedIds.size === 0}
                      className="border-2 hairline press inline-flex items-center justify-center px-6 py-3 font-display text-[20px] leading-none tracking-[0.02em] text-white hover:text-black hover:bg-pink hover:border-pink disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-white disabled:hover:border-white/20 disabled:cursor-not-allowed"
                    >
                      Delete selected ({selectedIds.size})
                    </button>
                    <button
                      onClick={exitSelectMode}
                      className="border-2 hairline press inline-flex items-center justify-center px-6 py-3 font-display text-[20px] leading-none tracking-[0.02em] text-white/70 hover:text-white"
                    >
                      Cancel
                    </button>
                  </>
                ) : (
                  <button
                    onClick={() => setSelectMode(true)}
                    className="border-2 hairline press inline-flex items-center justify-center px-6 py-3 font-display text-[20px] leading-none tracking-[0.02em] text-white hover:text-black hover:bg-pink hover:border-pink"
                  >
                    Select
                  </button>
                )
              )}
              {/* Artist SaaS billing. /dashboard redirects here, so this is the
                  real dashboard home. The portal route derives the Stripe
                  customer id server-side from the caller's claimed artist
                  profile — nothing to pass in (see BillingButtons). */}
              <ManageBillingButton className="border-2 hairline press inline-flex items-center justify-center px-6 py-3 font-display text-[20px] leading-none tracking-[0.02em] text-white hover:text-black hover:bg-pink hover:border-pink disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-white disabled:hover:border-white/20 disabled:cursor-not-allowed">
                Manage Billing
              </ManageBillingButton>
              <Link
                href="/design"
                className="tape press inline-flex items-center justify-center px-6 py-3 font-display text-[20px] leading-none tracking-[0.02em]"
              >
                New Design
                <span className="ml-2 text-[14px]">▸</span>
              </Link>
            </div>
          </div>

          <TasteCard designs={designs} hydrated={hydrated} />

          {showEmpty ? (
            <div className="mt-20 border-2 hairline py-20 px-6 text-center">
              <div className="font-display text-[72px] sm:text-[90px] leading-none text-pink/25 select-none">
                {"//"}
              </div>
              <div className="mt-6 font-display text-[40px] sm:text-[56px] leading-[0.95] text-white">
                No cuts yet<span className="text-pink">.</span>
              </div>
              <p className="mt-4 text-[12px] uppercase tracking-[0.2em] text-white/50 font-body">
                Describe the ink you want and get two cuts to pick from.
              </p>
              <Link
                href="/design"
                className="mt-10 tape press inline-flex items-center justify-center px-8 py-4 font-display text-[24px] leading-none tracking-[0.02em]"
              >
                Start Designing
                <span className="ml-3 text-[18px]">▸</span>
              </Link>
            </div>
          ) : (
            <>
              {latestDesign && latestJourney && !selectMode && (
                <section
                  aria-labelledby="continue-design-heading"
                  className="mt-12 border-2 hairline bg-white/[0.035] p-4 sm:p-6"
                >
                  <div className="grid grid-cols-1 md:grid-cols-[180px_1fr_auto] gap-5 md:gap-7 items-center">
                    <Link
                      href={`/designs/${latestDesign.id}`}
                      aria-label={`Open ${deriveDesignTitle(latestDesign)}`}
                      className={`block aspect-square ${latestDesign.image ? "bg-bone" : latestDesign.color} border-2 hairline relative overflow-hidden press`}
                    >
                      {latestDesign.image ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={latestDesign.image}
                          alt=""
                          className="absolute inset-0 w-full h-full object-cover"
                        />
                      ) : (
                        <div className="absolute inset-0 bg-gradient-to-b from-transparent to-black/50 mix-blend-multiply" />
                      )}
                      <span className="absolute left-2 bottom-2 bg-black/75 px-2 py-1 text-[10px] uppercase tracking-[0.18em] text-white/70 font-body">
                        Last saved
                      </span>
                    </Link>

                    <div className="min-w-0">
                      <div className="text-[10px] uppercase tracking-[0.28em] text-pink font-body">
                        A strong next move
                      </div>
                      <h2
                        id="continue-design-heading"
                        className="mt-2 font-display text-[32px] sm:text-[42px] leading-[0.95] text-white"
                      >
                        {deriveDesignTitle(latestDesign)}
                        <span className="text-pink">.</span>
                      </h2>
                      <p className="mt-3 text-[13px] leading-[1.5] text-white/60 font-body">
                        <span className="text-white">{latestJourney.status}.</span>{" "}
                        {latestJourney.note}
                      </p>
                      <div className="mt-5 max-w-md">
                        <DesignJourneyRail journey={latestJourney} />
                      </div>
                    </div>

                    <div className="flex md:flex-col gap-3 md:min-w-[180px]">
                      <Link
                        href={latestJourney.nextHref}
                        className="tape press inline-flex items-center justify-center px-5 py-4 font-display text-[20px] leading-none tracking-[0.02em]"
                      >
                        {latestJourney.nextLabel}
                        <span className="ml-2 text-[14px]">▸</span>
                      </Link>
                      <Link
                        href={`/designs/${latestDesign.id}`}
                        className="border-2 hairline press inline-flex items-center justify-center px-4 py-3 text-[10px] uppercase tracking-[0.2em] text-white/60 hover:text-white font-body"
                      >
                        Review the cut
                      </Link>
                    </div>
                  </div>
                </section>
              )}

              <div className="mt-14 flex items-end justify-between gap-4">
                <div>
                  <div className="text-[10px] uppercase tracking-[0.28em] text-pink font-body">
                    Saved work
                  </div>
                  <h2 className="mt-1 font-display text-[32px] sm:text-[40px] leading-none text-white">
                    Every idea, still here.
                  </h2>
                </div>
                <span className="text-[10px] uppercase tracking-[0.2em] text-white/40 font-body">
                  Newest first
                </span>
              </div>

              <div className="mt-7 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
                {designs.map((d) => {
                  const isSelected = selectedIds.has(d.id);
                  const journey = getDesignJourney(d, bookings);
                  const tile = (
                    <div
                      className={`aspect-square ${d.image ? "bg-bone" : d.color} border-2 hairline relative overflow-hidden ${isSelected ? "outline outline-2 outline-pink" : ""}`}
                    >
                      {d.image ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={d.image}
                          alt={deriveDesignTitle(d)}
                          className="absolute inset-0 w-full h-full object-cover"
                          loading="lazy"
                        />
                      ) : (
                        <div className="absolute inset-0 bg-gradient-to-b from-transparent to-black/50 mix-blend-multiply" />
                      )}
                      <span className="absolute top-2 left-2 text-[10px] uppercase tracking-[0.2em] text-white/70 font-body bg-black/60 px-1.5 py-0.5">
                        v1
                      </span>
                    </div>
                  );

                  return (
                    <div key={d.id} className="group press relative">
                      {selectMode ? (
                        <button
                          type="button"
                          onClick={() => toggleSelected(d.id)}
                          aria-pressed={isSelected}
                          aria-label={`${isSelected ? "Deselect" : "Select"} ${deriveDesignTitle(d)}`}
                          className="block w-full text-left"
                        >
                          {tile}
                        </button>
                      ) : (
                        <Link href={`/designs/${d.id}`} className="block">
                          {tile}
                        </Link>
                      )}
                      {selectMode && (
                        <span
                          className={`pointer-events-none absolute top-2 right-2 w-6 h-6 flex items-center justify-center border-2 hairline font-display text-[14px] leading-none ${isSelected ? "bg-pink text-black border-pink" : "bg-black/70 text-white/60"}`}
                          aria-hidden="true"
                        >
                          {isSelected ? "✓" : ""}
                        </span>
                      )}
                      <div className="mt-3 flex items-baseline justify-between gap-3">
                        <span className="font-display text-[18px] tracking-wide text-white group-hover:text-pink">
                          {deriveDesignTitle(d)}
                        </span>
                        <span className="text-[10px] uppercase tracking-[0.18em] text-white/40 tabular-nums font-body">
                          {formatEdited(d.createdAt)}
                        </span>
                      </div>
                      <p className="mt-1 text-[11px] text-white/40 font-body leading-[1.4] line-clamp-2">
                        {d.prompt}
                      </p>
                      {!selectMode && (
                        <div className="mt-4 border-t hairline pt-3">
                          <div className="flex items-center justify-between gap-3">
                            <span className="text-[10px] uppercase tracking-[0.18em] text-white/45 font-body">
                              Next
                            </span>
                            <Link
                              href={journey.nextHref}
                              className="text-[10px] uppercase tracking-[0.18em] text-pink hover:text-white font-body"
                            >
                              {journey.nextLabel}&nbsp;▸
                            </Link>
                          </div>
                          <div className="mt-3">
                            <DesignJourneyRail journey={journey} compact />
                          </div>
                        </div>
                      )}
                      {!selectMode && (
                        <button
                          onClick={() => {
                            if (confirm("Delete this design?")) removeDesign(d.id);
                          }}
                          aria-label={`Delete ${deriveDesignTitle(d)}`}
                          className="absolute top-2 right-2 w-8 h-8 flex items-center justify-center bg-black/80 border hairline text-white/60 hover:text-pink hover:bg-black opacity-0 group-hover:opacity-100 transition-opacity press font-display text-[18px] leading-none"
                        >
                          ✕
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>
            </>
          )}
        </div>
      </div>
    </StudioShell>
  );
}
