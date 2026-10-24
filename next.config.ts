import type { NextConfig } from "next";

/**
 * Security response headers. A production self-audit of tatttester.com on
 * 2026-10-23 found HSTS and nothing else. The CSP ships as
 * Content-Security-Policy-Report-Only on purpose: it is derived from a static
 * read of what the app loads, and we have not yet watched real pages run
 * against it. Violations only show up in the browser console; nothing breaks.
 * After a soak with no unexpected violations, flip the header name to
 * Content-Security-Policy. Script/style 'unsafe-inline' stays until nonces are
 * set up (separate work). No report-uri/report-to: no report endpoint exists yet.
 */
const isDev = process.env.NODE_ENV !== "production";

const cspDirectives = [
  "default-src 'self'",
  // Next.js inline bootstrap scripts need 'unsafe-inline' without nonces.
  // Dev server (React refresh) needs eval. apis.google.com = Firebase popup auth.
  `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ""} https://apis.google.com https://vercel.live`,
  // Material Symbols stylesheet is @imported from fonts.googleapis.com.
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' data: https://fonts.gstatic.com",
  // Portfolio images are hotlinked from arbitrary https hosts.
  "img-src 'self' https: data: blob:",
  "media-src 'self' blob:",
  "worker-src 'self' blob:",
  // Firebase Auth + Firestore (cloudSync), Replicate/GCS result images fetched for canvas compositing.
  [
    "connect-src 'self' blob: data:",
    "https://identitytoolkit.googleapis.com",
    "https://securetoken.googleapis.com",
    "https://www.googleapis.com",
    "https://firestore.googleapis.com",
    "https://*.firebaseapp.com",
    "https://replicate.delivery",
    "https://storage.googleapis.com",
    "https://vercel.live",
  ].join(" "),
  // Google sign-in popup helper iframe (*.firebaseapp.com/__/auth/iframe), Vercel toolbar.
  "frame-src https://accounts.google.com https://*.firebaseapp.com https://vercel.live",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  // Stripe Checkout is reached by window.location redirect to session.url, not a form post.
  "form-action 'self'",
  "object-src 'none'",
];

const securityHeaders = [
  { key: "Content-Security-Policy-Report-Only", value: cspDirectives.join("; ") },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  // camera: AR preview. payment: no Stripe.js / Payment Request API on the client.
  { key: "Permissions-Policy", value: "camera=(self), microphone=(), geolocation=(), payment=()" },
];

const nextConfig: NextConfig = {
  poweredByHeader: false,
  async headers() {
    return [{ source: "/(.*)", headers: securityHeaders }];
  },
  // Prevent Next from inferring a higher-level monorepo root when multiple lockfiles exist.
  outputFileTracingRoot: process.cwd(),
  typescript: {
    // TEMPORARY carryover from the former next.config.js (which Next loaded in
    // preference to this file, so this flag was the one actually in effect).
    // The codebase currently has ~44 pre-existing type errors — most notably the
    // Next 15+ `params: Promise<...>` route-handler migration and a missing
    // @google-cloud/secret-manager import — that block `next build` when type
    // checking runs. Remove this once that type debt is cleared; do NOT add new
    // type errors under cover of it.
    ignoreBuildErrors: true,
  },
  // Turbopack disabled — causes PostCSS sandbox errors in this environment
  webpack: (config, { isServer }) => {
    if (!isServer) {
      config.resolve.fallback = {
        ...config.resolve.fallback,
        fs: false,
        net: false,
        tls: false,
        child_process: false,
        http2: false,
        dns: false,
        "node:http": false,
        "node:https": false,
        "node:util": false,
        "node:stream": false,
        "node:zlib": false,
        "node:url": false,
        "node:assert": false,
        "node:querystring": false,
        "node:buffer": false,
        "node:events": false,
        "node:fs": false,
        "node:net": false,
        "node:tls": false,
        "node:path": false,
        "node:process": false,
        "node:os": false,
        "node:crypto": false,
      };

      // Also ignore these modules if imported directly
      config.resolve.alias = {
        ...config.resolve.alias,
        'google-auth-library': false,
        '@google-cloud/aiplatform': false,
        '@google-cloud/vertexai': false,
        '@google-cloud/storage': false,
        '@google-cloud/vision': false,
        'firebase-admin': false,
        'neo4j-driver': false,
      };
    }
    return config;
  },
};

export default nextConfig;
