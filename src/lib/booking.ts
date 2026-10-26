/**
 * Booking domain helpers — pure, no I/O, unit-tested.
 *
 * Shared by the /api/v1/book capture route (payload validation), the
 * /api/checkout deposit route (deposit table), and the punk /book flow
 * (labels + deposit display). The availability model is deliberately
 * minimal and honest: every artist defaults to "unknown" until a real
 * availability document exists — the UI must say "availability on
 * request", never fake open slots.
 */

// ─── Availability ──────────────────────────────────────────────────────

export type AvailabilityStatus = "unknown" | "open" | "waitlist" | "closed";

export type ArtistAvailability = {
  artistId: string;
  status: AvailabilityStatus;
  /** Optional artist-written note, e.g. "Books open March". */
  note?: string;
  /** ISO timestamp of the last real update; absent for defaults. */
  updatedAt?: string;
};

const AVAILABILITY_STATUSES: readonly AvailabilityStatus[] = [
  "unknown",
  "open",
  "waitlist",
  "closed",
];

/** The honest default: we do not know this artist's schedule. */
export function defaultAvailability(artistId: string): ArtistAvailability {
  return { artistId, status: "unknown" };
}

/**
 * Normalize a raw Firestore document (or null/undefined) into a valid
 * ArtistAvailability. Anything malformed collapses to "unknown".
 */
export function normalizeAvailability(
  artistId: string,
  raw: unknown,
): ArtistAvailability {
  if (!raw || typeof raw !== "object") return defaultAvailability(artistId);
  const doc = raw as Record<string, unknown>;
  const status = AVAILABILITY_STATUSES.includes(doc.status as AvailabilityStatus)
    ? (doc.status as AvailabilityStatus)
    : "unknown";
  const out: ArtistAvailability = { artistId, status };
  if (typeof doc.note === "string" && doc.note.trim()) {
    out.note = doc.note.trim().slice(0, 200);
  }
  if (typeof doc.updatedAt === "string") out.updatedAt = doc.updatedAt;
  return out;
}

/** UI copy per status — no fake certainty. */
export function availabilityLabel(status: AvailabilityStatus): string {
  switch (status) {
    case "open":
      return "Taking bookings";
    case "waitlist":
      return "Waitlist only";
    case "closed":
      return "Books closed";
    default:
      return "Availability on request";
  }
}

// ─── Deposits ──────────────────────────────────────────────────────────

export type TattooSize = "small" | "medium" | "large" | "sleeve";

/**
 * The size-based deposit ladder, in CENTS.
 *
 * Cents is the unit of record for every money value in this codebase: it is
 * what Stripe's `unit_amount` takes, what `platformFeeCents` computes on,
 * what the `depositCents` charge metadata carries, and what
 * `computeDepositCents` in ./session-types returns. A dollars/cents mix-up
 * here is a 100x billing error, so there is exactly one table and it is
 * denominated in cents — see ADR 0026.
 *
 * Dollars appear only at the presentation edge, via depositDollarsForSize.
 */
export const DEPOSIT_CENTS_BY_SIZE: Record<TattooSize, number> = {
  small: 7_500,
  medium: 15_000,
  large: 30_000,
  sleeve: 50_000,
};

/** The deposit for a size bucket, in cents. Use this for anything Stripe. */
export function depositCentsForSize(size: string | undefined): number {
  const normalized = size?.toLowerCase() as TattooSize;
  return DEPOSIT_CENTS_BY_SIZE[normalized] ?? DEPOSIT_CENTS_BY_SIZE.medium;
}

/**
 * Whole-dollar view of the same ladder, for UI copy ("$150 deposit") only.
 * Never hand this to Stripe or to any function whose name ends in `Cents`.
 */
export function depositDollarsForSize(size: string | undefined): number {
  return depositCentsForSize(size) / 100;
}

/** Display order of the size ladder, smallest first. */
export const DEPOSIT_LADDER_ORDER: readonly TattooSize[] = ["small", "medium", "large", "sleeve"];

/**
 * The whole deposit ladder in cents, smallest first (spec 4) — one source so
 * the profile CTA, the /book header and the pricing page always agree.
 */
export function depositLadder(): Array<{ size: TattooSize; cents: number }> {
  return DEPOSIT_LADDER_ORDER.map((size) => ({ size, cents: DEPOSIT_CENTS_BY_SIZE[size] }));
}

/** The smallest deposit, in cents ("deposit from $75"). */
export function minimumDepositCents(): number {
  return Math.min(...DEPOSIT_LADDER_ORDER.map((s) => DEPOSIT_CENTS_BY_SIZE[s]));
}

/** "$75 small · $150 medium · $300 large · $500 sleeve" — display only. */
export function depositLadderLabel(): string {
  return depositLadder()
    .map(({ size, cents }) => `$${(cents / 100).toLocaleString("en-US")} ${size}`)
    .join(" · ");
}

// ─── Requested slots ───────────────────────────────────────────────────

/**
 * A time the client is asking for — a request, not a reservation.
 * The artist confirms (or counters) after the booking is captured.
 */
export type RequestedSlot = {
  /** ISO "YYYY-MM-DD". */
  date: string;
  /** Free-form preference, e.g. "Afternoon" or "2:30 PM". */
  time?: string;
};

export const MAX_REQUESTED_SLOTS = 3;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function isValidIsoDate(value: string): boolean {
  if (!ISO_DATE.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

/**
 * Keep only well-formed slots, cap the count. Invalid entries are
 * dropped silently — a booking with zero valid slots is still a valid
 * "contact me to schedule" request.
 */
export function normalizeRequestedSlots(input: unknown): RequestedSlot[] {
  if (!Array.isArray(input)) return [];
  const out: RequestedSlot[] = [];
  for (const item of input) {
    if (out.length >= MAX_REQUESTED_SLOTS) break;
    if (!item || typeof item !== "object") continue;
    const { date, time } = item as Record<string, unknown>;
    if (typeof date !== "string" || !isValidIsoDate(date)) continue;
    const slot: RequestedSlot = { date };
    if (typeof time === "string" && time.trim()) {
      slot.time = time.trim().slice(0, 40);
    }
    out.push(slot);
  }
  return out;
}

// ─── Booking lifecycle state machine ───────────────────────────────────

/**
 * The lifecycle of a captured booking. Distinct from AvailabilityStatus:
 * availability describes an artist's schedule; this describes one booking
 * record as it moves from request → paid deposit → confirmed → done.
 *
 * `held` is the reservation path's missing middle (ADR 0027). On the request
 * model a booking goes straight `pending → deposit_paid`, which is why two
 * clients could pay for the same time: nothing ever reserved it. On the
 * reservation model, taking an exclusive hold on a concrete slot moves the
 * booking to `held`, and only a booking in `held` may pay for that slot.
 *
 * The two edges out of `held` that are not payment matter as much as the one
 * that is:
 *  - `held → pending` — the hold lapsed, was abandoned, or the payment failed.
 *    The SLOT is released to everyone else; the BOOKING survives as a plain
 *    request, so the client loses their reservation but never their enquiry.
 *  - `held → expired` — the whole booking is being retired, not just the hold.
 */
export type BookingStatus =
  | "pending"
  | "held"
  | "deposit_paid"
  | "confirmed"
  | "declined"
  | "completed"
  | "cancelled"
  | "refunded"
  | "expired";

/** Every booking starts here — captured, awaiting a deposit. */
export const INITIAL_BOOKING_STATUS: BookingStatus = "pending";

/**
 * Directed graph of allowed transitions. A status maps to the set of
 * statuses it may move to. Terminal states map to an empty array.
 */
const BOOKING_TRANSITIONS: Record<BookingStatus, readonly BookingStatus[]> = {
  pending: ["held", "deposit_paid", "cancelled", "expired"],
  held: ["deposit_paid", "pending", "cancelled", "expired"],
  deposit_paid: ["confirmed", "declined", "refunded", "cancelled"],
  confirmed: ["completed", "cancelled", "refunded"],
  declined: ["refunded"],
  completed: [],
  refunded: [],
  cancelled: [],
  expired: [],
};

/**
 * Whether a booking may move from `from` to `to`. Same-state moves and
 * unknown statuses are always rejected — a transition must be a real edge
 * in the directed graph above.
 */
export function canTransition(from: BookingStatus, to: BookingStatus): boolean {
  if (from === to) return false;
  const allowed = BOOKING_TRANSITIONS[from];
  if (!allowed) return false;
  return allowed.includes(to);
}

/**
 * One entry in a booking's status history — an audit trail of who moved
 * the booking to which state, and when.
 */
export type BookingStatusEvent = {
  status: BookingStatus;
  /** ISO timestamp of the transition. */
  at: string;
  /** Actor: 'system', a user uid, or 'stripe-webhook'. */
  by: string;
};

/**
 * Append `next` to a status history, returning a NEW array. Never mutates
 * the input; treats undefined as an empty history.
 */
export function appendStatus(
  history: BookingStatusEvent[] | undefined,
  next: BookingStatusEvent,
): BookingStatusEvent[] {
  return [...(history ?? []), next];
}

/**
 * Shape a booking doc for a client response. The capture path stores the
 * requester's IP for rate limiting/abuse tracing — that is server-side
 * metadata and must never be echoed back to the owner.
 */
export function sanitizeBooking(
  doc: Record<string, unknown>,
): Record<string, unknown> {
  const rest = { ...doc };
  delete rest.ip;
  return rest;
}

// ─── Booking payload validation ────────────────────────────────────────

export type BookingPayload = {
  artistId?: string;
  artistName?: string;
  clientName: string;
  clientEmail: string;
  clientPhone?: string;
  description: string;
  budget: string;
  designId?: string;
  designImageUrl?: string;
  /** Design-session id ("ds" query param) — links the booking to its Brief. */
  designSessionId?: string;
  requestedSlots: RequestedSlot[];
};

export type BookingValidation =
  | { ok: true; value: BookingPayload }
  | { ok: false; error: string };

function optionalString(value: unknown, max = 500): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, max) : undefined;
}

/**
 * Validate + normalize a raw /api/v1/book request body. Required
 * fields match the historical route contract: name, email,
 * description, budget.
 */
export function validateBookingRequest(body: unknown): BookingValidation {
  if (!body || typeof body !== "object") {
    return { ok: false, error: "Invalid request body" };
  }
  const raw = body as Record<string, unknown>;

  const clientName = optionalString(raw.clientName, 120);
  const clientEmail = optionalString(raw.clientEmail, 200);
  const description = optionalString(raw.description, 2000);
  const budget = optionalString(raw.budget, 60);

  if (!clientName || !clientEmail || !description || !budget) {
    return {
      ok: false,
      error: "Name, email, description, and budget are required",
    };
  }

  return {
    ok: true,
    value: {
      artistId: optionalString(raw.artistId, 80),
      artistName: optionalString(raw.artistName, 160),
      clientName,
      clientEmail,
      clientPhone: optionalString(raw.clientPhone, 40),
      description,
      budget,
      designId: optionalString(raw.designId, 80),
      designImageUrl: optionalString(raw.designImageUrl, 1000),
      designSessionId: optionalString(raw.designSessionId, 120),
      requestedSlots: normalizeRequestedSlots(raw.requestedSlots),
    },
  };
}
