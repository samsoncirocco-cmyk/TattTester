import type { Metadata } from "next";
import Link from "next/link";
import HalftoneBg from "@/components/punk/HalftoneBg";
import SlashHeadline from "@/components/punk/SlashHeadline";
import TapeCTA from "@/components/punk/TapeCTA";

/**
 * The Image2Ink discovery door (TAT-46).
 *
 * One page, served at image2ink.com's root via a middleware rewrite
 * (src/proxy.ts). Copy: docs/brand/image2ink-landing-copy.md. Rules:
 * docs/brand/two-door-brand-guide.md — Image2Ink is not a second brand,
 * there is no separate signup, and every CTA hands the visitor to
 * TattTester. Register: Loud (ADR-0032) — this is a marketing surface,
 * not a commitment screen.
 *
 * Deliberately NOT wrapped in StudioShell: the shell is the product's
 * interior nav, and the door has no nav — the only ways out are
 * TattTester CTAs.
 */

const CANONICAL_HOST = process.env.CANONICAL_HOST ?? "tatttester.com";

/** Every path off this page lands on the canonical TattTester host. */
const tt = (path: string) => `https://${CANONICAL_HOST}${path}`;

export const metadata: Metadata = {
  title: "Image2Ink — Turn any image into your first tattoo",
  description:
    "Drop in any image — a photo, a sketch, your dog, an album cover. " +
    "Image2Ink turns it into tattoo directions in real styles, you swipe until " +
    "one stops you, and we match that direction to artist profiles whose public " +
    "work fits. Image2Ink is the design engine inside TattTester.",
  alternates: {
    // The door's single page is canonical on its own domain; everything
    // else on that host 301s to tatttester.com (src/proxy.ts).
    canonical: "https://image2ink.com/",
  },
  openGraph: {
    title: "Image2Ink — Turn any image into your first tattoo",
    description:
      "Image2Ink turns an image into tattoo directions, then matches them to artist profiles. It is the design engine inside TattTester.",
    url: "https://image2ink.com/",
    siteName: "TattTester",
    images: [{ url: "https://tatttester.com/images/hero-og.jpg", width: 1024, height: 1024, alt: "Tattoo in progress at the studio" }],
  },
};

const STEPS = [
  {
    n: "01",
    title: "Feed it anything",
    body: "A photo from your camera roll. A screenshot. A rough sketch. A vibe. You don't need to know what you want — that's the point.",
  },
  {
    n: "02",
    title: "Get designs back",
    body: "Image2Ink generates tattoo designs from your image in real styles — fine line, traditional, blackwork, and more. Not one option. A pile of them.",
  },
  {
    n: "03",
    title: "Swipe",
    body: "Flick through the designs like you already know how. Skip fast, save the ones that stop your thumb.",
  },
  {
    n: "04",
    title: "Meet your artist",
    body: "Pick a design and we match it to artist profiles whose public portfolio work fits. Your artist takes the direction, refines it, and makes it ink-ready. Then you book.",
  },
];

const MATCH_POINTS = [
  {
    title: "Matched on their real work.",
    body: "Not ads, not who paid us most. We compare your design against actual portfolio pieces.",
  },
  {
    title: "Style-true.",
    body: "Picked a fine-line piece? You won't be matched with a bold-traditional specialist, and vice versa.",
  },
  {
    title: "They finish the design.",
    body: "Your artist gets a clean stencil export and refines it with you. The final line work is theirs — that's how good tattoos happen.",
  },
];

const FAQ = [
  {
    q: "Do I need to know what I want?",
    a: "No. That's the whole point. Start with any image you like — or don't even like, just find interesting — and swipe from there. Most people find out what they want by seeing fifty things they don't.",
  },
  {
    q: "What kind of images can I use?",
    a: "Photos, screenshots, sketches, art you love. Use images as inspiration for a style or subject. What you shouldn't do is copy another artist's tattoo line-for-line — your matched artist wouldn't ink that anyway, and neither would we help you try.",
  },
  {
    q: "What happens after I pick a design?",
    a: "Two things. First, you can test it: see it on your own body in AR and even wear it as a temporary tattoo before you commit — that part of the product is called TattTester, and it's where your account lives. Second, we match you with artists who fit the design, you pick one, and you book.",
  },
  {
    q: "Is the design I pick exactly what gets tattooed?",
    a: "Almost — and that's a good thing. Your artist gets the design as a stencil and refines it: sizing for your placement, line weights that age well, details that work on skin instead of screens. You approve the final version before any needle appears.",
  },
  {
    q: "Do I have to get the tattoo?",
    a: "Nope. Swipe forever if you want. Wear a design as a temp tattoo and change your mind. Booking only happens when you decide it does.",
  },
  {
    q: "How much does it cost?",
    a: "You pay for design generation, and a booking fee when you book an artist. The tattoo itself is priced by your artist, like always. Early-access members get launch pricing — join the waitlist and we'll show you exactly what it costs before you pay anything.",
  },
];

export default function Image2InkLanding() {
  return (
    <HalftoneBg as="main">
      {/* HEADER — Image2Ink wordmark alone (lockup rules: never the two
          wordmarks side by side; TattTester attribution lives in the footer) */}
      <header className="px-6 md:px-14 py-6 flex items-center justify-between border-b-2 hairline">
        <span className="font-display text-white text-[22px] tracking-[0.02em] leading-none">
          Image2Ink<span className="text-pink">.</span>
        </span>
        <Link
          href={tt("/signup")}
          className="text-[10px] uppercase tracking-[0.2em] text-white/70 hover:text-pink font-body"
        >
          Get early access&nbsp;&nbsp;→
        </Link>
      </header>

      {/* HERO */}
      <section className="px-6 md:px-14 py-16 md:py-24 max-w-[900px]">
        <div className="text-[11px] uppercase tracking-[0.28em] text-pink mb-5 font-body rise rise-1">
          ▸&nbsp;No idea what tattoo to get? Perfect.
        </div>

        <SlashHeadline
          before={
            <>
              Feed it
              <br />a photo.
              <br />
              Get back
            </>
          }
          slashed="ink"
          size="hero"
          className="rise rise-2 text-balance"
        />

        <p className="rise rise-3 mt-7 max-w-[46ch] text-[15px] leading-[1.55] text-white/70 font-body">
          Drop in any image — a photo, a sketch, your dog, an album cover.
          Image2Ink turns it into tattoo designs in every style, you swipe
          until one stops you, and we match you with a{" "}
          <span className="scribble text-pink">real artist</span> who actually
          inks like that.
        </p>

        <div className="rise rise-4 mt-10 flex flex-col sm:flex-row sm:items-center gap-5">
          <TapeCTA href={tt("/signup")} size="lg">
            Get early access
          </TapeCTA>
          <a
            href="#how-it-works"
            className="text-[10px] uppercase tracking-[0.2em] text-white/70 hover:text-pink font-body"
          >
            See how it works&nbsp;&nbsp;↓
          </a>
        </div>
      </section>

      {/* HOW IT WORKS */}
      <section
        id="how-it-works"
        className="px-6 md:px-12 py-20 md:py-28 border-t-2 hairline"
      >
        <div className="max-w-6xl mx-auto">
          <div className="flex items-baseline justify-between gap-6 mb-12">
            <h2 className="font-display text-white text-[32px] md:text-[48px] tracking-wide leading-[0.95] max-w-[18ch]">
              From &ldquo;no idea&rdquo; to &ldquo;that one&rdquo; in four
              steps<span className="text-pink">.</span>
            </h2>
            <span className="hidden sm:block text-[10px] uppercase tracking-[0.25em] text-pink tabular-nums font-body whitespace-nowrap">
              04&nbsp;steps
            </span>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-8 md:gap-10">
            {STEPS.map((s) => (
              <div key={s.n}>
                <div className="sticker inline-block px-4 py-2 mb-6">
                  <div className="font-display text-[14px] tracking-widest leading-none">
                    Step&nbsp;{s.n}
                  </div>
                </div>
                <h3 className="font-display text-white text-[28px] md:text-[34px] tracking-wide leading-[0.95]">
                  {s.title}
                  <span className="text-pink">.</span>
                </h3>
                <p className="mt-4 text-[14px] text-white/70 font-body leading-[1.55] max-w-[280px]">
                  {s.body}
                </p>
              </div>
            ))}
          </div>

          <div className="mt-12">
            <Link
              href={tt("/design")}
              className="text-[10px] uppercase tracking-[0.25em] text-white/70 hover:text-pink font-body"
            >
              Or try the generator&nbsp;&nbsp;→
            </Link>
          </div>
        </div>
      </section>

      {/* MATCHMAKING — the plot twist: the designs lead to a real artist */}
      <section className="px-6 md:px-12 py-20 md:py-28 border-t-2 hairline">
        <div className="max-w-6xl mx-auto">
          <h2 className="font-display text-white text-[32px] md:text-[48px] tracking-wide leading-[0.95] max-w-[24ch]">
            The designs are the fun part. The artist is the real part
            <span className="text-pink">.</span>
          </h2>
          <p className="mt-6 mb-12 text-[14px] text-white/70 font-body leading-[1.55] max-w-[52ch]">
            A design on a screen isn&rsquo;t a tattoo. A great artist is. When
            you pick a design, we search real artist portfolios — by style, by
            line weight, by the kind of work they actually love doing — and
            show you the ones who fit.
          </p>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-8 md:gap-12">
            {MATCH_POINTS.map((p) => (
              <div key={p.title} className="border-t-2 hairline pt-5">
                <h3 className="text-[13px] uppercase tracking-[0.18em] text-pink font-body">
                  ▸&nbsp;{p.title}
                </h3>
                <p className="mt-3 text-[14px] text-white/70 font-body leading-[1.55]">
                  {p.body}
                </p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* FAQ */}
      <section className="px-6 md:px-12 py-20 md:py-28 border-t-2 hairline">
        <div className="max-w-6xl mx-auto">
          <h2 className="font-display text-white text-[32px] md:text-[48px] tracking-wide leading-none mb-12">
            Fair questions<span className="text-pink">.</span>
          </h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-x-12 gap-y-10">
            {FAQ.map((f) => (
              <div key={f.q}>
                <h3 className="font-display text-white text-[20px] md:text-[24px] tracking-wide leading-[1.05]">
                  {f.q}
                </h3>
                <p className="mt-3 text-[14px] text-white/70 font-body leading-[1.55]">
                  {f.a}
                </p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* FOOTER — the attribution lockup + the TattTester handoff.
          Per the brand guide this is mandatory on every Image2Ink page. */}
      <footer className="px-6 md:px-12 py-20 md:py-24 border-t-2 hairline">
        <div className="max-w-6xl mx-auto">
          <p className="text-[15px] text-white/70 font-body leading-[1.6] max-w-[56ch]">
            <span className="text-white">
              Image2Ink is the design engine inside TattTester
            </span>{" "}
            — the app for testing a tattoo on your own body before it&rsquo;s
            forever. One account, one place: your designs, your AR previews,
            your temp tattoos, your artist bookings.
          </p>

          <div className="mt-10">
            <TapeCTA href={tt("/signup")} size="md" variant="ghost">
              Get early access to TattTester
            </TapeCTA>
          </div>

          <nav className="mt-14 flex flex-wrap gap-x-8 gap-y-3">
            <Link
              href={tt("/claim")}
              className="text-[10px] uppercase tracking-[0.2em] text-white/60 hover:text-pink font-body"
            >
              For artists
            </Link>
            <Link
              href={tt("/legal/privacy")}
              className="text-[10px] uppercase tracking-[0.2em] text-white/60 hover:text-pink font-body"
            >
              Privacy
            </Link>
            <Link
              href={tt("/legal/terms")}
              className="text-[10px] uppercase tracking-[0.2em] text-white/60 hover:text-pink font-body"
            >
              Terms
            </Link>
          </nav>
        </div>
      </footer>
    </HalftoneBg>
  );
}
