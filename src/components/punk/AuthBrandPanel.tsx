/**
 * Left-hand brand panel for the auth split layout — studio photo at
 * half opacity under the halftone, bottom scrim, big display line and
 * a testimonial. Server-safe (no client hooks).
 *
 * `quiet` (ADR-0032): auth is a commitment surface, so the calm version
 * drops the halftone and the slash, keeps the photo and the words, and
 * turns the volume down.
 */
type Props = {
  quote: string;
  attribution: string;
  quiet?: boolean;
};

export default function AuthBrandPanel({ quote, attribution, quiet = false }: Props) {
  return (
    <div
      className={`relative hidden lg:block overflow-hidden border-r ${quiet ? "hairline-quiet-soft" : "border-r-2 hairline"}`}
    >
      <picture>
        <source srcSet="/images/hero.webp" type="image/webp" />
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src="/images/hero-og.jpg"
          alt=""
          aria-hidden
          width={1024}
          height={1024}
          className={`absolute inset-0 w-full h-full object-cover ${quiet ? "opacity-30" : "opacity-50"}`}
        />
      </picture>
      {!quiet && <div className="halftone absolute inset-0" />}
      <div className="absolute inset-0 bg-[linear-gradient(0deg,#0a0a0a_10%,transparent_55%)]" />
      <div className="relative z-[2] h-full flex flex-col justify-end p-12">
        {quiet ? (
          <div className="font-display-quiet text-quiet text-[36px] xl:text-[44px] leading-[1.1]">
            Think it.
            <br />
            Ink it.
          </div>
        ) : (
          <div className="font-display text-white text-[64px] xl:text-[80px] leading-[0.88]">
            Think it.
            <br />
            <span className="slash"><span>Ink it</span></span>
            <span className="text-pink">.</span>
          </div>
        )}
        <p
          className={`mt-8 max-w-sm text-[13px] leading-[1.7] font-body ${quiet ? "text-quiet-dim" : "text-white/70"}`}
        >
          &ldquo;{quote}&rdquo;
        </p>
        <div
          className={
            quiet
              ? "mt-4 text-[12px] text-quiet-dim/80 font-body"
              : "mt-4 text-[10px] uppercase tracking-[0.25em] text-pink font-body"
          }
        >
          {quiet ? attribution : <>▸&nbsp;{attribution}</>}
        </div>
      </div>
    </div>
  );
}
