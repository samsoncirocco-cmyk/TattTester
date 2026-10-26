/**
 * Privacy policy, v1.0 — the complete published policy.
 *
 * Section 4 ("Artists collected from public sources") is the part that matters
 * and the part that is unusual. It is grounded in dated production counts and
 * distinguishes external image URLs from the small number of GCS-hosted
 * copies. Generic cookie-and-analytics templates do not address data collected
 * from third-party public sources.
 *
 * Every factual claim below is traceable to behaviour in this repo:
 *   §1 what we collect          → Firebase auth (src/lib/firebase-client.ts),
 *                                 design-session Firestore store
 *                                 (src/services/designSession/internal/store.ts, ADR-0022),
 *                                 checkout fields (src/app/api/checkout/route.ts)
 *   §1 AR stays on-device       → src/services/ar/arService.js,
 *                                 src/features/ar/ (no network path exists)
 *   §4.3 removal mechanics      → docs/adr/0025, scripts/execute-takedown.mjs
 *   §4.4 the retained tombstone → docs/adr/0025 §3, scripts/lib/takedown-tombstone.mjs
 *   §4.5 coming back            → docs/adr/0026, scripts/execute-reinstatement.mjs
 *   §5 SMS wording              → TAT-49; the no-sharing sentence is required
 *                                 verbatim by the A2P carrier registration
 *   §6 processor list           → each provider named is called from this repo
 *
 * If any of those change, this text becomes false. It is not decoration.
 *
 * Open questions for counsel: docs/legal/artist-data-counsel-notes.md.
 */
import Link from "next/link";
import StudioShell from "@/components/studio/StudioShell";
import QuietHeadline from "@/components/quiet/QuietHeadline";

function H2({ children }: { children: React.ReactNode }) {
  return (
    <h2 className="font-display-quiet text-quiet text-[20px] md:text-[22px] pt-12 pb-1">
      {children}
    </h2>
  );
}

function H3({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="font-display-quiet text-quiet/90 text-[15px] md:text-[16px] pt-8 pb-1">
      {children}
    </h3>
  );
}

export default function PrivacyPage() {
  return (
    <StudioShell quiet>
      <div className="px-6 md:px-12 pt-8 pb-6 border-b hairline-quiet-soft">
        <div className="max-w-3xl mx-auto flex items-center justify-between text-[12px] text-quiet-dim tabular-nums font-body">
          <span>Legal / Privacy</span>
          <span>v1.0</span>
        </div>
      </div>

      <div className="px-6 md:px-12 py-24 md:py-32">
        <div className="max-w-3xl mx-auto">
          <QuietHeadline>Privacy policy</QuietHeadline>
          <p className="mt-6 text-[12px] text-quiet-dim font-body tabular-nums">
            Last updated: 26 October 2026. We&rsquo;ll announce material changes on this page.
          </p>

          {/* Section 4 makes commitments about other people's data. The
              continuity promise below predates v1.0 and survives it. */}
          <div className="mt-14 border hairline-quiet p-6 md:p-8 bg-white/[0.03]">
            <p className="text-[13px] text-quiet-dim font-body leading-[1.7]">
              Wording here may be revised, but one thing will not change without being
              announced on this page first: the substance of section 4 — the removal right
              for artists, and what removal actually does.
            </p>
          </div>

          <div className="mt-16 space-y-5 text-[14px] text-quiet-dim font-body leading-[1.8] border-t hairline-quiet-soft pt-12">
            <p className="text-[15px] text-quiet">
              TattTester holds personal data about two groups of people who are in very different
              positions. Sections 1 to 3 cover people who signed up, and section 5 covers
              texting with SketchBot. Section 4 covers artist records collected from the
              public internet with no identified opt-in evidence. If you are an artist who
              found your name or your work on this site and did not put it there,{' '}
              <a href="#artists" className="text-quiet underline underline-offset-4 hover:text-white">
                section 4 is the one you want
              </a>
              .
            </p>

            {/* ─────────── Users ─────────── */}
            <H2>1.&nbsp;Information we collect from you</H2>
            <p>If you create an account or use the design tools, here is what we hold:</p>
            <ul className="list-disc pl-6 space-y-2 marker:text-quiet-dim">
              <li>
                <strong className="text-quiet">Account details.</strong> Your email address
                and a password. Sign-in is handled by Firebase Authentication.
              </li>
              <li>
                <strong className="text-quiet">Design prompts and conversations.</strong>{" "}
                What you type when describing a design, including the full back-and-forth
                with SketchBot. We keep the whole transcript.
              </li>
              <li>
                <strong className="text-quiet">Reference images you upload</strong>, stored
                so we can use them in your designs.
              </li>
              <li>
                <strong className="text-quiet">Generated designs</strong> — the designs we
                make for you, and the working layers behind them.
              </li>
              <li>
                <strong className="text-quiet">Taste signals.</strong> Which of the designs
                you pick and which you say are least you. We log these from day one so the
                product can learn your taste; nothing personalizes across sessions yet.
              </li>
              <li>
                <strong className="text-quiet">Booking details.</strong> When you book an
                artist: your name and email, the artist, date and time, placement, size and
                budget.
              </li>
              <li>
                <strong className="text-quiet">Funnel steps.</strong> When you land, start
                a design conversation, get a design back, or open booking, we log that
                step and the page path. We do not attach your account, your prompt, or
                your email to that log, and we do not send it to a third-party analytics
                vendor.
              </li>
            </ul>
            <p>
              Payments are processed by Stripe, on Stripe&rsquo;s own checkout page. Your
              card number goes to Stripe directly and never touches our servers — we see
              whether the payment succeeded, not the card. Texting with SketchBot is covered
              in section 5.
            </p>

            <div className="border-l-2 border-quiet/50 pl-5 py-1 my-6">
              <p className="text-quiet text-[15px]">
                <strong>The AR mirror runs entirely on your device.</strong> When you point
                your camera at your skin to preview a design, the video never leaves your
                phone: camera frames are not uploaded, stored, or sent to us. The whole
                preview happens in your browser. If you capture a snap or a clip,
                &ldquo;save it&rdquo; saves it to your device, not to TattTester, and
                &ldquo;send it to the group chat&rdquo; opens your phone&rsquo;s own share
                sheet — the capture goes straight from your device, without passing
                through our servers.
              </p>
            </div>

            <H2>2.&nbsp;How we use it</H2>
            <p>
              To operate the service, generate and store your designs, match you with artists,
              take and settle bookings, and meet legal and tax obligations. We do not sell
              personal data.
            </p>

            <H2>3.&nbsp;Your rights as a user</H2>
            <p>
              You can see and update your profile in Settings. For everything else —
              a copy of what we hold about you, a correction you cannot make yourself,
              or deleting your account — contact us (section 9) and we will do it.
              Deleting your account removes your designs and your generation history.
              Booking and payment records are retained where we are required to keep them.
            </p>

            {/* ─────────── The part that matters ─────────── */}
            <div id="artists" className="scroll-mt-24" />
            <H2>4.&nbsp;Artists collected from public sources</H2>

            <div className="border-l-2 border-quiet/50 pl-5 py-1 my-6">
              <p className="text-quiet text-[15px]">
                We built TattTester&rsquo;s artist directory by collecting public information
                about tattoo artists from the internet rather than asking artists to submit it
                themselves. We have not identified opt-in records for that collected dataset.
                If we listed you without your permission, you can have it removed. Section 4.2
                tells you how.
              </p>
            </div>

            <H3>4.1&nbsp;&mdash;&nbsp;What we collected, and from where</H3>
            <p>
              As of July 30, 2026, our production directory contained roughly{' '}
              <strong className="text-quiet">18,000 artist records</strong> collected from
              publicly accessible sources: studio and shop websites, public artist directories,
              and public Instagram profiles. A record may include some combination of name,
              Instagram handle, studio or shop name, city and state, approximate location,
              tattoo styles, public ratings and review counts, and a link to the page where we
              found it.
            </p>
            <p>
              About 7,500 records have portfolio-image links attached, totaling roughly 68,500
              URLs. Most point to the website where the image was published. A small subset
              has been copied to TattTester storage: on the same date, our production data
              contained 26 TattTester-hosted image URLs across 6 artist records. Whether
              unclaimed artists&rsquo; portfolio images appear in the product is controlled by
              a server-side safety switch. We may also store mathematical representations
              (&ldquo;embeddings&rdquo;) used by our matching system.
            </p>
            <p>
              We did this so the directory would be useful on day one rather than empty. That
              was our commercial interest, not the artists&rsquo;, and we are naming it as such
              rather than describing it as a benefit to them.
            </p>

            <H3>4.2&nbsp;&mdash;&nbsp;Your right to have it removed, and how to use it</H3>
            <p>
              You can ask us to remove you. You do not need a TattTester account, a lawyer, or a
              reason.
            </p>
            <ul className="list-disc pl-6 space-y-2 marker:text-quiet-dim">
              <li>
                Use the removal link on your profile page, which goes to a form at{" "}
                <span className="text-quiet">/takedown</span>.
              </li>
              <li>
                Or email us. Either way, tell us which profile is yours and how to reach you.
              </li>
              <li>
                You can ask us to remove{" "}
                <strong className="text-quiet">your photographs only</strong> and leave the
                basic listing, or to remove <strong className="text-quiet">everything</strong>.
                If you do not say, we remove everything.
              </li>
            </ul>
            <p>
              Submitting the form does not delete anything by itself, and we will not tell you
              that it has. A person reviews every request. We do this deliberately: if a form
              submission could erase an artist, anyone could use it to erase a competitor. We
              will confirm to you when removal has actually happened.
            </p>

            <H3>4.3&nbsp;&mdash;&nbsp;What removal deletes, and what it does not</H3>
            <p>You are entitled to the exact answer rather than a reassuring one.</p>

            <p className="text-quiet pt-2">Permanently deleted:</p>
            <ul className="list-disc pl-6 space-y-2 marker:text-quiet-dim">
              <li>
                Every portfolio photograph of yours that we re-hosted. Deleted from our
                storage, not hidden.
              </li>
              <li>
                The style embedding derived from your work, so it no longer influences
                matching.
              </li>
              <li>
                Your name, biography, Instagram handle, studio name, location, ratings, review
                counts and portfolio links, which are erased from our database record.
              </li>
              <li>
                Your profile page, and your presence in search, browsing, recommendations and
                the homepage.
              </li>
            </ul>

            <p className="text-quiet pt-4">Retained, and why:</p>
            <ul className="list-disc pl-6 space-y-2 marker:text-quiet-dim">
              <li>
                <strong className="text-quiet">An emptied database record.</strong> We keep a
                stripped record identified only by an internal ID, with the date of your
                removal. It holds no personal details. It exists because deleting the record
                outright would break links to any payment held in your name, and would destroy
                our own proof that we honoured your request.
              </li>
              <li>
                <strong className="text-quiet">Any payment record</strong> created by a client
                leaving a deposit for you. Where a client&rsquo;s money is involved we cannot
                simply delete the record; we resolve the payment first, and our removal tool
                refuses to run while one is outstanding.
              </li>
              <li>
                <strong className="text-quiet">A record of the removal itself.</strong> See 4.4
                — this one deserves its own explanation.
              </li>
            </ul>

            <p className="text-quiet pt-4">What we cannot promise:</p>
            <ul className="list-disc pl-6 space-y-2 marker:text-quiet-dim">
              <li>
                Copies held elsewhere. Search engines, caches and content delivery networks may
                serve old copies of images for a period after we delete them. We cannot reach
                into those, but we can tell you what the URLs were so you can ask them
                directly.
              </li>
              <li>
                Backups. Our infrastructure keeps operational backups on a rolling schedule, so
                deleted content may persist in those for a period before ageing out.
              </li>
            </ul>

            <H3>4.4&nbsp;&mdash;&nbsp;We keep one permanent record so you are not re-added</H3>
            <p>
              Our directory was built by automated collection, and we may run that again. If we
              kept no record of your removal, the next run would find your public Instagram
              profile and add you back — and you would have to ask us again, forever.
            </p>
            <p>
              So when we remove you, we permanently record{" "}
              <strong className="text-quiet">your Instagram handle</strong> (and internal
              identifiers) on a suppression list that every collection process checks before
              adding anyone. Your handle is the only identifier that stays stable between runs,
              which is why we keep that specifically.
            </p>
            <div className="border-l-2 border-quiet/30 pl-5 py-1 my-5">
              <p>
                Being straightforward about the trade-off:{" "}
                <strong className="text-quiet">
                  this suppression list is itself retained personal data
                </strong>
                . We keep one piece of information about you indefinitely, for the specific and
                only purpose of never processing anything else about you again. We think that
                is the right balance, and it is why we are stating it plainly rather than
                leaving you to discover it. The entry holds your handle, the date, and nothing
                else — no photographs, no name, no location, no contact details.
              </p>
            </div>
            <p>
              If you would rather we did not keep even that, tell us and we will delete it. We
              will also tell you honestly that we can then no longer guarantee a future
              collection run will not re-add you.
            </p>

            <H3>4.5&nbsp;&mdash;&nbsp;Coming back, if you ever want to</H3>
            <p>
              Removal is not a ban. The suppression list stops{" "}
              <em className="text-quiet/90">us</em> adding you; it does not stop{" "}
              <em className="text-quiet/90">you</em> joining. If you later decide you want a
              TattTester profile, you can create an account and claim one deliberately.
            </p>
            <p>Two things are worth knowing before you do:</p>
            <ul className="list-disc pl-6 space-y-2 marker:text-quiet-dim">
              <li>
                <strong className="text-quiet">Nothing comes back.</strong> Your photographs and
                details were genuinely destroyed. You would start from an empty profile and fill
                it in yourself. We cannot undo the deletion, and we would not want to be able
                to.
              </li>
              <li>
                <strong className="text-quiet">
                  Our automated collection stays blocked permanently
                </strong>
                , even after you join. Your profile is yours; a later collection run must never
                overwrite what you wrote with scraped data.
              </li>
            </ul>

            <H3>4.6&nbsp;&mdash;&nbsp;Proving it is you</H3>
            <p>
              We have to be careful in both directions: a removal request must not be usable to
              erase a rival, and a request to take ownership of a profile must not be usable to
              take someone else&rsquo;s.
            </p>
            <p className="pt-1">
              <strong className="text-quiet">To have yourself removed</strong>, we normally ask
              you to show control of the Instagram account shown on the profile — usually by
              posting a short code we send you, or messaging us from that account. If you no
              longer have that account, or never had one, tell us and we will find another way.
              We would rather remove someone on imperfect evidence than leave a real artist
              listed against their wishes.
            </p>
            <p className="pt-1">
              <strong className="text-quiet">To claim or reinstate a profile</strong>, the bar
              is higher, because a claimed profile can receive client deposits. We require an
              account, proof of control of the Instagram handle, and review by a person before
              any profile is bound to you.
            </p>
            <p className="pt-1">
              We are not able to establish who owns the copyright in a photograph. If an artist
              and a studio disagree about whose work a portfolio is, we cannot adjudicate that,
              and we will say so rather than pick a side.
            </p>

            <H3>4.7&nbsp;&mdash;&nbsp;How long we take</H3>
            <p>
              We aim to acknowledge a removal request within a few days and to action it
              promptly after that. If you tell us your request is made under a specific legal
              right, say so and we will treat the applicable statutory deadline as binding.
            </p>

            {/* ─────────── SMS (TAT-49) ─────────── */}
            <H2>5.&nbsp;Texting with SketchBot (SMS)</H2>
            <p>
              You can run a design conversation over text message by texting SketchBot at
              the number published on this site. If you do, we collect your{" "}
              <strong className="text-quiet">phone number</strong>, the{" "}
              <strong className="text-quiet">content of your messages</strong>, and the{" "}
              <strong className="text-quiet">design requests</strong> you make in them. We
              use that information to provide the design conversation service: understanding
              your idea, replying, generating the designs you asked for, and delivering them
              to you. Photos you text to SketchBot are part of that message content: we keep
              them with the conversation and use them only as design references — to
              understand the style and subjects you are pointing at. We do not use your
              number for anything else.
            </p>
            <p>
              Message and data rates may apply, and message frequency varies with the
              conversation. Text <strong className="text-quiet">STOP</strong> at any time to
              opt out of further messages, or <strong className="text-quiet">HELP</strong>{" "}
              for help.
            </p>
            <p className="text-quiet">
              No mobile information will be shared with third parties or affiliates for
              marketing or promotional purposes.
            </p>

            <H2>6.&nbsp;Who else sees this data</H2>
            <p>
              We use a small set of providers to run the service. They process data on our
              instructions, and we do not sell personal data to anyone.
            </p>
            <ul className="list-disc pl-6 space-y-2 marker:text-quiet-dim">
              <li>
                <strong className="text-quiet">Stripe</strong> — payments, deposits and
                payouts to artists. Card details go to Stripe directly.
              </li>
              <li>
                <strong className="text-quiet">Google Cloud, Firebase and Vertex AI</strong>{" "}
                — image and file storage, sign-in, our databases, and AI models used to
                generate designs.
              </li>
              <li>
                <strong className="text-quiet">Replicate</strong> — AI image generation
                models. Your design prompt is sent there to produce your designs.
              </li>
              <li>
                <strong className="text-quiet">OpenRouter</strong> — routes some
                design-conversation prompts to language models.
              </li>
              <li>
                <strong className="text-quiet">Twilio</strong> — carries SketchBot&rsquo;s
                text messages.
              </li>
              <li>
                <strong className="text-quiet">Vercel</strong> — hosts the website.
              </li>
              <li>
                <strong className="text-quiet">Resend</strong> — delivers transactional
                email, such as booking notifications.
              </li>
              <li>
                <strong className="text-quiet">Supabase and Neo4j</strong> — the databases
                behind artist records and matching.
              </li>
              <li>
                <strong className="text-quiet">Instagram (Meta)</strong> — artist portfolio
                posts embedded on profile pages are served by Instagram itself. When a page
                shows one, your browser talks to Instagram directly and Instagram&rsquo;s
                own privacy policy applies.
              </li>
            </ul>

            <H2>7.&nbsp;How long we keep things</H2>
            <p>
              We have not invented retention windows to sound official. Where a period is
              not fixed by law or by the mechanics described in this policy, the rule is:
              we keep it until you delete it or ask us to.
            </p>
            <ul className="list-disc pl-6 space-y-2 marker:text-quiet-dim">
              <li>
                Your designs, prompts, conversations and taste signals — until you delete
                them or ask us to.
              </li>
              <li>Your account — until you delete it.</li>
              <li>
                Booking and payment records — for as long as tax and payment rules require,
                even after your account is gone.
              </li>
              <li>
                SketchBot texting — your phone number and message history, kept to run the
                conversation. Text STOP to end it, or ask us to delete the history.
              </li>
              <li>
                The suppression list in section 4.4 — indefinitely, on purpose, for the
                single reason given there.
              </li>
              <li>
                Operational backups age out on a rolling schedule, so deleted content can
                persist in them for a period first.
              </li>
            </ul>

            <H2>8.&nbsp;Who this service is for</H2>
            <p>
              TattTester is for adults. Tattoos are an 18-and-over decision, and so is this
              service. We do not knowingly collect personal data from anyone under 18; if
              you believe we have, contact us and we will delete it.
            </p>

            <H2>9.&nbsp;Contact</H2>
            <p>
              For anything in this policy — removal requests, questions about what we hold,
              corrections, deletion — email{" "}
              <a
                href="mailto:support@tatttester.com"
                className="text-quiet underline underline-offset-4 hover:text-white"
              >
                support@tatttester.com
              </a>{" "}
              or reach us via the{" "}
              <Link href="/about" className="text-quiet underline underline-offset-4 hover:text-white">
                about page
              </Link>
              . If you are an artist asking to be removed, you do not need an account and you do
              not need to explain yourself.
            </p>
          </div>
        </div>
      </div>
    </StudioShell>
  );
}
