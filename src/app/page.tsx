import Link from "next/link";
import StudioShell from "@/components/studio/StudioShell";
import SlashHeadline from "@/components/punk/SlashHeadline";
import TapeCTA from "@/components/punk/TapeCTA";
import ArtistCard from "@/components/punk/ArtistCard";
import SmsDisclosure from "@/components/sketchbot/SmsDisclosure";
import { getSketchBotSmsContact } from "@/lib/sketchbot-sms";
import { getFeaturedArtists } from "@/lib/featured-artists";
import { artistSlug } from "@/lib/artist-slug";
import { EXAMPLE_DESIGNS } from "@/lib/example-designs";

// The featured grid is curated but suppression-checked against the live graph,
// so a completed takedown drops off the homepage on its own rather than waiting
// for someone to re-run a script and redeploy. Revalidated rather than
// force-dynamic: the landing page stays cached, and the worst case is that a
// removed artist lingers for up to a minute instead of indefinitely.
// See src/lib/featured-artists.ts and docs/adr/0025.
export const revalidate = 60;

const STEPS = [
  {
    n: "01",
    title: "Describe",
    body: "Type one sentence. Subject, placement, mood. We'll handle the noise.",
  },
  {
    n: "02",
    title: "Generate",
    body: "AI cuts two passes in seconds. Pick the one that bites. Iterate or ship.",
  },
  {
    n: "03",
    title: "Connect",
    body: "Match with vetted artists who actually do this style. Book the chair.",
  },
];

export default async function Home() {
  // Curated from the live graph (scripts/pick-featured-artists.mjs), then
  // suppression-checked on render. May be short, or empty, and is rendered
  // honestly either way — backfilling would defeat the point.
  const featured = await getFeaturedArtists();
  // TAT-49: the published SMS door. Env-gated — no number, no mention.
  const sms = getSketchBotSmsContact();

  return (
    <StudioShell>
      <div className="flex flex-col">
        {/* HERO — full-bleed studio photo, left-weighted scrim */}
        <section className="relative min-h-[520px] md:min-h-[620px] overflow-hidden flex">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="/images/hero.png"
            alt="Tattoo in progress at the studio"
            className="absolute inset-0 w-full h-full object-cover object-[center_35%]"
          />
          <div className="absolute inset-0 bg-[linear-gradient(90deg,#0a0a0a_22%,rgba(10,10,10,0.5)_55%,rgba(10,10,10,0.15)_100%)]" />
          <div className="absolute inset-0 bg-[linear-gradient(0deg,#0a0a0a_4%,transparent_40%)]" />
          <div className="halftone absolute inset-0" />

          {/* TAT-52: the hero states the superpower in five seconds — you
              design by talking, on the site or from your texts — and offers
              both doors to SketchBot as equals. Kept deliberately short on
              mobile so the next section still peeks above the fold. */}
          <div className="relative z-[2] px-6 md:px-14 py-10 md:py-[70px] max-w-[820px] flex flex-col justify-center">
            <div className="text-[11px] uppercase tracking-[0.28em] text-pink mb-4 md:mb-5 font-body rise rise-1">
              ▸&nbsp;Think it. Text it. Test it.
            </div>

            <SlashHeadline
              before={<>Talk it<br />into</>}
              slashed="ink"
              size="hero"
              className="rise rise-2 text-balance"
            />

            <p className="rise rise-3 mt-5 md:mt-7 max-w-[40ch] text-[15px] leading-[1.55] text-white/70 font-body">
              Forever is a big ask —{" "}
              <span className="scribble text-pink">test it first</span>. Tell
              SketchBot your idea and get two cuts back before a needle gets
              anywhere near you.
            </p>

            {/* The conversation, in one beat. Mock copy in styled bubbles —
                not a screenshot, not a real person (ADR-0036 honesty bar). */}
            <div className="rise rise-4 mt-5 md:mt-7 flex flex-col gap-2 max-w-[320px] font-body text-[13px] leading-snug">
              <p className="self-start border-2 hairline-white bg-white/[0.07] px-3.5 py-2 text-white/85">
                &ldquo;an arm sleeve of my favorite anime&rdquo;
              </p>
              <p className="self-end bg-pink text-black px-3.5 py-2">
                say less. two cuts coming.
              </p>
            </div>

            {/* Two doors to the same SketchBot: talk on the site, or text
                the published number (TAT-49, env-gated — no number, no
                mention). The carrier disclosure travels with the number
                wherever it renders (ADR-0035/0036). */}
            <div className="rise rise-5 mt-7 md:mt-9 flex flex-col gap-4">
              {/* TAT-45 converged loud CTAs onto TapeCTA; keep that here. */}
              <TapeCTA href="/design" size="lg" className="self-start">
                Start talking
              </TapeCTA>

              {sms && (
                <div>
                  <p className="text-[15px] text-white/80 font-body leading-[1.55] max-w-[40ch]">
                    or text your idea to{" "}
                    <a
                      href={sms.href}
                      className="inline-block py-3 -my-3 text-pink hover:underline whitespace-nowrap tabular-nums"
                    >
                      {sms.display}
                    </a>{" "}
                    — SketchBot texts back two designs.
                  </p>
                  <SmsDisclosure className="mt-2 max-w-[62ch]" />
                </div>
              )}
            </div>
          </div>
        </section>

        {/* HOW IT WORKS */}
        <section className="px-6 md:px-12 py-20 md:py-28 border-t-2 hairline">
          <div className="max-w-6xl mx-auto">
            <div className="flex items-baseline justify-between mb-12">
              <h2 className="font-display text-white text-[32px] md:text-[48px] tracking-wide leading-none">
                How it works
              </h2>
              <span className="text-[10px] uppercase tracking-[0.25em] text-pink tabular-nums font-body">
                03&nbsp;steps
              </span>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-8 md:gap-12">
              {STEPS.map((s, i) => (
                <div key={s.n} className="relative">
                  <div className="sticker inline-block px-4 py-2 mb-6">
                    <div className="font-display text-[14px] tracking-widest leading-none">
                      Step&nbsp;{s.n}
                    </div>
                    <div className="font-body text-[10px] uppercase tracking-widest leading-none mt-1">
                      {s.title}
                    </div>
                  </div>
                  <h3 className="font-display text-white text-[32px] md:text-[48px] tracking-wide leading-[0.95]">
                    {i === 1 ? (
                      <>
                        <span className="slash"><span>{s.title}</span></span>
                        <span className="text-pink">.</span>
                      </>
                    ) : (
                      <>
                        {s.title}
                        <span className="text-pink">.</span>
                      </>
                    )}
                  </h3>
                  <p className="mt-4 text-[14px] text-white/70 font-body leading-[1.55] max-w-[280px]">
                    {s.body}
                  </p>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* EXAMPLE DESIGNS — the zero-signup product preview (TAT-36).
            Real outputs of the generation pipeline, labeled as AI-generated
            examples. NOT community posts (the gallery stays honestly empty
            until people share), no view counts, no artist attribution. */}
        <section className="px-6 md:px-12 py-20 md:py-28 border-t-2 hairline">
          <div className="max-w-6xl mx-auto">
            {/* Stacked below sm: the non-wrapping label otherwise squeezes the
                h2 into a ~170px column at 375px, wrapping it to three lines. */}
            <div className="flex flex-col gap-2 sm:flex-row sm:items-baseline sm:justify-between mb-6">
              <h2 className="font-display text-white text-[32px] md:text-[48px] tracking-wide leading-none">
                Straight out of the machine
              </h2>
              <span className="text-[10px] uppercase tracking-[0.25em] text-pink font-body">
                AI-generated&nbsp;examples
              </span>
            </div>
            <p className="mb-12 text-[14px] text-white/60 font-body leading-[1.55] max-w-[52ch]">
              Two cuts from the same pipeline behind{" "}
              <span className="text-white/80">Start your design</span> — shown
              as examples, not community posts.
            </p>

            <div className="grid grid-cols-2 md:grid-cols-4 gap-6 md:gap-8">
              {EXAMPLE_DESIGNS.map((d) => (
                <figure key={d.src} className="border-2 hairline bg-white/[0.03]">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={d.src}
                    alt={d.alt}
                    width={640}
                    height={640}
                    loading="lazy"
                    decoding="async"
                    className="w-full aspect-square object-cover"
                  />
                  <figcaption className="px-3 py-2.5 flex items-baseline justify-between gap-2">
                    <span className="text-[10px] uppercase tracking-[0.2em] text-white/70 font-body">
                      {d.style}
                    </span>
                    <span className="text-[10px] uppercase tracking-[0.2em] text-pink font-body whitespace-nowrap">
                      Example
                    </span>
                  </figcaption>
                </figure>
              ))}
            </div>

            <div className="mt-12">
              <Link
                href="/design"
                className="inline-block py-4 -my-4 text-[10px] uppercase tracking-[0.25em] text-white/70 hover:text-pink font-body"
              >
                Make your own&nbsp;&nbsp;→
              </Link>
            </div>

            {/* The SMS door (TAT-49) moved up into the hero (TAT-52) — one
                published number, disclosure adjacent, above the fold. */}
          </div>
        </section>

        {/* FEATURED ARTISTS */}
        <section className="px-6 md:px-12 py-20 md:py-28 border-t-2 hairline">
          <div className="max-w-6xl mx-auto">
            <div className="flex items-baseline justify-between mb-12">
              <h2 className="font-display text-white text-[32px] md:text-[48px] tracking-wide leading-none">
                Featured artists
              </h2>
              <Link
                href="/artists"
                className="inline-block py-4 -my-4 text-[10px] uppercase tracking-[0.25em] text-white/70 hover:text-pink font-body"
              >
                See all&nbsp;&nbsp;→
              </Link>
            </div>

            {featured.length ? (
              <div className="grid grid-cols-2 md:grid-cols-4 gap-6 md:gap-8">
                {featured.map((a, i) => (
                  <ArtistCard
                    key={a.id}
                    variant="compact"
                    slug={artistSlug(a.name, a.id)}
                    name={a.name}
                    city={`${a.city}, ${a.state}`}
                    style={a.styles[0]}
                    color={["bg-pink", "bg-bone", "bg-cream", "bg-pink-deep"][i % 4]}
                    // The artist's own hero, read through the same gate the
                    // profile reads — so the card a customer taps here shows
                    // the work they land on. `color` still backs the tile when
                    // there is no displayable photo.
                    image={a.heroImage ?? undefined}
                    handle={a.instagram}
                  />
                ))}
              </div>
            ) : (
              // Empty is a legitimate outcome: everyone curated has been removed,
              // or the graph could not vouch for them and the gate failed closed.
              // Say nothing about why, and point at the roster instead.
              <p className="text-[14px] text-white/60 font-body leading-[1.55] max-w-[46ch]">
                Nothing featured right now.{" "}
                <Link href="/artists" className="text-pink hover:underline">
                  Browse the full roster
                </Link>{" "}
                instead.
              </p>
            )}
          </div>
        </section>
      </div>
    </StudioShell>
  );
}
