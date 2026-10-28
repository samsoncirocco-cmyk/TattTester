# Execution Manifest

Maps each directive to the scripts, services, and API routes that implement it. No files were moved — this is a reference index.

## Artist discovery and quarterly refresh

The Instagram operator path is deliberately split into three auditable stages:

1. `discover_ig.py` collects and profiles possible new handles, then writes
   every accepted and rejected candidate to `data/discovery/candidates.json`.
   It requires an explicit valid `--queue`; paid collection and profiling also
   require `--execute --sweep-id <id>`. Discovery writes its own
   `apify-discovery-run-report.json` spend ledger and caches a seed, hashtag,
   or profile chunk only after the actor reaches terminal `SUCCEEDED`.
2. `apify_ig_enrich.py` refreshes known handles. The shared
   `ig_quality.py` gate is on by default; `--no-filter` is the explicit,
   audited override. The command is dry-run by default; paid actor work
   requires `--execute` and an explicit valid `--queue`. With no `--count`,
   it processes the rest of that queue rather than a hidden default slice.
3. `scripts/host-artist-images.mjs` hosts accepted images and
   `scripts/apply-artist-refresh-status.mjs` applies the separate freshness
   ledger. The status applier is dry-run by default.

The refresh distinguishes confirmed `not_found` / `private` observations from
transient actor or network failures. Three consecutive confirmed dead
observations mark an artist stale. A confirmed active profile clears stale;
transient failures never create or clear it. One sweep ID gets one observation
per handle, so retries or overlapping workers cannot manufacture the three
dead observations. A later confirmed active/dead result in the same sweep can
replace an earlier transient result. Ledger state is checkpointed only after
the profile/quarantine/audit effects complete, and audit event IDs make crash
retries idempotent.

Rejected and confirmed-dead profile files move into the local
`apify-profiles/quarantine/` directory instead of being deleted. Every
decision is appended to `refresh-audit.jsonl`. This keeps repeated runs
idempotent without destroying review evidence.

### Classifier limits

The filter is conservative but heuristic:

- A private individual artist is rejected because enrichment cannot verify
  their current work or booking signal.
- A studio bio containing “our artists,” hiring language, or multi-artist
  booking language can reject an otherwise legitimate resident artist if the
  profile itself is a shared shop account.
- Sparse bios can pass as `tattoo-artist(weak)` when they clearly identify the
  craft but provide no booking link.
- Mixed tattoo/piercing accounts and unusually worded product promotions may
  still require manual review.

Tune the shared rules in `ig_quality.py` with focused tests. Do not silently
delete rejections or maintain a second classifier in another pipeline.

### Cadence and cost gate

There is intentionally no quarterly schedule yet. Each Apify run writes
`apify-run-report.json`, including `usageTotalUsd` when Apify supplies it.
Pass one `--sweep-id` across every batch; both discovery and refresh reports
deduplicate paid attempts
and accumulate cost rather than overwriting the prior slice. The total stays
unknown when any POST outcome is ambiguous or any identified actor run is
non-terminal or lacks pricing. The report exposes the known subtotal,
missing/non-terminal/ambiguous counts, and `incomplete` status instead of
presenting a partial sum as complete. A durable ambiguous-spend checkpoint is
written before POST and updated as soon as a run ID or terminal result exists,
so a crash cannot erase paid-attempt evidence.
After the host stage, capture GCS cost from the billing export and attach both
amounts to the run record. Only schedule the sweep after one complete,
measured run has an approved spend cap. The nightly crew runner is unrelated
and must not launch this paid job.

`enrich_all.sh`, `parallel_enrich.sh`, and the compatibility
`enrich_artists.py` entrypoint all route into the audited runner. The shell
runners require `--execute`, a stable `--sweep-id`, and an explicit queue.
The parallel wrapper treats `--workers` as concurrency and schedules slices
until the whole queue is covered. Parallel processes merge the ledger and cost
report under file locks and audit-log appends are serialized. Supply
`APIFY_TOKEN` only through the process environment; both discovery and refresh
send it in an authorization header and never place it in a URL.

Refresh/import writers may update portfolio, the audited `looksBookable`
verdict/reason, and refresh-health properties only. Artist-owned profile
fields (including `artistManagedFields` and
`profileManagedAtEpochMs`) remain authoritative and must never be overwritten
by a scrape. Instagram is immutable after identity verification, and
`claimVerificationStatus` is verification state rather than scrape data.

## Directive → Implementation Map

### `directives/generate-design.md`

| Step | Implementation |
|------|---------------|
| Council enhancement | `src/services/councilService.ts` |
| Image generation | `src/services/generationService.ts` |
| Generation model routing | `src/config/modelRoutingRules.js` |
| Vertex generation adapter (calls Gemini image models despite its name) | `src/services/generation/internal/vertexImagen.ts` |
| Multi-layer processing | `src/services/multiLayerService.js` |
| Canvas layer management | `src/services/canvasService.ts` |
| Layer management hook | `src/features/generate/hooks/useLayerManagement.ts` |
| Generation hook | `src/features/generate/hooks/useImageGeneration.js` |
| API: v1 generate | `src/app/api/v1/generate/route.ts` |
| GCP auth | `src/lib/google-auth-edge.ts` |

### `directives/council-enhance.md`

| Step | Implementation |
|------|---------------|
| Council service | `src/services/councilService.ts` |
| Character database | `src/config/characterDatabase.js` |
| Council skill pack | `src/config/councilSkillPack.js` |
| Style-model mapping | `src/utils/styleModelMapping.js` |
| Prompt templates | `src/config/promptTemplates.js` |
| Model routing rules | `src/config/modelRoutingRules.js` |
| API: council enhance | `src/app/api/v1/council/enhance/route.ts` |

### `directives/artist-matching.md`

| Step | Implementation |
|------|---------------|
| Hybrid match service | `src/features/match-pulse/services/hybridMatchService.ts` |
| Embedding service | `src/services/embeddingService.ts` |
| Vector DB service | `src/services/vectorDbService.js` |
| Neo4j service | `src/features/match-pulse/services/neo4jService.ts` |
| Score aggregation | `src/utils/scoreAggregation.js` |
| Firebase match service | `src/services/firebase-match-service.js` |
| Match service (legacy) | `src/features/match-pulse/services/matchService.js` |
| Demo match service | `src/features/match-pulse/services/demoMatchService.js` |
| Match update service | `src/features/match-pulse/services/matchUpdateService.js` |
| Real-time hook | `src/features/match-pulse/hooks/useRealtimeMatchPulse.js` |
| Artist matching hook | `src/features/match-pulse/hooks/useArtistMatching.js` |
| MatchPulse UI | `src/features/match-pulse/components/Match/MatchPulse.tsx` |
| API: semantic match | `src/app/api/v1/match/semantic/route.ts` |
| API: match update | `src/app/api/v1/match/update/route.ts` |
| Vector DB config | `src/config/vectorDbConfig.js` |
| **Scripts** | |
| Import artists to Neo4j | `scripts/import-to-neo4j.js` |
| Generate embeddings | `scripts/generate-vertex-embeddings.js` |
| Setup vector schema | `scripts/setup-supabase-vector-schema.js` |
| Inject Supabase data | `scripts/inject-supabase-data.js` |
| Migrate embeddings | `scripts/migrate-to-text-embeddings.js` |
| Test vector DB | `scripts/test-vector-db.js` |
| Test Supabase | `scripts/test-supabase-connection.js` |
| Benchmark vector search | `scripts/benchmark-vector-search.js` |
| Add sample relationships | `scripts/add-sample-relationships.js` |

### `directives/stencil-export.md`

| Step | Implementation |
|------|---------------|
| Stencil service | `src/features/stencil/services/stencilService.js` |
| Edge detection | `src/features/stencil/services/stencilEdgeService.js` |
| PDF generator | `src/utils/pdfGenerator.js` |
| Stencil calibration | `src/utils/stencilCalibration.js` |
| DPI service | `src/services/pngDpiService.js` |
| Email queue service | `src/services/emailQueueService.js` |
| StencilExport UI | `src/features/stencil/components/StencilExport.jsx` |
| API: stencil export | `src/app/api/v1/stencil/export/route.ts` |

### `directives/ar-preview.md`

| Step | Implementation |
|------|---------------|
| Camera + support check | `src/services/ar/arService.js` |
| On-skin guard + alpha strip | `src/services/ar/designSource.ts` |
| Session lifecycle | `src/features/ar/useArSession.ts` |
| Mirror UI | `src/features/ar/components/ARMirror.tsx` |
| Entry page | `src/app/visualize/page.tsx` |

No API route: the preview is entirely client-side. The depth-mapping, MindAR
and anatomical-mapping modules and `/api/v1/ar/visualize` were removed — see
`docs/adr/0024-live-ar-is-untracked.md`.

### `directives/layer-management.md`

| Step | Implementation |
|------|---------------|
| Multi-layer service | `src/services/multiLayerService.js` |
| Canvas service | `src/services/canvasService.ts` |
| Image registry | `src/services/forgeImageRegistry.ts` |
| Image load manager | `src/services/imageLoadManager.ts` |
| Layer utilities | `src/lib/layerUtils.js` |
| Layer management hook | `src/features/generate/hooks/useLayerManagement.ts` |
| ForgeCanvas UI | `src/features/generate/components/ForgeCanvas.tsx` |
| TransformHandles | `src/features/generate/components/Forge/TransformHandles.tsx` |
| Segmentation (SAM) | `src/lib/segmentation.ts` |
| Segmentation (Vertex) | `src/lib/segmentation-vertex.ts` |
| GCS service | `src/services/gcs-service.ts` |
| API: decompose | `src/app/api/v1/layers/decompose/route.ts` |
| API: upload layer | `src/app/api/v1/upload-layer/route.ts` |
| API: storage upload | `src/app/api/v1/storage/upload/route.ts` |
| API: signed URL | `src/app/api/v1/storage/get-signed-url/route.ts` |

### `directives/neo4j-queries.md`

| Step | Implementation |
|------|---------------|
| Neo4j driver | `src/lib/neo4j.ts` |
| Neo4j service | `src/features/match-pulse/services/neo4jService.ts` |
| API: Neo4j query | `src/app/api/neo4j/query/route.ts` |
| **Scripts** | |
| Import artists | `scripts/import-to-neo4j.js` |
| Generate Cypher | `scripts/generate-neo4j-cypher.js` |
| Migrate schema | `scripts/migrate-neo4j-schema.js` |
| Add relationships | `scripts/add-sample-relationships.js` |
| Sample queries | `scripts/SAMPLE_QUERIES.cypher` |

### `directives/artist-takedown.md`

Removal semantics and identity-proof decisions: `docs/adr/0025-artist-takedown-semantics.md`

| Step | Implementation |
|------|---------------|
| Domain rules (validation, tombstone keys, suppression clause) | `src/lib/takedown.ts` |
| Request persistence (`:TakedownRequest`) | `src/lib/takedown-graph.ts` |
| API: submit a request (public, removes nothing) | `src/app/api/v1/artists/takedown/route.ts` |
| Ops notification (reports failure, never swallows) | `src/lib/notify.ts` (`notifyOpsOfTakedownRequest`) |
| UI: request form | `src/app/takedown/[artistId]/page.tsx` |
| Read-path suppression | `src/lib/artists-graph.ts`, `src/features/match-pulse/services/neo4jService.ts`, `src/app/api/v1/book/route.ts`, `src/app/api/v1/connect/claim/route.ts` |
| Homepage featured grid (curated candidates, suppression-checked, fails closed) | `src/lib/featured-artists.ts` |
| Public disclosure of the scrape and the removal right (**draft, needs counsel**) | `src/app/legal/privacy/page.tsx` §4, `docs/legal/artist-data-counsel-notes.md` |
| **Scripts** | |
| Execute a takedown (dry-run by default) | `scripts/execute-takedown.mjs` |
| Planner / executor | `scripts/lib/takedown-plan.mjs` |
| Ingest tombstone gate (fails closed) | `scripts/lib/takedown-tombstone.mjs` |
| Gated ingest paths | `scripts/import-to-neo4j.js`, `scripts/host-artist-images.mjs` |

### `directives/artist-reinstatement.md`

The one door through the takedown wall: `docs/adr/0026-reinstatement-self-signup.md`.
The tombstone is **never** lifted — ingest stays permanently blocked; what opens
is a separate, identity-checked self-signup.

| Step | Implementation |
|------|---------------|
| Domain rules (validation, code TTL, refusal decision) | `src/lib/reinstatement.ts` |
| Request persistence (`:ReinstatementRequest`) | `src/lib/reinstatement-graph.ts` |
| API: submit a request (authenticated, changes nothing, reveals nothing) | `src/app/api/v1/artists/reinstate/route.ts` |
| Ops notification (leads with the check the operator must perform) | `src/lib/notify.ts` (`notifyOpsOfReinstatementRequest`) |
| **Scripts** | |
| Execute a reinstatement (dry-run by default) | `scripts/execute-reinstatement.mjs` |
| Planner / executor | `scripts/lib/reinstate-plan.mjs` |

### `directives/deploy.md`

| Step | Implementation |
|------|---------------|
| Build config | `next.config.ts` |
| Vercel config | `vercel.json` |
| TypeScript config | `tsconfig.json` |
| Docker (alt deploy) | `Dockerfile`, `docker-compose.yml` |
| Env reference | `.env.example`, `CLAUDE.md` (Environment Variables) |
| **Scripts** | |
| Verify changes | `scripts/verify-changes.sh` |
| Test Docker | `scripts/test-docker.sh` |
| Test GCP health | `scripts/test-gcp-health.js` |
| Test Supabase | `scripts/test-supabase-connection.js` |

### `directives/setup-local-dev.md`

| Step | Implementation |
|------|---------------|
| Env template | `.env.example` |
| Quick start | `QUICKSTART.sh` |
| Package config | `package.json` |
| **Scripts** | |
| Install skills | `scripts/install-skills.sh` |
| Update skills | `scripts/update-skills.sh` |
| Setup & migrate | `scripts/setup-and-migrate.sh` |
| Setup Supabase schema | `scripts/setup-supabase-vector-schema.js` |
| Quick start guide | `scripts/QUICKSTART.md` |
| Supabase setup guide | `scripts/SUPABASE_SETUP.md` |

### `directives/api-endpoints.md`

| Route Group | Implementation |
|-------------|---------------|
| Health | `src/app/api/health/route.ts` |
| Debug | `src/app/api/debug/route.ts` |
| Generate (v1) | `src/app/api/v1/generate/route.ts` |
| Council | `src/app/api/v1/council/enhance/route.ts` |
| Match semantic | `src/app/api/v1/match/semantic/route.ts` |
| Match update | `src/app/api/v1/match/update/route.ts` |
| Stencil export | `src/app/api/v1/stencil/export/route.ts` |
| Layer decompose | `src/app/api/v1/layers/decompose/route.ts` |
| Upload layer | `src/app/api/v1/upload-layer/route.ts` |
| Storage upload | `src/app/api/v1/storage/upload/route.ts` |
| Storage signed URL | `src/app/api/v1/storage/get-signed-url/route.ts` |
| Embeddings | `src/app/api/v1/embeddings/generate/route.ts` |
| Predictions | `src/app/api/predictions/route.ts` |
| Prediction status | `src/app/api/predictions/[id]/route.ts` |
| Neo4j query | `src/app/api/neo4j/query/route.ts` |
| Auth middleware | `src/lib/api-auth.ts` |
| Rate limiting | `src/lib/rate-limit.ts` |
| Observability | `src/lib/observability.ts` |

### SketchBot SMS channel (TAT-49, `docs/sketchbot-sms-setup.md`)

| Step | Implementation |
|------|---------------|
| Inbound webhook (signature-verified, flag-gated) | `src/app/api/webhooks/twilio/route.ts` |
| Channel adapter (conversation ↔ SMS, spend guardrails) | `src/services/sketchbotSms/` |
| Phone profiles + atomic reveal cap | `src/services/sketchbotSms/internal/profileStore.ts` |
| SMS rendering + channel voice | `src/services/sketchbotSms/internal/render.ts` |
| Twilio config, signature validation, sender | `src/lib/twilio.ts` |
| Per-phone rate limit (`sms-inbound`) | `src/lib/rate-limit.ts` |
| Channel diagnostics ("why didn't it reply?") | `scripts/diagnose-twilio-sms.mjs` |

### Reference-image vision (TAT-50)

| Step | Implementation |
|------|---------------|
| Shared vision analyzer (Vertex Gemini multimodal, budget-gated) | `src/services/vision/` |
| MMS media parse + fetch + analyze batch | `src/services/sketchbotSms/internal/media.ts` |
| Session reference entries + record merge (IP rule parity) | `src/services/designSession/internal/references.ts` |
| Attach seam both channels land on | `attachReference` in `src/services/designSession/` |
| Web reference upload route | `src/app/api/v1/design-session/[id]/reference/route.ts` |
| Notepad reference row | `SessionNotes.references` → `src/features/design-session/components/SketchbotNotes.tsx` |
| Budget line item | `VISION_ANALYSIS_COST_CENTS` in `src/lib/budget-tracker.ts` |

---

## Shared Infrastructure

| Module | Path | Used By |
|--------|------|---------|
| API Auth | `src/lib/api-auth.ts` | All protected routes |
| GCP Auth (Edge) | `src/lib/google-auth-edge.ts` | Council, generation, embeddings |
| Neo4j Driver | `src/lib/neo4j.ts` | Neo4j query route, match services |
| Observability | `src/lib/observability.ts` | All services (logEvent) |
| Rate Limiting | `src/lib/rate-limit.ts` | API routes |
| Performance Monitor | `src/utils/performanceMonitor.js` | Stencil, matching |
| Forge Store (Zustand) | `src/stores/useForgeStore` | All canvas/layer operations |
| Image Registry | `src/services/forgeImageRegistry.ts` | Layer image resolution |

## In-house artist discovery (`discover_inhouse.py`), an Apify replacement

This writes the same artifacts as `discover_ig.py` (`profiles.json` and `candidates.json`), so
`scripts/import-discovery-to-neo4j.mjs` works on them unchanged. The script never connects to Neo4j.
The only write path is still the importer with `--apply`.

```bash
D=data/discovery-inhouse
python3 execution/discover_inhouse.py --out $D seed-shops --states NE,IA,SD     # OSM shop=tattoo
python3 execution/discover_inhouse.py --out $D seed-shops --states NE --bbox 41.15,-96.25,41.40,-95.85  # lighter metro query
python3 execution/discover_inhouse.py --out $D crawl-shops --max 50             # shop sites: roster IGs, email, phone, tech
IG_GRAPH_USER_ID=... IG_GRAPH_TOKEN=... \
python3 execution/discover_inhouse.py --out $D enrich --provider meta           # or --provider apify --sweep-id X (paid fallback)
python3 execution/discover_inhouse.py --out $D --reference snap.json --queue queue.json filter   # dedupe + skip protected
node scripts/import-discovery-to-neo4j.mjs --input $D/candidates.json --reference snap.json      # offline dry-run plan
```

| Apify actor | In-house replacement |
|---|---|
| google-search / maps seeding | OpenStreetMap Overpass `shop=tattoo` (free, ODbL; cite OSM) |
| contact-info-scraper, rag-web-browser, tech-stack | `crawl-shops` (robots.txt, 1 req/2s per host, identified UA) |
| instagram-profile-scraper | Meta Graph `business_discovery` (business/creator accounts only) |
| followers/following scraper | bio and roster `@mention` expansion (a second enrich pass) |
| hashtag scraper | **no replacement**: the official hashtag API returns no usernames |

**Dedupe and protection.** Handles already in `--queue` or in the `--reference` snapshot are dropped,
and so are name+city matches. Artists flagged claimed, selfRegistered, removed, takedownPending,
tombstoned, or verified in the snapshot are never emitted. The importer's write query still enforces
the protected fields.

**Cost and rate limits.** OSM, the site crawl, and the Meta API are free.
- Meta allows about 200 calls per hour per token, so roughly 30k lookups a week, well above the 500–1,000 a week target.
- Public Overpass mirrors often return 502/504 or time out. The script rotates mirrors with backoff, and `--bbox` metro queries succeed more reliably than whole-state queries.
- Apify costs about $2–3 per 1k profiles plus actor fees per run.

**Why not scrape IG directly (REA findings).** A logged-out instagram.com page server-renders no profile data.
- Its only GraphQL calls are logged-out experiment and dialog queries.
- `api/v1/users/web_profile_info` returns 401 `require_login`.
- Apify gets around this with residential proxies, which this project does not use.

**Gaps.** Personal (non-business) IG accounts can't be resolved by the Meta API and land in
`profile_misses.json`. Use the Apify fallback or review them manually. OSM coverage is uneven: about half of the shops have a website.
