/**
 * The reply-time promise on the request model.
 *
 * Request mode takes a deposit and then waits on a human. Competitor study
 * (REA roll-up 2026-10-23, gap #3) found that every booking product a
 * first-time customer has used states when they will hear back; TattTester
 * said it nowhere a customer could see. The API's own "within 24 hours" string
 * was never rendered, and 24 hours is not a promise an artist who tattoos all
 * day can keep. 48 hours is the window we commit to on screen.
 *
 * One constant, one sentence builder, so the request card, the success page
 * and the API message cannot drift apart. The expiry that enforces this
 * window (an unanswered request auto-refunds) is a follow-up, not in here.
 */
export const REQUEST_REPLY_HOURS = 48;

/**
 * The sentence shown wherever a request-mode customer is told what happens
 * next. Claimed artists reply themselves; for an unclaimed profile TattTester
 * relays the request, so the promise is that the customer hears back from us.
 */
export function requestReplyPromise(
  artistName: string,
  artistClaimed = true,
): string {
  return artistClaimed
    ? `${artistName} replies within ${REQUEST_REPLY_HOURS} hours to confirm a time or suggest another.`
    : `TattTester relays your request and you hear back within ${REQUEST_REPLY_HOURS} hours, whether or not ${artistName} has replied.`;
}
