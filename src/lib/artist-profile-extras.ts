/**
 * Artist-written policies, FAQ and travel dates (spec 16) — types, limits,
 * validation and the render-side filters. Pure; storage lives in
 * ./artist-profile-extras-store (server only).
 *
 * Plain text only. URLs, email addresses and phone numbers are REJECTED with
 * a clear error rather than silently stripped (spec 16 open question 3,
 * recommendation taken; ADR-0054's reject-don't-clamp spirit): free text that
 * routes customers off the platform would also route them around its refund
 * rules.
 */

export const EXTRAS_FIELDS = ['policies', 'faqs', 'travelDates'] as const;
export type ExtrasField = (typeof EXTRAS_FIELDS)[number];

export const POLICY_KEYS = ['deposit', 'cancellation', 'aftercare'] as const;
export type PolicyKey = (typeof POLICY_KEYS)[number];
export type ArtistPolicies = Partial<Record<PolicyKey, string>>;

export type ArtistFaq = { q: string; a: string };

export const TRAVEL_KINDS = ['guest_spot', 'convention', 'travel'] as const;
export type TravelKind = (typeof TRAVEL_KINDS)[number];
export type TravelDate = {
  city: string;
  region?: string;
  startsOn: string;
  endsOn: string;
  kind: TravelKind;
  note?: string;
};

export type ArtistProfileExtras = {
  policies: ArtistPolicies;
  faqs: ArtistFaq[];
  travelDates: TravelDate[];
};

export const EXTRAS_LIMITS = {
  policy: 1000,
  faqCount: 8,
  faqQ: 140,
  faqA: 600,
  travelCount: 12,
  city: 80,
  region: 80,
  note: 200,
  travelRangeDays: 120,
} as const;

export const EMPTY_EXTRAS: ArtistProfileExtras = { policies: {}, faqs: [], travelDates: [] };

const URL_RE = /\b(?:https?:\/\/|www\.)\S+|\b[a-z0-9-]+\.(?:com|net|org|io|co|me|ink|studio|art|shop|app|link|xyz)\b/i;
const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;
// A North American 3-3-4 number in any common punctuation, or any "+" number
// of eight or more digits. Shaped so dates ("2026-03-04") and prices pass.
const PHONE_RE = /(?:\(\d{3}\)|\b\d{3})[\s.-]?\d{3}[\s.-]?\d{4}\b|\+\d(?:[\s().-]?\d){7,}/;

/** Why a piece of text is refused, or null when it is fine. */
export function contactDetailIn(text: string): 'link' | 'email' | 'phone' | null {
  if (EMAIL_RE.test(text)) return 'email';
  if (URL_RE.test(text)) return 'link';
  if (PHONE_RE.test(text)) return 'phone';
  return null;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
function isRealDate(s: string): boolean {
  if (!ISO_DATE.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}
function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}

type Fail = { ok: false; error: string };

function checkText(label: string, raw: unknown, max: number, required: boolean): { ok: true; value: string | undefined } | Fail {
  if (raw === undefined || raw === null) {
    return required ? { ok: false, error: `${label} is required.` } : { ok: true, value: undefined };
  }
  if (typeof raw !== 'string') return { ok: false, error: `${label} must be text.` };
  const value = raw.trim();
  if (!value) {
    return required ? { ok: false, error: `${label} is required.` } : { ok: true, value: undefined };
  }
  if (value.length > max) return { ok: false, error: `${label} is too long (maximum ${max} characters).` };
  const contact = contactDetailIn(value);
  if (contact) {
    const what = contact === 'link' ? 'links' : contact === 'email' ? 'email addresses' : 'phone numbers';
    return {
      ok: false,
      error: `${label} can't include ${what}. Clients reach you through TattTester, so its booking and refund rules protect you both.`,
    };
  }
  return { ok: true, value };
}

function validatePolicies(raw: unknown): { ok: true; value: ArtistPolicies } | Fail {
  if (raw === null) return { ok: true, value: {} };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, error: 'Policies must be an object.' };
  const obj = raw as Record<string, unknown>;
  const unknown = Object.keys(obj).filter((k) => !(POLICY_KEYS as readonly string[]).includes(k));
  if (unknown.length) return { ok: false, error: `Unknown policy fields: ${unknown.join(', ')}.` };
  const value: ArtistPolicies = {};
  for (const key of POLICY_KEYS) {
    const r = checkText(`The ${key} policy`, obj[key], EXTRAS_LIMITS.policy, false);
    if (!r.ok) return r;
    if (r.value) value[key] = r.value;
  }
  return { ok: true, value };
}

function validateFaqs(raw: unknown): { ok: true; value: ArtistFaq[] } | Fail {
  if (raw === null) return { ok: true, value: [] };
  if (!Array.isArray(raw)) return { ok: false, error: 'FAQs must be a list.' };
  if (raw.length > EXTRAS_LIMITS.faqCount) {
    return { ok: false, error: `At most ${EXTRAS_LIMITS.faqCount} questions.` };
  }
  const value: ArtistFaq[] = [];
  for (const [i, item] of raw.entries()) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return { ok: false, error: `Question ${i + 1} is malformed.` };
    const { q, a, ...rest } = item as Record<string, unknown>;
    if (Object.keys(rest).length) return { ok: false, error: `Question ${i + 1} has unknown fields.` };
    const qr = checkText(`Question ${i + 1}`, q, EXTRAS_LIMITS.faqQ, true);
    if (!qr.ok) return qr;
    const ar = checkText(`Answer ${i + 1}`, a, EXTRAS_LIMITS.faqA, true);
    if (!ar.ok) return ar;
    value.push({ q: qr.value!, a: ar.value! });
  }
  return { ok: true, value };
}

function validateTravel(raw: unknown): { ok: true; value: TravelDate[] } | Fail {
  if (raw === null) return { ok: true, value: [] };
  if (!Array.isArray(raw)) return { ok: false, error: 'Travel dates must be a list.' };
  if (raw.length > EXTRAS_LIMITS.travelCount) {
    return { ok: false, error: `At most ${EXTRAS_LIMITS.travelCount} travel dates.` };
  }
  const value: TravelDate[] = [];
  for (const [i, item] of raw.entries()) {
    const n = i + 1;
    if (!item || typeof item !== 'object' || Array.isArray(item)) return { ok: false, error: `Travel date ${n} is malformed.` };
    const { city, region, startsOn, endsOn, kind, note, ...rest } = item as Record<string, unknown>;
    if (Object.keys(rest).length) return { ok: false, error: `Travel date ${n} has unknown fields.` };
    const c = checkText(`Travel date ${n} city`, city, EXTRAS_LIMITS.city, true);
    if (!c.ok) return c;
    const r = checkText(`Travel date ${n} region`, region, EXTRAS_LIMITS.region, false);
    if (!r.ok) return r;
    const nt = checkText(`Travel date ${n} note`, note, EXTRAS_LIMITS.note, false);
    if (!nt.ok) return nt;
    if (typeof startsOn !== 'string' || !isRealDate(startsOn) || typeof endsOn !== 'string' || !isRealDate(endsOn)) {
      return { ok: false, error: `Travel date ${n} needs start and end dates as YYYY-MM-DD.` };
    }
    if (endsOn < startsOn) return { ok: false, error: `Travel date ${n} ends before it starts.` };
    if (daysBetween(startsOn, endsOn) > EXTRAS_LIMITS.travelRangeDays) {
      return { ok: false, error: `Travel date ${n} is longer than ${EXTRAS_LIMITS.travelRangeDays} days.` };
    }
    if (typeof kind !== 'string' || !(TRAVEL_KINDS as readonly string[]).includes(kind)) {
      return { ok: false, error: `Travel date ${n} must be a guest spot, convention or travel.` };
    }
    value.push({
      city: c.value!,
      ...(r.value ? { region: r.value } : {}),
      startsOn,
      endsOn,
      kind: kind as TravelKind,
      ...(nt.value ? { note: nt.value } : {}),
    });
  }
  value.sort((a, b) => a.startsOn.localeCompare(b.startsOn));
  return { ok: true, value };
}

/**
 * Validate the extras part of a profile PATCH. Each group present replaces the
 * stored group (last write wins per group); `null` clears it.
 */
export function validateExtrasPatch(
  raw: Partial<Record<ExtrasField, unknown>>,
): { ok: true; value: Partial<ArtistProfileExtras>; fields: ExtrasField[] } | Fail {
  const value: Partial<ArtistProfileExtras> = {};
  const fields: ExtrasField[] = [];
  if ('policies' in raw) {
    const r = validatePolicies(raw.policies);
    if (!r.ok) return r;
    value.policies = r.value;
    fields.push('policies');
  }
  if ('faqs' in raw) {
    const r = validateFaqs(raw.faqs);
    if (!r.ok) return r;
    value.faqs = r.value;
    fields.push('faqs');
  }
  if ('travelDates' in raw) {
    const r = validateTravel(raw.travelDates);
    if (!r.ok) return r;
    value.travelDates = r.value;
    fields.push('travelDates');
  }
  return { ok: true, value, fields };
}

/** Split a PATCH body into its extras part and the scalar profile part. */
export function splitProfilePatch(body: Record<string, unknown>): {
  extras: Partial<Record<ExtrasField, unknown>>;
  scalar: Record<string, unknown>;
} {
  const extras: Partial<Record<ExtrasField, unknown>> = {};
  const scalar: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(body)) {
    if ((EXTRAS_FIELDS as readonly string[]).includes(k)) extras[k as ExtrasField] = v;
    else scalar[k] = v;
  }
  return { extras, scalar };
}

/** Coerce whatever is stored into the shape, dropping anything malformed. */
export function normalizeStoredExtras(raw: unknown): ArtistProfileExtras {
  if (!raw || typeof raw !== 'object') return EMPTY_EXTRAS;
  const doc = raw as Record<string, unknown>;
  const policies = validatePolicies(doc.policies ?? null);
  const faqs = validateFaqs(doc.faqs ?? null);
  const travel = validateTravel(doc.travelDates ?? null);
  return {
    policies: policies.ok ? policies.value : {},
    faqs: faqs.ok ? faqs.value : [],
    travelDates: travel.ok ? travel.value : [],
  };
}

/** Upcoming (or in-progress) travel only; `today` is "YYYY-MM-DD". */
export function upcomingTravel(travel: TravelDate[], today: string): TravelDate[] {
  return travel.filter((t) => t.endsOn >= today);
}

export function hasAnyExtras(e: ArtistProfileExtras | null | undefined, today: string): boolean {
  if (!e) return false;
  return (
    Object.values(e.policies).some(Boolean) ||
    e.faqs.length > 0 ||
    upcomingTravel(e.travelDates, today).length > 0
  );
}

export function hasPolicies(e: ArtistProfileExtras | null | undefined): boolean {
  return Boolean(e && Object.values(e.policies).some(Boolean));
}
