/**
 * Security classification for every API route in src/app/api.
 *
 * Every route.ts MUST have an entry here — api-route-security.test.ts
 * inventories the filesystem and fails the build when a route is added
 * without an explicit classification, or when a classified route does
 * not actually call the enforcement function its class requires.
 *
 * Classes:
 *  - firebase-auth:    must call verifyApiAuth() (Firebase ID token Bearer)
 *  - cloud-tasks-oidc: must call verifyCloudTaskRequest() (Google OIDC)
 *  - webhook-signature: must verify the provider's HMAC signature
 *  - public:           deliberately unauthenticated — a written reason is required
 */
export type RouteSecurityClass =
  | 'firebase-auth'
  | 'cloud-tasks-oidc'
  | 'webhook-signature'
  | 'public';

export interface RouteSecurityEntry {
  class: RouteSecurityClass;
  /** Required for `public` routes: why this is safe without auth. */
  reason?: string;
}

/** Keys are route paths relative to src/app/api, without the trailing /route.ts */
export const API_ROUTE_SECURITY: Record<string, RouteSecurityEntry> = {
  'checkout': { class: 'firebase-auth' },
  'debug': { class: 'firebase-auth' },
  'health': {
    class: 'public',
    reason: 'Liveness probe for load balancers; returns static status, touches no paid services or user data.',
  },
  'health/council': { class: 'firebase-auth' },
  'health/startup': { class: 'firebase-auth' },
  'neo4j/query': { class: 'firebase-auth' },
  'predictions': { class: 'firebase-auth' },
  'predictions/[id]': { class: 'firebase-auth' },
  'v1/artist/availability': { class: 'firebase-auth' },
  'v1/artist/calendar/connect': { class: 'firebase-auth' },
  'v1/artist/calendar/callback': {
    class: 'public',
    reason:
      "Google's OAuth redirect targets the artist's BROWSER, so no Authorization header can be sent. " +
      'Authentication is the `state` parameter: an unguessable, server-issued, single-use token minted ' +
      'in v1/artist/calendar/connect while holding a verified Firebase uid and a proven claimedByUid ' +
      'match, consumed inside a transaction and expiring in 10 minutes. The artist id comes from the ' +
      'stored state, never from the query string, and the authorization code is exchanged server-side.',
  },
  'v1/artist/calendar/disconnect': { class: 'firebase-auth' },
  'v1/artist/instagram/connect': { class: 'firebase-auth' },
  'v1/artist/instagram/media': { class: 'firebase-auth' },
  'v1/artist/instagram/callback': {
    class: 'public',
    reason:
      "Instagram redirects the artist's browser without a Firebase bearer token. " +
      'The callback consumes a random, single-use, server-stored state bound to a verified uid, ' +
      'artist id, and expected Instagram username; it expires in ten minutes. The returned ' +
      'Instagram account must match that locked identity before any encrypted token is stored.',
  },
  // Artist console (TAT-38): both resolve the artist from the VERIFIED uid
  // via claimedByUid — client-supplied artistIds are never accepted.
  'v1/artist/me': { class: 'firebase-auth' },
  'v1/artist/bookings': { class: 'firebase-auth' },
  'v1/artist/profile': { class: 'firebase-auth' },
  'v1/book': { class: 'firebase-auth' },
  'v1/book/hold': { class: 'firebase-auth' },
  'v1/bookings': { class: 'firebase-auth' },
  'v1/bookings/[id]': { class: 'firebase-auth' },
  // Owner-scoped .ics download of a reservation's slot; same uid discipline
  // and existence-hiding 404s as v1/bookings/[id].
  'v1/bookings/[id]/calendar.ics': { class: 'firebase-auth' },
  'v1/council/enhance': { class: 'firebase-auth' },
  'v1/council/generate': { class: 'firebase-auth' },
  'v1/design-session': { class: 'firebase-auth' },
  'v1/design-session/[id]': { class: 'firebase-auth' },
  'v1/design-session/[id]/confirm': { class: 'firebase-auth' },
  'v1/design-session/[id]/critique': { class: 'firebase-auth' },
  'v1/design-session/[id]/pick': { class: 'firebase-auth' },
  'v1/design-session/[id]/placement-preview': { class: 'firebase-auth' },
  'v1/design-session/[id]/refine': { class: 'firebase-auth' },
  'v1/design-session/[id]/reference': { class: 'firebase-auth' },
  'v1/design-session/[id]/round': { class: 'firebase-auth' },
  'v1/design-session/[id]/round/pick': { class: 'firebase-auth' },
  'v1/design-session/[id]/round/reroll': { class: 'firebase-auth' },
  'v1/design-session/converse': { class: 'firebase-auth' },
  'v1/designs/share': { class: 'firebase-auth' },
  'v1/designs/share/[shareId]': {
    class: 'public',
    reason: 'Public share links are the product feature: read-only fetch of a design by unguessable shareId.',
  },
  'v1/designs/share/[shareId]/vote': {
    class: 'public',
    reason:
      'Friend voting on a shared design (TAT-52) is anonymous BY DESIGN — the friend in the ' +
      'group chat has no account and must not need one. Scope is one atomic counter increment ' +
      'on a share reached only by its unguessable shareId; the tally feeds nothing downstream ' +
      '(no spend, no matching). Abuse posture: per-IP rate limit via the shared rate-limit lib, ' +
      'one-vote-per-browser dedupe client-side; fails closed 503 when no durable store is wired.',
  },
  'v1/artists/takedown': {
    class: 'public',
    reason:
      'A scraped artist has no TattTester account — requiring one before they may ask us to ' +
      'stop using their photographs would be backwards. The route removes nothing: it ' +
      'records a :TakedownRequest and emails ops, with no write path to GCS, Supabase, ' +
      'or the :Artist node. Removal is a human-run CLI (docs/adr/0025). IP rate-limited.',
  },
  'v1/artist-intros': {
    class: 'public',
    reason:
      'A customer may ask for an introduction before creating a TatT account. The route cannot take a deposit, confirm a booking, or modify an artist; it records a relay request and sends it to ops, with a per-IP limit.',
  },
  // The counterpart to takedown, and deliberately the opposite class. Asking to
  // be removed must need no account; asking to be re-added must, because the
  // account is part of the identity proof and is what the profile binds to.
  // See docs/adr/0026.
  'v1/artists/reinstate': { class: 'firebase-auth' },
  'v1/embeddings/generate': { class: 'firebase-auth' },
  'v1/estimate': { class: 'firebase-auth' },
  'v1/generate': { class: 'firebase-auth' },
  'v1/layers/decompose': { class: 'firebase-auth' },
  'v1/match/semantic': { class: 'firebase-auth' },
  'v1/match/update': { class: 'firebase-auth' },
  'v1/stencil/export': { class: 'firebase-auth' },
  'v1/storage/get-signed-url': { class: 'firebase-auth' },
  'v1/storage/upload': { class: 'firebase-auth' },
  'v1/upload-layer': { class: 'firebase-auth' },
  // Stripe Connect (marketplace) — artist onboarding & payouts
  'v1/connect/accounts': { class: 'firebase-auth' },
  'v1/connect/onboarding-link': { class: 'firebase-auth' },
  'v1/connect/status': { class: 'firebase-auth' },
  'v1/connect/login-link': { class: 'firebase-auth' },
  'v1/connect/claim': { class: 'firebase-auth' },
  'v1/connect/claim-complete': { class: 'firebase-auth' },
  // SaaS Billing (artist subscriptions) + Invoicing
  'v1/billing/subscribe': { class: 'firebase-auth' },
  'v1/billing/portal': { class: 'firebase-auth' },
  'v1/billing/credits': { class: 'firebase-auth' },
  'v1/invoices': { class: 'firebase-auth' },
  'webhooks/stripe': { class: 'webhook-signature' },
  // SketchBot SMS inbound (TAT-49): X-Twilio-Signature verified against
  // TWILIO_AUTH_TOKEN; also flag-gated (404) and fail-closed (503).
  'webhooks/twilio': { class: 'webhook-signature' },
  // Maintenance cron: refunds held deposits past their hold window.
  'cron/expire-deposits': {
    class: 'public',
    reason: 'Vercel cron endpoint guarded by CRON_SECRET bearer; no user data, idempotent maintenance job.',
  },
  // Review cron: re-asks the ADR-0060 prompt contract over recently updated
  // sessions and reports zero-render stalls (#376). Read-only and spend-free.
  'cron/session-review': {
    class: 'public',
    reason:
      'Vercel cron endpoint guarded by CRON_SECRET bearer; read-only sweep, no writes, no model calls.',
  },
};
