import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

const ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',').map((o) => o.trim()).filter(Boolean)
  : ['http://localhost:5173', 'http://localhost:3000', 'http://localhost:3001'];

// Host canonicalization (TAT-46, docs/brand/two-door-brand-guide.md):
// image2ink.com is a one-page marketing door into TattTester, and tatt-t.com
// is retired in favor of tatttester.com. Hosts are env-configurable but
// defaulted so production needs no configuration. Any host that matches
// neither (localhost, 127.0.0.1, *.vercel.app previews, custom dev hosts)
// passes through untouched.
const RETIRED_HOSTS = ['tatt-t.com'];

function image2inkHost(): string {
  return (process.env.IMAGE2INK_HOST ?? 'image2ink.com').toLowerCase();
}

function canonicalHost(): string {
  return (process.env.CANONICAL_HOST ?? 'tatttester.com').toLowerCase();
}

/** Lowercase, strip the port, and fold www. into the apex. */
function normalizeHost(raw: string | null): string {
  if (!raw) return '';
  const host = raw.split(':')[0].toLowerCase();
  return host.startsWith('www.') ? host.slice(4) : host;
}

export async function proxy(request: NextRequest) {
  const { pathname, search } = request.nextUrl;
  const rawHost = (request.headers.get('host') ?? request.nextUrl.host)
    .split(':')[0]
    .toLowerCase();
  const host = normalizeHost(rawHost);

  // www.* is a duplicate indexable origin (#81): 301 it to the apex. This
  // must run before the image2ink root rewrite so www.image2ink.com/
  // redirects to the apex instead of serving the door. Localhost and
  // *.vercel.app previews never carry a www prefix, so they fall through.
  if (
    rawHost.startsWith('www.') &&
    (host === canonicalHost() || host === image2inkHost())
  ) {
    return NextResponse.redirect(`https://${host}${pathname}${search}`, 301);
  }

  if (host === image2inkHost()) {
    // The discovery door has exactly one page. The root serves the
    // Image2Ink landing; every other path belongs to the canonical host.
    if (pathname === '/') {
      const url = request.nextUrl.clone();
      url.pathname = '/image2ink';
      return NextResponse.rewrite(url);
    }
    return NextResponse.redirect(
      `https://${canonicalHost()}${pathname}${search}`,
      301
    );
  }

  if (RETIRED_HOSTS.includes(host)) {
    return NextResponse.redirect(
      `https://${canonicalHost()}${pathname}${search}`,
      301
    );
  }

  // CORS origin check (defense-in-depth; API Gateway may handle preflight).
  // Same-origin requests are always allowed — the browser sets Origin on
  // same-site POSTs too, and blocking them broke every custom domain
  // (tatttester.com etc.) the moment it was pointed at the app.
  if (pathname.startsWith('/api/')) {
    const origin = request.headers.get('origin');
    const sameOrigin = origin === `${request.nextUrl.protocol}//${request.nextUrl.host}`;
    if (
      origin &&
      !sameOrigin &&
      !ALLOWED_ORIGINS.includes(origin) &&
      !origin.endsWith('.vercel.app')
    ) {
      return NextResponse.json(
        { error: 'Origin not allowed', code: 'CORS_FORBIDDEN' },
        { status: 403 }
      );
    }
  }

  // Authentication is enforced by each route using Firebase ID tokens,
  // Stripe signatures, or Cloud Tasks OIDC as appropriate.
  return NextResponse.next();
}

export const config = {
  matcher: [
    // API routes: CORS check + host canonicalization.
    '/api/:path*',
    // Page routes: host canonicalization. Skips Next internals and any
    // path with a file extension (public/ assets), so a rewritten landing
    // page can still load its static chunks on the image2ink host.
    '/((?!api|_next/static|_next/image|_next/data|favicon.ico|.*\\..*).*)',
  ],
};
