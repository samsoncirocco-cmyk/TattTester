import { describe, expect, it } from 'vitest';
import nextConfig from '../next.config';

async function catchAllHeaders() {
  const rules = await nextConfig.headers!();
  const rule = rules.find((r) => r.source === '/(.*)');
  expect(rule, 'catch-all header rule').toBeDefined();
  return new Map(rule!.headers.map((h) => [h.key, h.value]));
}

describe('next.config security headers', () => {
  it('hides x-powered-by', () => {
    expect(nextConfig.poweredByHeader).toBe(false);
  });

  it('sets every security header on the catch-all route', async () => {
    const h = await catchAllHeaders();
    for (const name of [
      'Content-Security-Policy-Report-Only',
      'X-Frame-Options',
      'X-Content-Type-Options',
      'Referrer-Policy',
      'Permissions-Policy',
    ]) {
      expect(h.has(name), name).toBe(true);
    }
    expect(h.get('X-Frame-Options')).toBe('DENY');
    expect(h.get('X-Content-Type-Options')).toBe('nosniff');
    expect(h.get('Referrer-Policy')).toBe('strict-origin-when-cross-origin');
  });

  it('keeps the CSP report-only (not enforcing) until the soak is done', async () => {
    const h = await catchAllHeaders();
    expect(h.has('Content-Security-Policy')).toBe(false);
    const csp = h.get('Content-Security-Policy-Report-Only')!;
    for (const d of ["frame-ancestors 'none'", "base-uri 'self'", "object-src 'none'", "form-action 'self'"]) {
      expect(csp).toContain(d);
    }
    expect(csp).toContain('img-src \'self\' https: data: blob:');
  });

  it('allows the camera for the AR preview and denies mic/geolocation', async () => {
    const pp = (await catchAllHeaders()).get('Permissions-Policy')!;
    expect(pp).toContain('camera=(self)');
    expect(pp).toContain('microphone=()');
    expect(pp).toContain('geolocation=()');
  });
});
