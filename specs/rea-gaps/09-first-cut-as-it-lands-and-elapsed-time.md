# Spec 9 — Deliver the first finished cut as it lands, and show elapsed time

Status: draft · Effort: **M** (the elapsed counter alone is **S**) · Depends on: [7](07-design-session-in-the-url.md) (the polled GET, the `rendering` flag) · Rollup rank 10 (gaps G2, R2)

## 1. Problem

The reveal and every refine round are one blocking POST that returns only when both cuts are done. Wrong on day one: on a slow lane the customer stares at rotating lines for minutes with no sign of progress, although the first cut may have been ready long before the second.

Line numbers: map citations are main @ 6b1a0af; the orchestrator moved with #401, so its lines are re-read at 1e301a1.

- Confirm is one blocking `fetch` (`src/features/design-session/services/designSessionApi.ts:371-389`), `maxDuration = 300` (`src/app/api/v1/design-session/[id]/confirm/route.ts:24`). Rounds are the same (`round/route.ts`, same 300 s). No polling or streaming on the design-session path; polling exists only on the Studio/Forge `/api/predictions` path (map §0.3, §A5).
- Two cuts render in parallel through `Promise.allSettled` (`orchestrator.ts` `startFromRecord`, 1e301a1 around `:426-460`), each through `renderDurably` (`orchestrator.ts:307`), one provider call per image (`pinnedRequest` sets `numImages: 1`, `:232-270`). The session is written once, after both finish (`store.save`, end of `startFromRecord`; rounds the same in `renderRoundCuts`, `:930`). If one cut rejects, the whole reveal throws (`failure = results.find(rejected)`).
- Each image is copied into our GCS bucket before the URL is stored; the provider URL is never served (`internal/durableImage.ts:1-18,58-60`; map §A2), so a cut URL is durable the moment `renderDurably` returns.
- While waiting, `GeneratingBeat` rotates `REVEAL_BEAT_LINES` every 2600 ms with no percentage or time (`src/features/design-session/components/GeneratingBeat.tsx:17-22,31`); refine and critique use `REFINE_BEAT_LINES` (`:25-29`). Used at `DesignSessionFlow.tsx:288-290,353,375`.
- The client treats confirm as a single promise; provider throttles are retried silently up to 3 times with the hinted wait (`designSessionApi.ts:61-63,371-389`), which can stretch the wait further.

## 2. Competitor evidence

- Gemini: one streaming request, then short status polls; the turn is visible immediately and the image lands in at most ~90 s; the only signal is the sentence "Creating your image", no timer (rollup G2; `~/reports/tatttester/2026-10-24-rea-gemini.html`, `ev_0c0223de`: prompt sent 17:23:30 UTC, image by 17:25:00).
- Krea: job accepted immediately; progress and the finished image arrive on a held-open stream; the page shows "Generating · Loading 3s" with a live elapsed counter; image present about 8 s after the click (R2; `~/reports/tatttester/2026-10-24-rea-krea.html`, `ev_d1b35b13`, 0 polls seen in 100 s). Two single runs each; not a latency distribution.

## 3. Scope and non-goals

In scope: the first finished cut appears as soon as it exists, for the reveal and for rounds; an elapsed-time counter in the waiting state; a safe way for a refresh to see partial progress (builds on spec 7).

Non-goals: percentage progress bars (no provider reports one); changing the two-cut model or credit unit (ADR-0049); streaming tokens of the Council; making the confirm POST asynchronous/fire-and-forget (larger change; see 4.2 alternative); showing a cut that is not yet durable.

## 4. Proposed change

### 4.1 User-visible behaviour

1. While the reveal renders, a small clock counts up ("14s"). It keeps counting across a retry wait, so the customer always knows how long it has been.
2. The moment one cut is finished it appears in the grid, with the second slot still showing the waiting state ("one more, almost dry…"). The customer cannot pick yet: the pick means choosing between two. The first cut can be opened full size.
3. When the second lands, both are live and the existing pick/refine controls appear as today.
4. If the second cut fails, the customer keeps seeing the first only if the whole round is delivered; failure behaviour is unchanged (the round fails, the credit is released, "didn't take — your credit is back"). The preview disappears with the failed round (5.2).
5. The same applies to each refine round.

### 4.2 Data and API

Recommended design: **incremental save plus polling the existing GET**, not a streaming rewrite.

- **Preview field.** Add `preview?: Variation[]` to the stored session and its public projection. In `startFromRecord` and `renderRoundCuts`, each render's completion handler appends its finished `Variation` to `preview` with a targeted Firestore update (field-level, not the whole-document `set` the final save uses), guarded by the current claim id so a stale writer cannot append after the claim is released. The final whole-document save sets `variations`/`rounds`, clears `roundInFlight` and drops `preview`. Keep `phase` unchanged until the final save so every phase-gated rule (pick, confirm checks) is unaffected.
- **Store.** Add `appendPreview(sessionId, claimId, variation)` to `SessionStore` (`src/services/designSession/internal/store.ts`; Firestore `tx.update` with `FieldValue.arrayUnion`, and the in-memory store for demo mode). Compatible with the claim fields at `store.ts:330-355`.
- **Order and ids.** Preview ids are the same ids the final cuts will have (`v{n}`, `orchestrator.ts` round id scheme: ids continue the running order, `renderRoundCuts` `:930+`), so the UI can swap preview for final without flicker.
- **Client polling.** While the confirm/round POST is in flight, the client also polls `GET /api/v1/design-session/{id}` every 2 seconds (the interval the Studio path already uses, map §A5) and reads `preview` and `rendering`. Polling stops when the POST resolves. The POST remains the source of truth for completion and for `credits`/`creditReleased`.
- **Rate limit.** The GET uses the `default` limiter (60/min signed in, `src/lib/rate-limit.ts:51-55`); 30 polls/min fits. Use a 3-second interval after 60 seconds.
- **Elapsed counter.** `GeneratingBeat` takes `startedAt` and renders `{n}s`; the clock comes from the client timestamp of "confirm clicked" (or `rendering.since` after a resume, spec 7) so it survives a refresh.
- **Alternative considered (not recommended):** stream NDJSON from the POST. Matches Gemini/Krea literally but the client is a single `fetch` with silent auto-retry (`designSessionApi.ts:371-389`), the platform's streaming behaviour for this route is unverified, and a refresh would lose the stream anyway; polling gives resume for free.

### 4.3 Copy (ADR-0036)

No money mentioned. Existing lowercase Sketchbot register.

- Counter: "14s" next to the beat line.
- Waiting slot after the first cut: "one more, almost dry…".
- Optional after 90 seconds: "this one's taking a while — still on it."

## 5. Failure and edge cases

1. Preview save fails: log and continue; the final save still delivers both cuts. Preview is an optimisation, never required.
2. The other cut fails: the round fails as today; the claim is released, `preview` is cleared by the failure path (`releaseRevealSlot`/`releaseRoundSlot`, `orchestrator.ts:802,846`), and the customer sees the existing failure copy. They may have seen one cut for a few seconds; accept, and do not keep it (it was part of a failed paid round that was refunded).
3. Text-guard re-render: the guard can re-render before a cut "lands" (`generation/index.ts` screen-and-reroll, billed as `1 + textGuardRerolls`); preview appends only post-guard images, so a cut that would be re-rolled is never shown.
4. Downgrade to the backup lane (ADR-0048): the round is flagged and the credit released (`round/route.ts:117-124`); a preview already shown from the primary lane stays consistent with the final cut for that slot only if the same render is the final one. Rule: preview entries are the final entries; a downgrade does not replace a cut that already landed. **Unverified** that the downgrade path never re-renders a landed cut; read `renderRoundCuts` before implementing.
5. Customer picks the first cut early via a deep link or old tab: `recordRoundPick` refuses picks during a render (`orchestrator.ts:562-568` in the map); keep that.
6. Polling during a stale claim (>10 minutes): the client stops polling when `rendering.since` exceeds the stale window.
7. Demo mode returns stock images immediately; preview/polling is skipped.
8. Hidden tab: pause polling; resume on focus.

## 6. Test plan

Extend:
- `src/services/designSession/__tests__/durability.test.ts`: finished cut is written to `preview` only after the durable GCS copy; the final save clears it.
- `src/services/designSession/__tests__/rounds.test.ts`: round preview appends in completion order, ids match the final ids; a failed sibling clears preview and releases the credit.
- `src/services/designSession/__tests__/sessionStore.test.ts`: `appendPreview` rejects a stale claim id and is idempotent per variation id.
- `src/app/api/v1/design-session/__tests__/get.test.ts`: projection includes `preview` while rendering.
- `src/features/design-session/__tests__/GeneratingBeat.test.tsx`: counter renders and keeps counting from `startedAt` (fake timers).
- `src/features/design-session/__tests__/DesignSessionFlow.test.tsx`: first preview cut shows with a waiting second slot; picking is disabled until both exist; polling stops on POST resolve.
- `src/features/design-session/__tests__/RevealGrid.test.tsx`: grid supports one filled slot.

## 7. Effort and dependencies

S for the counter. M for preview + polling (store method, two orchestrator call sites, client poller, grid state). Needs spec 7's `rendering` flag and ownership rule for the GET. Interacts with spec 12 (lane/seed shown in cut detail) only through the `Variation` shape.

## 8. Open questions for Samson

1. Is showing one cut while the other renders acceptable given the product's "two cuts, pick one" idea (ADR-0049)? A customer may form a view of the first cut alone. Alternative: show the first cut blurred/"developing" until both are done, giving progress without early judgment.
2. Poll (recommended) or stream? Streaming needs a platform check.
3. Should the elapsed counter show on every wait (confirm, round, critique re-cut) or only the reveal?
