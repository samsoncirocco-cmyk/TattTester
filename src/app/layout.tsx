import type { Metadata } from "next";
import { Anton, Space_Mono } from "next/font/google";
import "./globals.css";

// Self-hosted via next/font (TAT-52): the old globals.css @import chained
// stylesheet → fonts.googleapis.com CSS → fonts.gstatic.com woff2, three
// serial round-trips before the brand type could paint. next/font inlines
// the @font-face rules at build time and preloads the woff2 from our own
// origin with display:swap, so first paint never waits on Google.
// Material Symbols (icon font) stays on the Google CSS @import — next/font
// cannot express its variable axes — and icons are not first-paint text.
const anton = Anton({
  weight: "400",
  subsets: ["latin"],
  display: "swap",
  variable: "--font-anton",
});

const spaceMono = Space_Mono({
  weight: ["400", "700"],
  style: ["normal", "italic"],
  subsets: ["latin"],
  display: "swap",
  variable: "--font-space-mono",
});
import DemoModeBanner from "@/components/DemoModeBanner";
import { AuthProvider } from "@/components/AuthProvider";
import SignInPromptGate from "@/components/auth/SignInPromptGate";
import { ToastProvider } from "@/contexts/ToastContext";
import { CANONICAL_ORIGIN, OG_IMAGE, SITE_DESCRIPTION, SITE_NAME, SITE_TITLE } from "@/lib/site";

export const metadata: Metadata = {
  // tatttester.com is the one canonical host (docs/brand/two-door-brand-guide.md,
  // TAT-46): every page's canonical tag points there, regardless of which
  // domain served it. The './' canonical resolves to each page's own path
  // against metadataBase; the Image2Ink landing overrides it with its own
  // absolute canonical (src/app/image2ink/page.tsx).
  metadataBase: new URL(CANONICAL_ORIGIN),
  alternates: { canonical: "./" },
  title: SITE_TITLE,
  description: SITE_DESCRIPTION,
  applicationName: SITE_NAME,
  openGraph: {
    type: "website",
    siteName: SITE_NAME,
    title: SITE_TITLE,
    description: SITE_DESCRIPTION,
    images: [OG_IMAGE],
  },
  twitter: {
    card: "summary_large_image",
    title: SITE_TITLE,
    description: SITE_DESCRIPTION,
    images: [OG_IMAGE.url],
  },
  robots: { index: true, follow: true },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className={`${anton.variable} ${spaceMono.variable}`}>
      <body className="antialiased">
        <AuthProvider>
          <ToastProvider>
            {/* Demo mode banner — fixed top, only renders when NEXT_PUBLIC_DEMO_MODE=true */}
            <DemoModeBanner />
            {children}
            {/* Sign-in modal, shown on 401 AUTH_REQUIRED from any API call */}
            <SignInPromptGate />
          </ToastProvider>
        </AuthProvider>
      </body>
    </html>
  );
}
