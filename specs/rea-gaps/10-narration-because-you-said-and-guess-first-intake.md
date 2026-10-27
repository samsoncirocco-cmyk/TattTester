# Spec 10 — "Because you said …", "changed: …" prefix, interim line, and an optional guess-first intake

Status: draft · Effort: **S** for the narration changes; **M** for the guess-first intake mode (separable, shippable second) · Depends on: none; the interim line is cleaner after [9](09-first-cut-as-it-lands-and-elapsed-time.md) · Rollup ranks 15 and 14 (gaps V2, V3, V4, V1)

## 1. Problem

The bot says what it did, never why it believes it fits this customer, and it does not say what it changed between rounds. Re-rolls feel random. Intake asks questions before it shows anything. Wrong on day one: a first-time customer sees two cuts, a generic "I split these two on line weight", and a refined pair with no account of what moved.

Current behaviour (generation/matching map §C; `revealNarration.ts` and `refineryVoice.ts` verified at 1e301a1; orchestrator lines re-read there):

- `revealNarration(axisSelection)` returns "I split these two on {axis} and {axis} — your pick tells me which way to lean." (or the compositional variant) from the axis selection alone (`src/features/design-session/services/revealNarration.ts:23-32`). It takes no intake and never quotes the customer. The module's own comment explains why the raw axis rationale must not be shown.
- After each round, copy is `ROUND_PROMPT` "Two cuts. Tap the one that's closer." (`DesignSessionFlow.tsx:32`), the next-axis invite from `refineInviteLine` (`:307-318`), the downgrade notice (`:49-52`) and `CRITIQUE_INVITE` (`:59-60`). Nothing names what changed since the previous round.
- Critique replies (`src/services/designSession/internal/critiqueVoice.ts`): `fixLandedLine` "re-cut {name} with that. have a look." (`:19-21`), `wrongRenderLine` (`:34-36`), `rerollLandedLine` (`:120-124`). The re-roll arm appends an optional hint as `Customer direction: "…"` (`orchestrator.ts` reroll, ~`:1073+`) but no line states it back.
- The Studio voice has fixed lines such as `KEPT_LINE` "kept it." (`src/features/generate/services/refineryVoice.ts:27-28`); that file serves the Studio, not `/design`.
- While the Council and render run, nothing is said except the rotating beat lines (`GeneratingBeat.tsx:17-31`); the client can say nothing specific because it has not received any Council output.
- Intake is a conversation that fills `IntakeRecord` (`src/services/intake/types.ts:51-120`: `placement`, `styleTags`, `meaning`, `subject`, `paletteAnswer`, `ambiguousAxes`, `requestedAxis`). `POST /api/v1/design-session/converse` opens with a question (`converse/route.ts:38,144`) and the confirm needs a proposal with playback + consent (ADR-0020), except the fast lane when the first message is already a complete prompt (ADR-0028). A scripted two-question fallback exists when the engine is down (`DesignConversation.tsx:29,203-218`).

## 2. Competitor evidence

Veri (an SMS tattoo agent, studied by reading its public pages and one thread; single observations, `~/reports/tatttester/2026-10-23-rea-veri.html`):
- V1: commits to one concrete pick on vague input and lets the reply steer, zero questions before the first answer.
- V2: ties every answer to a remembered preference by name.
- V3: names the miss before re-rolling ("i steered too dark").
- V4: signposts research before a slow answer ("lemme check the dub casts") and corrects itself afterwards.
- Latency figures in that report are two single observations; do not treat them as a distribution. No claim here is about how customers reacted.

## 3. Scope and non-goals

In scope: (a) a "because you said …" clause in `revealNarration`; (b) a "changed: …" line before each refined round and each critique re-cut/re-roll; (c) one interim line before the render starts; (d) an optional guess-first intake mode with stated assumptions.

Non-goals: SMS intake (rollup rank 19, parked); changing the axis ladder or the credit unit (ADR-0049); LLM-generated narration (all lines are templates over structured fields; no new model spend); rendering on silence (see 8.1); rewriting the Council.

## 4. Proposed change

### 4.1 User-visible behaviour

1. **Reveal.** "You asked for a phoenix on your forearm, so I split these two on line weight and how much detail they carry — your pick tells me which way to lean." The quoted pieces come from the customer's own settled fields, never from the axis rationale.
2. **Refined rounds.** Before the new pair: "kept: fine line. now splitting: black ink vs color." The kept part is the picked pole from the previous round; the splitting part is the next ladder axis.
3. **Critique re-cut and re-roll.** The first line names the change in the customer's words: "changed: thinner outline, per 'too heavy'." For a fresh-set ask: "changed: new set on the same direction (kept your pick)."
4. **Interim line.** When the customer confirms, before cuts exist: "drawing your phoenix, forearm, fine line." Built from the intake fields the client already holds.
5. **Guess-first (optional mode).** *Moved to [spec 17](17-guess-first-intake.md), which supersedes this item and the guess-first bullets in 4.2.* For a vague first message the bot immediately says what it will assume and offers to draw: "I'm assuming fine-line, black ink, outer forearm. Want me to draw that? Or tell me what to change." Tapping Draw it confirms (existing consent step). The questions remain as optional chips, not gates.

### 4.2 Data and API

- **`revealNarration`.** New signature `revealNarration(axisSelection, intake?)` where `intake` is the settled projection (`placement`, `subject`, and at most one of `meaning`/`styleTags`). Build the clause from `subject` first ("a phoenix"), then `placement`; if absent, fall back to today's sentence exactly. Never quote `meaning` verbatim (it is freeform and sensitive; the type says it is preserved verbatim for the artist brief, `types.ts:56-57`); use `subject` and short closed tags only. Keep the module pure.
- **Round line.** New pure helper `roundChangeLine({ keptPole, nextAxis })` next to `refineInviteLine` (`DesignSessionFlow.tsx:307-318`); inputs come from `session.rounds` (`RefineRound { axis, pickedId… }`, `types.ts:51-77`) and `nextRoundAxis` (`src/services/designSession/roundPlan.ts:62`). Axis wording reuses `AXIS_SPOKEN` (`revealNarration.ts`) so the vocabulary has one home.
- **Critique line.** `critiqueVoice.ts` lines gain the structured change: for per-cut fixes the state diff that `deriveDesignState` already computes for the re-cut (`renderStatePrompt(nextState)`, `orchestrator.ts` ~`:1649`, ADR-0060) supplies "what changed"; for re-rolls the hint. **Unverified:** whether the state diff is available as a value at the line-composition point (it is computed to build the prompt); read `critique()` around `:1292-1800` before sizing. If it is not exposed, derive the line from `pendingCritique`/the customer's sentence trimmed to 60 characters.
- **Interim line.** Client-side only: `interimLine(intake)` in the `features/design-session/services` folder, shown by `GeneratingBeat` before the first rotating line. Honest limit: it echoes known intake, it does not report Council output (the Council runs inside the blocking confirm; the client receives nothing mid-flight until spec 9's preview). Do not invent a "checking what neo-trad means" line the server did not actually produce.
- **Guess-first mode.**
  - A new `converse` option `mode: 'guess-first'` (feature-flagged by env `DESIGN_INTAKE_GUESS_FIRST=false` in `src/config/envSchema.js`; regenerate `.env.example`). On the first turn, if the existing readiness check says the input is not a complete prompt, the engine returns `stage: 'proposal'` with `playback` that states the assumptions (the response already has `stage: 'proposal'` and `playback`, `types.ts:24,71-82`) instead of asking its first question.
  - Assumptions are drawn from structured defaults, not free invention: a default placement is a guess the customer can correct; a hard-constraint field (placement is "a hard generation constraint, never inferred loosely", `types.ts:53`) must be **stated** in the assumption line and confirmed by the tap, never silently defaulted.
  - The consent tap remains (ADR-0020). No render on silence: see 8.1.
  - Time-to-first-image is measured with the existing turn logs (server-side `turnLogs`); add an event for assumption accepted/edited. No new data store.

### 4.3 Copy (ADR-0036)

No money mentioned in any of these lines. "TattTester" does not appear (the bot speaks as Sketchbot). Lowercase register matches `critiqueVoice`.

- Reveal: "{you asked for a {subject} on your {placement}}, so I split these two on {axes} — your pick tells me which way to lean."
- Round: "kept: {pole}. now splitting: {axis A} vs {axis B}."
- Critique: "changed: {what}."
- Interim: "drawing your {subject}, {placement}, {style}."
- Guess-first: "I'm assuming {style}, {palette}, {placement}. want me to draw that, or tell me what to change?"

## 5. Failure and edge cases

1. Intake has no `subject` (the request has no nameable subject): omit the clause; do not fall back to quoting `meaning`.
2. Subject contains a named real person or a character: use the verified roster entry, not raw text (`requestedCharacters`, `characterIdentities`, ADR-0050 treats real-person photos specially); never echo a flagged value.
3. Long subject strings: truncate to 40 characters at a word boundary.
4. Wrong assumption in guess-first (e.g. wrong placement): editing is one tap and costs no credit; the credit is only reserved at confirm (`generation-credits.ts:49-100`).
5. Customer ignores the guess and keeps typing: treat the next message as a normal turn; the guess proposal is superseded.
6. Scripted fallback intake (conversation engine down): guess-first is unavailable; behave as today.
7. Critique line says "changed: …" but the render did not honour it (the allowance, prompt-contract refusals exist: `ALLOWANCE_SPENT_LINE`, `UNTRANSLATED_LOOK_LINE`): only emit "changed" after the render lands; keep the existing refusal lines for refusals.
8. Accessibility: the new lines are ordinary chat bubbles, no new live regions.

## 6. Test plan

Extend:
- No `revealNarration` test exists today (grep found none); add `src/features/design-session/services/revealNarration.test.ts`. Other importers to keep green: `SketchbotNotes.tsx`, `DesignSessionFlow.tsx`, `src/services/designConversation/internal/notes.ts`: clause present with subject/placement, absent without, never contains `meaning`, compositional variant unchanged.
- `src/features/design-session/__tests__/DesignSessionFlow.test.tsx`: round line shows kept/splitting; interim line appears before the first beat line.
- `src/services/designSession/__tests__/critique.test.ts` and `reroll.test.ts`: "changed:" line states the customer's change after a successful re-cut/re-roll and is absent on refusals.
- `src/app/api/v1/design-session/converse/__tests__/converse.test.ts`: with the flag on, a vague first turn returns `stage:'proposal'` with `playback` naming the placement; flag off is unchanged; a complete first prompt still takes the ADR-0028 fast lane.
- `src/services/designSession/__tests__/conversationService.test.ts`: assumption fields never silently default `placement`.

Add:
- `src/features/design-session/__tests__/interimLine.test.ts` (new).

## 7. Effort and dependencies

S for (a)-(c): pure functions and template lines over fields already in hand. M for (d): converse-engine behaviour, a flag, and a measurement hook. (d) can ship alone, later. No hard dependencies; spec 9's preview makes a truthful mid-render line possible later.

## 8. Open questions for Samson

1. The rollup suggests rendering "on yes or on silence". Rendering on silence spends a credit and an image render with no tap, against ADR-0020's confirm-before-generate. Recommendation: yes-only, with the assumption line plus one Draw-it button. Do you want silence to render after some timeout anyway?
2. Is it right to echo the customer's subject back ("a phoenix on your forearm"), or should the bot stay generic for sensitive subjects (memorial tattoos, names of people)? Proposed default: echo only subjects matched to a catalog entry or a safe closed vocabulary; otherwise generic.
3. Guess-first should apply to which customers: everyone behind the flag, or only when the first message is under N words?
