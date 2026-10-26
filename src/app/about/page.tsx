import StudioShell from "@/components/studio/StudioShell";
import SlashHeadline from "@/components/punk/SlashHeadline";
import TapeCTA from "@/components/punk/TapeCTA";

const SECTIONS = [
  {
    n: "01",
    word: "Describe",
    body: [
      "One sentence. That's the rule. Tell us the subject, where it goes on your body, and the mood you're chasing.",
      "Don't overthink the prompt. The system is built to read intent, not jargon. Slang welcome. Vibe-based descriptions encouraged.",
    ],
  },
  {
    n: "02",
    word: "Generate",
    body: [
      "Two passes a round, each a different cut at the same idea — different angle, different weight, different attitude. Render time varies with the design and studio traffic.",
      "Pick the one that hits or try again. If a render breaks, your prompt and settings stay put so you can retry the exact idea without rebuilding it.",
    ],
  },
  {
    n: "03",
    word: "Refine",
    body: [
      "Pick the cut that's closer. One refinement round locks the direction you want to take to an artist.",
      "The result is a brief and a visual, not a finished tattoo. Your artist owns the final linework.",
    ],
  },
  {
    n: "04",
    word: "Connect",
    body: [
      "Search real artist records by portfolio fit, location, and availability — not by who paid for placement. Claimed and unclaimed profiles are labeled so you know who controls the page.",
      "Some artists offer live times; everyone else receives a date request. You see the deposit and TattTester's separate booking fee before checkout, and the artist confirms what happens next.",
    ],
  },
];

export default function AboutPage() {
  return (
    <StudioShell>
      <div className="px-6 md:px-12 pt-6 pb-4 border-b hairline">
        <div className="max-w-5xl mx-auto flex items-center justify-between text-[10px] uppercase tracking-[0.25em] text-white/50 tabular-nums font-body">
          <span><span className="text-pink">●</span>&nbsp;&nbsp;How It Works</span>
          <span>04&nbsp;<span className="text-pink">steps</span></span>
        </div>
      </div>

      <div className="px-6 md:px-12 py-16 md:py-24">
        <div className="max-w-5xl mx-auto">
          <SlashHeadline
            before={<>From idea<br />to</>}
            slashed="ink"
            size="display"
          />
          <p className="mt-8 text-[15px] text-white/70 font-body max-w-xl leading-[1.55]">
            Four steps. No bullshit. Here&rsquo;s how TattTester works.
          </p>
        </div>
      </div>

      {SECTIONS.map((s) => (
        <section key={s.n} className="px-6 md:px-12 py-20 md:py-28 border-t-2 hairline">
          <div className="max-w-5xl mx-auto grid grid-cols-1 md:grid-cols-12 gap-8 md:gap-12 items-start">
            <div className="md:col-span-3">
              <div className="sticker inline-block px-4 py-2">
                <div className="font-display text-[14px] tracking-widest leading-none">
                  Step&nbsp;{s.n}
                </div>
                <div className="font-body text-[10px] uppercase tracking-widest leading-none mt-1">
                  Of&nbsp;04
                </div>
              </div>
            </div>
            <div className="md:col-span-9">
              <SlashHeadline
                as="h2"
                before={<span className="text-pink">{s.n}.</span>}
                slashed={s.word}
                period={false}
                size="display"
              />
              <div className="mt-8 space-y-4 max-w-xl">
                {s.body.map((p, i) => (
                  <p key={i} className="text-[15px] text-white/70 font-body leading-[1.6]">
                    {p}
                  </p>
                ))}
              </div>
            </div>
          </div>
        </section>
      ))}

      <section className="px-6 md:px-12 py-24 border-t-2 hairline">
        <div className="max-w-5xl mx-auto text-center">
          <h2 className="font-display text-white text-[48px] md:text-[80px] leading-[0.88]">
            Ready?
            <span className="text-pink">.</span>
          </h2>
          <TapeCTA href="/design" size="lg" className="mt-10">
            Start Designing
          </TapeCTA>
        </div>
      </section>
    </StudioShell>
  );
}
