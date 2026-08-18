import { describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';
import { proxy } from './proxy';

function apiRequest(url: string, origin?: string): NextRequest {
  return new NextRequest(url, {
    method: 'POST',
    headers: origin ? { origin } : {},
  });
}

/** A plain page navigation, with the Host header a real proxy would see. */
function pageRequest(url: string, host?: string): NextRequest {
  return new NextRequest(url, {
    headers: host ? { host } : {},
  });
}

function rewriteTarget(res: Response): string | null {
  return res.headers.get('x-middleware-rewrite');
}

function isPassThrough(res: Response): boolean {
  return (
    res.status === 200 &&
    res.headers.get('location') === null &&
    rewriteTarget(res) === null
  );
}

describe('proxy CORS origin check', () => {
  it('allows same-origin requests from any custom domain', async () => {
    // Regression: custom domains (tatttester.com etc.) 403'd on every API
    // call because same-origin browser POSTs carry an Origin header.
    const res = await proxy(
      apiRequest('https://tatttester.com/api/v1/generate', 'https://tatttester.com')
    );
    expect(res.status).not.toBe(403);
  });

  it('allows *.vercel.app origins', async () => {
    const res = await proxy(
      apiRequest('https://tatt-app.vercel.app/api/v1/generate', 'https://tatt-app.vercel.app')
    );
    expect(res.status).not.toBe(403);
  });

  it('allows requests without an Origin header (curl, server-to-server)', async () => {
    const res = await proxy(apiRequest('https://tatttester.com/api/v1/generate'));
    expect(res.status).not.toBe(403);
  });

  it('still blocks cross-origin requests from unknown domains', async () => {
    const res = await proxy(
      apiRequest('https://tatttester.com/api/v1/generate', 'https://evil.example.com')
    );
    expect(res.status).toBe(403);
  });
});

describe('host routing (TAT-46)', () => {
  describe('image2ink.com — the one-page discovery door', () => {
    it('rewrites the root to the Image2Ink landing route', async () => {
      const res = await proxy(
        pageRequest('https://image2ink.com/', 'image2ink.com')
      );
      expect(rewriteTarget(res)).toContain('/image2ink');
    });

    it('301s www.image2ink.com to the apex instead of serving the door', async () => {
      const res = await proxy(
        pageRequest('https://www.image2ink.com/', 'www.image2ink.com')
      );
      expect(res.status).toBe(301);
      expect(res.headers.get('location')).toBe('https://image2ink.com/');
    });

    it('301s every other path to the canonical host, preserving path + query', async () => {
      const res = await proxy(
        pageRequest('https://image2ink.com/pricing?utm=door', 'image2ink.com')
      );
      expect(res.status).toBe(301);
      expect(res.headers.get('location')).toBe(
        'https://tatttester.com/pricing?utm=door'
      );
    });

    it('301s even its own landing route path — the landing lives at the root only', async () => {
      const res = await proxy(
        pageRequest('https://image2ink.com/image2ink', 'image2ink.com')
      );
      expect(res.status).toBe(301);
      expect(res.headers.get('location')).toBe(
        'https://tatttester.com/image2ink'
      );
    });
  });

  describe('tatt-t.com — retired domain', () => {
    it('301s the root to the canonical host', async () => {
      const res = await proxy(pageRequest('https://tatt-t.com/', 'tatt-t.com'));
      expect(res.status).toBe(301);
      expect(res.headers.get('location')).toBe('https://tatttester.com/');
    });

    it('301s deep links preserving path + query', async () => {
      const res = await proxy(
        pageRequest('https://tatt-t.com/artists/kira?ref=ig', 'tatt-t.com')
      );
      expect(res.status).toBe(301);
      expect(res.headers.get('location')).toBe(
        'https://tatttester.com/artists/kira?ref=ig'
      );
    });

    it('folds www.tatt-t.com into the same redirect', async () => {
      const res = await proxy(
        pageRequest('https://www.tatt-t.com/pricing', 'www.tatt-t.com')
      );
      expect(res.status).toBe(301);
      expect(res.headers.get('location')).toBe('https://tatttester.com/pricing');
    });
  });

  describe('www — duplicate indexable origin (#81)', () => {
    it('301s www.tatttester.com to the apex, preserving path + query', async () => {
      const res = await proxy(
        pageRequest('https://www.tatttester.com/x?q=1', 'www.tatttester.com')
      );
      expect(res.status).toBe(301);
      expect(res.headers.get('location')).toBe('https://tatttester.com/x?q=1');
    });

    it('301s the www root to the apex root', async () => {
      const res = await proxy(
        pageRequest('https://www.tatttester.com/', 'www.tatttester.com')
      );
      expect(res.status).toBe(301);
      expect(res.headers.get('location')).toBe('https://tatttester.com/');
    });
  });

  describe('hosts that must never be touched', () => {
    it('passes the canonical host through', async () => {
      const res = await proxy(
        pageRequest('https://tatttester.com/artists', 'tatttester.com')
      );
      expect(isPassThrough(res)).toBe(true);
    });

    it('passes localhost through (dev server, with port)', async () => {
      const res = await proxy(
        pageRequest('http://localhost:3000/design', 'localhost:3000')
      );
      expect(isPassThrough(res)).toBe(true);
    });

    it('passes Vercel preview deployments through', async () => {
      const res = await proxy(
        pageRequest(
          'https://tatt-app-git-branch.vercel.app/image2ink',
          'tatt-app-git-branch.vercel.app'
        )
      );
      expect(isPassThrough(res)).toBe(true);
    });

    it('leaves API requests on the canonical host alone', async () => {
      const res = await proxy(
        apiRequest('https://tatttester.com/api/v1/generate', 'https://tatttester.com')
      );
      expect(res.headers.get('location')).toBeNull();
      expect(rewriteTarget(res)).toBeNull();
    });
  });
});
