---
status: current
verified_against: 018bbaa
verified_on: 2026-07-27
---

# Current architecture

TatT is a Next.js App Router application with several deep product modules
behind route and UI adapters. The architecture should be understood through
those module interfaces, not through the repository's historical
“directives/orchestration/execution” narrative.

## Product modules

| Module | Interface | Responsibility |
| --- | --- | --- |
| Intake | `src/services/intake/index.ts` | Extract and normalize placement, style, meaning, references, and constraints |
| Design conversation | `src/services/designConversation/index.ts` | Run the conversational intake, proposal cadence, provider fallback, and turn state |
| Design session | `src/services/designSession/index.ts` | Orchestrate session persistence, confirmation, selection, refinement, and placement |
| Generation | `src/services/generation/index.ts` | Generate tattoo directions while hiding provider routing |
| Council | `src/services/council/index.ts` | Improve or structure generation intent |
| Storage | `src/services/storage/index.ts` | Store and retrieve design assets through storage adapters |
| Matching | API and feature modules under `match`, `smart-match`, and `match-pulse` | Combine semantic, graph, and interaction evidence into artist results |
| AR mirror | `src/features/ar/` and `src/app/visualize/page.tsx` | Composite a saved design onto a live camera feed, user-positioned only, with capture and group-chat share |
| Booking | `src/lib/scheduling-engine.ts`, booking routes, and checkout | Resolve booking mode, reserve inventory, collect deposits, and track state |
| Artist calendar | `src/lib/artist-calendar.ts` and connection adapter | Authorize Google Calendar, read conflicts, and write TatT booking events |
| Artist lifecycle | claim, takedown, reinstatement, and Connect routes | Move scraped profiles through ownership, suppression, return, and payout readiness |
| Artist refresh hygiene | `scripts/lib/artist-refresh-status.mjs` and `src/lib/artist-visibility.ts` | Apply auditable reachability signals and keep stale or rejected profiles out of public reads |
| Sharing | share routes and pages | Create and render addressable selected-design links |

## Primary data and infrastructure

| System | Current role |
| --- | --- |
| Firebase Auth | User identity and bearer-token verification |
| Firestore / Firebase | Session, user, and product state used by current adapters |
| Neo4j | Artist graph, profiles, styles, booking relays, and lifecycle state |
| Supabase pgvector | Semantic artist/portfolio matching |
| Google Cloud Storage | Generated assets and hosted portfolio images |
| Replicate / Vertex AI | Image-generation providers |
| Gemini / OpenRouter | Conversational and Council provider paths |
| Stripe / Stripe Connect | Booking fees, deposits, artist onboarding, transfers, subscriptions |
| Google Calendar | Free/busy checks and TatT-created booking events |
| Vercel | Canonical Next.js deployment and cron scheduling |

## Important seams

### Design conversation

Callers should depend on the exported conversation interface and types, not
internal provider, persona, confidence, or demo adapters. The engine chooses
normal and degraded behavior internally.

### Generation

Callers request tattoo directions without selecting Replicate or Vertex
directly. Provider choice and fallback belong inside generation.

The render text guard reads words from the image, then decides whether the
request asked for them. `TYPESAFE_LETTERING` defaults off. When it is on, a
TypeSafe Noul at or above 0.7 means the request asked for lettering, a Noul
at or below 0.3 means it did not, and the band between them keeps the keyword
check. A missing key, timeout, error, or denied budget also keeps the keyword
check. Live model quality for that Noul is unmeasured.

The design-session orchestrator passes the full intake style set into routing,
pins one resulting model for the session, and records each image actually
purchased. Named multi-character briefs are treated as composition problems:
Council locks the exact roster, verified character-to-source bindings,
requested interaction, and signature-prop ownership while varying four
ensemble-safe layouts. The same identity clause also accompanies a single IP
character. Every brief receives the same contract from structured intake; no
franchise has a generation-code branch. The generated character catalog
enriches recognized names with series and visual context when available, while
provider-extracted bindings are accepted only when both the character and its
source are grounded in the customer's words. Multi-source requests additionally
require catalog corroboration per character; an uncorroborated name stays in the
cast without an invented or potentially swapped source binding. Every
design-session provider result is transport only; reveal, critique, and refine
images are copied into product-owned Google Cloud Storage at deterministic,
retry-safe paths before the session persists them. This durability guarantee
is scoped to the design-session pipeline, not every legacy generation route.
Storage clients share one credential resolver: Vercel reads service-account
JSON or split credentials from environment variables, while local development
may continue to use a credential file.

### Booking and calendar

Booking decides whether a request can reserve a real slot or must remain a
request. Google Calendar is an adapter supplying busy intervals and receiving
TatT-created events; it is not the booking source of truth.

### Artist lifecycle

Public discovery, matching, hosted images, claims, deposits, takedown, and
reinstatement all touch artist state. Documentation must treat this as one
lifecycle even though the implementation currently spans routes and graph
helpers.

### Artist freshness and public visibility

[ADR 0034](../adr/0034-artist-refresh-suppression.md) makes stale and classifier
suppression reversible graph state rather than deletion. Three consecutive
confirmed dead/private observations suppress a profile; active evidence
restores it, and transient failures do not change visibility. Roster, profile,
featured, and matching reads use the shared predicate in
`src/lib/artist-visibility.ts`. The dry-run-first applier refuses ambiguous
identity matches and does not write artist-managed profile, ownership,
verification, payment, or portfolio fields. The upstream paid discovery and
refresh runners are dry-run by default and require an explicit queue and
sweep ID. Discovery caches actor output only after terminal success. Refresh
gives each sweep one dead-threshold vote per handle and lets confirmed retries
replace transient results. Both paths checkpoint paid-attempt evidence before
actor POST; refresh also checkpoints downstream effects. Shared ledger, audit,
and cost-report updates are serialized across workers.

## Known architecture debt

- Multiple design and matching routes implement overlapping journeys.
- Matching does not yet present one small, stable module interface.
- Artist lifecycle logic spans several route families.
- Legacy and current services coexist in `src/services`.
- Some repository-level instructions still reference the pre-App-Router
  structure.

## Structural evidence

The existing Graphify snapshot identified the principal communities around
design conversation, intake, design session, generation, placement preview,
matching, booking holds, Stripe, artist calendar, claims, takedown,
reinstatement, sharing, auth, storage, and observability. Graph edges were used
as a navigation aid; claims in this document were verified against source
files at the snapshot commit.

Focused infrastructure evidence:

- Identity: `src/lib/api-auth.ts`, `src/lib/firebase-admin.ts`, and
  `src/lib/api-route-security.test.ts`
- Neo4j artist and lifecycle state: `src/lib/artists-graph.ts`,
  `src/lib/takedown-graph.ts`, `src/lib/reinstatement-graph.ts`,
  `src/lib/artist-visibility.ts`, and `scripts/lib/artist-refresh-status.mjs`
- Semantic matching: `src/config/vectorDbConfig.js` and
  `src/app/api/v1/match/semantic/route.ts`
- Storage: `src/services/storage/index.ts` and
  `src/services/storage/imageStorageService.ts`
- Image and language providers: `src/services/generation/`,
  `src/services/designConversation/internal/providers.ts`, and
  `src/services/council/`
- Stripe booking and Connect: `src/app/api/checkout/route.ts`,
  `src/app/api/webhooks/stripe/route.ts`, and
  `src/app/api/checkout/route.test.ts`
- Calendar: `src/lib/artist-calendar.ts` and
  `src/lib/artist-calendar.test.ts`
- AR mirror: `src/app/visualize/page.tsx`, `src/features/ar/`, and
  `src/services/ar/arService.js`, honestly scoped by
  [ADR 0024](../adr/0024-live-ar-is-untracked.md)
- Vercel cron: `vercel.json` and
  `src/app/api/cron/expire-deposits/route.ts`
