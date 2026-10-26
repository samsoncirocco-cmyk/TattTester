/**
 * "Before you book" (spec 16): the artist's own policies, FAQ and travel
 * dates, directly above the booking module on a CLAIMED profile.
 *
 * The page only passes extras for a claimed artist (see
 * readClaimedArtistExtras); an empty or missing set renders nothing at all —
 * no placeholder that could imply the artist wrote something.
 */
import { toZonedISODate } from "@/lib/scheduling-engine";
import {
  upcomingTravel,
  type ArtistProfileExtras,
  type PolicyKey,
  type TravelDate,
} from "@/lib/artist-profile-extras";

const POLICY_LABELS: Record<PolicyKey, string> = {
  deposit: "Deposit",
  cancellation: "Cancelling or rescheduling",
  aftercare: "Aftercare and health",
};

const KIND_LABELS: Record<TravelDate["kind"], string> = {
  guest_spot: "Guest spot",
  convention: "Convention",
  travel: "Travelling",
};

const FAQ_VISIBLE = 3;

/**
 * Today on the westernmost clock (UTC−12): a trip that "ends today" anywhere
 * on Earth is still shown. The cost is showing a finished trip for up to a
 * day — the safe direction (spec 16 §5.6; the profile has no artist zone).
 */
export function travelToday(nowMs = Date.now()): string {
  return toZonedISODate(nowMs, "Etc/GMT+12");
}

function shortDay(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-US", {
    timeZone: "UTC",
    month: "short",
    day: "numeric",
  });
}

function travelLine(t: TravelDate, today: string): string {
  const place = [t.city, t.region].filter(Boolean).join(", ");
  if (t.startsOn <= today && today <= t.endsOn) return `In ${place} until ${shortDay(t.endsOn)}`;
  const range = t.startsOn === t.endsOn ? shortDay(t.startsOn) : `${shortDay(t.startsOn)} – ${shortDay(t.endsOn)}`;
  return `${place} · ${range}`;
}

export default function BeforeYouBook({
  artistName,
  extras,
  nowMs,
}: {
  artistName: string;
  extras: ArtistProfileExtras | undefined;
  nowMs?: number;
}) {
  if (!extras) return null;
  const today = travelToday(nowMs);
  const policies = (Object.keys(POLICY_LABELS) as PolicyKey[]).filter((k) => extras.policies[k]);
  const travel = upcomingTravel(extras.travelDates, today);
  if (!policies.length && !extras.faqs.length && !travel.length) return null;

  const faqShown = extras.faqs.slice(0, FAQ_VISIBLE);
  const faqMore = extras.faqs.slice(FAQ_VISIBLE);

  return (
    <section
      id="before-you-book"
      data-testid="before-you-book"
      aria-labelledby="before-you-book-heading"
      className="mt-12 border hairline-quiet p-6 md:p-8 max-w-md font-body"
    >
      <h2 id="before-you-book-heading" className="font-display-quiet text-[20px] text-quiet">
        Before you book
      </h2>

      {policies.length > 0 && (
        <div className="mt-5 space-y-4">
          {policies.map((k) => (
            <div key={k}>
              <div className="text-[11px] text-quiet-dim">{POLICY_LABELS[k]}</div>
              <p className="mt-1 text-[13px] text-quiet leading-[1.7] whitespace-pre-line">
                {extras.policies[k]}
              </p>
            </div>
          ))}
          <p className="text-[11px] text-quiet-dim leading-[1.6]">
            TattTester&apos;s refund rules apply where they differ.
          </p>
        </div>
      )}

      {extras.faqs.length > 0 && (
        <div className="mt-6">
          <div className="text-[11px] text-quiet-dim">Questions I get asked</div>
          <dl className="mt-2 space-y-3">
            {faqShown.map((f, i) => (
              <div key={i}>
                <dt className="text-[13px] text-quiet">{f.q}</dt>
                <dd className="mt-1 text-[13px] text-quiet-dim leading-[1.7] whitespace-pre-line">{f.a}</dd>
              </div>
            ))}
          </dl>
          {faqMore.length > 0 && (
            // Full text stays in the DOM (spec 16 §5.5); <details> just folds it.
            <details className="mt-3">
              <summary className="text-[12px] text-quiet-dim cursor-pointer">Show more</summary>
              <dl className="mt-3 space-y-3">
                {faqMore.map((f, i) => (
                  <div key={i}>
                    <dt className="text-[13px] text-quiet">{f.q}</dt>
                    <dd className="mt-1 text-[13px] text-quiet-dim leading-[1.7] whitespace-pre-line">{f.a}</dd>
                  </div>
                ))}
              </dl>
            </details>
          )}
        </div>
      )}

      {travel.length > 0 && (
        <div className="mt-6">
          <div className="text-[11px] text-quiet-dim">Where I&apos;ll be</div>
          <ul className="mt-2 space-y-2">
            {travel.map((t, i) => (
              <li key={i} className="text-[13px] text-quiet">
                {travelLine(t, today)}
                <span className="text-quiet-dim"> · {KIND_LABELS[t.kind]}</span>
                {t.note && <span className="block text-[12px] text-quiet-dim">{t.note}</span>}
              </li>
            ))}
          </ul>
        </div>
      )}

      <p className="mt-6 text-[11px] text-quiet-dim">Written by {artistName}.</p>
    </section>
  );
}
