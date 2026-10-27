/**
 * Artist notifications.
 *
 * When a held deposit lands for an unclaimed artist, we want to reach out and
 * nudge them to claim their profile and finish Stripe onboarding so the funds
 * can be released. We log the claim link (unchanged) AND attempt a real
 * transactional email through whatever provider is configured
 * (see emailQueueService.sendTransactionalEmail). A notification failure must
 * never break the Stripe webhook, so delivery is best-effort and swallowed.
 */
import type { BookingRelay } from '@/lib/booking-relay';
import type { TakedownRequest } from '@/lib/takedown';
import type { ReinstatementRequest } from '@/lib/reinstatement';
import type { PendingArtistClaim } from '@/lib/artist-claim';
import type { ArtistIntroRequest } from '@/lib/artist-intro';
import { getArtistStripe } from '@/lib/artist-stripe';
import { artistDepositNotificationMoneyCopy } from '@/lib/money-copy';
import { sendTransactionalEmail } from '@/services/emailQueueService';

/** Notify an artist that a deposit is being held for them, with a claim link. */
export async function notifyArtistOfBooking(relay: BookingRelay): Promise<void> {
  const base = (process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000').replace(/\/$/, '');
  const claimLink = `${base}/claim/${relay.artistId}`;

  console.log('[notify] held deposit awaiting claim', {
    relayId: relay.id,
    artistId: relay.artistId,
    customerEmail: relay.customerEmail,
    amountCents: relay.amountCents,
    claimLink,
  });

  // Best-effort real email. Look up the artist's own address from the graph
  // (BookingRelay carries no such field). For scraped/unclaimed artists we
  // often don't have one, so fall back to an ops inbox. If we have neither,
  // the log above is the only record — that's acceptable degradation.
  // getArtistStripe never throws (its read helper degrades to []/null on
  // any Neo4j failure), so no try/catch is needed here.
  const artist = await getArtistStripe(relay.artistId);
  const to = artist?.email || process.env.OPS_NOTIFY_EMAIL;
  if (!to) return;

  const amount = (relay.amountCents / 100).toLocaleString('en-US', {
    style: 'currency',
    currency: (process.env.STRIPE_CURRENCY || 'usd').toUpperCase(),
  });

  const subject = 'A client left a deposit for you on TattTester';
  const moneySentence = artistDepositNotificationMoneyCopy(amount);
  const text =
    `Good news — a client just left a ${amount} deposit for you on TattTester.\n\n` +
    `${moneySentence}\n\n` +
    `Claim your profile and finish setup to release the funds:\n${claimLink}\n\n` +
    `The deposit is held securely until you claim it.`;
  const html =
    `<p>Good news — a client just left a <strong>${amount}</strong> deposit for you on TattTester.</p>` +
    `<p>${moneySentence}</p>` +
    `<p>Claim your profile and finish setup to release the funds:</p>` +
    `<p><a href="${claimLink}">${claimLink}</a></p>` +
    `<p>The deposit is held securely until you claim it.</p>`;

  try {
    await sendTransactionalEmail({ to, subject, text, html });
  } catch (err) {
    // Delivery is best-effort; never let a notification failure propagate into
    // the Stripe webhook. sendTransactionalEmail already avoids throwing, but
    // we guard here too as a belt-and-suspenders measure.
    console.error('[notify] transactional email failed (non-fatal)', err);
  }
}

/** Outcome of a notification that the caller is expected to act on. */
export type NotifyResult = { delivered: true } | { delivered: false; reason: string };

/**
 * Send the human relay queue a browse-only introduction request. This is not a
 * best-effort notification: browse-only exists precisely because TatT must not
 * claim a delivery path it cannot prove. Callers surface an undelivered result.
 */
export async function notifyOpsOfArtistIntroRequest(
  request: ArtistIntroRequest,
  requestId: string,
  artistName: string,
  brief?: Record<string, unknown>,
): Promise<NotifyResult> {
  const to = process.env.OPS_NOTIFY_EMAIL;
  if (!to) {
    return { delivered: false, reason: 'OPS_NOTIFY_EMAIL is not configured — an intro request would reach nobody.' };
  }
  const subject = `[Artist intro] ${artistName} — relay requested`;
  const sessionBlock = request.designSessionId
    ? `Design session: ${request.designSessionId}\n`
    : '';
  const briefBlock = brief
    ? `\nBrief:\n${JSON.stringify(brief, null, 2)}\n`
    : '';
  const text =
    `A customer asked TatT to introduce them to a browse-only artist.\n\n` +
    `Request id:   ${requestId}\nArtist id:    ${request.artistId}\nArtist:       ${artistName}\n` +
    `Customer:     ${request.clientName}\nEmail:        ${request.clientEmail}\n` +
    sessionBlock +
    `\nNote:\n${request.message || '(none)'}\n` +
    briefBlock +
    `\n--- NO DEPOSIT WAS TAKEN ---\n` +
    `This profile is not in the bookable tier. Contact the artist through the verified shop channel, then reply to the customer with the outcome. Do not promise availability or a booking.`;
  try {
    const result = await sendTransactionalEmail({ to, subject, text, replyTo: request.clientEmail });
    return result?.sent
      ? { delivered: true }
      : { delivered: false, reason: result?.reason || 'email provider reported the send as unsent' };
  } catch (err) {
    return { delivered: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Tell ops that a signed-in account asked to own a scraped artist profile.
 *
 * The request route has no ownership powers. This notification describes the
 * human check and the dry-run-first approval command; an undelivered request is
 * reported to the artist instead of pretending somebody will review it.
 */
export async function notifyOpsOfArtistClaim(
  request: PendingArtistClaim,
  artistName: string | null,
): Promise<NotifyResult> {
  const to = process.env.OPS_NOTIFY_EMAIL;
  if (!to) {
    return {
      delivered: false,
      reason: 'OPS_NOTIFY_EMAIL is not configured — a claim request would reach nobody.',
    };
  }

  const handle = request.instagram?.replace(/^@/, '') || null;
  const proof =
    handle && request.verificationCode
      ? `Open https://instagram.com/${handle} and confirm this code is visible in the bio, a post, or a story:\n\n` +
        `    ${request.verificationCode}\n\n` +
        `Then use --method instagram --approved-by "<your operator id>" --handle-verified.`
      : `This profile has no usable Instagram handle. Verify identity out of band, record exactly what you checked, ` +
        `and use --method manual --approved-by "<your operator id>" --review-note "<specific evidence>".`;
  const subject = `[Artist claim] ${artistName || request.artistId} — identity review required`;
  const text =
    `A signed-in account requested ownership of an artist profile.\n\n` +
    `Request id:   ${request.id}\n` +
    `Artist id:    ${request.artistId}\n` +
    `Artist:       ${artistName || '(unnamed)'}\n` +
    `Instagram:    ${handle ? `@${handle}` : '(none)'}\n` +
    `Firebase uid: ${request.uid}\n` +
    `Contact:      ${request.contactEmail || '(none)'}\n\n` +
    `--- NOTHING HAS CHANGED ---\n` +
    `The requester does not own the profile, cannot edit it, cannot create or access its Stripe account, ` +
    `and cannot receive its held deposits. The public route only recorded this pending request.\n\n` +
    `--- REQUIRED IDENTITY CHECK ---\n${proof}\n\n` +
    `Dry run:\n` +
    `node scripts/approve-artist-claim.mjs --request-id ${request.id}\n\n` +
    `Approval after Instagram proof:\n` +
    `node scripts/approve-artist-claim.mjs --request-id ${request.id} --method instagram ` +
    `--approved-by "<your operator id>" --handle-verified --execute --confirm ${request.id}\n`;

  try {
    const result = await sendTransactionalEmail({
      to,
      subject,
      text,
      ...(request.contactEmail ? { replyTo: request.contactEmail } : {}),
    });
    if (!result?.sent) {
      return {
        delivered: false,
        reason: result?.reason || 'email provider reported the send as unsent',
      };
    }
    return { delivered: true };
  } catch (err) {
    return { delivered: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

/** A moderation hold to include in the ops email. Absent when the call was not used. */
export interface ModerationNotice {
  action: 'review' | 'block';
  summary: string;
}

function moderationParagraph(notice?: ModerationNotice | null): string {
  if (!notice) return '';
  return (
    `Moderation: ${notice.action.toUpperCase()}. ${notice.summary}\n` +
    `Nothing was deleted and this request was not resolved. A person decides.\n\n`
  );
}

/**
 * Tell a human that an artist has asked to be removed. See docs/adr/0025.
 *
 * Unlike notifyArtistOfBooking, this is NOT best-effort and does NOT swallow.
 * A booking notification can fail quietly because the money still moved and the
 * record still exists. A takedown notification failing quietly means nobody
 * learns that an artist asked us to stop using their photographs, while the
 * artist is shown a confirmation. That is worse than having no takedown button
 * at all, so the caller gets the truth and surfaces it.
 *
 * Never throws — a thrown provider error is reported as an undelivered result.
 */
export async function notifyOpsOfTakedownRequest(
  request: TakedownRequest,
  requestId: string,
  moderation?: ModerationNotice | null,
): Promise<NotifyResult> {
  const to = process.env.OPS_NOTIFY_EMAIL;
  if (!to) {
    const reason =
      'OPS_NOTIFY_EMAIL is not configured — a takedown request would reach nobody.';
    console.error(`[notify] takedown request ${requestId} undeliverable: ${reason}`);
    return { delivered: false, reason };
  }

  const base = (process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000').replace(/\/$/, '');
  const scopeLine =
    request.scope === 'images'
      ? 'IMAGES ONLY — remove the re-hosted photos, keep the listing.'
      : 'ALL — remove the photos and suppress the profile.';

  const subject = `[Takedown] ${request.artistId} — artist requested removal`;
  const text =
    `A takedown request was submitted.\n\n` +
    `Request id:   ${requestId}\n` +
    `Artist id:    ${request.artistId}\n` +
    `Profile:      ${base}/artists\n` +
    `Contact:      ${request.contactEmail}\n` +
    `Relationship: ${request.relationship} (self-declared — NOT verified)\n` +
    `Scope:        ${scopeLine}\n\n` +
    `Message:\n${request.message || '(none provided)'}\n\n` +
    moderationParagraph(moderation) +
    `--- Before you remove anything ---\n` +
    `Nothing has been removed. This request changed no data.\n` +
    `Verify the requester controls the artist's Instagram handle (ask them to post\n` +
    `a one-time code, or message you from it). The handle is the identity anchor\n` +
    `for this dataset — see docs/adr/0025 for what that does and does not prove.\n\n` +
    `--- Dry run (reports what WOULD be removed, changes nothing) ---\n` +
    `node scripts/execute-takedown.mjs --artist-id ${request.artistId}\n\n` +
    `--- Execute for real (only after verification) ---\n` +
    `node scripts/execute-takedown.mjs --artist-id ${request.artistId} ` +
    `--scope ${request.scope} --execute --confirm ${request.artistId}\n`;

  try {
    const result = await sendTransactionalEmail({
      to,
      subject,
      text,
      // So an ops reply lands with the person who asked, not in a void.
      replyTo: request.contactEmail,
    });
    if (!result?.sent) {
      const reason = result?.reason || 'email provider reported the send as unsent';
      console.error(`[notify] takedown request ${requestId} not delivered: ${reason}`);
      return { delivered: false, reason };
    }
    console.log(`[notify] takedown request ${requestId} delivered to ops`, {
      artistId: request.artistId,
      scope: request.scope,
    });
    return { delivered: true };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.error(`[notify] takedown request ${requestId} threw during send: ${reason}`);
    return { delivered: false, reason };
  }
}

/**
 * Tell a human that a removed artist has asked to come back. See docs/adr/0026.
 *
 * Like the takedown notification and unlike the booking one, this does NOT
 * swallow. A reinstatement request nobody reads is an artist waiting forever for
 * a profile they asked for.
 *
 * The mail deliberately leads with what the operator must go and *check*. That
 * check is the only identity verification anywhere in this flow — no code can
 * look at an Instagram account — and a mail that read like an approval prompt
 * would turn the one door through the takedown wall into a rubber stamp.
 *
 * Never throws — a thrown provider error is reported as an undelivered result.
 */
export async function notifyOpsOfReinstatementRequest(
  request: ReinstatementRequest,
  requestId: string,
  verificationCode: string,
  moderation?: ModerationNotice | null,
): Promise<NotifyResult> {
  const to = process.env.OPS_NOTIFY_EMAIL;
  if (!to) {
    const reason =
      'OPS_NOTIFY_EMAIL is not configured — a reinstatement request would reach nobody.';
    console.error(`[notify] reinstatement request ${requestId} undeliverable: ${reason}`);
    return { delivered: false, reason };
  }

  const subject = `[Reinstatement] @${request.instagram} — removed artist asks to return`;
  const text =
    `A reinstatement request was submitted by a signed-in account.\n\n` +
    `Request id:   ${requestId}\n` +
    `Instagram:    @${request.instagram}\n` +
    `Firebase uid: ${request.uid}\n` +
    `Contact:      ${request.contactEmail}\n\n` +
    `Message:\n${request.message || '(none provided)'}\n\n` +
    moderationParagraph(moderation) +
    `--- Nothing has changed ---\n` +
    `No tombstone was lifted and no profile was unsuppressed; this request changed\n` +
    `no data. It also does not confirm that this handle was ever removed — the\n` +
    `route answers identically either way, so it cannot be used to find out who has\n` +
    `asked to be taken down. The dry run below tells you the truth.\n\n` +
    `--- YOU MUST CHECK THIS BEFORE APPROVING ---\n` +
    `Open https://instagram.com/${request.instagram} and confirm this code is\n` +
    `published there (bio, post, or story) by the account holder:\n\n` +
    `    ${verificationCode}\n\n` +
    `That check is the ONLY identity verification in this flow. Code cannot read\n` +
    `Instagram. If you cannot see the code, stop — and see docs/adr/0026 for what\n` +
    `this does and does not prove (notably: it does not survive a hijacked account).\n\n` +
    `--- Dry run (reports what WOULD change, changes nothing) ---\n` +
    `node scripts/execute-reinstatement.mjs --instagram ${request.instagram}\n\n` +
    `--- Approve (only after seeing the code on the account) ---\n` +
    `node scripts/execute-reinstatement.mjs --instagram ${request.instagram} \\\n` +
    `  --handle-verified --execute --confirm ${request.instagram}\n\n` +
    `Reinstatement restores NOTHING that was deleted: the photographs and the\n` +
    `embedding are gone, and the node was scrubbed. The artist gets an empty\n` +
    `profile bound to their account, which they fill in themselves. The ingest\n` +
    `tombstone stays in place permanently either way, so no future scrape can\n` +
    `re-add them.\n`;

  try {
    const result = await sendTransactionalEmail({
      to,
      subject,
      text,
      // So an ops reply lands with the artist who asked, not in a void.
      replyTo: request.contactEmail,
    });
    if (!result?.sent) {
      const reason = result?.reason || 'email provider reported the send as unsent';
      console.error(`[notify] reinstatement request ${requestId} not delivered: ${reason}`);
      return { delivered: false, reason };
    }
    console.log(`[notify] reinstatement request ${requestId} delivered to ops`, {
      instagram: request.instagram,
    });
    return { delivered: true };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.error(`[notify] reinstatement request ${requestId} threw during send: ${reason}`);
    return { delivered: false, reason };
  }
}
