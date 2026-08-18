# TatT

TatT is a pre-launch tattoo decision and booking platform. It combines
conversational intake, AI-generated tattoo directions, placement review,
artist matching, booking, deposits, and artist operations in one Next.js
application.

Live at [https://tatttester.com](https://tatttester.com) — the one canonical
origin. image2ink.com is the one-page discovery door, and tatt-t.com 301s to
tatttester.com.

## Start here

- [Current product](docs/product/current-product.md)
- [Customer journeys](docs/product/customer-journeys.md)
- [Architecture](docs/architecture/current-architecture.md)
- [Feature ledger](docs/status/features.yaml)
- [Pitch facts](docs/product/pitch-facts.md)
- [Documentation map](docs/README.md)

These documents distinguish repository implementation, accepted decisions,
and production or operational proof.

## Current state

- Pre-launch operator state is recorded and qualified in
  [pitch facts](docs/product/pitch-facts.md).
- The repository contains real generation, design-session, placement,
  matching, booking, Stripe Connect, availability, calendar, takedown, and
  reinstatement paths.
- The launch convergence in ADR-0028–0031 is materially implemented:
  `/design` is the one door, matching flows through `/smart-match` and
  `/swipe`, pricing states the launch model, and artists land at `/console`.
- Compatibility routes redirect into that spine; `/generate` remains the
  intentional Studio editing room.

See [known contradictions](docs/status/known-contradictions.md) before reusing
brand, fundraising, market, artist-count, image-count, or traction claims.

## Quick start

Requirements:

- Node.js 20 or newer, as required by `package.json`
- Service credentials for non-demo provider paths

```bash
npm install --legacy-peer-deps
cp .env.example .env.local
npm run dev
```

Open `http://localhost:3000`.

Useful commands:

```bash
npm test                 # Vitest
npm run lint             # ESLint
npm run build            # Next production build (webpack)
npm run security:secrets # Scan tracked files for committed secrets
```

## Primary product modules

| Module | Interface |
| --- | --- |
| Intake | `src/services/intake/index.ts` |
| Design conversation | `src/services/designConversation/index.ts` |
| Design session | `src/services/designSession/index.ts` |
| Generation | `src/services/generation/index.ts` |
| Council | `src/services/council/index.ts` |
| Storage | `src/services/storage/index.ts` |
| AR mirror | `src/features/ar/` and `src/app/visualize/page.tsx` |
| Matching | `src/app/api/v1/match/` and matching feature modules |
| Booking | booking routes, `src/lib/scheduling-engine.ts`, and checkout |
| Artist calendar | `src/lib/artist-calendar.ts` |
| Artist lifecycle | claim, Connect, takedown, and reinstatement routes |

## Repository map

```text
src/app/          Next.js pages and route adapters
src/features/     Product UI modules
src/services/     Product modules and provider adapters
src/lib/          Shared booking, identity, data, and infrastructure logic
src/store/        Client state
docs/adr/         Durable product and architecture decisions
docs/status/      Built-vs-decided reconciliation
docs/product/     Current product narrative and claim controls
docs/architecture Current module map
directives/       Operational procedures
scripts/          Data, migration, verification, and maintenance tooling
```

## Important truth constraints

Use [pitch facts](docs/product/pitch-facts.md) for public claims and
[the feature ledger](docs/status/features.yaml) for implementation status.
Accepted ADRs can describe future work, so use the ledger rather than assuming
an accepted decision has landed.

## Deployment and dependencies

The application uses Vercel, Firebase, Neo4j, Supabase, Google Cloud Storage,
Replicate, Vertex AI, OpenRouter, Stripe, and Google Calendar in different
paths. Routes generally fail closed when required configuration is absent.
Consult the relevant runbook or source adapter before changing production
configuration.

## Working in this repository

- Preserve unrelated local changes.
- Use a separate worktree for substantial changes.
- Read accepted ADRs that govern the module you are changing.
- Update `docs/status/features.yaml` when a public capability or launch
  decision changes.
- Verify tests fail before fixing behavioral defects.
- Do not publish counts or traction claims copied from dated documents.
