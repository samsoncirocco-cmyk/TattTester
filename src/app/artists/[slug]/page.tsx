import Link from "next/link";
import { notFound } from "next/navigation";
import StudioShell from "@/components/studio/StudioShell";
import FavoriteButton from "@/components/punk/FavoriteButton";
import InstagramEmbed from "@/components/punk/InstagramEmbed";
import SlashHeadline from "@/components/punk/SlashHeadline";
import QuietCTA from "@/components/quiet/QuietCTA";
import { artistIdFromSlug } from "@/lib/artist-slug";
import { pickHeroImage } from "@/lib/hero-image";
import { getRosterArtistById, instagramUrl } from "@/lib/artists-graph";

// 10k+ artists live in the graph — profiles render on demand, never at build.
export const dynamic = "force-dynamic";

// Surface budget for the embed tier (TAT-40): full Instagram embeds render
// HERE and only here — a handful, lazily. Card grids (/artists roster) and
// the swipe deck never mount iframes; they stay on hosted-image/stub tiles.
const PROFILE_EMBED_LIMIT = 4;

export default async function ArtistProfilePage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  // Graph outage is not "artist missing" — match /book and /intro's
  // retry-oriented copy instead of letting the throw become a 500.
  let artist: Awaited<ReturnType<typeof getRosterArtistById>>;
  try {
    artist = await getRosterArtistById(artistIdFromSlug(slug));
  } catch {
    return (
      <StudioShell>
        <div className="px-6 md:px-12 pt-6 pb-4 border-b hairline">
          <div className="max-w-6xl mx-auto flex items-center justify-between text-[10px] uppercase tracking-[0.25em] text-white/50 tabular-nums font-body">
            <Link href="/artists" className="hover:text-pink">
              ←&nbsp;Roster
            </Link>
            <span>Profile&nbsp;/&nbsp;Unavailable</span>
          </div>
        </div>
        <div className="px-6 md:px-12 py-24 md:py-32">
          <div className="max-w-md mx-auto text-center">
            <p className="font-display text-white text-[28px] md:text-[36px] leading-none">
              Couldn&apos;t reach the artist graph.
            </p>
            <p className="mt-6 text-[13px] text-white/60 font-body leading-[1.9]">
              The live roster is unreachable right now — try again in a minute.
            </p>
            <p className="mt-10">
              <Link href="/artists" className="underline text-sm font-body text-white/80 hover:text-pink">
                Browse the roster
              </Link>
            </p>
          </div>
        </div>
      </StudioShell>
    );
  }
  if (!artist) notFound();

  const nameParts = artist.name.split(" ");
  const lastName = nameParts.pop() ?? artist.name;
  const firstNames = nameParts.join(" ");
  const igUrl = instagramUrl(artist.instagram);
  // Not [0]: that index is import order, and it is a blurred thumbnail, a
  // site banner or a headshot for 23% of the roster (#365). One seam with the
  // homepage grid and the roster card, so an artist wears the same photograph
  // on every surface.
  const heroImage = pickHeroImage(artist.portfolioImages) ?? undefined;
  // Artist-authorized selections outrank imported website images and the old
  // unclaimed recovery tier. They are the work this artist chose to show.
  const displayedPermalinks =
    artist.authorizedPortfolioPermalinks.length > 0
      ? artist.authorizedPortfolioPermalinks
      : artist.portfolioPermalinks;
  const artistSelectedInstagram =
    artist.authorizedPortfolioPermalinks.length > 0;
  const featuredPermalink = displayedPermalinks[0];
  const remainingPermalinks = displayedPermalinks.slice(
    1,
    PROFILE_EMBED_LIMIT,
  );
  const hasDisplayedWork =
    Boolean(heroImage) || displayedPermalinks.length > 0;
  const monogram = artist.name
    .split(/\s+/)
    .map((w) => w[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();

  return (
    <StudioShell>
      {/* breadcrumb meta */}
      <div className="px-6 md:px-12 pt-6 pb-4 border-b hairline">
        <div className="max-w-6xl mx-auto flex items-center justify-between text-[10px] uppercase tracking-[0.25em] text-white/50 tabular-nums font-body">
          <Link href="/artists" className="hover:text-pink">
            ←&nbsp;Roster
          </Link>
          <span>
            Profile&nbsp;/&nbsp;<span className="text-pink">{artist.id}</span>
          </span>
        </div>
      </div>

      {/* HERO — licensed portfolio image, official Instagram post, or a compact
          no-work state | info panel. A monogram is identity, not portfolio. */}
      <div className="px-6 md:px-12 py-10 md:py-12">
        <div className="max-w-6xl mx-auto grid grid-cols-1 md:grid-cols-12 gap-8 md:gap-12 items-start">
          <div className="md:col-span-5">
            {featuredPermalink ? (
              <div data-testid="instagram-embed-featured">
                <div className="text-[10px] uppercase tracking-[0.28em] text-pink mb-4 font-body">
                  ▸&nbsp;Featured&nbsp;work&nbsp;·&nbsp;
                  {artistSelectedInstagram ? "selected on Instagram" : "via Instagram"}
                </div>
                <InstagramEmbed
                  permalink={featuredPermalink}
                  className="border-2 hairline bg-black/40 overflow-hidden"
                  fallback={
                    <div className="min-h-[260px] border-2 hairline bg-pink/10 flex flex-col items-center justify-center gap-4 p-8 text-center">
                      <span className="font-display text-[64px] leading-none text-pink">
                        {monogram}
                      </span>
                      <span className="font-body text-[10px] uppercase tracking-[0.22em] text-white/50">
                        Instagram post unavailable
                      </span>
                    </div>
                  }
                />
              </div>
            ) : heroImage ? (
              <div className="aspect-[3/4] bg-bone border-2 hairline relative overflow-hidden">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={heroImage}
                  alt={`${artist.name} portfolio work`}
                  className="absolute inset-0 w-full h-full object-cover"
                  fetchPriority="high"
                  decoding="async"
                />
                {artist.instagram && (
                  <div className="absolute top-4 left-4 sticker px-2.5 py-1.5 -rotate-3">
                    <span className="font-body text-[10px] uppercase tracking-[0.18em]">
                      {artist.instagram}&nbsp;→
                    </span>
                  </div>
                )}
                {igUrl && (
                  <a
                    href={igUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="absolute bottom-4 left-4 right-4 text-center text-[10px] uppercase tracking-[0.22em] font-body bg-cream text-black px-3 py-3 press hover:bg-white"
                  >
                    See their work on Instagram&nbsp;▸
                  </a>
                )}
              </div>
            ) : (
              <div
                data-testid="artist-no-work"
                className="min-h-[260px] border-2 hairline bg-white/[0.02] flex flex-col justify-between p-8"
              >
                <span className="font-body text-[10px] uppercase tracking-[0.25em] text-pink">
                  Portfolio pending
                </span>
                <div>
                  <p className="font-display text-[38px] leading-[0.95] text-white/80">
                    Work belongs here.
                  </p>
                  <p className="mt-4 max-w-xs font-body text-[12px] leading-[1.7] text-white/45">
                    No portfolio media is available for this profile yet.
                  </p>
                  {igUrl && (
                    <a
                      href={igUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="mt-6 inline-block text-[10px] uppercase tracking-[0.22em] font-body text-white/70 hover:text-pink press"
                    >
                      See their Instagram&nbsp;▸
                    </a>
                  )}
                </div>
              </div>
            )}
          </div>

          <div className="md:col-span-7 relative">
            {!heroImage && (
              <div className="mb-5 flex items-center gap-3">
                <div
                  data-testid="artist-monogram"
                  className="h-12 w-12 shrink-0 bg-pink border hairline flex items-center justify-center"
                >
                  <span className="font-display text-[24px] leading-none text-black/45 select-none">
                    {monogram}
                  </span>
                </div>
                <div className="font-body text-[10px] uppercase tracking-[0.22em] text-white/45">
                  Artist profile
                  {artist.instagram && (
                    <span className="block mt-1 text-white/65">
                      {artist.instagram}
                    </span>
                  )}
                </div>
              </div>
            )}

            {artist.rating != null && (
              <div className="hidden sm:block absolute top-0 right-0 sticker px-3 py-1.5 z-10">
                <div className="font-display text-[14px] tracking-widest leading-none tabular-nums">
                  ★&nbsp;{artist.rating.toFixed(1)}
                </div>
                <div className="font-body text-[10px] uppercase tracking-widest leading-none mt-0.5 tabular-nums">
                  Shop&nbsp;rating
                  {artist.reviewCount != null && (
                    <>
                      &nbsp;·&nbsp;{artist.reviewCount.toLocaleString()}
                      &nbsp;reviews
                    </>
                  )}
                </div>
              </div>
            )}

            <div className="text-[10px] uppercase tracking-[0.28em] text-pink mb-5 font-body">
              {artist.styles.length > 0 ? (
                <>▸&nbsp;{artist.styles.join(" · ")}</>
              ) : (
                <span className="text-white/40">
                  ▸&nbsp;Styles not cataloged yet
                </span>
              )}
            </div>

            <div className="flex items-start justify-between gap-4">
              <SlashHeadline
                before={firstNames || undefined}
                slashed={lastName}
                sizeClassName="text-[48px] sm:text-[72px] md:text-[88px] leading-[0.88]"
                className="text-balance"
              />
              <FavoriteButton
                slug={artist.slug}
                label={artist.name}
                size={28}
                className="mt-2 shrink-0"
              />
            </div>

            <div className="mt-4 flex flex-wrap items-center gap-3 text-[10px] uppercase tracking-[0.25em] text-white/60 font-body">
              {artist.shopName && (
                <>
                  <span>{artist.shopName}</span>
                  <span className="text-pink">●</span>
                </>
              )}
              <span>{artist.location}</span>
            </div>

            {artist.bio && (
              <p className="mt-7 max-w-2xl font-body text-[14px] leading-[1.7] text-white/70">
                {artist.bio}
              </p>
            )}

            {/* STAT ROW — shop-level signals, labeled as such */}
            {(artist.rating != null || artist.reviewCount != null) && (
              <div className="mt-10 grid grid-cols-2 max-w-md border-t hairline pt-6 gap-6">
                {artist.rating != null && (
                  <div>
                    <div className="font-display text-[30px] sm:text-[38px] leading-none text-pink tabular-nums">
                      ★{artist.rating.toFixed(1)}
                    </div>
                    <div className="mt-2 text-[10px] uppercase tracking-[0.22em] text-white/50 font-body">
                      Shop rating
                    </div>
                  </div>
                )}
                {artist.reviewCount != null && (
                  <div>
                    <div className="font-display text-[30px] sm:text-[38px] leading-none text-pink tabular-nums">
                      {artist.reviewCount.toLocaleString()}
                    </div>
                    <div className="mt-2 text-[10px] uppercase tracking-[0.22em] text-white/50 font-body">
                      Shop reviews
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* BOOKING MODULE — the register flips here (ADR-0032): the
                showcase above stays loud, the commitment affordance is quiet. */}
            <div className="mt-12 border hairline-quiet p-6 md:p-8 max-w-md">
              <div className="text-[12px] text-quiet-dim font-body">
                {artist.bookingTier === "bookable" ? "Booking" : "Artist introduction"}
              </div>
              <div className="mt-5 flex flex-col sm:flex-row sm:items-center gap-5">
                <QuietCTA
                  href={
                    artist.bookingTier === "bookable"
                      ? `/book?artistId=${encodeURIComponent(artist.id)}`
                      : `/intro?artistId=${encodeURIComponent(artist.id)}`
                  }
                  size="md"
                >
                  {artist.bookingTier === "bookable" ? "Book the chair" : "Request an intro"}
                </QuietCTA>
                {igUrl && (
                  <a
                    href={igUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-[12px] text-quiet-dim hover:text-white font-body press"
                  >
                    {artist.instagram}&nbsp;→
                  </a>
                )}
                {artist.bookingUrl && (
                  <a
                    href={artist.bookingUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-[12px] text-quiet-dim hover:text-white font-body press"
                  >
                    Artist&apos;s booking site&nbsp;→
                  </a>
                )}
              </div>
              <p className="mt-5 text-[12px] text-quiet-dim font-body leading-[1.7]">
                {artist.bookingTier === "bookable"
                  ? "A deposit holds your request — the artist confirms the time."
                  : "TatT will relay your request to the artist’s shop. No deposit is taken."}
              </p>
            </div>

            {/* Provenance label (ADR-0036 law 3): an unclaimed profile says
                plainly that it is unclaimed and where the work comes from,
                with credit — and keeps both endings one click away: run it,
                or have it removed (docs/adr/0025). Profile page only; roster
                cards stay unlabeled. Claimed artists run their own profile,
                so they do not get the provenance label or claim door. The
                removal door remains available in both states. */}
            <div className="mt-10 pt-6 border-t hairline-quiet-soft font-body text-[11px] text-white/40 leading-[1.6]">
              {/* wording pending counsel review (TAT-31) */}
              {!artist.claimed && (
                <p>
                  This profile is unclaimed — {artist.name} hasn&apos;t taken it
                  over yet.{" "}
                  {hasDisplayedWork ? (
                    <>
                      The work shown here is credited to {artist.name} and comes
                      from their public Instagram
                      {artist.instagram ? <> ({artist.instagram})</> : null}.
                    </>
                  ) : igUrl ? (
                    <>
                      No portfolio work is shown here yet.{" "}
                      <a
                        href={igUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-white/60 hover:text-white press"
                      >
                        See their work on Instagram.
                      </a>
                    </>
                  ) : (
                    <>No portfolio work is shown here yet.</>
                  )}
                </p>
              )}
              <p className={artist.claimed ? undefined : "mt-2"}>
                Are you {artist.name}?{" "}
                {!artist.claimed && (
                  <>
                    <Link
                      href={`/claim/${encodeURIComponent(artist.id)}`}
                      className="text-white/60 hover:text-white press"
                    >
                      Claim your profile
                    </Link>
                    {" · "}
                  </>
                )}
                <Link
                  href={`/takedown/${encodeURIComponent(artist.id)}`}
                  className="text-white/60 hover:text-white press"
                >
                  Have it removed
                </Link>
              </p>
            </div>
          </div>
        </div>
      </div>

      {/* MORE RECENT WORK — artist-authorized Instagram selections first;
          legacy recovered links only when their server-side flag permits. The
          media is served by Instagram; TatT stores the canonical permalink and
          consent/provenance record, never an expiring media URL. */}
      {remainingPermalinks.length > 0 && (
        <div className="px-6 md:px-12 pb-12 md:pb-16">
          <div className="max-w-6xl mx-auto">
            <div className="text-[10px] uppercase tracking-[0.28em] text-pink mb-6 font-body border-t hairline pt-8">
              ▸&nbsp;More&nbsp;{artistSelectedInstagram ? "selected" : "recent"}
              &nbsp;work&nbsp;·&nbsp;via&nbsp;Instagram
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6 md:gap-8">
              {remainingPermalinks.map((permalink) => (
                <InstagramEmbed
                  key={permalink}
                  permalink={permalink}
                  className="border-2 hairline bg-black/40"
                  // A deleted/private post degrades to a compact identity
                  // state — never a broken box or a false portfolio image.
                  fallback={
                    <div className="min-h-[240px] bg-pink/10 border-2 hairline flex flex-col items-center justify-center gap-4 p-8 text-center">
                      <span className="font-display text-[52px] leading-none text-pink select-none">
                        {monogram}
                      </span>
                      <span className="font-body text-[10px] uppercase tracking-[0.22em] text-white/50">
                        Instagram post unavailable
                      </span>
                    </div>
                  }
                />
              ))}
            </div>
          </div>
        </div>
      )}

      {/* FLOATING CTA — a booking affordance, so it speaks quiet (ADR-0032). */}
      <div className="sticky bottom-6 z-30 px-6 md:px-12 pb-10 pointer-events-none">
        <div className="max-w-6xl mx-auto flex justify-end">
          <Link
            href={
              artist.bookingTier === "bookable"
                ? `/book?artistId=${encodeURIComponent(artist.id)}`
                : `/intro?artistId=${encodeURIComponent(artist.id)}`
            }
            className="press inline-flex items-center justify-center px-8 py-4 font-body text-[14px] leading-none bg-quiet text-black hover:bg-white pointer-events-auto"
          >
            {artist.bookingTier === "bookable" ? "Book consultation" : "Request an intro"}
          </Link>
        </div>
      </div>
    </StudioShell>
  );
}
