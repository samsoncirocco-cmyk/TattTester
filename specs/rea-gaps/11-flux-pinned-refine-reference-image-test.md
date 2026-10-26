# Spec 11 — Prove or disprove the Flux-pinned refine-round reference-image failure, then fix it if real

Status: draft · Effort: **S** for the test; **M** for a fix if the test fails (two fix options below) · Depends on: none · Rollup rank 12 (gap G3)

## 1. Problem

The "Refine — 1 credit" button may not work for most sessions. If it does not, the failure is a refunded error, so no one is overcharged, but the core pick-and-refine loop (ADR-0049) would be dead on day one for every customer who has not uploaded a photo or named three characters. Wrong on day one, and cheap to find out.

**The claim is a code-reading inference. It has not been executed.** The map tags it `[inferred, VERIFY]` (generation/matching map §C1) and the rollup and the Gemini report repeat it as "inferred (unverified in the map)". This spec reads further than the map did and still stops short of running anything.

Chain of reasoning, with citations (orchestrator lines re-read at 1e301a1; provider lines unchanged since 6b1a0af):

1. A session pins its model once, at the reveal (`pinnedModelId`, set at `orchestrator.ts:~470` in the reveal save, 1e301a1; map §A6). Default routing picks `flux_dev` (`src/services/generation/internal/routing.ts:124-127`); `krea_2` for anime/manga/illustrative/new-school/japanese styles (`src/config/modelRoutingRules.js:129-231`). Only 3+ named characters or customer reference photos route to `nano_banana_2` (`routing.ts:136-150`).
2. `renderRoundCuts` always puts the previous pick's GCS image first in `referenceImages` for rounds after the first (`orchestrator.ts:947-960`, 1e301a1: `leadPath` from `pickedCutReferencePath`, then the customer's photos).
3. The request is built by `pinnedRequest(..., { allowDowngrade: true, referenceImages })` (`orchestrator.ts:232-270,977`), i.e. `modelId` = the pin, `allowProviderFallback: true`, `referenceImages` set.
4. The Replicate provider refuses reference images on any model whose `supportsReferenceImages` is false, with 400 `REFERENCE_IMAGES_UNSUPPORTED` (`src/services/generation/internal/replicate.ts:311-319`). The flags: flux-dev `:70` false, flux-schnell `:86` false, nano-banana-2 `:109` true, krea-2 `:122` false. The `pinnedRequest` doc comment says the refusal "cannot happen in practice: photos force the nano-banana pin at session start" (`orchestrator.ts:~245-250`), which is true only for the customer's photos, not for the picked cut that round two adds.
5. The fallback loop in `generate()` filters the fallback chain to reference-capable models when the request carries `referenceImages` (`src/services/generation/index.ts:237-239`, 1e301a1), and flux_dev's chain is `flux_dev → flux_schnell → krea_2` (`modelRoutingRules.js:238-244` in the map), none of which accept references. The filtered chain is empty, so `generate()` rethrows the original error.
6. The round route maps any non-`DesignSessionError` to 502 `ROUND_FAILED` and releases the credit (`round/route.ts:117-124,165-172`); the customer sees "That round didn't take - your credit is back. Run it again?" and the same thing happens on every retry.

No existing test exercises the capability check: `rounds.test.ts` mocks the whole generation module (`generate`, `routeGeneration` are `vi.fn()`, header of the file: "every module boundary is mocked"), and its reference-chain assertion only checks what is *sent* (`rounds.test.ts:420-440`). `replicate.test.ts` covers the provider in isolation. `rg REFERENCE_IMAGES_UNSUPPORTED src/services/designSession` finds nothing (map §C1). Nothing connects the two, which is exactly where the defect would hide.

Counter-evidence to weigh before assuming it is real: the ADR-0049 text says round two is image-to-image, so a deliberate decision may exist that I have not found (e.g. a model-specific path, a later migration, or a production default that is always `nano_banana_2`). The map notes it did not check "whether ADR-0049's 'round two is image-to-image' claim holds for non-nano pins in production data". Production session data was not read for this spec (no read-only query was run).

## 2. Competitor evidence

Gemini edits conversationally: the previous image is implicit context, no mask, no seed exposed (rollup G3; `~/reports/tatttester/2026-10-24-rea-gemini.html`, `ev_90f85ecd`: edit sent 17:26:04, second image present by 17:27:36). That report observed Gemini only; the TattTester half of G3 is the inference above. No competitor behaviour here bears on whether TattTester's Flux path fails.

## 3. Scope and non-goals

In scope: (1) a test, with the provider real and only the network mocked, that runs a refine round on a `flux_dev`-pinned and a `krea_2`-pinned session; (2) if it fails, a fix.

Non-goals: changing the two-cuts model or the axis ladder; moving all sessions to the nano lane; the critique lane's separate re-cut design (ADR-0060 deliberately regenerates from state, not from the target image — the rollup's G3 second half, "route named-cut re-cuts to a reference-capable lane with the target image", is a different, larger decision and is listed in open question 8.3, not here); running paid renders (this spec costs $0: network is mocked).

## 4. Proposed change

### 4.1 User-visible behaviour

- If the test **passes** (refine works on Flux/Krea pins): nothing user-visible changes; the test stays as a regression guard and the PR records why (for example, a lane adaptor exists that the inference missed).
- If the test **fails** (the inference holds): after the fix, "Refine — 1 credit" on a Flux or Krea session produces a second pair that visibly follows the picked cut or, under Option B, honestly says it continued from the pick's description rather than its pixels. A round never fails with a refunded error for a reason the system could have known in advance.

### 4.2 The test (the deliverable of this spec)

New file `src/services/designSession/__tests__/refineRoundReferenceLane.test.ts`:

- Same seams as `rounds.test.ts` for everything except generation: mock intake, council, GCS (`copyImageToPath`, `recoverImageAtPath`, `uploadImageToPath`, `getSignedUrl`), and `recordSpend`, with persistence on `memorySessionStore`. **Do not mock `../../generation`.** Instead stub global `fetch` (as `src/services/generation/__tests__/replicate.test.ts:29-33` does) with canned Replicate responses so the real `generate()`, real `replicateProvider`, and real model flags run.
- Table-driven over pinned model ids: `flux_dev`, `flux_schnell`, `krea_2`, `nano_banana_2`. For each: run `startSession`/confirm path to a reveal with that pin (set `pinnedModelId` on the stored session directly to avoid depending on routing), `recordRoundPick`, `refineRound`.
- Assertions, per model: whether `refineRound` resolves or rejects; if it resolves, the outgoing Replicate body contains `image_input` only for `nano_banana_2`; if it rejects, the error code is `REFERENCE_IMAGES_UNSUPPORTED`, the credit is released, and the claim is cleared.
- One more case locks in the lane-selection premise: for a session with no photos and fewer than 3 named characters, `routeGeneration` returns a non-nano pin (this asserts the part of the chain a reader would otherwise have to trust, `routing.ts:121-171`).
- Report in the PR whether the test **failed before any fix**. The run is deterministic (network mocked), so state which pinned models resolved and which rejected rather than a pass rate.

### 4.3 Data and API / the fix, only if the test fails

Pick one with Samson (open question 8.1); both avoid silent downgrades (ADR-0048).

- **Option A — prompt-only continuation on non-reference lanes.** In `renderRoundCuts`, drop the picked-cut reference when the pinned model has no reference input (`modelSupportsReferenceImages` is already used by `generate()` at `src/services/generation/index.ts:237-239`; it is unverified whether it is exported for orchestrator use, otherwise export it), and carry the pick forward through the locked poles that `enhanceRound` already receives (`lockedPoles`, `orchestrator.ts:892`; ADR-0049's "round two holds the chosen pole"). Cheapest and keeps the lane. Weakness: round two no longer starts from pixels the customer liked, which ADR-0049 intended ("a refinement of something they already half-like"). Add a quiet note to the bubble ("continuing from your pick's style") so the product does not over-promise.
- **Option B — attach the pick on a reference-capable lane.** For rounds after the first, if the pinned model cannot take references, render that round on `nano_banana_2` with the picked cut as reference and flag it as a **disclosed** lane change on the round (`downgraded`-style flag but not a downgrade: the credit is *not* released, since this is a designed path; this needs a new field and an ADR-0016/0048 amendment because "one provider per round" is held by ADR-0016 as amended by ADR-0052). Costs more per image (catalog: nano-banana-2 6.7¢ vs flux-dev 2.5¢, `replicate.ts:67,83,102,120` in the map) and changes the look between rounds. Needs a spend-cap check: design-session spend is recorded as a flat 1¢ per image (`spend.ts:19,36-39`; map §B3, inferred), so the cap under-counts nano renders further.
- Either option updates the `pinnedRequest` doc comment that currently says the refusal "cannot happen in practice".

### 4.4 Copy (ADR-0036)

No money mentioned. Option A adds one bubble clause, lowercase register: "continuing from your pick's style." Option B adds: "this round runs on a different pencil so it can see your pick." (round-level notice beside the existing downgrade notice at `DesignSessionFlow.tsx:49-52`).

## 5. Failure and edge cases

1. The test passes because the production default is always nano: record which production default makes that true (an env or a rule I did not find), and add the assertion that guards it.
2. `krea_2` fan-out: Krea is single-output and fans out N predictions (`replicate.ts:~330`); the test covers `numImages: 1` only because the design session always asks for one.
3. A retried round reuses a staged render (`durableRender` fingerprint includes `modelId` and reference paths, `orchestrator.ts:307-345`); under Option B the *requested* model in the fingerprint differs from the serving model, so the staged metadata must carry the lane (ties to spec 12).
4. Reveal-time pin with customer photos is already nano; the test's photo variant must still pass (regression).
5. The critique re-cut lane does not send the target image on any lane (`orchestrator.ts:~1700-1760`, strict pin, no fallback); that is not changed here.
6. If Option A is chosen, rounds past the ladder ("re-rolls on the locked poles", `orchestrator.ts:836-846` in the map) already work without a reference; nothing else changes.

## 6. Test plan

Add:
- `src/services/designSession/__tests__/refineRoundReferenceLane.test.ts` (new): the table above.

Extend (only if a fix lands):
- `src/services/designSession/__tests__/rounds.test.ts`: the reference-chain test asserts per-lane behaviour instead of assuming a reference-capable pin.
- `src/services/generation/__tests__/replicate.test.ts`: unchanged semantics, add the chain-empty case for `generate()` with references on a flux pin.

## 7. Effort and dependencies

S for the test (about one file, existing seams). If it fails, Option A is S–M; Option B is M and needs an ADR amendment. No dependencies; do this early — it determines whether the rest of the generation work is polishing a loop that does not run.

## 8. Open questions for Samson

1. If the test fails, Option A (continue from the pick's style, cheaper, keeps the lane) or Option B (switch lane to keep the pixels, dearer, changes the look)? Recommendation: A first because it never changes cost or look, then measure.
2. Can someone check, read-only, what share of existing sessions are pinned to non-nano models? That tells us how many customers would hit this. (Not queried for this spec.)
3. The rollup's other half of G3 — critique re-cuts sending the criticised image — conflicts with ADR-0060 ("regenerate from state, not from the last prompt"). Separate decision; do you want it specced after this test lands?
