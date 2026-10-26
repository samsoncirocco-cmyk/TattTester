# Spec 7 — /design session in the URL, with resume

Status: draft · Effort: **M** · Depends on: none; [9](09-first-cut-as-it-lands-and-elapsed-time.md) reuses the same GET and the in-flight flag · Rollup rank 8 (gaps G1, R4)

## 1. Problem

A refresh during the reveal throws away the two cuts the customer's credit already paid for. Wrong on day one: the first customer to reload, switch apps on a phone, or lose signal mid-render restarts at the opener while the server finishes the render and keeps the credit.

Line numbers below: map citations are against main @ 6b1a0af; the reveal/confirm files shifted with PR #401 (3544d91, now in the base 1e301a1), so orchestrator lines were re-read at 1e301a1 and are marked "(1e301a1)".

- `/design` has no session key. It reads only `?prompt=` (`src/app/design/page.tsx:18-21`). `?ds=<sessionId>` is the handoff key for `/smart-match`, `/swipe`, `/book` and `/visualize` (`src/app/swipe/SwipeClient.tsx:22-24,42`; `src/app/smart-match/SmartMatchClient.tsx:27-33,68`), not for `/design` (generation/matching map §0).
- `sessionId`, `messages` and `revealSession` live in React state only (`src/features/design-session/components/DesignConversation.tsx:83-96`). No `localStorage`/`sessionStorage`/URL write exists in `src/features/design-session` (map §D4). A refresh restarts at the opener (`DesignConversation.tsx:172-183`).
- The server keeps rendering after the client disappears and saves the session when both cuts land: `startFromRecord` persists `phase: 'revealed'` only after the renders (`orchestrator.ts:468`, `store.save` at the end of `startFromRecord`, 1e301a1). **Inferred, not executed:** that the serverless handler is not cancelled when the browser aborts; verify on the deployed platform before relying on it (open question 8.3). Since #401 the reveal also holds a render claim (`claimRevealSlot`, `orchestrator.ts:790`, 1e301a1), so a second confirm during the render is refused with `REVEAL_IN_FLIGHT`.
- A read endpoint exists: `GET /api/v1/design-session/[id]` (`src/app/api/v1/design-session/[id]/route.ts:14-41`): API-key auth and the `default` limiter only, returns `{success, session}`. Its only client consumer is `/smart-match`, which reads a completed session's `brief` (`SmartMatchClient.tsx:197-213`).
- The GET returns the public projection `DesignSession` (`types.ts:118-200`): phase, intake, state, variations, rounds, critique cuts, brief. It does **not** include the chat transcript or the in-flight claim; those are server-only (`StoredSession.conversation`, `roundInFlight`; store.ts:30-55,64-71,126).
- The only existing "resume" is `/design?prompt=` for an unfinished saved design (`src/app/designs/designJourney.ts:70`).
- The booking page already treats `?ds=` as "server-side session is the source of truth, no storage key" (booking map §G).

## 2. Competitor evidence

- Gemini: the conversation lives at `/app/{id}`; reload restores both user turns and both model turns server-side (rollup G1; `~/reports/tatttester/2026-10-24-rea-gemini.html`, reload test; image bitmap decode after reload was **not confirmed**, and whether an in-flight image completes after reload was **not tested**).
- Krea: the tool navigates to `/image/{sessionId}` on first generation; reloading restores the prompt, the model chip, the result and the free counter; sessions are listed in a sidebar (R4; `~/reports/tatttester/2026-10-24-rea-krea.html`, reload test). Refresh *mid-render* was not tested.

## 3. Scope and non-goals

In scope: the session id in the `/design` URL as `?ds=`; hydration from the existing GET; a "picking up where you left off" state for each phase; showing a render that is still running.

Non-goals: a session history list or sidebar (Krea has one; later); resuming the Studio/Forge path (`tattester_generation_session` in localStorage is a different system); sharing a session with another person; changing what a credit costs; streaming (spec 9).

## 4. Proposed change

### 4.1 User-visible behaviour

1. As soon as the conversation creates a session, the address bar becomes `/design?ds={id}`. Copying that link into a new tab or reloading returns to the same place.
2. On load with `?ds`, the page shows a short "Picking up where you left off" line and then the right state:
   - `intake` phase: the earlier chat is shown and the conversation continues (the server already has the transcript).
   - Reveal still rendering: the waiting state ("two cuts, almost dry…") with no second charge; when the cuts land they appear.
   - `revealed`: the two cuts with the pick/refine controls as they were; `picked`/`complete`: the corresponding view.
3. A session that belongs to someone else, or no longer exists, falls back to a fresh start with one quiet line; it never shows another person's cuts.
4. `?prompt=` and `?ds=` together: `ds` wins.

### 4.2 Data and API

- **URL write.** After the first `converse` response returns `sessionId` (`DesignConversation.tsx` handles it), `history.replaceState` to add `?ds=`. Use the Next router's `replace` with `scroll:false` if the page is a client component under the app router (verify; `app/design/page.tsx` is a server component passing `initialPrompt`).
- **Hydration.** `app/design/page.tsx` reads `ds` and passes `initialSessionId`. `DesignConversation` on mount: if set, `GET /api/v1/design-session/{id}`; map the projection to existing state (`revealSession`, `sessionId`, `stage`).
- **Projection additions** (additive, so `/smart-match` is unaffected): `rendering?: { kind:'reveal'|'round', since: ISO }` derived from `roundInFlight` (without exposing the claim id or reservation id), and `transcript?: ConversationMessage[]` for `intake`-phase sessions, only when the caller owns the session (below). The transcript projection includes the bot and user text the client already rendered, nothing from `turnLogs`/telemetry (the existing rule that TurnLog "stays server-side", `DesignConversation.tsx` doc comment).
- **Ownership.** The GET currently performs no uid check (API key + rate limit only, `[id]/route.ts:20-31`). Session ids are UUIDs, and `?ds=` links already travel through `HandoffCard` (`/smart-match?ds=…`), so the existing posture is "the id is the capability". Putting the id in the address bar widens how often it appears in browser history and shared screenshots. Recommended: when `ownerUid` is set (stamped by the first charged action, `store.ts:128-134`, `orchestrator.ts:156-175`), GET returns `transcript` and `rendering` only if the caller's verified uid matches; the base projection stays as today for `/smart-match`. Sessions that are still unowned (no charged action yet) are readable by id, as today. **Unverified:** whether any consumer relies on a signed-out GET of an owned session (the booking handoff passes `ds` for a *signed-in* flow per map §G; confirm before tightening).
- **No new write routes.** Hydration is read-only; the confirm/round routes are unchanged.
- **Signed-out customers.** The reveal requires sign-in (confirm route auth, map §A2), so an `intake`-phase session can exist for a signed-out customer. Their resume works from the id (unowned) but the transcript is returned only for owned sessions in the recommended rule; for unowned `intake` sessions return the transcript too, since it is only what they typed (decision in 8.2).

### 4.3 Copy (ADR-0036)

No money mentioned. "TattTester" appears nowhere new. Voice is the Sketchbot register already used on this page (lowercase, short).

- Resume line: "picking up where you left off."
- Still rendering: reuse the existing beat lines; add "still drawing — your credit's already spent on this one, no second charge."  Money-free wording alternative if counsel prefers: "still drawing — this is the same round, not a new one."
- Not found / not yours: "couldn't find that sketch — starting fresh."

## 5. Failure and edge cases

1. GET returns 404: show the not-found line, drop `ds` from the URL, start fresh.
2. Session is mid-render and the render then *fails*: the server releases the credit and clears the claim; the polled GET (spec 9) shows no `rendering`; the client shows the existing "didn't take — your credit is back" copy. Until spec 9 lands, hydration shows the beat for at most the stale-claim window (10 minutes, `store.ts:78`) then offers "start over".
3. Stale claim after a crash (render died without release): `rendering.since` older than 10 minutes is treated as not rendering; the credit reconciliation for the evicted claim is a log today, not an automatic refund (map §D4). This spec does not fix that; flag it.
4. Two tabs on the same `ds`: both read the same state; the claim already prevents two paid renders (`REVEAL_IN_FLIGHT`, `ROUND_IN_FLIGHT`).
5. `ds` for a `complete` session: show the finished design and the handoff card, not the chat opener.
6. Demo mode / in-memory store (`store.ts:394-398`): ids do not survive a server restart; resume returns 404, acceptable.
7. Leaving a session on purpose: provide "start a new sketch" that clears `ds`.
8. Browsers that block `history.replaceState` are not a concern; the id is also kept for the session in `sessionStorage` as a fallback (optional, wrapped in try/catch).

## 6. Test plan

Extend:
- `src/features/design-session/__tests__/DesignConversation.test.tsx`: first converse response writes `?ds=`; mount with `initialSessionId` calls GET and renders `revealed` cuts; mount with a 404 starts fresh; `ds` beats `prompt`.
- `src/features/design-session/__tests__/DesignSessionFlow.test.tsx`: hydrated `picked`/`complete` sessions open on the right step.
- `src/app/api/v1/design-session/__tests__/get.test.ts`: `rendering` appears while a claim exists and never exposes the claim or reservation id; `transcript` only for the owner; unowned sessions unchanged; `/smart-match` consumer shape unchanged.
- `src/services/designSession/__tests__/sessionStore.test.ts`: projection helper derives `rendering` from `roundInFlight`, and ignores a claim older than the stale window.

Add:
- `src/app/design/__tests__/page.resume.test.tsx` (new): server component passes `ds` to the client component; `prompt`-only behaviour unchanged.

## 7. Effort and dependencies

M: URL plumbing, hydration state mapping for four phases, a projection addition, an ownership rule. Spec 9 builds directly on the `rendering` flag and the polled GET; do this first.

## 8. Open questions for Samson

1. Use `?ds=` (consistent with the other pages) or a path like `/design/{id}`? Recommendation: `?ds=`, zero new routes.
2. Should a signed-out customer's `intake` chat be resumable from the id alone? Recommendation: yes; it contains only what they typed and nothing is charged.
3. Please confirm on the deployed platform whether a render survives the browser disconnecting (the whole premise of "your cuts are waiting"). If the handler is cancelled, resume would show a failed round, not a finished one; the fix would be to move the render to a background job, which is a larger change than this spec.
