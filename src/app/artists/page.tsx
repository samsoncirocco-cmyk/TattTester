import Link from "next/link";
import StudioShell from "@/components/studio/StudioShell";
import ArtistCard from "@/components/punk/ArtistCard";
import SlashHeadline from "@/components/punk/SlashHeadline";
import RosterControls from "./RosterControls";
import { pickHeroImage } from "@/lib/hero-image";
import {
  browseArtists,
  ROSTER_STYLES,
  type RosterPage,
} from "@/lib/artists-graph";

// Filters and pagination come from the URL; every request re-queries the
// live graph, so this page can never be statically rendered.
export const dynamic = "force-dynamic";

const COLORS = ["bg-pink", "bg-bone", "bg-cream", "bg-pink-deep", "bg-white/10", "bg-white/5"];

function pageHref(
  q: string,
  style: string,
  hasPortfolio: boolean,
  page: number,
): string {
  const params = new URLSearchParams();
  if (q) params.set("q", q);
  if (style) params.set("style", style);
  if (hasPortfolio) params.set("hasPortfolio", "1");
  if (page > 1) params.set("page", String(page));
  const qs = params.toString();
  return `/artists${qs ? `?${qs}` : ""}`;
}

export default async function ArtistsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const q = typeof sp.q === "string" ? sp.q : "";
  const style = typeof sp.style === "string" ? sp.style : "";
  const hasPortfolio = sp.hasPortfolio === "1";

  const roster: RosterPage = await browseArtists({ q, style, hasPortfolio }, sp.page);
  const { artists, total, page, pageCount } = roster;

  return (
    <StudioShell>
      <div className="px-6 md:px-12 pt-6 pb-4 border-b hairline">
        <div className="max-w-6xl mx-auto flex items-center justify-between text-[10px] uppercase tracking-[0.25em] text-white/50 tabular-nums font-body">
          <span>
            <span className="text-pink">●</span>&nbsp;&nbsp;Directory
          </span>
          <span>
            Artists:&nbsp;<span className="text-pink">{total.toLocaleString()}</span>
          </span>
        </div>
      </div>

      <div className="px-6 md:px-12 py-16 md:py-20">
        <div className="max-w-6xl mx-auto">
          <SlashHeadline
            before="The"
            slashed="roster"
            size="section"
          />
          <p className="mt-6 text-[14px] text-white/60 font-body max-w-xl leading-[1.55]">
            Real tattoo artists, live from the graph. Search by name, city, or
            shop — see their work on Instagram.
          </p>

          <RosterControls
            styles={ROSTER_STYLES}
            q={q}
            style={style}
            hasPortfolio={hasPortfolio}
          />

          <div className="mt-12 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-6">
            {artists.map((a, i) => (
              <ArtistCard
                key={a.id}
                slug={a.slug}
                name={a.name}
                city={a.location}
                color={COLORS[i % COLORS.length]}
                image={pickHeroImage(a.portfolioImages) ?? undefined}
                handle={a.instagram ?? undefined}
                style={a.styles[0] ?? ""}
                showFavorite
                favoriteSize={20}
                favoritePosition="top-right"
              />
            ))}
          </div>

          {artists.length === 0 && (
            <div className="mt-16 border-2 hairline p-10 text-center">
              <div className="font-display text-[24px] tracking-wide text-white/60">
                No artists match&nbsp;
                <span className="text-pink">
                  {[q ? `"${q}"` : null, style].filter(Boolean).join(" / ") || "that"}
                </span>
              </div>
              <p className="mt-3 text-[12px] uppercase tracking-[0.2em] text-white/40 font-body">
                Try a broader term — or the graph may be briefly unreachable.
              </p>
            </div>
          )}

          {/* PAGINATION */}
          {pageCount > 1 && (
            <div className="mt-14 flex items-center justify-between border-t hairline pt-6">
              {page > 1 ? (
                <Link
                  href={pageHref(q, style, hasPortfolio, page - 1)}
                  className="text-[10px] uppercase tracking-[0.2em] text-white/70 hover:text-black hover:bg-pink border-2 hairline px-4 py-3 press font-body"
                >
                  ◂&nbsp;Previous
                </Link>
              ) : (
                <span />
              )}
              <span className="text-[10px] uppercase tracking-[0.25em] text-white/50 tabular-nums font-body">
                Page&nbsp;<span className="text-pink">{page}</span>
                &nbsp;/&nbsp;{pageCount.toLocaleString()}
              </span>
              {page < pageCount ? (
                <Link
                  href={pageHref(q, style, hasPortfolio, page + 1)}
                  className="text-[10px] uppercase tracking-[0.2em] text-white/70 hover:text-black hover:bg-pink border-2 hairline px-4 py-3 press font-body"
                >
                  Next&nbsp;▸
                </Link>
              ) : (
                <span />
              )}
            </div>
          )}
        </div>
      </div>
    </StudioShell>
  );
}
