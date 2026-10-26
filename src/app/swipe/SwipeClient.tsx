"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import StudioShell from "@/components/studio/StudioShell";
import SlashHeadline from "@/components/punk/SlashHeadline";
import { useMatchStore, type ArtistMatch } from "@/store/useMatchStore";
import { artistSlug } from "@/lib/artist-slug";
import { decisionsClient } from "./decisionsClient";
import { SignInRequiredError } from "@/lib/client-api-auth";
import SwipeCard, { type SwipeCardModel } from "./SwipeCard";

// react-tinder-card touches the DOM directly on mount — load client-only.
const TinderCard = dynamic(() => import("react-tinder-card"), { ssr: false });

/**
 * Card-deck swipe UI over whatever /smart-match put in useMatchStore.
 * Real graph artists only — no fake fallback deck. If the store is
 * empty (direct nav, refresh after a session), send the visitor back
 * to /smart-match to run a real search instead of showing stand-ins.
 *
 * A design-session handoff arrives as /swipe?ds=<sessionId>; the "ds"
 * param threads onward into the pinned artists' Book CTAs
 * (/book?artistId=…&ds=…) so the booking can carry designSessionId.
 *
 * Decisions (spec 13): every pin and pass is stored per verified uid through
 * /api/v1/match/decision, optimistically — the card leaves at once. On mount
 * the caller's decisions are fetched and the deck resumes past them, so a
 * reload or another device does not bring swiped cards back. Signed-out
 * visitors get the sign-in prompt, same as /smart-match.
 *
 * Two decks (spec 14): the primary matches, then — when the server found the
 * primary set thin — "Close to what you asked for", the server's broadened[]
 * rendered as a visibly separate second deck rather than discarded. One-step
 * undo brings the last card back and reverses its decision on the server.
 */

type Deck = "primary" | "broadened";
type DecisionsState = "loading" | "ready" | "signin";

const UNDO_FLASH_MS = 4000;

/** Client-owned copy for the second deck (ADR-0036): the server's reason
 *  string is a signal, not a sentence we show. */
const BROADENED_LEAD = "Close to what you asked for";
const BROADENED_REASON =
  "Fewer than a handful of exact matches for your filters — these are the nearest.";

function toCard(m: ArtistMatch, deck: Deck): SwipeCardModel {
  return {
    id: m.artistId,
    name: m.artistName,
    slug: artistSlug(m.artistName, m.artistId),
    matchPercent: Math.min(99, Math.max(1, Math.round(m.matchScore || 0))),
    styles: (m.styles || m.tags || []).slice(0, 3),
    reasonChips: (m.reasonChips || []).slice(0, 3),
    location: m.location,
    instagram: m.instagramUrl,
    heroImage: m.heroImage ?? null,
    distanceMiles: typeof m.distanceMiles === "number" ? m.distanceMiles : undefined,
    deck,
  };
}

export default function SwipeClient() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const designSessionId = searchParams.get("ds");
  const storedMatches = useMatchStore((s) => s.matches);
  const storedBroadened = useMatchStore((s) => s.broadened);
  const hasHydrated = useMatchStore((s) => s.hasHydrated);

  const bookHref = (artistId: string) =>
    `/book?artistId=${encodeURIComponent(artistId)}${
      designSessionId ? `&ds=${encodeURIComponent(designSessionId)}` : ""
    }`;

  const primaryCards = useMemo(
    () => storedMatches.map((m) => toCard(m, "primary")),
    [storedMatches]
  );
  const broadenedCards = useMemo(() => {
    const seen = new Set(storedMatches.map((m) => m.artistId));
    return (storedBroadened ?? [])
      .filter((m) => !seen.has(m.artistId))
      .map((m) => toCard(m, "broadened"));
  }, [storedMatches, storedBroadened]);
  const cards = useMemo(
    () => [...primaryCards, ...broadenedCards],
    [primaryCards, broadenedCards]
  );

  // Tracked by id rather than a numeric index: useMatchStore is
  // zustand-persist-backed, so on a fresh load the store starts empty and
  // hydrates from localStorage asynchronously — an index-based initial value
  // would capture 0 from that first render and never recover.
  const [swipedIds, setSwipedIds] = useState<Set<string>>(new Set());
  const [liked, setLiked] = useState<SwipeCardModel[]>([]);
  // Passes hydrated from the server for cards in this deck. Kept apart from
  // swipedIds so "Show artists I passed" can put exactly those back.
  const [hydratedPassIds, setHydratedPassIds] = useState<Set<string>>(new Set());
  const [decisionsState, setDecisionsState] = useState<DecisionsState>("loading");
  const [unsaved, setUnsaved] = useState(false);
  // Which deck is on the table. The primary deck's "complete" screen is the
  // interstitial into the second one.
  const [phase, setPhase] = useState<Deck>("primary");
  // One-step undo: the last swipe, until the next one overwrites it.
  const [lastAction, setLastAction] = useState<{ card: SwipeCardModel; decision: "pin" | "pass" } | null>(null);
  const [undoFlash, setUndoFlash] = useState(false);
  const undoFlashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Resume past decided cards. Runs once the deck is known; a non-auth
  // failure (network, 5xx) falls through to an undecided deck rather than
  // blocking the page — the customer can still swipe, and writes still queue.
  const deckKey = cards.map((c) => c.id).join("|");
  useEffect(() => {
    if (!hasHydrated || cards.length === 0) return;
    let cancelled = false;
    (async () => {
      try {
        const decisions = await decisionsClient.fetchDecisions(designSessionId);
        if (cancelled) return;
        const byId = new Map(decisions.map((d) => [d.artistId, d.decision]));
        const decided = new Set<string>();
        const passes = new Set<string>();
        const pins: SwipeCardModel[] = [];
        for (const card of cards) {
          const d = byId.get(card.id);
          if (!d) continue;
          decided.add(card.id);
          if (d === "pin") pins.push(card);
          else passes.add(card.id);
        }
        setSwipedIds((prev) => new Set([...decided, ...prev]));
        setLiked((prev) => [...pins, ...prev.filter((c) => !decided.has(c.id))]);
        setHydratedPassIds(passes);
        setDecisionsState("ready");
      } catch (err) {
        if (cancelled) return;
        if (err instanceof SignInRequiredError) {
          setDecisionsState("signin");
          return;
        }
        console.warn("[Swipe] Could not load decisions:", err);
        setDecisionsState("ready");
      }
    })();
    return () => {
      cancelled = true;
    };
    // deckKey stands in for `cards` so a same-content deck does not refetch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasHydrated, deckKey, designSessionId]);

  useEffect(() => decisionsClient.subscribe((s) => setUnsaved(s.unsaved)), []);

  const swiped = useCallback(
    (direction: string, card: SwipeCardModel) => {
      const decision = direction === "right" ? "pin" : "pass";
      if (decision === "pin") setLiked((prev) => [...prev, card]);
      decisionsClient.record(card.id, decision, designSessionId);
      setSwipedIds((prev) => new Set(prev).add(card.id));
      setLastAction({ card, decision });
      setUndoFlash(true);
      if (undoFlashTimer.current) clearTimeout(undoFlashTimer.current);
      undoFlashTimer.current = setTimeout(() => setUndoFlash(false), UNDO_FLASH_MS);
    },
    [designSessionId]
  );

  const undo = useCallback(() => {
    if (!lastAction) return;
    const { card, decision } = lastAction;
    setSwipedIds((prev) => {
      const next = new Set(prev);
      next.delete(card.id);
      return next;
    });
    if (decision === "pin") setLiked((prev) => prev.filter((c) => c.id !== card.id));
    decisionsClient.remove(card.id);
    // Undoing the last card of the primary deck returns to that card, not
    // to the interstitial.
    setPhase(card.deck);
    setLastAction(null);
    setUndoFlash(false);
  }, [lastAction]);

  const showPassed = () => {
    setSwipedIds((prev) => {
      const next = new Set(prev);
      hydratedPassIds.forEach((id) => next.delete(id));
      return next;
    });
    setHydratedPassIds(new Set());
  };

  // A primary deck that is empty from the start (thin search) goes straight
  // to the alternatives with the reason line, instead of a dead end.
  const activeDeck: Deck = primaryCards.length === 0 ? "broadened" : phase;
  const deckCards = activeDeck === "primary" ? primaryCards : broadenedCards;
  const remaining = deckCards.filter((card) => !swipedIds.has(card.id));
  const topCard = remaining[remaining.length - 1] ?? null;
  const broadenedRemaining = broadenedCards.filter((c) => !swipedIds.has(c.id)).length;
  const deckDone = deckCards.length > 0 && remaining.length === 0;
  const canContinue = activeDeck === "primary" && broadenedRemaining > 0;

  // Keyboard: ← pass · → pin · ↑ profile · Z / Backspace undo. Read through
  // a ref so one listener sees the current top card without re-binding.
  const latest = useRef({ topCard, swiped, undo });
  latest.current = { topCard, swiped, undo };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const { topCard: top, swiped: doSwipe, undo: doUndo } = latest.current;
      if (e.key === "ArrowLeft" && top) {
        e.preventDefault();
        doSwipe("left", top);
      } else if (e.key === "ArrowRight" && top) {
        e.preventDefault();
        doSwipe("right", top);
      } else if (e.key === "ArrowUp" && top) {
        e.preventDefault();
        window.open(`/artists/${encodeURIComponent(top.slug)}`, "_blank", "noopener");
      } else if (e.key === "z" || e.key === "Z" || e.key === "Backspace") {
        e.preventDefault();
        doUndo();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Persist rehydration is async: matches starts as [] even when a deck
  // exists in localStorage. Wait before deciding the empty state so a
  // reload / direct nav to /swipe does not flash "No deck yet."
  if (!hasHydrated || (cards.length > 0 && decisionsState === "loading")) {
    return (
      <StudioShell>
        <div className="px-6 md:px-12 py-16 md:py-20 flex flex-col items-center">
          <div className="max-w-3xl w-full text-center mb-10">
            <div className="h-[56px] md:h-[64px] bg-white/5 border-2 hairline max-w-md mx-auto" />
            <div className="mt-3 h-[14px] bg-white/5 border hairline max-w-sm mx-auto" />
          </div>
          <div
            className="w-full max-w-sm h-[520px] bg-white/5 border-2 hairline"
            aria-busy="true"
            aria-label="Loading swipe deck"
          />
        </div>
      </StudioShell>
    );
  }

  if (decisionsState === "signin") {
    return (
      <StudioShell>
        <div className="px-6 md:px-12 py-24 text-center">
          <div className="max-w-md mx-auto border-2 hairline p-10">
            <div className="font-display text-[24px] tracking-wide text-white/60">
              Sign in to&nbsp;<span className="text-pink">swipe</span>
            </div>
            <p className="mt-3 text-[12px] uppercase tracking-[0.2em] text-white/40 font-body leading-[1.8]">
              Your pins and passes are saved to your account, so they are there on any device.
            </p>
            <Link
              href="/login"
              className="mt-6 inline-flex items-center min-h-[44px] text-[10px] uppercase tracking-[0.2em] text-white/80 hover:text-black hover:bg-pink border-2 hairline px-4 py-3 press font-body"
            >
              Sign in&nbsp;<span className="ml-2">▸</span>
            </Link>
          </div>
        </div>
      </StudioShell>
    );
  }

  if (cards.length === 0) {
    return (
      <StudioShell>
        <div className="px-6 md:px-12 py-24 text-center">
          <div className="max-w-md mx-auto border-2 hairline p-10">
            <div className="font-display text-[24px] tracking-wide text-white/60">
              No deck&nbsp;<span className="text-pink">yet</span>
            </div>
            <p className="mt-3 text-[12px] uppercase tracking-[0.2em] text-white/40 font-body leading-[1.8]">
              Run a match search first — swipe works over real results, never a stand-in deck.
            </p>
            <Link
              href="/smart-match"
              className="mt-6 inline-flex items-center min-h-[44px] text-[10px] uppercase tracking-[0.2em] text-white/80 hover:text-black hover:bg-pink border-2 hairline px-4 py-3 press font-body"
            >
              Set preferences&nbsp;<span className="ml-2">▸</span>
            </Link>
          </div>
        </div>
      </StudioShell>
    );
  }

  return (
    <StudioShell>
      <div className="px-6 md:px-12 pt-6 pb-4 border-b hairline">
        <div className="max-w-3xl mx-auto flex items-center justify-between text-[10px] uppercase tracking-[0.25em] text-white/50 tabular-nums font-body">
          <span>
            <span className="text-pink">●</span>&nbsp;&nbsp;Step&nbsp;02/02 — Swipe
          </span>
          <span>
            Pinned:&nbsp;<span className="text-pink tabular-nums">{liked.length}</span>
          </span>
        </div>
      </div>

      <div className="px-6 md:px-12 py-16 md:py-20 flex flex-col items-center">
        <div className="max-w-3xl w-full text-center mb-10">
          {activeDeck === "broadened" ? (
            <>
              <SlashHeadline
                before="Close to what"
                slashed="you asked for"
                sizeClassName="text-[32px] md:text-[48px] leading-[0.9]"
                className="justify-center"
              />
              <p className="mt-3 text-[14px] text-white/60 font-body">{BROADENED_REASON}</p>
            </>
          ) : (
            <>
              <SlashHeadline
                before="Real"
                slashed="artists"
                sizeClassName="text-[40px] md:text-[56px] leading-[0.9]"
                className="justify-center"
              />
              <p className="mt-3 text-[14px] text-white/60 font-body">
                Swipe right to pin, left to pass. Ranked live from the graph.
              </p>
            </>
          )}
          {unsaved && (
            <p role="status" className="mt-2 text-[11px] uppercase tracking-[0.18em] text-pink/80 font-body">
              Not saved yet — we&apos;ll keep trying.
            </p>
          )}
          {hydratedPassIds.size > 0 && (
            <button
              type="button"
              onClick={showPassed}
              className="mt-3 text-[10px] uppercase tracking-[0.2em] text-white/50 hover:text-pink underline underline-offset-4 font-body"
            >
              Show artists I passed.
            </button>
          )}
        </div>

        {!deckDone ? (
          <>
            <div className="w-full max-w-sm h-[520px] relative">
              {/* Cards not yet swiped, stacked via CSS (absolute + source
                  order — later siblings paint on top). Explicit filter
                  rather than relying on TinderCard's internal DOM removal,
                  which fights React's own reconciliation on re-render. */}
              {remaining.map((card, i) => (
                <TinderCard
                  key={card.id}
                  onSwipe={(dir) => swiped(dir, card)}
                  preventSwipe={["up", "down"]}
                  className="absolute w-full h-full"
                >
                  <SwipeCard
                    card={card}
                    onPass={() => swiped("left", card)}
                    onPin={() => swiped("right", card)}
                    eager={i >= remaining.length - 2}
                  />
                </TinderCard>
              ))}
            </div>
            <div className="mt-6 flex items-center gap-6">
              <button
                type="button"
                onClick={undo}
                disabled={!lastAction}
                className={`min-h-[44px] text-[10px] uppercase tracking-[0.2em] border hairline px-4 py-2 press font-body disabled:opacity-30 ${
                  undoFlash ? "bg-pink text-black border-pink" : "text-white/70 hover:text-pink"
                }`}
              >
                Undo
              </button>
              <span className="text-[10px] uppercase tracking-[0.2em] text-white/40 font-body">
                ← pass · → pin · ↑ profile · Z undo
              </span>
            </div>
          </>
        ) : (
          /* The booking affordance speaks quiet (ADR-0032): the deck above is
             loud, but the moment the sheet offers a commitment — booking a
             pinned artist — the register flips. */
          <div className="max-w-md w-full text-center border hairline-quiet p-10 md:p-12">
            <p className="text-quiet-dim text-[12px] mb-4 font-body">Deck complete</p>
            <div className="font-display-quiet text-[24px] mb-4 text-quiet">
              {liked.length} pinned
            </div>
            <p className="text-[13px] text-quiet-dim font-body leading-[1.7] mb-10">
              {canContinue
                ? `${BROADENED_LEAD}: ${broadenedRemaining} more artist${
                    broadenedRemaining === 1 ? "" : "s"
                  } near your filters are waiting in a second deck.`
                : liked.length > 0
                  ? "Book a pinned artist below, or browse the full roster."
                  : "Nothing pinned this round — try different preferences."}
            </p>
            {liked.length > 0 && (
              <ul className="mb-10 space-y-3 text-left">
                {liked.map((card) => (
                  <li
                    key={card.id}
                    className="flex items-center justify-between gap-3 border hairline-quiet-soft px-4 py-3"
                  >
                    <span className="font-body text-[13px] text-quiet truncate">{card.name}</span>
                    <Link
                      href={bookHref(card.id)}
                      className="shrink-0 inline-flex items-center min-h-[44px] text-[12px] bg-quiet text-black hover:bg-white px-4 py-2.5 press font-body"
                    >
                      Book
                    </Link>
                  </li>
                ))}
              </ul>
            )}
            {canContinue && (
              <button
                type="button"
                onClick={() => setPhase("broadened")}
                className="w-full mb-3 text-[13px] bg-quiet text-black hover:bg-white px-8 py-4 press font-body"
              >
                See close matches ▸
              </button>
            )}
            {lastAction && (
              <button
                type="button"
                onClick={undo}
                className="w-full mb-3 text-[13px] border hairline-quiet text-quiet hover:border-quiet hover:text-white px-8 py-4 press font-body"
              >
                Undo
              </button>
            )}
            <button
              type="button"
              onClick={() => router.push(liked.length > 0 ? "/artists" : "/smart-match")}
              className="w-full text-[13px] border hairline-quiet text-quiet hover:border-quiet hover:text-white px-8 py-4 press font-body"
            >
              {liked.length > 0 ? "Browse the roster" : "Try again"}
            </button>
          </div>
        )}
      </div>
    </StudioShell>
  );
}
