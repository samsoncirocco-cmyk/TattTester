// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import PrivacyPage from './page';

afterEach(cleanup);

vi.mock('@/components/studio/StudioShell', () => ({
  default: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="shell">{children}</div>
  ),
}));

vi.mock('@/components/quiet/QuietHeadline', () => ({
  default: ({ children }: { children: React.ReactNode }) => <h1>{children}</h1>,
}));

describe('PrivacyPage — SMS section (TAT-49)', () => {
  it('discloses the SMS data collected, its use, and STOP/HELP', () => {
    render(<PrivacyPage />);

    const text = (document.body.textContent ?? '').replace(/ /g, ' ');
    expect(
      screen.getByRole('heading', { name: /texting with sketchbot \(sms\)/i })
    ).toBeTruthy();
    expect(text).toContain('phone number');
    expect(text).toContain('content of your messages');
    expect(text).toContain('design requests');
    expect(text).toContain('provide the design conversation service');
    expect(text).toContain('Message and data rates may apply');
    expect(text).toMatch(/Text STOP at any time to opt out/);
    expect(text).toMatch(/or HELP\s*for help/);
  });

  it('covers photos texted to SketchBot and their design-reference use (TAT-50)', () => {
    render(<PrivacyPage />);
    const text = (document.body.textContent ?? '').replace(/ /g, ' ');
    expect(text).toContain('Photos you text to SketchBot are part of that message content');
    expect(text).toContain('use them only as design references');
  });

  it('carries the carrier-required no-sharing sentence verbatim', () => {
    render(<PrivacyPage />);
    // Exact wording required by the A2P registration — do not paraphrase.
    expect(document.body.textContent).toContain(
      'No mobile information will be shared with third parties or affiliates for marketing or promotional purposes.'
    );
  });
});

describe('PrivacyPage — v1.0 published policy', () => {
  it('shows standard versioning instead of the draft banner', () => {
    render(<PrivacyPage />);
    const text = document.body.textContent ?? '';
    expect(text).toContain('v1.0');
    expect(text).toContain('Last updated: 26 October 2026');
    expect(text).not.toContain('draft');
    expect(text).not.toContain('Draft — not yet reviewed by a lawyer');
    expect(text).toMatch(/announce material changes on this page/i);
  });

  it('keeps the section 4 continuity promise', () => {
    render(<PrivacyPage />);
    const text = document.body.textContent ?? '';
    // The removal-right substance must not change silently (TAT-31).
    expect(text).toMatch(
      /substance of section 4 — the removal right for artists, and what removal actually does/
    );
    expect(
      screen.getByRole('heading', { name: /artists collected from public sources/i })
    ).toBeTruthy();
  });

  it('states the verified artist-data scale without repeating the retired re-hosting claim', () => {
    render(<PrivacyPage />);
    const text = (document.body.textContent ?? '').replace(/\s+/g, ' ');
    expect(text).toContain('18,000 artist records');
    expect(text).toContain('roughly 68,500 URLs');
    expect(text).toContain('26 TattTester-hosted image URLs across 6 artist records');
    expect(text).not.toMatch(/7,800 tattoo artists/i);
    expect(text).not.toMatch(/re-hosted approximately 62,000/i);
  });

  it('states prominently that the AR mirror never uploads camera frames', () => {
    render(<PrivacyPage />);
    const text = (document.body.textContent ?? '').replace(/\s+/g, ' ');
    // Verified against src/services/ar/arService.js and src/features/ar/ —
    // the camera stream feeds a local <video>, capture composites on a local
    // canvas and exits only via a blob-URL download ("save it") or the OS
    // share sheet via navigator.share ("send it to the group chat"). No
    // network path exists.
    expect(text).toContain('The AR mirror runs entirely on your device.');
    expect(text).toMatch(/camera frames are not uploaded, stored, or sent to us/);
    expect(text).toContain('“save it” saves it to your device, not to TattTester');
    expect(text).toContain('“send it to the group chat” opens your phone’s own share sheet');
  });

  it('enumerates the real service providers', () => {
    render(<PrivacyPage />);
    const text = document.body.textContent ?? '';
    for (const provider of [
      'Stripe',
      'Google Cloud, Firebase and Vertex AI',
      'Replicate',
      'OpenRouter',
      'Twilio',
      'Vercel',
      'Resend',
      'Supabase and Neo4j',
      'Instagram (Meta)',
    ]) {
      expect(text).toContain(provider);
    }
  });

  it('says card numbers never touch our servers (Stripe-hosted checkout)', () => {
    render(<PrivacyPage />);
    expect(document.body.textContent).toMatch(
      /card number goes to Stripe directly and never touches our servers/
    );
  });

  it('carries the retention, adults-only, and contact sections', () => {
    render(<PrivacyPage />);
    const text = document.body.textContent ?? '';
    expect(
      screen.getByRole('heading', { name: /how long we keep things/i })
    ).toBeTruthy();
    expect(text).toMatch(/until you delete it or ask us to/);
    expect(text).toMatch(/TattTester is for adults/);
    expect(text).toContain('support@tatttester.com');
  });
});
