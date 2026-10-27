# Spec 17 — Guess-first intake: state the assumption, keep the tap

Status: built behind a flag · Effort: **M** · Split out of [spec 10](10-narration-because-you-said-and-guess-first-intake.md) §4.1(5) and §4.2, which shipped the narration half (#421) and left this mode unbuilt · Competitor evidence: Veri V1 (spec 10 §2)

## 1. Problem

A first message such as "something for my grandma, maybe flowers" gets a question back, never a picture. Intake asks before it shows. Veri, by contrast, commits to one concrete guess on vague input and lets the reply steer. Wrong on day one: a first-time customer who does not know their placement or style is asked to decide before seeing anything.

## 2. Behaviour

With `DESIGN_INTAKE_GUESS_FIRST=true`, on the customer's **first** message only:

1. If the normal cadence would already propose (judgment, the draw-request fast lane of ADR-0028, an axis spread, a colour call), nothing changes.
2. Otherwise, if the record holds something to draw (`subject` or `meaning`), the engine proposes at once instead of asking its first question.
   - If placement is missing it assumes `DEFAULT_PLACEMENT` (the inner forearm, the same default the stalled-placement re-ask already commits to) and **says so**.
   - Style and palette are never invented. A settled value is restated; an open one is named as the split the two cuts will show.
   - Reply: `i'm assuming {assumptions}. here's what i'm hearing: {playback}. want me to draw that, or tell me what to change?`
3. The consent tap stays (ADR-0020). Nothing renders on silence. No credit is reserved until confirm, so correcting a wrong guess is free.
4. If there is nothing to draw ("i want a tattoo"), the first question is asked as today.

The placement constraint holds: placement is "never inferred loosely" (`intake/types.ts`). It is stated in the assumption line and confirmed by the tap, never silently defaulted.

### Follow-up turns

- A reply after a guess is a normal turn. The assumed placement is carried forward only while the customer has not named one and the record still lacks one, so the next proposal still states it.
- `TurnLog.assumedPlacement` records the guess. `firedRule: 'guess-first-proposal'` marks the turn.

### Measurement (no new store)

- `design_conversation.guess_first_edited`: logged on the turn after a guess-first proposal.
- `design_conversation.guess_first_accepted`: logged at confirm when the proposal being confirmed was the guess.
- Time-to-first-image comes from the existing turn logs.

## 3. Non-goals

Rendering on silence; SMS intake; LLM-written assumption copy (templates only, no new model spend); changing the scripted fallback (guess-first is unavailable there, as spec 10 §5.6 says); demo mode (the demo script is unchanged).

## 4. Decisions taken on spec 10's open questions

1. Silence never renders. Yes-only, via the existing confirm tap.
2. The subject echo reuses `buildPlayback`, which already speaks a short subject label and marks meaning as "about …". No new exposure of freeform text.
3. Scope is everyone behind the flag, first turn only. A word-count threshold was not added; the "something to draw" check already excludes empty asks.

## 5. Tests (no paid renders, providers mocked)

`src/services/designConversation/__tests__/guessFirst.test.ts`:
- flag off: a vague first turn with a subject and no placement still chats.
- flag on: same turn proposes, states the default placement, keeps the consent question, logs `guess-first-proposal` and `assumedPlacement`.
- flag on, nothing to draw: asks as today.
- flag on, second turn: does not fire.
- flag on, a first turn that would already propose: unchanged rule.
- the follow-up turn logs `guess_first_edited` and carries the assumed placement.

`conversationService` test: confirming a guess-first proposal logs `guess_first_accepted`.

## 6. Rollout

Default off in every environment. Turn on in a preview first and read the two events before production.
