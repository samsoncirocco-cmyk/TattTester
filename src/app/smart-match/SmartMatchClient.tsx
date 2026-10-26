"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import StudioShell from "@/components/studio/StudioShell";
import SlashHeadline from "@/components/punk/SlashHeadline";
import { getApiAuthHeaders } from "@/lib/client-api-auth";
import {
  CANONICAL_STYLES,
  canonicalStylesFromOntologyTags,
  parseStylesParam,
} from "@/lib/design-style-signal";
import { useMatchStore, type ArtistMatch } from "@/store/useMatchStore";
import { deriveReasonChips } from "@/features/match-pulse/services/matchReasonChips";
import type { DesignSession } from "@/services/designSession/types";
import { useStylePreferences } from "@/lib/tattStorage";
import {
  INTENTS,
  RATES,
  appliedLine,
  filtersInPlay,
  intentToFilters,
  parseIntentParam,
  parseRateParam,
  rateToBudget,
  type IntentId,
  type RateId,
} from "./intentFilters";

/**
 * Preference form → live semantic match → hands off to /swipe.
 *
 * This is the swipe deck's entry point: pick styles + a location, submit,
 * and the top results from /api/v1/match/semantic land in useMatchStore
 * for /swipe to render as a card deck. No local/fake fallback — the
 * honesty gate (data.query_info?.graphSource !== "live" means "say so,"
 * never dress up demo artists as real matches) lives here.
 *
 * Design-session handoff: arriving as /smart-match?ds=<sessionId> loads the
 * completed session's brief, pre-selects the mapped style pills, enriches the
 * semantic query with the brief's placement + meaning, and auto-runs the
 * search — the user can still edit and re-run. A missing or errored session
 * falls back silently to the blank form. The "ds" param threads onward to
 * /swipe so the booking eventually carries designSessionId.
 *
 * Style-signal handoff: sessionless surfaces (a saved design's detail page,
 * the AR mirror) arrive as /smart-match?styles=<canonical,names> — those
 * pills come pre-selected but nothing auto-runs; the user still owns the
 * search. Garbage style names are dropped by parseStylesParam, never thrown.
 *
 * Intent and rate pills (spec 15): "What are you after?" drives
 * `has_portfolio` (a big piece or a cover-up asks for shown work) and
 * "Hourly rate you're comfortable with" sends `budget` in dollars per hour —
 * the unit the artist data has. Both live in the URL (?intent=big&rate=250)
 * so refresh and back keep them. No radius control: the engine measures no
 * distance yet, so a radius pill would be a promise nothing keeps.
 */

type Status = "idle" | "searching" | "error";

type MatchPayload = {
  id: string; name: string; score: number; styles?: string[];
  location?: string; city?: string; instagram?: string;
  bio?: string; reasoning?: string;
  rating?: number; reviewCount?: number; portfolio?: string[];
  heroImage?: string | null;
};

/**
 * One mapper for both decks (spec 14): a broadened artist carries exactly the
 * fields a primary one does, including the gated heroImage, so /swipe renders
 * them with the same card.
 */
function toArtistMatch(
  m: MatchPayload,
  asked: { styles: string[]; location: string },
  deck: "primary" | "broadened",
): ArtistMatch {
  return {
    artistId: String(m.id),
    artistName: m.name,
    matchScore: m.score,
    tags: m.styles || [],
    styles: m.styles || [],
    location: m.location,
    instagramUrl: m.instagram,
    bio: m.bio,
    reasoning: m.reasoning,
    heroImage: m.heroImage ?? null,
    deck,
    // Derived here — the only place that still knows what the user
    // actually asked for — so /swipe can say WHY, not just how much.
    reasonChips: deriveReasonChips(
      {
        styles: m.styles,
        city: m.city,
        location: m.location,
        rating: m.rating,
        reviewCount: m.reviewCount,
        portfolio: m.portfolio,
      },
      asked
    ),
  };
}

function StylePill({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={`text-[10px] uppercase tracking-[0.2em] border hairline px-3 py-2 press font-body shrink-0 ${
        active ? "bg-pink text-black border-pink" : "text-white/70 hover:text-black hover:bg-pink"
      }`}
    >
      {label}
    </button>
  );
}

export default function SmartMatchClient() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const designSessionId = searchParams.get("ds");
  const explicitStyles = searchParams.get("styles");
  const hasExplicitStyles = searchParams.has("styles");
  const setMatches = useMatchStore((s) => s.setMatches);
  const setBroadened = useMatchStore((s) => s.setBroadened);
  const {
    stylePreferences,
    hydrated: preferencesHydrated,
  } = useStylePreferences();
  const validStylePreferences = useMemo(
    () =>
      stylePreferences.filter((style) =>
        (CANONICAL_STYLES as readonly string[]).includes(style),
      ),
    [stylePreferences],
  );

  const [styles, setStyles] = useState<string[]>(() =>
    parseStylesParam(explicitStyles)
  );
  const [locationInput, setLocationInput] = useState("");
  const [intent, setIntent] = useState<IntentId | null>(() =>
    parseIntentParam(searchParams.get("intent"))
  );
  const [rate, setRate] = useState<RateId>(() => parseRateParam(searchParams.get("rate")));

  // Selections live in the URL so refresh and back keep them; replaceState
  // rather than router.replace so toggling a pill never re-renders the route.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const url = new URL(window.location.href);
    if (intent) url.searchParams.set("intent", intent);
    else url.searchParams.delete("intent");
    if (rate !== "any") url.searchParams.set("rate", rate);
    else url.searchParams.delete("rate");
    const next = url.pathname + url.search;
    if (next !== window.location.pathname + window.location.search) {
      window.history.replaceState(window.history.state, "", next);
    }
  }, [intent, rate]);
  // Placement + meaning lifted from the design brief; folded into the
  // semantic query so the vector search gets real signal, not just pills.
  const [briefContext, setBriefContext] = useState("");
  const [status, setStatus] = useState<Status>("idle");
  const [errorMsg, setErrorMsg] = useState("");

  const toggleStyle = (style: string) => {
    setStyles((prev) =>
      prev.includes(style) ? prev.filter((s) => s !== style) : [...prev, style]
    );
  };

  const runSearch = useCallback(
    async (opts: {
      styles: string[];
      location: string;
      briefContext: string;
      intent: IntentId | null;
      rate: RateId;
    }) => {
      setStatus("searching");
      setErrorMsg("");

      try {
        const authHeaders = await getApiAuthHeaders();
        const location = opts.location.trim();
        const { hasPortfolio } = intentToFilters(opts.intent);
        // `budget` is an hourly rate in whole dollars (see intentFilters.ts).
        const budget = rateToBudget(opts.rate);

        const res = await fetch("/api/v1/match/semantic", {
          method: "POST",
          headers: { "Content-Type": "application/json", ...authHeaders },
          body: JSON.stringify({
            query:
              [opts.briefContext, ...opts.styles, location].filter(Boolean).join(" ") ||
              "tattoo artist",
            style_preferences: opts.styles,
            location: location || null,
            max_results: 20,
            has_portfolio: hasPortfolio,
            ...(budget !== null ? { budget } : {}),
          }),
        });

        if (!res.ok) {
          // Surface the route's own reason (e.g. a 400 from preference
          // validation) instead of a bare status code.
          const errBody = (await res.json().catch(() => null)) as { error?: string } | null;
          throw new Error(errBody?.error || `HTTP ${res.status}`);
        }
        const data = await res.json();
        if (!data.success) throw new Error(data.error || "Matching failed");

        // Honesty gate — never let a demo-artist fallback masquerade as a
        // real match deck.
        if (data.query_info?.graphSource !== "live") {
          setStatus("error");
          setErrorMsg("The live artist graph is unreachable right now — we don't fake matches.");
          return;
        }

        const asked = { styles: opts.styles, location };
        const matches: ArtistMatch[] = (data.matches || []).map((m: MatchPayload) =>
          toArtistMatch(m, asked, "primary")
        );
        // The server's near-matches when the primary set is thin. Kept as a
        // second deck, never folded into the first; de-duped by id here too.
        const primaryIds = new Set(matches.map((m) => m.artistId));
        const broadened: ArtistMatch[] = (data.broadened || [])
          .map((m: MatchPayload) => toArtistMatch(m, asked, "broadened"))
          .filter((m: ArtistMatch) => !primaryIds.has(m.artistId));

        if (matches.length === 0 && broadened.length === 0) {
          setStatus("error");
          const inPlay = filtersInPlay(opts.intent, opts.rate);
          setErrorMsg(
            inPlay
              ? `No artists match that combination yet (${inPlay}) — try loosening a filter, fewer styles or a broader location.`
              : "No artists match that combination yet — try fewer styles or a broader location."
          );
          return;
        }

        setMatches(matches);
        setBroadened(broadened, typeof data.broadened_reason === "string" ? data.broadened_reason : null);
        router.push(
          designSessionId ? `/swipe?ds=${encodeURIComponent(designSessionId)}` : "/swipe"
        );
      } catch (err) {
        console.error("[SmartMatch] Search failed:", err);
        setStatus("error");
        setErrorMsg(err instanceof Error ? err.message : "Search failed — try again.");
      }
    },
    [setMatches, setBroadened, router, designSessionId]
  );

  const handleSubmit = useCallback(
    () => runSearch({ styles, location: locationInput, briefContext, intent, rate }),
    [runSearch, styles, locationInput, briefContext, intent, rate]
  );

  // Design-session prefill: fetch the brief, map its ontology tags onto the
  // canonical pills, enrich the query, auto-run. Any failure (missing
  // session, no brief yet, network) falls back silently to the blank form.
  const prefillRan = useRef(false);
  useEffect(() => {
    if (!designSessionId || prefillRan.current) return;
    prefillRan.current = true;
    let cancelled = false;

    (async () => {
      try {
        const authHeaders = await getApiAuthHeaders();
        const res = await fetch(
          `/api/v1/design-session/${encodeURIComponent(designSessionId)}`,
          { headers: authHeaders }
        );
        if (!res.ok) return;
        const data = (await res.json()) as { session?: DesignSession } | null;
        const brief = data?.session?.brief;
        if (!brief || cancelled) return;

        const mappedStyles = canonicalStylesFromOntologyTags(brief.styleTags ?? []);
        const context = [brief.placement, brief.meaning].filter(Boolean).join(" ");
        setStyles(mappedStyles);
        setBriefContext(context);
        // The pills are the customer's; the brief prefill leaves them as set.
        await runSearch({ styles: mappedStyles, location: "", briefContext: context, intent, rate });
      } catch (err) {
        // Silent fallback — the blank form still works without the brief.
        console.warn("[SmartMatch] Design-session prefill failed:", err);
      }
    })();

    return () => {
      cancelled = true;
    };
    // intent/rate are read once at prefill time; prefillRan guards re-runs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [designSessionId, runSearch]);

  // A saved taste profile is a gentle default, never an override. Explicit
  // design-session context and ?styles= handoffs always win.
  const tastePrefillRan = useRef(false);
  useEffect(() => {
    if (
      tastePrefillRan.current ||
      !preferencesHydrated ||
      designSessionId ||
      hasExplicitStyles
    ) {
      return;
    }
    tastePrefillRan.current = true;
    setStyles(validStylePreferences);
  }, [
    designSessionId,
    hasExplicitStyles,
    preferencesHydrated,
    validStylePreferences,
  ]);

  return (
    <StudioShell>
      <div className="px-6 md:px-12 pt-6 pb-4 border-b hairline">
        <div className="max-w-3xl mx-auto text-[10px] uppercase tracking-[0.25em] text-white/50 tabular-nums font-body">
          <span className="text-pink">●</span>&nbsp;&nbsp;Step&nbsp;01/02 — Preferences
        </div>
      </div>

      <div className="px-6 md:px-12 py-16 md:py-20">
        <div className="max-w-3xl mx-auto">
          <SlashHeadline
            before="Find your"
            slashed="artist"
            sizeClassName="text-[48px] md:text-[72px] leading-[0.9]"
          />
          <p className="mt-3 text-[14px] text-white/60 font-body max-w-xl leading-[1.55]">
            Pick a few styles and a location. Real artists, ranked live from the graph — swipe through the top matches next.
          </p>
          {!designSessionId && !hasExplicitStyles && preferencesHydrated && validStylePreferences.length > 0 && (
            <p className="mt-4 text-[11px] uppercase tracking-[0.18em] text-pink/80 font-body">
              Your saved taste is already dialed in. Change anything you want.
            </p>
          )}

          <div className="mt-10 space-y-6 border-y-2 hairline py-6">
            <div>
              <span className="block text-[10px] uppercase tracking-[0.25em] text-pink font-body mb-3">
                Style
              </span>
              <div className="flex flex-wrap gap-2">
                {CANONICAL_STYLES.map((s) => (
                  <StylePill key={s} label={s} active={styles.includes(s)} onClick={() => toggleStyle(s)} />
                ))}
              </div>
            </div>

            <div>
              <label
                htmlFor="smart-match-location"
                className="block text-[10px] uppercase tracking-[0.25em] text-pink font-body mb-3"
              >
                Location (optional)
              </label>
              <input
                id="smart-match-location"
                type="text"
                value={locationInput}
                onChange={(e) => setLocationInput(e.target.value)}
                placeholder="Any city…"
                className="bg-black text-white placeholder-white/30 focus:outline-none text-[10px] uppercase tracking-[0.2em] border hairline focus:border-pink px-3 py-3 font-body w-full max-w-xs"
              />
            </div>

            <div>
              <span className="block text-[10px] uppercase tracking-[0.25em] text-pink font-body mb-3">
                What are you after?
              </span>
              <div className="flex flex-wrap gap-2" role="group" aria-label="What are you after?">
                {INTENTS.map((i) => (
                  <StylePill
                    key={i.id}
                    label={i.label}
                    active={intent === i.id}
                    onClick={() => setIntent((prev) => (prev === i.id ? null : i.id))}
                  />
                ))}
              </div>
            </div>

            <div>
              <span className="block text-[10px] uppercase tracking-[0.25em] text-pink font-body mb-3">
                Hourly rate you&apos;re comfortable with
              </span>
              <div className="flex flex-wrap gap-2" role="group" aria-label="Hourly rate you're comfortable with">
                {RATES.map((r) => (
                  <StylePill
                    key={r.id}
                    label={r.label}
                    active={rate === r.id}
                    onClick={() => setRate(r.id)}
                  />
                ))}
              </div>
              <p className="mt-2 text-[11px] text-white/40 font-body leading-[1.6]">
                Based on artists&apos; listed hourly rates, with some give. Many artists haven&apos;t listed one.
              </p>
            </div>

            {appliedLine(intent, rate) && (
              <p role="status" className="text-[11px] uppercase tracking-[0.18em] text-pink/80 font-body">
                {appliedLine(intent, rate)}
              </p>
            )}
          </div>

          {status === "error" && (
            <div className="mt-8 border-2 hairline p-6 text-center bg-pink/5">
              <p className="text-[12px] uppercase tracking-[0.2em] text-white/60 font-body">
                {errorMsg}
              </p>
            </div>
          )}

          <div className="mt-10">
            <button
              type="button"
              onClick={handleSubmit}
              disabled={status === "searching"}
              className="w-full sm:w-auto text-[10px] uppercase tracking-[0.25em] bg-pink text-black px-8 py-4 press font-body disabled:opacity-50"
            >
              {status === "searching" ? "Matching…" : "Find Artists ▸"}
            </button>
          </div>
        </div>
      </div>
    </StudioShell>
  );
}
