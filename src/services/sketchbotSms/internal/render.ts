/**
 * SMS rendering + fixed channel phrasings (TAT-49).
 *
 * The conversation engine writes for a chat pane; SMS needs the same
 * consultant voice in a tighter frame: no markdown, no long turns. Long
 * replies get TIGHTENED at sentence boundaries — the closing sentence (the
 * bot's question/affordance almost always lives there) is always kept, and
 * earlier sentences are dropped from the middle out. Never a mid-sentence
 * truncation.
 *
 * The canned texts stay in the persona's register (ADR-0021: consultant,
 * never a wall — refusals are judgment calls or honest capacity, not
 * "limit reached").
 */
import {
  referenceAckText as sharedReferenceAck,
  referenceOverflowText,
  type ReferenceAnalysis,
} from '@/services/vision';

/** ~3 GSM-7 segments. Beyond this a turn stops being a text message. */
export const SMS_MAX_CHARS = 450;

/** Strip the markdown the engine may emit down to plain SMS text. */
export function stripMarkdown(text: string): string {
  return (
    text
      // [label](url) → "label url" — the URL must survive, SMS has no anchors.
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 $2')
      .replace(/(\*\*|__)(.*?)\1/g, '$2')
      .replace(/(\*|_)(.*?)\1/g, '$2')
      .replace(/`{1,3}([^`]*)`{1,3}/g, '$1')
      .replace(/^#{1,6}\s+/gm, '')
      .replace(/^\s*[-*•]\s+/gm, '- ')
      // Whitespace: newlines collapse to spaces (short SMS turns read as
      // one paragraph), runs collapse to one space.
      .replace(/\s*\n+\s*/g, ' ')
      .replace(/[ \t]{2,}/g, ' ')
      .trim()
  );
}

function sentences(text: string): string[] {
  // Split after terminal punctuation; keeps the punctuation with the sentence.
  return text.split(/(?<=[.!?…])\s+/).filter((s) => s.length > 0);
}

/**
 * Render one bot turn for SMS: strip markdown, then tighten to maxChars.
 * Tightening keeps the FIRST sentence(s) that fit alongside the LAST
 * sentence — openers carry the reaction, closers carry the question — and
 * drops the middle. Only a single over-long sentence is ever word-cut.
 */
export function renderSmsReply(text: string, maxChars: number = SMS_MAX_CHARS): string {
  const plain = stripMarkdown(text);
  if (plain.length <= maxChars) return plain;

  const parts = sentences(plain);
  const last = parts[parts.length - 1];

  if (parts.length === 1) {
    // One giant sentence — the pathological case. Cut on a word boundary.
    const cut = plain.slice(0, maxChars - 1);
    return `${cut.slice(0, cut.lastIndexOf(' '))}…`;
  }

  const kept: string[] = [];
  let used = last.length + 1; // room for the closing sentence + a space
  for (const part of parts.slice(0, -1)) {
    if (used + part.length + 1 > maxChars) break;
    kept.push(part);
    used += part.length + 1;
  }
  if (kept.length === 0) {
    // Even sentence #1 doesn't fit next to the closer — closer alone wins.
    return last.length <= maxChars ? last : renderSmsReply(last, maxChars);
  }
  return [...kept, last].join(' ');
}

// ─── Fixed channel phrasings ────────────────────────────────────────────

/** Ack sent the moment a reveal is armed — renders take minutes. */
export const REVEAL_ACK =
  "On it. I'm sketching two cuts now — give me a couple of minutes and they'll land right here.";

/** Per-phone daily reveal cap reached — a judgment call, never a wall. */
export function capReachedText(webUrl: string): string {
  return (
    "I've put a lot in front of you today — I'd rather you sit with these than pile on more. " +
    `Fresh eyes tomorrow, or keep working what you have here: ${webUrl}`
  );
}

/** Global budget exhausted — honest capacity, never silence. */
export const BUDGET_EXHAUSTED_TEXT =
  "We're at capacity today — I can't render new designs right now. Your ideas are saved; text me tomorrow and we'll pick this right up.";

/** Account-link gate after the free reveals: the invitation, in voice. */
export function linkGateText(signupUrl: string): string {
  return (
    "You've got two full sets from me — at this point you deserve a real workspace. " +
    `Grab a free account and everything we've made together comes with you: ${signupUrl}`
  );
}

/** Generation failed after the ack — own it, refund is already done. */
export const REVEAL_FAILED_TEXT =
  "That render didn't come together — my fault, not yours, and it didn't count against you. Give it another go in a few minutes.";

/**
 * Same failure, but the generation-credit release did not land. The copy
 * must not claim the ledger was untouched.
 */
export const REVEAL_FAILED_NO_REFUND_TEXT =
  "That render didn't come together — my fault, not yours. Give it another go in a few minutes.";

/** Conversation providers all down (the web flow's 503 path, in voice). */
export function unavailableText(webUrl: string): string {
  return `I'm having trouble thinking straight right now. Try me again shortly — or design on the site: ${webUrl}`;
}

/**
 * An unexpected failure on a VERIFIED inbound — the catch-all's in-voice
 * answer. The channel's rule is that a refusal is always a reply the texter
 * can read (see internal/adapter.ts); an HTTP 500 is not, because Twilio
 * sends nothing on it and the texter just watches their message go nowhere.
 */
export const INTERNAL_ERROR_TEXT =
  "Something went sideways on my end — that's mine to fix, not yours. Text me again in a minute and I'll pick this straight back up.";

/**
 * Closing text of a round's MMS sequence (ADR-0049 acceptance copy): the
 * two cuts named by their poles, the A/B ask, and the bridge into the web
 * session. Pole labels are computed from the round's axis — never
 * hardcoded per axis.
 */
export function roundRevealText(
  poleA: string,
  poleB: string,
  shareUrl: string
): string {
  return (
    `Two cuts this round: A is ${poleA}, B is ${poleB}. Reply A or B. ` +
    `See them big here: ${shareUrl}`
  );
}

/** The round pick landed (ADR-0049 acceptance copy) — changeable until REFINE. */
export const ROUND_LOCKED_TEXT =
  "Locked. Reply REFINE for the next round (1 credit) or BOOK when you're ready.";

/** Ack sent the moment a REFINE round is armed — two renders take minutes. */
export const ROUND_ACK =
  "On it — cutting the next round now. Two new cuts land here in a minute or two.";

/**
 * A charged round failed after the ack (ADR-0049 acceptance copy). Sent
 * only when the credit release actually landed — the refund claim and the
 * refund ship together or not at all.
 */
export const ROUND_FAILED_TEXT =
  "That round didn't take — your credit is back. Reply REFINE to try again.";

/** Same failure when the release itself failed: no refund claim made. */
export const ROUND_FAILED_NO_REFUND_TEXT =
  "That round didn't take. Reply REFINE to try again.";

/** REFINE before any A/B — the round has no pick to refine from. */
export function roundUnpickedText(): string {
  return 'Pick one first — reply A or B, then REFINE cuts the next round from it.';
}

/** The BOOK reply: straight to the artists, carrying the session. */
export function bookText(matchUrl: string): string {
  return `Here are the artists whose work actually fits it: ${matchUrl}`;
}

/** Caption for one of a round's two cuts — "Cut A — bold". */
export function roundCutCaption(letter: 'A' | 'B', poleLabel: string): string {
  return `Cut ${letter} — ${poleLabel}`;
}

/** The reply named no single cut — ask again without scolding. */
export function pickRetryText(cutCount: number): string {
  return `Just the number — 1 to ${cutCount} — whichever one you'd actually put on your body.`;
}

/** The pick landed; now the one clean negative signal (ADR-0012). */
export function mostNotYouQuestion(pickedNumber: number): string {
  return `Cut ${pickedNumber} it is. Now the opposite: which one is the least you? That tells me what to steer away from.`;
}

/** The most-not-you tap named the cut they already picked. */
export function pickCollisionText(cutCount: number): string {
  return (
    `That's the one you're keeping — I need a different number for the one ` +
    `that's least you. Any of the other ${Math.max(cutCount - 1, 1)}.`
  );
}

/** Praise with no instruction in it — answered, never silently ignored. */
export function chatterAckText(): string {
  return (
    'Glad they landed. Reply A or B to pick this round, or tell me what to ' +
    'change on either of them.'
  );
}

/** Ack sent the moment a critique re-cut is armed. */
export const CRITIQUE_ACK = "On it — reworking that now. Back in a moment.";

/** The critique render failed after the ack — own it, invite the retry. */
export const CRITIQUE_FAILED_TEXT =
  "That re-cut didn't come together — my fault, not yours. Say it again and I'll take another run at it.";

/** Ack sent the moment a refinement is armed — one render still takes time. */
export const REFINE_ACK = "Got it. Reworking that one now — back in a moment.";

/** Caption on the single regenerated design. */
export const REFINED_CAPTION = 'The tightened version';

/** Caption on the derived black line art — the artist's working file. */
export const STENCIL_CAPTION =
  'The stencil — black line art your artist can resize and rearrange';

/**
 * Closing text once the session is complete. This is the only SMS exit that
 * carries the session id, because it is the only point where a Brief exists
 * — /smart-match?ds= reads it to pre-select styles and enrich the search,
 * and threads the id onward so the booking records which design it came from.
 *
 * The copy only promises a stencil when one actually rendered: derivation is
 * off by default and can fail, and a text claiming two files when one
 * arrived reads as a broken send.
 */
export function refinedClosingText(matchUrl: string, hasStencil = false): string {
  const lead = hasStencil
    ? 'Two files: the design you approved, and the stencil your artist inks from.'
    : "That's the one an artist works from.";
  return `${lead} Here are the artists whose work actually fits it: ${matchUrl}`;
}

/** The refinement render failed after the ack — own it, offer the retry. */
export const REFINE_FAILED_TEXT =
  "That rework didn't come together — my fault, not yours. Tell me again what you'd change and I'll take another run at it.";

/** Caption for cut n of the session's running order (critique re-cuts). */
export function cutCaption(index: number, total: number): string {
  return `Cut ${index + 1} of ${total}`;
}

// ─── Reference images (TAT-50) ──────────────────────────────────────────

/**
 * The acknowledgment sentence(s) for a message's analyzed reference photos
 * — SketchBot NEVER silently ingests an image; every reading is named back.
 * Voice pieces are shared with the web channel via '@/services/vision'.
 */
export function referenceAckText(
  analyses: ReferenceAnalysis[],
  ignored: number,
  unreadable = 0
): string {
  const parts: string[] = [];
  if (analyses.length === 1) {
    parts.push(sharedReferenceAck(analyses[0]));
  } else if (analyses.length > 1) {
    parts.push(
      `Got your photos — I'm seeing ${analyses.map((a) => a.summary).join('; and ')}.`
    );
  }
  if (unreadable > 0 && analyses.length > 0) {
    parts.push(
      unreadable === 1 ? "One of them I couldn't make out." : `${unreadable} of them I couldn't make out.`
    );
  }
  if (ignored > 0) parts.push(referenceOverflowText(analyses.length));
  return parts.join(' ');
}

// ─── Placement preview ──────────────────────────────────────────────────

/** Caption on the composite — the design laid on the texter's own photo. */
export const PLACEMENT_CAPTION = 'On you';

/** Ack the moment a body photo arrives; compositing takes a few seconds. */
export const PLACEMENT_ACK =
  "Let me put it on you — one sec.";

/** The composite landed. Names the one adjustment the channel understands. */
export const PLACEMENT_DONE_TEXT =
  "That's it at roughly life size. Send the photo again with \"bigger\" or \"smaller\" if the scale is off.";

/** No design exists yet to lay on a body. */
export const PLACEMENT_NO_DESIGN_TEXT =
  "I don't have a design to put on you yet — tell me what you're after and I'll draw some first.";

/** The photo could not be read (too large, wrong type, fetch failed). */
export const PLACEMENT_UNREADABLE_TEXT =
  "I couldn't open that photo. A regular JPEG or PNG straight from your camera works best.";

/**
 * The design is an opaque scene rather than flash art on white, so
 * compositing it would lay someone else's body over the texter's own — the
 * failure `designBackdrop` exists to prevent. Said honestly, never silently.
 */
export const PLACEMENT_UNUSABLE_DESIGN_TEXT =
  "That render came out as a photo rather than clean flash art, so I can't lay it on your skin properly. Ask me to redo it and I'll get you a clean one.";

/** Compositing failed for an unexpected reason — own it. */
export const PLACEMENT_FAILED_TEXT =
  "That didn't come together on my end — send the photo again and I'll have another go.";
