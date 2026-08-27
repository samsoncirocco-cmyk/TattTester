"use client";

import { useState } from "react";
import { getApiAuthHeaders } from "@/lib/client-api-auth";
import { useAuthStore } from "@/store/useAuthStore";

/**
 * Client-side billing actions for the artist SaaS subscription (money flow #2:
 * the PLATFORM charges the ARTIST directly). Both buttons attach the firebase
 * auth header via getApiAuthHeaders and follow the Stripe-hosted URL the API
 * returns.
 */

/** Starts an artist subscription Checkout Session and redirects to Stripe. */
export function ArtistSubscribeButton({
  className,
  children,
}: {
  className?: string;
  children: React.ReactNode;
}) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const user = useAuthStore((s) => s.user);

  async function subscribe() {
    setError(null);
    setLoading(true);
    try {
      const headers = await getApiAuthHeaders();
      // No artistId here on purpose (#97): user.uid is a Firebase uid, not a
      // graph Artist id — the server derives the caller's claimed artist from
      // the verified token (claimedByUid) so the webhook can persist status
      // onto the right Artist node.
      const res = await fetch("/api/v1/billing/subscribe", {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ email: user?.email }),
      });
      const data = (await res.json()) as { sessionUrl?: string; error?: string };
      if (!res.ok || !data.sessionUrl) {
        throw new Error(data.error || "Unable to start subscription.");
      }
      window.location.href = data.sessionUrl;
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong.");
      setLoading(false);
    }
  }

  return (
    <>
      <button
        type="button"
        onClick={subscribe}
        disabled={loading}
        className={className}
      >
        {loading ? "Starting…" : children}
      </button>
      {error && (
        <p className="mt-3 text-[11px] uppercase tracking-[0.2em] text-pink font-body">
          {error}
        </p>
      )}
    </>
  );
}

/** Starts the one-time $10 / 25-generation consumer credit checkout. */
export function BuyGenerationCreditsButton({
  className,
  children,
}: {
  className?: string;
  children: React.ReactNode;
}) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function buyCredits() {
    setError(null);
    setLoading(true);
    try {
      const headers = await getApiAuthHeaders();
      const res = await fetch("/api/v1/billing/credits", {
        method: "POST",
        headers,
      });
      const data = (await res.json()) as { sessionUrl?: string; error?: string };
      if (!res.ok || !data.sessionUrl) {
        throw new Error(data.error || "Unable to start credit checkout.");
      }
      window.location.href = data.sessionUrl;
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong.");
      setLoading(false);
    }
  }

  return (
    <>
      <button type="button" onClick={buyCredits} disabled={loading} className={className}>
        {loading ? "Starting…" : children}
      </button>
      {error && (
        <p className="mt-3 text-[11px] uppercase tracking-[0.2em] text-pink font-body">
          {error}
        </p>
      )}
    </>
  );
}

/**
 * Opens the Stripe customer portal so an artist can manage their subscription.
 * The Stripe customer id (`cus_...`) is derived SERVER-SIDE by
 * /api/v1/billing/portal from the caller's own claimed artist profile — the
 * client sends nothing but its auth header, so there is no id to surface (or
 * spoof) here. Callers without a subscription get a friendly 404 message.
 */
export function ManageBillingButton({
  className,
  children,
}: {
  className?: string;
  children: React.ReactNode;
}) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function openPortal() {
    setError(null);
    setLoading(true);
    try {
      const headers = await getApiAuthHeaders();
      const res = await fetch("/api/v1/billing/portal", {
        method: "POST",
        headers,
      });
      const data = (await res.json()) as { url?: string; error?: string; code?: string };
      if (!res.ok || !data.url) {
        if (data.code === "NO_BILLING_CUSTOMER") {
          throw new Error("No subscription yet — start one from the pricing page first.");
        }
        throw new Error(data.error || "Unable to open billing portal.");
      }
      window.location.href = data.url;
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong.");
      setLoading(false);
    }
  }

  return (
    <>
      <button
        type="button"
        onClick={openPortal}
        disabled={loading}
        className={className}
      >
        {loading ? "Opening…" : children}
      </button>
      {error && (
        <p className="mt-3 text-[11px] uppercase tracking-[0.2em] text-pink font-body">
          {error}
        </p>
      )}
    </>
  );
}
