'use client';

/**
 * Spec 16 editor sections: "Policies", "Questions I get asked", "Where I'll
 * be". Controlled — the parent owns the state and saves it with the rest of
 * the profile in one PATCH; the server validates (src/lib/artist-profile-extras).
 */
import type {
  ArtistFaq,
  ArtistPolicies,
  ArtistProfileExtras,
  PolicyKey,
  TravelDate,
  TravelKind,
} from '@/lib/artist-profile-extras';

const POLICY_FIELDS: Array<{ key: PolicyKey; label: string; placeholder: string }> = [
  { key: 'deposit', label: 'Deposit', placeholder: 'What the deposit covers and when it applies to your final price.' },
  { key: 'cancellation', label: 'Cancelling or rescheduling', placeholder: 'How much notice you need to move or cancel.' },
  { key: 'aftercare', label: 'Aftercare and health', placeholder: 'Anything clients should know before or after the session.' },
];

const KINDS: Array<{ value: TravelKind; label: string }> = [
  { value: 'guest_spot', label: 'Guest spot' },
  { value: 'convention', label: 'Convention' },
  { value: 'travel', label: 'Travelling' },
];

const MAX_FAQS = 8;
const MAX_TRAVEL = 12;

const label = 'block font-body text-[10px] uppercase tracking-[0.24em] text-pink';
const input = 'mt-2 w-full border hairline bg-black px-4 py-3 font-body text-[14px] text-white';
const help = 'mt-2 font-body text-[12px] leading-[1.6] text-white/45';
const smallBtn =
  'border hairline px-3 py-2 font-body text-[10px] uppercase tracking-[0.2em] text-white/70 hover:text-pink press';

export const EMPTY_EDITOR_EXTRAS: ArtistProfileExtras = { policies: {}, faqs: [], travelDates: [] };

export default function ProfileExtrasEditor({
  value,
  onChange,
}: {
  value: ArtistProfileExtras;
  onChange: (next: ArtistProfileExtras) => void;
}) {
  const setPolicy = (key: PolicyKey, text: string) => {
    const policies: ArtistPolicies = { ...value.policies, [key]: text };
    onChange({ ...value, policies });
  };
  const setFaq = (i: number, patch: Partial<ArtistFaq>) =>
    onChange({ ...value, faqs: value.faqs.map((f, j) => (j === i ? { ...f, ...patch } : f)) });
  const setTravel = (i: number, patch: Partial<TravelDate>) =>
    onChange({
      ...value,
      travelDates: value.travelDates.map((t, j) => (j === i ? { ...t, ...patch } : t)),
    });

  return (
    <div className="space-y-10">
      <section aria-labelledby="extras-policies">
        <h2 id="extras-policies" className="font-display text-white text-[28px]">Policies</h2>
        <p className={help}>
          Say what you want clients to know before they pay. TattTester&apos;s own rules still
          apply: deposits are refunded in full if you don&apos;t reply in time.
        </p>
        {POLICY_FIELDS.map((f) => (
          <div key={f.key} className="mt-5">
            <label htmlFor={`policy-${f.key}`} className={label}>{f.label}</label>
            <textarea
              id={`policy-${f.key}`}
              value={value.policies[f.key] ?? ''}
              placeholder={f.placeholder}
              maxLength={1000}
              rows={3}
              onChange={(e) => setPolicy(f.key, e.target.value)}
              className={input}
            />
          </div>
        ))}
      </section>

      <section aria-labelledby="extras-faqs">
        <h2 id="extras-faqs" className="font-display text-white text-[28px]">Questions I get asked</h2>
        {value.faqs.length === 0 && (
          <p className={help}>Nothing here yet. Clients see this above the Book button.</p>
        )}
        {value.faqs.map((f, i) => (
          <div key={i} className="mt-5 border hairline p-4">
            <label htmlFor={`faq-q-${i}`} className={label}>Question {i + 1}</label>
            <input
              id={`faq-q-${i}`}
              value={f.q}
              maxLength={140}
              onChange={(e) => setFaq(i, { q: e.target.value })}
              className={input}
            />
            <label htmlFor={`faq-a-${i}`} className={`${label} mt-4`}>Answer</label>
            <textarea
              id={`faq-a-${i}`}
              value={f.a}
              maxLength={600}
              rows={3}
              onChange={(e) => setFaq(i, { a: e.target.value })}
              className={input}
            />
            <button
              type="button"
              className={`${smallBtn} mt-3`}
              onClick={() => onChange({ ...value, faqs: value.faqs.filter((_, j) => j !== i) })}
            >
              Remove question
            </button>
          </div>
        ))}
        {value.faqs.length < MAX_FAQS && (
          <button
            type="button"
            className={`${smallBtn} mt-4`}
            onClick={() => onChange({ ...value, faqs: [...value.faqs, { q: '', a: '' }] })}
          >
            Add a question
          </button>
        )}
      </section>

      <section aria-labelledby="extras-travel">
        <h2 id="extras-travel" className="font-display text-white text-[28px]">Where I&apos;ll be</h2>
        {value.travelDates.length === 0 && (
          <p className={help}>Nothing here yet. Clients see this above the Book button.</p>
        )}
        {value.travelDates.map((t, i) => (
          <div key={i} className="mt-5 border hairline p-4 grid gap-4 sm:grid-cols-2">
            <div>
              <label htmlFor={`travel-city-${i}`} className={label}>City</label>
              <input id={`travel-city-${i}`} value={t.city} maxLength={80} onChange={(e) => setTravel(i, { city: e.target.value })} className={input} />
            </div>
            <div>
              <label htmlFor={`travel-region-${i}`} className={label}>State or country</label>
              <input id={`travel-region-${i}`} value={t.region ?? ''} maxLength={80} onChange={(e) => setTravel(i, { region: e.target.value })} className={input} />
            </div>
            <div>
              <label htmlFor={`travel-start-${i}`} className={label}>From</label>
              <input id={`travel-start-${i}`} type="date" value={t.startsOn} onChange={(e) => setTravel(i, { startsOn: e.target.value })} className={input} />
            </div>
            <div>
              <label htmlFor={`travel-end-${i}`} className={label}>Until</label>
              <input id={`travel-end-${i}`} type="date" value={t.endsOn} onChange={(e) => setTravel(i, { endsOn: e.target.value })} className={input} />
            </div>
            <div>
              <label htmlFor={`travel-kind-${i}`} className={label}>Kind</label>
              <select id={`travel-kind-${i}`} value={t.kind} onChange={(e) => setTravel(i, { kind: e.target.value as TravelKind })} className={input}>
                {KINDS.map((k) => (
                  <option key={k.value} value={k.value}>{k.label}</option>
                ))}
              </select>
            </div>
            <div>
              <label htmlFor={`travel-note-${i}`} className={label}>Note</label>
              <input id={`travel-note-${i}`} value={t.note ?? ''} maxLength={200} onChange={(e) => setTravel(i, { note: e.target.value })} className={input} />
            </div>
            <button
              type="button"
              className={`${smallBtn} sm:col-span-2 justify-self-start`}
              onClick={() => onChange({ ...value, travelDates: value.travelDates.filter((_, j) => j !== i) })}
            >
              Remove dates
            </button>
          </div>
        ))}
        {value.travelDates.length < MAX_TRAVEL && (
          <button
            type="button"
            className={`${smallBtn} mt-4`}
            onClick={() =>
              onChange({
                ...value,
                travelDates: [...value.travelDates, { city: '', startsOn: '', endsOn: '', kind: 'guest_spot' }],
              })
            }
          >
            Add dates
          </button>
        )}
      </section>
    </div>
  );
}

/** Editor state → PATCH body: blanks become absent, so empty sections clear. */
export function extrasToPatch(value: ArtistProfileExtras): Pick<ArtistProfileExtras, 'policies' | 'faqs' | 'travelDates'> {
  const policies: ArtistPolicies = {};
  for (const [k, v] of Object.entries(value.policies) as Array<[PolicyKey, string | undefined]>) {
    if (v && v.trim()) policies[k] = v;
  }
  return {
    policies,
    faqs: value.faqs.filter((f) => f.q.trim() || f.a.trim()),
    travelDates: value.travelDates
      .filter((t) => t.city.trim() || t.startsOn || t.endsOn)
      .map((t) => ({
        ...t,
        ...(t.region?.trim() ? {} : { region: undefined }),
        ...(t.note?.trim() ? {} : { note: undefined }),
      })),
  };
}
