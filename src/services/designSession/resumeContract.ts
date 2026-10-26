// What GET /api/v1/design-session/[id] adds for a caller allowed to resume
// the session (spec 7). Pure and client-safe: no server imports, so the
// /design page reads the same header name and shape the route writes.

import type {
  ConversationMessage,
  ConversationStage,
  SessionNotes,
} from '../designConversation/types';

/**
 * The header a signed-out browser sends to prove it created the session.
 * The value is the resume key returned once by the opening converse call.
 */
export const DESIGN_SESSION_KEY_HEADER = 'x-design-session-key';

/**
 * A charged render that was still running when the session was read.
 * `stale` means the claim outlived the stale window: the render is presumed
 * dead, so the client offers a re-run instead of waiting on it. The claim
 * id and the credit reservation id never leave the server.
 */
export interface SessionRendering {
  kind: 'reveal' | 'round';
  since: string;
  stale: boolean;
}

/**
 * The parts of a session only its owner sees. Everything here is either
 * what the customer typed or what the bot already said to them; TurnLogs,
 * scores and rationale stay server-side.
 */
export interface SessionResumeView {
  transcript: ConversationMessage[];
  stage?: ConversationStage;
  playback?: string;
  notes?: SessionNotes;
  handoffUrl?: string;
  rendering?: SessionRendering;
}
