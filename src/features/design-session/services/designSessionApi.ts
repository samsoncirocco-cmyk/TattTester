// Thin fetch client for the design-session API (frozen contract:
// src/services/designSession/types.ts). The UI never talks to intake,
// council, or generation directly — the session routes orchestrate those.

import { getApiAuthHeaders, getOptionalApiAuthHeaders } from '@/lib/client-api-auth';
import type {
  DesignSession,
  StartSessionRequest,
  PickRequest,
  RoundPickRequest,
  RefineRequest,
  CritiqueRequest,
  CritiqueResult,
} from '@/services/designSession/types';
import type {
  ConverseRequest,
  ConverseResponse,
} from '@/services/designConversation/types';

const BASE_PATH = '/api/v1/design-session';

/**
 * Every conversation provider is down (503 from converse). The flow catches
 * this to degrade seamlessly to the scripted two-question intake (ADR-0019).
 */
export class ConversationUnavailableError extends Error {}

/**
 * The opening chat call is the product's front door. A network request that
 * never settles must not leave every way to start a design disabled forever.
 */
export class ConversationTimeoutError extends Error {}

/**
 * A failed design-session request, carrying what the route told us rather
 * than just a sentence. Callers (and the UI) need `retryable` to know
 * whether retrying is meaningful at all and `retryAfterMs` to know how long
 * to wait — without them the only recovery is a generic message and a manual
 * button, which is exactly what users hit on a throttled /confirm.
 */
export class DesignSessionRequestError extends Error {
  readonly code: string;
  readonly status: number;
  readonly retryable: boolean;
  readonly retryAfterMs?: number;

  constructor(
    message: string,
    fields: { code: string; status: number; retryable: boolean; retryAfterMs?: number }
  ) {
    super(message);
    this.name = 'DesignSessionRequestError';
    this.code = fields.code;
    this.status = fields.status;
    this.retryable = fields.retryable;
    this.retryAfterMs = fields.retryAfterMs;
  }
}

/** Auto-retries for a retryable confirm, on top of the provider's own retries. */
const MAX_CONFIRM_ATTEMPTS = 3;
/** Cap so a hostile/absent hint can never hang the UI. */
const MAX_RETRY_WAIT_MS = 30_000;
/** A stalled opener should recover to the retry affordance, not a dead page. */
const CONVERSATION_TIMEOUT_MS = 10_000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function settleWithin<T>(operation: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new ConversationTimeoutError(message)),
      timeoutMs
    );
    operation.then(
      (value) => {
        clearTimeout(timeout);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timeout);
        reject(error);
      }
    );
  });
}

async function postAuthed(path: string, body: unknown): Promise<Response> {
  const authHeaders = await getApiAuthHeaders();
  return fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders },
    body: JSON.stringify(body),
  });
}

/**
 * Like postAuthed, but a signed-out caller sends the request anyway with no
 * Authorization header — instead of being stopped in the browser by a
 * sign-in modal. Only for routes the server accepts anonymously; a charged
 * route must keep using postAuthed, which fails closed.
 */
async function postMaybeAuthed(path: string, body: unknown): Promise<Response> {
  const authHeaders = await getOptionalApiAuthHeaders();
  return fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders },
    body: JSON.stringify(body),
  });
}

async function postJson(path: string, body: unknown): Promise<DesignSession> {
  const res = await postAuthed(path, body);

  let data: unknown = null;
  try {
    data = await res.json();
  } catch {
    // Non-JSON body (e.g. a 500 HTML page) — fall through to status error.
  }

  if (!res.ok) {
    const payload = (data ?? {}) as {
      error?: string;
      code?: string;
      retryable?: boolean;
      retryAfterMs?: number;
    };
    // A non-JSON or legacy body yields no hint — treat as non-retryable
    // rather than guessing, since a blind retry can cost paid renders.
    throw new DesignSessionRequestError(
      payload.error ?? `Design session request failed (${res.status})`,
      {
        code: payload.code ?? 'DESIGN_SESSION_FAILED',
        status: res.status,
        retryable: payload.retryable === true,
        retryAfterMs: payload.retryAfterMs,
      }
    );
  }

  // Tolerate both a bare DesignSession body and a { session } envelope.
  const record = data as ({ session?: DesignSession } & DesignSession) | null;
  if (!record) throw new Error('Design session response was empty');
  return record.session ?? record;
}

/** POST /api/v1/design-session — runs intake → council → generation. */
export function startSession(request: StartSessionRequest): Promise<DesignSession> {
  return postJson(BASE_PATH, request);
}

/** POST /api/v1/design-session/[id]/pick — the pick + most-not-you tap. */
export function submitPick(sessionId: string, request: PickRequest): Promise<DesignSession> {
  return postJson(`${BASE_PATH}/${sessionId}/pick`, request);
}

/** POST /api/v1/design-session/[id]/refine — allowed exactly once (ADR-0013). */
export function submitRefinement(sessionId: string, request: RefineRequest): Promise<DesignSession> {
  return postJson(`${BASE_PATH}/${sessionId}/refine`, request);
}

/**
 * POST /api/v1/design-session/[id]/round/pick — record (or change) the live
 * round's pick (ADR-0049). Free, and changeable until the next round is
 * charged.
 */
export function submitRoundPick(
  sessionId: string,
  request: RoundPickRequest
): Promise<DesignSession> {
  return postJson(`${BASE_PATH}/${sessionId}/round/pick`, request);
}

/**
 * What one charged round hands the flow: the session plus the ADR-0048
 * facts the route's envelope carries — a downgraded round was delivered
 * off the pinned lane and (when the release landed) refunded, and the
 * reveal must say so rather than swallow it.
 */
export interface RefineRoundResponse {
  session: DesignSession;
  downgraded: boolean;
  creditReleased: boolean;
}

/**
 * POST /api/v1/design-session/[id]/round — one charged refine round
 * (ADR-0049): 1 credit, two new cuts seeded by the picked one. The route's
 * failure body carries the decided copy ("That round didn't take — your
 * credit is back. Run it again?" — refund claimed only when it happened),
 * which the flow shows verbatim.
 */
export async function runRefineRound(sessionId: string): Promise<RefineRoundResponse> {
  const res = await postAuthed(`${BASE_PATH}/${sessionId}/round`, {});

  let data: unknown = null;
  try {
    data = await res.json();
  } catch {
    // Non-JSON body — fall through to the status error below.
  }

  if (!res.ok) {
    const payload = (data ?? {}) as {
      error?: string;
      code?: string;
      retryable?: boolean;
      retryAfterMs?: number;
    };
    throw new DesignSessionRequestError(
      payload.error ?? `Design session request failed (${res.status})`,
      {
        code: payload.code ?? 'DESIGN_SESSION_FAILED',
        status: res.status,
        retryable: payload.retryable === true,
        retryAfterMs: payload.retryAfterMs,
      }
    );
  }

  const record = data as {
    session?: DesignSession;
    round?: { downgraded?: boolean };
    creditReleased?: boolean;
  } | null;
  if (!record?.session) throw new Error('Design session response was empty');
  return {
    session: record.session,
    downgraded: record.round?.downgraded === true,
    creditReleased: record.creditReleased === true,
  };
}

/**
 * POST /api/v1/design-session/[id]/critique — one post-reveal critique turn
 * (ADR-0039). Unlike the other calls this returns more than the session: the
 * bot's reply, the new cut when one was rendered, and what's left of the fix
 * allowance, all of which the reveal lane renders.
 */
export async function submitCritique(
  sessionId: string,
  request: CritiqueRequest
): Promise<CritiqueResult> {
  const res = await postAuthed(`${BASE_PATH}/${sessionId}/critique`, request);

  let data: unknown = null;
  try {
    data = await res.json();
  } catch {
    // Non-JSON body — fall through to the status error below.
  }

  if (!res.ok) {
    const payload = (data ?? {}) as {
      error?: string;
      code?: string;
      retryable?: boolean;
      retryAfterMs?: number;
    };
    throw new DesignSessionRequestError(
      payload.error ?? `Design session request failed (${res.status})`,
      {
        code: payload.code ?? 'DESIGN_SESSION_FAILED',
        status: res.status,
        retryable: payload.retryable === true,
        retryAfterMs: payload.retryAfterMs,
      }
    );
  }

  if (!data) throw new Error('Design session response was empty');
  return data as CritiqueResult;
}

/**
 * POST /api/v1/design-session/[id]/placement-preview — persist the flattened
 * placement-preview screenshot (PNG data URL) onto the completed session's
 * Brief so it attaches to the booking record.
 */
export function attachPlacementPreview(
  sessionId: string,
  imageData: string
): Promise<DesignSession> {
  return postJson(`${BASE_PATH}/${sessionId}/placement-preview`, { imageData });
}

/**
 * Mint a share link for a saved placement preview, through the existing
 * durable share store (`POST /api/v1/designs/share`, issue #64) — the same
 * endpoint and the same `shared_designs` collection that /designs shares go
 * to. Deliberately NOT a second sharing mechanism: the preview is just
 * another design image as far as the store is concerned.
 *
 * `imageUrl` must be the saved `brief.placementPreviewUrl`, never the raw
 * canvas data URL — a share link has to outlive this browser tab.
 *
 * NOTE: PR #168 introduces `src/features/share/services/shareApi.ts` around
 * this same endpoint. When it lands, collapse this onto that client rather
 * than keeping two callers.
 */
export async function sharePlacementPreview(share: {
  imageUrl: string;
  prompt: string;
  style?: string;
  bodyPart?: string;
}): Promise<string> {
  const res = await postAuthed('/api/v1/designs/share', share);
  const data = (await res.json().catch(() => null)) as
    | { shareUrl?: string; error?: string }
    | null;

  if (!res.ok || !data?.shareUrl) {
    // 503 is the store refusing to mint a link it cannot serve later.
    throw new Error(data?.error ?? 'Could not create a share link — try again.');
  }
  return data.shareUrl;
}

/**
 * POST /api/v1/design-session/converse — one conversational intake turn
 * (ADR-0019). Omit sessionId and message to open a new conversation. A 503
 * (every provider down) throws ConversationUnavailableError so the UI can
 * fall back to the scripted intake.
 *
 * Deliberately NOT postAuthed: talking to SketchBot is free and open to
 * signed-out visitors (ADR-0041 gates generation, not conversation), and a
 * session starts unowned until a charged action stamps it (#357). A signed-in
 * caller still sends their token — the route uses it for per-user rate
 * limiting and the ownership check.
 */
export async function converse(request: ConverseRequest): Promise<ConverseResponse> {
  const res = await settleWithin(
    postMaybeAuthed(`${BASE_PATH}/converse`, request),
    CONVERSATION_TIMEOUT_MS,
    'SketchBot is taking longer than expected — try again.'
  );

  let data: unknown = null;
  try {
    data = await res.json();
  } catch {
    // Non-JSON body — fall through to status error.
  }

  const errorMessage = (data as { error?: string } | null)?.error;
  if (res.status === 503) {
    throw new ConversationUnavailableError(errorMessage ?? 'Conversation unavailable');
  }
  if (!res.ok) {
    throw new Error(errorMessage ?? `Design conversation request failed (${res.status})`);
  }
  if (!data) throw new Error('Design conversation response was empty');
  return data as ConverseResponse;
}

/**
 * POST /api/v1/design-session/[id]/confirm — the user's yes to the proposal
 * (ADR-0020). Fires generation and responds with the revealed DesignSession.
 *
 * Retries automatically while the route reports the failure as retryable
 * (the image provider throttling, in practice), honoring its retry-after
 * hint. This is the layer above the generation provider's own per-prediction
 * retries: when a whole throttle window outlasts the request, the confirm
 * itself has to be re-sent — previously the user's only recovery was a
 * manual RETRY button under a generic "Design session request failed".
 *
 * Only retryable failures are retried, and only ever after a failure, so a
 * confirm that produced renders is never re-sent.
 */
export async function confirmProposal(sessionId: string): Promise<DesignSession> {
  const path = `${BASE_PATH}/${sessionId}/confirm`;

  for (let attempt = 1; ; attempt += 1) {
    try {
      return await postJson(path, {});
    } catch (error) {
      const retryable =
        error instanceof DesignSessionRequestError && error.retryable;
      if (!retryable || attempt >= MAX_CONFIRM_ATTEMPTS) throw error;

      const wait = Math.min(
        (error as DesignSessionRequestError).retryAfterMs ?? 10_000,
        MAX_RETRY_WAIT_MS
      );
      await sleep(wait);
    }
  }
}
