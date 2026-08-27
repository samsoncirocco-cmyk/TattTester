/**
 * Environment-variable schema — the single source of truth for every
 * server-side env var this repo reads (src/, scripts/, execution/).
 *
 * Why this exists (#323 follow-up): .env.example used to be maintained by
 * hand and drifted from the code for months. Now the inventory lives HERE,
 * .env.example is GENERATED from it (`npm run env:example`), and CI fails
 * when the two disagree (`npm run env:check`). Adding or removing an env
 * read means updating this file — the drift check makes forgetting loud.
 *
 * Design rules (they preserve the app's pre-launch fail-closed posture):
 *  - MISSING values never throw. Optional integrations keep their existing
 *    per-feature degradation (Stripe routes 503, Google OAuth unset keeps
 *    artists on booking requests, budget vars fall back to defaults).
 *    `required: true` is advisory: boot validation logs a warning, nothing
 *    more — matching the startup health check's behavior, never a crash.
 *  - MALFORMED values (non-numeric int, bad URL, a bool that is neither
 *    "true" nor "false") fail loudly: at boot via src/instrumentation.ts,
 *    and at first use for call sites migrated onto the typed accessors.
 *  - Never throw at import time. All validation happens inside functions.
 *
 * Client/server split: NEXT_PUBLIC_* values are inlined into the client
 * bundle at BUILD time by Next.js, and only literal `process.env.NEXT_PUBLIC_X`
 * expressions are replaced — the dynamic lookups in this module therefore
 * work ONLY in server code. Never import these accessors from a client
 * component; declare-and-validate here covers the server's view of those
 * vars, the browser's copy is fixed at build.
 *
 * This file is plain JS (not TS) on purpose: scripts/generate-env-example.mjs
 * imports it under Node with no TypeScript loader, and src/config/ is the
 * repo's home for plain-JS config modules (vectorDbConfig.js et al).
 *
 * @typedef {Object} EnvVarSpec
 * @property {string} name         Environment variable name.
 * @property {'string'|'int'|'float'|'bool'|'url'|'enum'|'path'|'json'|'list'} type
 *                                 Shape. 'list' = comma-separated, 'json' = JSON blob,
 *                                 'path' = filesystem path. Only int/float/bool/url/enum
 *                                 are actively validated; the rest are free-form.
 * @property {boolean} required    Core-infra var the deployed app needs. Advisory:
 *                                 boot validation WARNS when unset, never throws.
 * @property {string} purpose      One-line (or short multi-line) purpose; emitted as
 *                                 the comment above the var in .env.example.
 * @property {string} [default]    Default the code applies when unset, as a string.
 * @property {string[]} [values]   Allowed values, for type 'enum'.
 * @property {string} [example]    Placeholder value emitted in .env.example ('' if absent).
 * @property {boolean} [commentedOut] Emit as a commented-out line in .env.example.
 * @property {boolean} [emit]      Set false to declare without emitting to .env.example
 *                                 (framework-set and test-only vars). Default true.
 * @property {string[]} [altNames] Alias names also read by code; a required var counts
 *                                 as present when any alias is set.
 *
 * @typedef {Object} EnvSection
 * @property {string} title        Section banner in .env.example.
 * @property {string[]} [comment]  Comment lines under the banner.
 * @property {string[]} [footer]   Comment lines after the section's vars.
 * @property {EnvVarSpec[]} vars
 */

/** Lines emitted at the very top of the generated .env.example. */
export const FILE_HEADER = [
  '# TatTester Environment Configuration',
  '#',
  '# GENERATED FILE — do not edit by hand. The source of truth is',
  '# src/config/envSchema.js; regenerate with `npm run env:example`',
  '# (CI runs `npm run env:check` and fails on drift).',
  '#',
  '# Every variable below is read by code in src/, scripts/, or execution/ unless',
  '# a comment says otherwise. Placeholder values only — never commit real secrets.',
];

/** Lines emitted at the very bottom of the generated .env.example. */
export const FILE_FOOTER = [
  '# CI/deploy-only (set as GitHub Actions secrets, never in a local .env):',
  '# CLAUDE_CODE_OAUTH_TOKEN, WIF_PROVIDER, WIF_SERVICE_ACCOUNT.',
];

/** @type {EnvSection[]} */
export const ENV_SECTIONS = [
  {
    title: 'CORE APP',
    vars: [
      {
        name: 'NEXT_PUBLIC_APP_URL', type: 'url', required: false, default: 'http://localhost:3000',
        example: 'https://tatttester.com',
        purpose: 'Public app URL used to build Stripe success/cancel/return URLs and OAuth callbacks.',
      },
      {
        name: 'NEXT_PUBLIC_BASE_URL', type: 'url', required: false,
        example: 'https://tatttester.com',
        purpose: 'Base URL for shareable design links (src/app/api/v1/designs/share/route.ts).',
      },
      {
        name: 'NEXT_PUBLIC_DEMO_MODE', type: 'bool', required: false, default: 'false',
        example: 'false',
        purpose: 'Demo mode (uses mock images instead of real API calls).',
      },
      {
        name: 'LOG_LEVEL', type: 'enum', values: ['debug', 'info', 'warn', 'error'],
        required: false, default: 'info', example: 'info',
        purpose: 'Logger level (src/lib/logger.ts): debug | info | warn | error.',
      },
      {
        name: 'ALLOWED_ORIGINS', type: 'list', required: false,
        example: 'http://localhost:3000',
        purpose: 'Allowed CORS origins (comma-separated, read by src/proxy.ts).',
      },
      {
        name: 'CANONICAL_HOST', type: 'string', required: false, default: 'tatttester.com',
        purpose: 'Canonical host redirect (src/proxy.ts, src/app/layout.tsx).',
      },
      {
        name: 'IMAGE2INK_HOST', type: 'string', required: false,
        purpose: 'Legacy image2ink host served by src/proxy.ts.',
      },
      {
        name: 'NODE_ENV', type: 'enum', values: ['development', 'production', 'test'],
        required: false, emit: false,
        purpose: 'Set by Next.js/Node — never set it in a .env file. Read as a production guard.',
      },
      {
        name: 'VERCEL', type: 'string', required: false, emit: false,
        purpose: 'Set by the Vercel platform; detected by councilService to pick defaults.',
      },
      {
        name: 'DOTENV_CONFIG_QUIET', type: 'string', required: false, emit: false,
        purpose: 'Read by dotenv inside scripts/ to silence its banner; not app config.',
      },
    ],
    footer: [
      '# Browser-to-API requests use Firebase ID tokens. Do not add a shared',
      '# NEXT_PUBLIC_* authentication secret; public variables ship to browsers.',
    ],
  },
  {
    title: 'FIREBASE',
    vars: [
      {
        name: 'NEXT_PUBLIC_FIREBASE_API_KEY', type: 'string', required: false,
        purpose: 'Client-side Firebase config (safe to expose).',
      },
      { name: 'NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN', type: 'string', required: false, purpose: '' },
      { name: 'NEXT_PUBLIC_FIREBASE_PROJECT_ID', type: 'string', required: false, purpose: '' },
      { name: 'NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET', type: 'string', required: false, purpose: '' },
      { name: 'NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID', type: 'string', required: false, purpose: '' },
      { name: 'NEXT_PUBLIC_FIREBASE_APP_ID', type: 'string', required: false, purpose: '' },
      {
        name: 'NEXT_PUBLIC_FIREBASE_DATABASE_URL', type: 'url', required: false,
        example: 'https://your-project.firebaseio.com', purpose: '',
      },
      { name: 'NEXT_PUBLIC_FIREBASE_MEASUREMENT_ID', type: 'string', required: false, purpose: '' },
      {
        name: 'FIREBASE_PROJECT_ID', type: 'string', required: false,
        purpose: 'Server-side admin config (keep secret). Either the three discrete values or\nthe full service-account JSON (src/lib/firebase-admin.ts).',
      },
      { name: 'FIREBASE_CLIENT_EMAIL', type: 'string', required: false, purpose: '' },
      { name: 'FIREBASE_PRIVATE_KEY', type: 'string', required: false, purpose: '' },
      { name: 'FIREBASE_SERVICE_ACCOUNT_JSON', type: 'json', required: false, purpose: '' },
      {
        name: 'FIREBASE_DATABASE_URL', type: 'url', required: false,
        example: 'https://your-project.firebaseio.com', purpose: '',
      },
    ],
  },
  {
    title: 'NEO4J DATABASE',
    vars: [
      {
        name: 'NEO4J_URI', type: 'url', required: true,
        example: 'bolt://localhost:7687',
        purpose: 'Bolt/Aura connection URI (src/lib/neo4j.ts).',
      },
      {
        name: 'NEO4J_USERNAME', type: 'string', required: true, altNames: ['NEO4J_USER'],
        example: 'neo4j',
        purpose: 'Both spellings are read (NEO4J_USERNAME in health checks, NEO4J_USER elsewhere).',
      },
      { name: 'NEO4J_USER', type: 'string', required: false, example: 'neo4j', purpose: '' },
      {
        name: 'NEO4J_PASSWORD', type: 'string', required: true,
        example: 'your_neo4j_password_here', purpose: '',
      },
      { name: 'NEO4J_DATABASE', type: 'string', required: false, example: 'neo4j', purpose: '' },
      {
        name: 'NEXT_PUBLIC_NEO4J_ENABLED', type: 'bool', required: false, default: 'false',
        example: 'false',
        purpose: 'Client-side match-pulse graph features (src/features/match-pulse).',
      },
      { name: 'NEXT_PUBLIC_NEO4J_ENDPOINT', type: 'url', required: false, purpose: '' },
    ],
  },
  {
    title: 'SUPABASE (Database + Vector Search)',
    vars: [
      {
        name: 'NEXT_PUBLIC_SUPABASE_URL', type: 'url', required: false,
        example: 'https://your-project.supabase.co',
        purpose: 'Project URL + anon key (src/config/vectorDbConfig.js).',
      },
      {
        name: 'NEXT_PUBLIC_SUPABASE_ANON_KEY', type: 'string', required: false,
        example: 'your_anon_key_here', purpose: '',
      },
      {
        name: 'SUPABASE_SERVICE_ROLE_KEY', type: 'string', required: false,
        example: 'your_service_role_key_here',
        purpose: 'Service role key (KEEP SECRET, server-side only) — vector embeddings, admin ops.',
      },
      {
        name: 'SUPABASE_URL', type: 'url', required: false,
        example: 'https://your-project.supabase.co',
        purpose: 'Legacy aliases still read by scripts/ (inspect-supabase-schema.js, embeddings scripts).',
      },
      { name: 'SUPABASE_ANON_KEY', type: 'string', required: false, example: 'your_anon_key_here', purpose: '' },
      { name: 'SUPABASE_SERVICE_KEY', type: 'string', required: false, example: 'your_service_role_key_here', purpose: '' },
    ],
  },
  {
    title: 'UPSTASH REDIS (Rate Limiting)',
    vars: [
      {
        name: 'UPSTASH_REDIS_REST_URL', type: 'url', required: false, commentedOut: true,
        example: 'https://your-region.upstash.io',
        purpose: 'Without these, rate limiting falls back to in-memory (fine for local dev).',
      },
      {
        name: 'UPSTASH_REDIS_REST_TOKEN', type: 'string', required: false, commentedOut: true,
        example: 'your_upstash_token_here', purpose: '',
      },
    ],
  },
  {
    title: 'GCP / VERTEX AI',
    vars: [
      {
        name: 'GCP_PROJECT_ID', type: 'string', required: true,
        altNames: ['GCLOUD_PROJECT', 'FIREBASE_PROJECT_ID', 'NEXT_PUBLIC_FIREBASE_PROJECT_ID'],
        purpose: 'GCP project for Vertex AI, GCS and Secret Manager (falls back to the Firebase project id).',
      },
      { name: 'GCLOUD_PROJECT', type: 'string', required: false, purpose: '' },
      {
        name: 'GCP_REGION', type: 'string', required: false, default: 'us-central1',
        example: 'us-central1', purpose: '',
      },
      {
        name: 'GOOGLE_APPLICATION_CREDENTIALS', type: 'path', required: false,
        purpose: 'Path to a service-account key file, or the JSON inline (monitoring client).',
      },
      { name: 'GOOGLE_APPLICATION_CREDENTIALS_JSON', type: 'json', required: false, purpose: '' },
      { name: 'GCP_SERVICE_ACCOUNT_KEY', type: 'json', required: false, purpose: '' },
      {
        name: 'GCP_SERVICE_ACCOUNT_EMAIL', type: 'string', required: false,
        purpose: 'Edge-runtime auth (src/lib/google-auth-edge.ts).',
      },
      { name: 'GCP_PRIVATE_KEY', type: 'string', required: false, purpose: '' },
      {
        name: 'GCP_STORAGE_BUCKET', type: 'string', required: false,
        purpose: 'Storage buckets for generated images and layers (all three names are read;\ndefault tatt-pro-assets).',
      },
      { name: 'GCS_BUCKET', type: 'string', required: false, purpose: '' },
      {
        name: 'GCS_BUCKET_NAME', type: 'string', required: true, default: 'tatt-pro-assets',
        altNames: ['GCS_BUCKET', 'GCP_STORAGE_BUCKET'], purpose: '',
      },
      {
        name: 'GCS_SIGNED_URL_EXPIRY', type: 'int', required: false, default: '3600',
        example: '3600',
        purpose: 'Signed URL expiry in seconds (src/services/gcs-service.ts).',
      },
      {
        name: 'VERTEX_PROJECT_ID', type: 'string', required: false,
        purpose: 'Vertex project for design-conversation providers.',
      },
      { name: 'NEXT_PUBLIC_VERTEX_AI_PROJECT_ID', type: 'string', required: false, purpose: '' },
      {
        name: 'VERTEX_SEGMENTATION_ENDPOINT_ID', type: 'string', required: false,
        purpose: 'Deployed segmentation endpoint id (src/lib/segmentation.ts).',
      },
      {
        name: 'CLOUD_RUN_URL', type: 'url', required: false,
        purpose: 'Read only by scripts/deploy-api-gateway.sh (deployment-only).',
      },
    ],
  },
  {
    title: 'AI GENERATION — models & providers',
    comment: ['# Routing between providers lives in src/config/modelRoutingRules.js.'],
    vars: [
      {
        name: 'REPLICATE_API_TOKEN', type: 'string', required: false, commentedOut: true,
        example: 'r8_your_token_here',
        purpose: 'Replicate (server-side only). Both names are read; TOKEN is canonical.',
      },
      {
        name: 'REPLICATE_API_KEY', type: 'string', required: false, commentedOut: true,
        example: 'r8_your_token_here', purpose: '',
      },
      {
        name: 'OPENROUTER_API_KEY', type: 'string', required: false, commentedOut: true,
        example: 'sk-or-your_key_here',
        purpose: 'OpenRouter — https://openrouter.ai/keys',
      },
      {
        name: 'OPENROUTER_SITE_URL', type: 'url', required: false,
        example: 'https://tatttester.com', purpose: '',
      },
      {
        name: 'COUNCIL_API_URL', type: 'url', required: false,
        example: 'http://localhost:8001/api',
        purpose: 'LLM Council (src/services/council).',
      },
      {
        name: 'NEXT_PUBLIC_COUNCIL_API_URL', type: 'url', required: false,
        example: 'http://localhost:8001/api', purpose: '',
      },
      {
        name: 'NEXT_PUBLIC_COUNCIL_DEMO_MODE', type: 'bool', required: false, default: 'true',
        example: 'true',
        purpose: 'Demo mode uses mock prompts without a council backend.',
      },
      {
        name: 'COUNCIL_USE_OPENROUTER', type: 'bool', required: false, default: 'false',
        example: 'false', purpose: '',
      },
      {
        name: 'NEXT_PUBLIC_USE_OPENROUTER', type: 'bool', required: false, default: 'false',
        example: 'false', purpose: '',
      },
      {
        name: 'COUNCIL_VERTEX_AI_ENABLED', type: 'bool', required: false, default: 'true',
        example: 'false',
        purpose: 'Default-on: anything but "false" enables the Vertex lane.',
      },
      {
        name: 'NEXT_PUBLIC_VERTEX_AI_ENABLED', type: 'bool', required: false, default: 'true',
        example: 'false', purpose: '',
      },
      {
        name: 'GEMINI_MODEL', type: 'string', required: false, default: 'gemini-2.5-flash',
        purpose: 'Model overrides (defaults live in code).',
      },
      { name: 'CONVERSATION_MODEL', type: 'string', required: false, purpose: '' },
      {
        name: 'INTAKE_EXTRACTION_MODEL', type: 'string', required: false,
        default: 'google/gemini-2.5-flash', purpose: '',
      },
      {
        name: 'VERTEX_IMAGE_MODEL', type: 'string', required: false,
        default: 'gemini-3.1-flash-image', example: 'gemini-3.1-flash-image',
        purpose: 'Image model for the Vertex generation adapter\n(src/services/generation/internal/vertexImagen.ts — calls Gemini image models).',
      },
      {
        name: 'VERTEX_IMAGE_COST_USD', type: 'float', required: false, default: '0.039',
        purpose: 'Per-image list price fed to cost telemetry (not a billing path).',
      },
      {
        name: 'IMAGEN_REPLICATE_SLUG', type: 'string', required: false,
        purpose: 'Used only by scripts/renderLanes.mjs.',
      },
      { name: 'IMAGEN_REPLICATE_COST_USD', type: 'float', required: false, purpose: '' },
      {
        name: 'RENDER_TEXT_GUARD', type: 'bool', required: false, default: 'true',
        commentedOut: true, example: 'false',
        purpose: "Render text guard (#297/#305): screens every design-session render for\nlettering the request did not ask for, re-rolling once if found. Costs one\nvision call per image plus the occasional re-roll render. ON by default\nsince the ADR-0048 routing switch (#318 measured 2/20 unsolicited\nlettering on the cast lane); set 'false' to opt out.",
      },
      { name: 'TEXT_GUARD_MODEL', type: 'string', required: false, purpose: '' },
      {
        name: 'TEXT_GUARD_LIVE', type: 'string', required: false, emit: false,
        purpose: "Test-only opt-in ('1') for the live text-guard vitest suite.",
      },
      {
        name: 'TEXT_GUARD_SAMPLE_PNG', type: 'path', required: false, emit: false,
        purpose: 'Test-only sample image path for the live text-guard vitest suite.',
      },
      {
        name: 'STENCIL_DERIVATION_ENABLED', type: 'bool', required: false, default: 'false',
        example: 'false',
        purpose: 'Stencil derivation (src/services/designSession/internal/stencil.ts).',
      },
      { name: 'STENCIL_PROMPT_STRENGTH', type: 'float', required: false, purpose: '' },
      {
        name: 'STYLE_ONTOLOGY_PATH', type: 'path', required: false,
        purpose: 'Optional override for the style ontology file (design conversation).',
      },
    ],
  },
  {
    title: 'VISION — reference-image analysis (TAT-50)',
    vars: [
      {
        name: 'VISION_MODEL', type: 'string', required: false, default: 'gemini-2.5-flash',
        example: 'gemini-2.5-flash',
        purpose: 'Vertex Gemini model for reading reference images (SMS media + web uploads).',
      },
      {
        name: 'VISION_ANALYSIS_COST_CENTS', type: 'int', required: false, default: '1',
        example: '1',
        purpose: 'Flat cents recorded per analyzed image against the global budget (default 1 —\na deliberate over-estimate; the real Gemini Flash call is a fraction of a cent).',
      },
    ],
  },
  {
    title: 'BUDGET CONTROLS (src/lib/budget-tracker.ts)',
    vars: [
      {
        name: 'BUDGET_MAX_SPEND_CENTS', type: 'int', required: false, default: '50000',
        example: '50000',
        purpose: 'Global hard cap on AI spend, in cents. Generation stops when exhausted.',
      },
      {
        name: 'CONVERSATION_TURNS_PER_CENT', type: 'int', required: false, default: '10',
        purpose: 'Conversation turns metered per cent of budget.',
      },
      {
        name: 'VERTEX_IMAGEN_COST_CENTS', type: 'int', required: false, default: '4',
        purpose: 'Flat per-operation costs recorded against the budget, in cents.',
      },
      { name: 'COUNCIL_ENHANCE_COST_CENTS', type: 'int', required: false, default: '2', purpose: '' },
      { name: 'COUNCIL_PIPELINE_COST_CENTS', type: 'int', required: false, default: '10', purpose: '' },
      { name: 'EMBEDDING_COST_CENTS', type: 'int', required: false, default: '1', purpose: '' },
      { name: 'ESTIMATE_COST_CENTS', type: 'int', required: false, default: '3', purpose: '' },
      { name: 'LAYER_DECOMPOSE_BASE_COST_CENTS', type: 'int', required: false, default: '1', purpose: '' },
      { name: 'LAYER_DECOMPOSE_MASK_COST_CENTS', type: 'int', required: false, default: '2', purpose: '' },
      {
        name: 'STUDIO_FIX_ALLOWANCE', type: 'int', required: false, default: '25',
        purpose: 'Free re-render ("fix") allowance per studio session (src/lib/studio-fix-allowance.ts).',
      },
      { name: 'NEXT_PUBLIC_STUDIO_FIX_ALLOWANCE', type: 'int', required: false, default: '25', purpose: '' },
    ],
  },
  {
    title: 'STRIPE — Payments, Connect, Billing, Tax, Invoicing, Radar',
    vars: [
      {
        name: 'STRIPE_SECRET_KEY', type: 'string', required: false,
        example: 'sk_test_PLACEHOLDER',
        purpose: 'Server-side secret key (test: sk_test_...); server only — routes fail closed (503) if unset/placeholder.',
      },
      {
        name: 'NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY', type: 'string', required: false,
        example: 'pk_test_PLACEHOLDER',
        purpose: 'Publishable key — safe to expose (Stripe.js). Documented but not yet\nread by code (reserved for client-side Stripe.js / embedded components).',
      },
      {
        name: 'STRIPE_WEBHOOK_SECRET', type: 'string', required: false,
        example: 'whsec_PLACEHOLDER',
        purpose: 'Webhook signing secret for the main endpoint (whsec_...). Placeholder → webhook fails closed (503).',
      },
      {
        name: 'STRIPE_CONNECT_WEBHOOK_SECRET', type: 'string', required: false,
        purpose: 'Optional: separate signing secret if Connect events use their own webhook endpoint.',
      },
      {
        name: 'STRIPE_WEBHOOK_ALLOW_PLACEHOLDER', type: 'bool', required: false, default: 'false',
        example: 'false',
        purpose: 'Non-prod ONLY escape hatch to accept unverified webhooks (never set in production).',
      },
      {
        name: 'PLATFORM_FEE_BPS', type: 'int', required: false, default: '1000',
        example: '1000',
        purpose: 'Platform take-rate on marketplace transactions, in basis points (1000 = 10%).',
      },
      {
        name: 'STRIPE_PRICE_ARTIST_SUB', type: 'string', required: false,
        purpose: 'Recurring Price id for the artist SaaS subscription (price_...). Create in the Stripe dashboard.',
      },
      {
        name: 'STRIPE_PRICE_CONSUMER_CREDITS', type: 'string', required: false,
        purpose: 'Price id for consumer credit packs (src/app/api/v1/billing/credits/route.ts).',
      },
      {
        name: 'STRIPE_CURRENCY', type: 'string', required: false, default: 'usd',
        example: 'usd',
        purpose: 'Currency for charges/invoices (default usd).',
      },
      {
        name: 'DEPOSIT_HOLD_DAYS', type: 'int', required: false, default: '7',
        example: '7',
        purpose: "Days a deposit for an unclaimed artist is held before it's auto-refunded (default 7).",
      },
      {
        name: 'CRON_SECRET', type: 'string', required: false,
        purpose: 'Bearer secret the Vercel cron uses to authenticate the scheduled endpoints (expire-deposits, session-review).',
      },
    ],
  },
  {
    title: 'GOOGLE CALENDAR — per-artist availability sync (docs/google-calendar-setup.md)',
    vars: [
      {
        name: 'GOOGLE_OAUTH_CLIENT_ID', type: 'string', required: false,
        example: 'your-client-id.apps.googleusercontent.com',
        purpose: 'OAuth client id — unset ⇒ every artist stays on booking requests.',
      },
      {
        name: 'GOOGLE_OAUTH_CLIENT_SECRET', type: 'string', required: false,
        purpose: 'OAuth client secret — server only.',
      },
      {
        name: 'CALENDAR_TOKEN_ENCRYPTION_KEY', type: 'string', required: false,
        purpose: "base64 of 32 random bytes; seals every artist's refresh token.",
      },
      {
        name: 'GOOGLE_CALENDAR_WRITE_ENABLED', type: 'bool', required: false, default: 'false',
        example: 'false',
        purpose: 'Write-back to an app-created calendar; false everywhere until deliberate.',
      },
    ],
  },
  {
    title: 'INSTAGRAM — artist-authorized portfolios',
    comment: [
      '# Create/configure the Meta app in the Instagram API product, and allow:',
      '#   https://tatttester.com/api/v1/artist/instagram/callback',
      '# The secret is server-only. Never prefix it with NEXT_PUBLIC_.',
    ],
    vars: [
      { name: 'INSTAGRAM_APP_ID', type: 'string', required: false, purpose: '' },
      { name: 'INSTAGRAM_APP_SECRET', type: 'string', required: false, purpose: '' },
    ],
  },
  {
    title: 'PORTFOLIO DISPLAY FLAGS',
    vars: [
      {
        name: 'SHOW_UNCLAIMED_PORTFOLIOS', type: 'bool', required: false, default: 'true',
        example: 'true',
        purpose: 'Kill switch for displaying scraped portfolio images (TAT-31).\nServer-side only (deliberately NOT NEXT_PUBLIC_). Unset or any value other\nthan "false" = current behavior (images shown). Set to "false" to stop\ndisplaying portfolio images for UNCLAIMED artists everywhere (roster cards,\nartist profiles, match results); claimed artists\' images always show.\nFlipping this is a counsel/human decision. See src/lib/portfolio-display.ts.',
      },
      {
        name: 'ENABLE_IG_EMBEDS', type: 'bool', required: false, default: 'false',
        example: 'false',
        purpose: "Instagram embed tier for unclaimed artists (TAT-40).\nServer-side only (deliberately NOT NEXT_PUBLIC_). Default off: only the\nliteral \"true\" enables. When on, an UNCLAIMED artist's profile page (and\nonly the profile page — card grids never mount iframes) renders official\nInstagram embeds from the permalinks on the :Artist node instead of hosted\nscraped copies; the media stays served by Meta, nothing is cached on TatT.\nClaimed artists always show their licensed hosted images instead.\nSee src/lib/portfolio-display.ts and src/components/punk/InstagramEmbed.tsx.",
      },
    ],
  },
  {
    title: 'TWILIO — SketchBot SMS channel (TAT-49, docs/sketchbot-sms-setup.md)',
    vars: [
      {
        name: 'SKETCHBOT_SMS_ENABLED', type: 'bool', required: false, default: 'false',
        example: 'false',
        purpose: 'Master flag: anything but "true" makes /api/webhooks/twilio answer 404.',
      },
      {
        name: 'TWILIO_ACCOUNT_SID', type: 'string', required: false,
        purpose: 'Account SID (AC...). Server-side only.',
      },
      {
        name: 'TWILIO_AUTH_TOKEN', type: 'string', required: false,
        purpose: 'Auth token — verifies X-Twilio-Signature (required; API keys cannot substitute here).',
      },
      {
        name: 'TWILIO_PHONE_NUMBER', type: 'string', required: false,
        purpose: 'Purchased number, E.164. Outbound sender when no Messaging Service is set.',
      },
      {
        name: 'TWILIO_WEBHOOK_URL', type: 'url', required: false,
        example: 'https://tatttester.com/api/webhooks/twilio',
        purpose: "The EXACT webhook URL configured on the number/Messaging Service — the\nsignature is HMAC'd over this string byte-for-byte, so it must match the\nTwilio console verbatim (scheme, host, path, no trailing slash). Unset ⇒\nderived from NEXT_PUBLIC_APP_URL + /api/webhooks/twilio.",
      },
      {
        name: 'TWILIO_MESSAGING_SERVICE_SID', type: 'string', required: false,
        purpose: 'Optional Messaging Service SID (MG...) — replaces "from" on sends.',
      },
      {
        name: 'TWILIO_API_KEY_SID', type: 'string', required: false,
        purpose: 'Optional API key pair for outbound sends (falls back to the auth token).',
      },
      { name: 'TWILIO_API_KEY_SECRET', type: 'string', required: false, purpose: '' },
      {
        name: 'SKETCHBOT_SMS_REVEALS_PER_DAY', type: 'int', required: false, default: '2',
        example: '2',
        purpose: 'Spend guardrails (env-tunable; see the setup doc for the math).',
      },
      { name: 'SKETCHBOT_SMS_FREE_REVEALS', type: 'int', required: false, default: '2', example: '2', purpose: '' },
      { name: 'SKETCHBOT_SMS_MSGS_PER_HOUR', type: 'int', required: false, default: '30', example: '30', purpose: '' },
      {
        name: 'SKETCHBOT_SMS_ALLOW_UNSIGNED', type: 'bool', required: false, default: 'false',
        example: 'false',
        purpose: 'Non-prod ONLY escape hatch to accept unsigned webhooks (never set in production).',
      },
      {
        name: 'NEXT_PUBLIC_SKETCHBOT_SMS_NUMBER', type: 'string', required: false,
        purpose: 'Published SketchBot number rendered on the site (public, not a secret).',
      },
    ],
  },
  {
    title: 'EMAIL (Resend — src/services/emailQueueService.js)',
    vars: [
      { name: 'RESEND_API_KEY', type: 'string', required: false, purpose: '' },
      { name: 'EMAIL_FROM', type: 'string', required: false, purpose: '' },
      { name: 'EMAIL_WEBHOOK_URL', type: 'url', required: false, purpose: '' },
      {
        name: 'OPS_NOTIFY_EMAIL', type: 'string', required: false, default: 'support@tatttester.com',
        purpose: 'Ops inbox notified about new artist intros.',
      },
    ],
  },
  {
    title: 'SCRIPTS / DATA ACQUISITION (not needed to run the app)',
    vars: [
      {
        name: 'GOOGLE_PLACES_API_KEY', type: 'string', required: false,
        purpose: 'scripts/data_acquisition crawlers.',
      },
      { name: 'BROWSERACT_API_KEY', type: 'string', required: false, purpose: '' },
      { name: 'CRAWLER_LIMIT', type: 'int', required: false, purpose: '' },
      { name: 'CRAWLER_TOTAL_LIMIT', type: 'int', required: false, purpose: '' },
      {
        name: 'APIFY_TOKEN', type: 'string', required: false,
        purpose: 'execution/ Python scrapers.',
      },
      {
        name: 'DEBUG_EMBEDDINGS', type: 'bool', required: false, default: 'false',
        purpose: 'Verbose logging in the embedding scripts (scripts-only).',
      },
      {
        name: 'CAST_CLAUSE', type: 'string', required: false,
        purpose: 'Optional Cypher clause override for scripts/castCorpus.mjs (scripts-only).',
      },
      {
        name: 'VITE_SUPABASE_URL', type: 'url', required: false,
        purpose: 'Legacy embedding scripts (scripts/generate-portfolio-embeddings.js,\nscripts/inject-supabase-data.js) still read these VITE_-prefixed names.',
      },
      { name: 'VITE_PROXY_URL', type: 'url', required: false, purpose: '' },
      { name: 'FRONTEND_AUTH_TOKEN', type: 'string', required: false, purpose: '' },
      { name: 'VITE_FRONTEND_AUTH_TOKEN', type: 'string', required: false, purpose: '' },
    ],
  },
];

/**
 * Flat name → spec index over every declared variable.
 * @type {Map<string, EnvVarSpec>}
 */
export const ENV_SCHEMA = new Map(
  ENV_SECTIONS.flatMap((section) => section.vars).map((spec) => [spec.name, spec]),
);

/** Thrown when a variable is SET to a value its declared type cannot parse. */
export class EnvVarError extends Error {
  /**
   * @param {string} name
   * @param {string} message
   */
  constructor(name, message) {
    super(`Invalid environment variable ${name}: ${message}`);
    this.name = 'EnvVarError';
    this.varName = name;
  }
}

/** @param {string} name @returns {EnvVarSpec} */
function specFor(name) {
  const spec = ENV_SCHEMA.get(name);
  if (!spec) {
    // A typo'd accessor call is a programming error — fail loudly in dev/tests.
    throw new EnvVarError(name, 'not declared in src/config/envSchema.js');
  }
  return spec;
}

/**
 * Parse one raw string per the spec's type. Throws EnvVarError on malformed
 * input; never called for unset values.
 * @param {EnvVarSpec} spec
 * @param {string} raw
 * @returns {string|number|boolean}
 */
function parseValue(spec, raw) {
  switch (spec.type) {
    case 'int': {
      const n = Number(raw.trim());
      if (!Number.isInteger(n)) throw new EnvVarError(spec.name, `expected an integer, got "${raw}"`);
      return n;
    }
    case 'float': {
      const n = Number(raw.trim());
      if (!Number.isFinite(n)) throw new EnvVarError(spec.name, `expected a number, got "${raw}"`);
      return n;
    }
    case 'bool': {
      const v = raw.trim();
      if (v === 'true') return true;
      if (v === 'false') return false;
      throw new EnvVarError(spec.name, `expected "true" or "false", got "${raw}"`);
    }
    case 'url': {
      try {
        new URL(raw.trim());
        return raw.trim();
      } catch {
        throw new EnvVarError(spec.name, `expected a URL, got "${raw}"`);
      }
    }
    case 'enum': {
      const v = raw.trim();
      if (!spec.values || !spec.values.includes(v)) {
        throw new EnvVarError(spec.name, `expected one of ${(spec.values || []).join(' | ')}, got "${raw}"`);
      }
      return v;
    }
    default:
      return raw; // string | path | json | list — free-form
  }
}

/**
 * Read a declared variable: unset/empty → parsed default (or undefined),
 * set-but-malformed → EnvVarError. Repo convention: empty string counts as
 * unset (`||` semantics), because that is how every hand-rolled read behaved.
 * @param {string} name
 * @param {Record<string, string|undefined>} [env]
 * @returns {string|number|boolean|undefined}
 */
export function readEnv(name, env = process.env) {
  const spec = specFor(name);
  const raw = env[name];
  if (raw === undefined || raw === '') {
    return spec.default === undefined ? undefined : parseValue(spec, spec.default);
  }
  return parseValue(spec, raw);
}

/** @param {string} name @param {Record<string, string|undefined>} [env] @returns {string|undefined} */
export function envString(name, env = process.env) {
  const value = readEnv(name, env);
  return value === undefined ? undefined : String(value);
}

/** @param {string} name @param {Record<string, string|undefined>} [env] @returns {number|undefined} */
export function envInt(name, env = process.env) {
  const value = readEnv(name, env);
  return /** @type {number|undefined} */ (value);
}

/** @param {string} name @param {Record<string, string|undefined>} [env] @returns {number|undefined} */
export function envFloat(name, env = process.env) {
  const value = readEnv(name, env);
  return /** @type {number|undefined} */ (value);
}

/** @param {string} name @param {Record<string, string|undefined>} [env] @returns {boolean} */
export function envBool(name, env = process.env) {
  const value = readEnv(name, env);
  return value === true;
}

/**
 * Validate the whole environment against the schema.
 *
 * - errors: variables SET to malformed values. The boot hook throws on these.
 * - warnings: required core-infra vars (and all their aliases) unset. Advisory
 *   only — missing values keep the per-feature fail-closed behavior.
 *
 * @param {Record<string, string|undefined>} [env]
 * @returns {{ errors: string[], warnings: string[] }}
 */
export function validateEnv(env = process.env) {
  const errors = [];
  const warnings = [];
  for (const spec of ENV_SCHEMA.values()) {
    const raw = env[spec.name];
    if (raw !== undefined && raw !== '') {
      try {
        parseValue(spec, raw);
      } catch (err) {
        errors.push(err instanceof Error ? err.message : String(err));
      }
    } else if (spec.required) {
      const aliasSet = (spec.altNames || []).some((alias) => env[alias]);
      if (!aliasSet) {
        warnings.push(
          `${spec.name} is not set (${spec.purpose.split('\n')[0] || 'core infrastructure'}) — dependent features stay disabled`,
        );
      }
    }
  }
  return { errors, warnings };
}
