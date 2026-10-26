/**
 * First-run funnel hooks. Four events, nothing else:
 * landing → intake_start → design_generated → booking_start.
 *
 * Delivery is first-party on purpose. There is no analytics vendor in
 * this repo, and inventing one would be an owner decision. Events go to
 * `window.dataLayer` when a tag manager is later attached, and to
 * POST /api/v1/funnel so the step shows up in our own logs today.
 * No prompt text, no account id, no email.
 */

export const FUNNEL_EVENTS = [
  "landing",
  "intake_start",
  "design_generated",
  "booking_start",
] as const;

export type FunnelEvent = (typeof FUNNEL_EVENTS)[number];

export function isFunnelEvent(value: unknown): value is FunnelEvent {
  return typeof value === "string" && (FUNNEL_EVENTS as readonly string[]).includes(value);
}

const fired = new Set<string>();

export function trackFunnel(event: FunnelEvent): void {
  // Vitest renders these components. A beacon from a test would steal a
  // mocked fetch queue. Production and `next dev` still send.
  if (process.env.NODE_ENV === "test") return;
  if (typeof window === "undefined") return;
  // One of each event per page load. A reload is a new load.
  if (fired.has(event)) return;
  fired.add(event);

  const payload = { event, path: window.location.pathname };
  const dataLayer = (window as Window & { dataLayer?: unknown[] }).dataLayer;
  if (Array.isArray(dataLayer)) {
    dataLayer.push({ event: `funnel_${event}`, path: payload.path });
  }
  window.dispatchEvent(new CustomEvent("tatt:funnel", { detail: payload }));

  const body = JSON.stringify(payload);
  try {
    if (typeof navigator.sendBeacon === "function") {
      const sent = navigator.sendBeacon(
        "/api/v1/funnel",
        new Blob([body], { type: "application/json" })
      );
      if (sent) return;
    }
    void fetch("/api/v1/funnel", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
      keepalive: true,
    }).catch(() => undefined);
  } catch {
    // Measurement must never break the page.
  }
}
