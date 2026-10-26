# Spec 12 — Set and store a seed on Flux and Krea lanes, and show lane and seed per cut

Status: draft · Effort: **S** · Depends on: none; best after [11](11-flux-pinned-refine-reference-image-test.md) (which may change which lane a round runs on) · Rollup rank 13 (gap R3)

## 1. Problem

A cut has no provenance. The customer, the artist they hand the brief to, and support cannot tell which model drew it, and nothing can be reproduced. Wrong on day one: when someone asks "can I get that one again, but with the star" or "why does this one look different", the product has no answer.

Current behaviour (generation/matching map §C1, §E1; `replicate.ts` and `types.ts` unchanged at 1e301a1; orchestrator lines re-read there):

- No seed is passed by the design-session lanes: `pinnedRequest` builds `{prompt, negativePrompt, numImages:1, modelId, aspectRatio, allowProviderFallback, referenceImages?, screenText?}` and never `seed` (`src/services/designSession/internal/orchestrator.ts:232-270`).
- The provider honours a seed if given: `if (request.seed !== undefined && request.seed !== '') input.seed = Number(...)` (`src/services/generation/internal/replicate.ts:322-324`). Gemini/nano and the Vertex provider ignore it (`vertexImagen.ts:350,412`; CLAUDE.md "Gemini also ignores seed"). Flux and Krea accept it. `/api/v1/generate` already accepts and returns `seed` in metadata (`src/app/api/v1/generate/route.ts:86-98,203-225`), the generic Studio path.
- `Variation` has no lane or seed: `id, axisPosition, prompt, negativePrompt?, imageUrl?, revisionOf?, revision?` (`src/services/designSession/types.ts:17-43`). The public `DesignSession` records `provider` (`types.ts:118-200`) and the server-only `pinnedModelId` (`store.ts`, `StoredSession`), but nothing is shown on a cut. The full-size view, `CutLightbox`, receives the cut's designed name and caption only (`src/features/design-session/components/CutLightbox.tsx`, doc comment: "this component never sees ... the raw axis internals").
- The durable-render staging fingerprint is keyed on `sessionId, tag, prompt, negativePrompt, modelId, referenceImagePaths` and the staged object's metadata carries only the downgrade reason (`orchestrator.ts:307-368`, 1e301a1). So a retry that reuses a staged image would not know the seed or the actual serving lane unless they travel in that metadata, the same trap the code comment documents for downgrades.

## 2. Competitor evidence

Krea returns the seed in every job record (`input_params.seed`) and shows the exact prompt, the model chip "Krea 3 · Fast · 2K" and a live elapsed counter on the result; the seed is in the API response but **not on screen** (rollup R3; `~/reports/tatttester/2026-10-24-rea-krea.html`, `ev_d1b35b13`; single run). Gemini's result card shows no seed, no model name and no dimensions; the mode picker says "Gemini Auto" (`~/reports/tatttester/2026-10-24-rea-gemini.html`). So the observed competitor trust signal is the **lane label and the prompt**, not the seed; the seed is TattTester's own reproducibility addition.

## 3. Scope and non-goals

In scope: derive and send a seed on Flux and Krea lanes; store `seed` and the **actual serving lane** on each `Variation`; show lane (always) and seed (in a details view) in the cut's full-size view.

Non-goals: seed controls for the customer ("use this seed again" button; later); determinism on the nano lane (no seed exists); changing prompts; exposing prompts (the cut already stores `prompt`; whether to show it is a separate copy decision); the Studio/Forge path.

## 4. Proposed change

### 4.1 User-visible behaviour

1. Open a cut full size: under its name, a quiet line "drawn on Flux Dev" (or the friendly lane name), and a "details" disclosure showing "seed 482910", and for the nano lane "seed: not used on this lane".
2. If a round came off the backup lane (ADR-0048 downgrade), the line shows the lane that actually drew the cut, not the pinned one.
3. A customer or support person who gives the seed and the lane can re-create the same cut (prompt is also stored).

### 4.2 Data and API

- **Seed choice.** Deterministic from the cut, not random: `seedFor(sessionId, cutId)` = a stable 32-bit hash of the two ids (a small pure helper `src/services/designSession/internal/seed.ts`). Deterministic derivation means a retried render and the staging fingerprint agree without the seed needing to enter the fingerprint, and the stored value can be recomputed for verification. Range: integer 0 to 2^31−1 (Flux accepts large integers; the exact accepted range on Replicate is **unverified**, so use the conservative 31-bit range).
- **Send.** `pinnedRequest` takes `seed?: number`; callers `startFromRecord`, `renderRoundCuts`, `runClaimedReroll`, the critique re-cut and the refine regen pass `seedFor(session.id, id)` **only if the pinned model supports a seed**. Add `supportsSeed` to the model catalog entries in `replicate.ts` (flux-dev, flux-schnell, krea-2: true; nano-banana-2: false) next to `supportsReferenceImages`; the provider already ignores unknown fields for nano, but making it explicit avoids sending a field the lane will drop.
- **Report back.** `generate()` already returns `metadata` including `model`, `provider`, `fallbackUsed` (map §A5 `/generate` response shape). Surface `metadata.model` and `metadata.seed` through `renderDurably`'s closure into the staged object's metadata (`{ downgradeReason? , lane, seed? }`), so a reused staged image reports the lane that actually drew it. `renderDurably` returns `outcome.imageUrl` only today; change it to return `{ imageUrl, lane, seed }` and update its six call sites (`startFromRecord`, `renderRoundCuts`, `runClaimedReroll`, `refine`, critique re-cut, plus any other `renderDurably` caller; grep before editing).
- **Types.** `Variation` gains `lane?: string` (model id, e.g. `flux_dev`) and `seed?: number`, both optional so sessions stored before this change keep rendering (the field comment on `revision` notes the same additive pattern, `types.ts:~35-42`). Firestore writes drop `undefined` through the JSON round trip (`store.ts:319-326`).
- **Projection.** `toDesignSession` passes both through. They are not sensitive.
- **Lane labels.** A pure map `laneLabel(modelId)` in `src/features/design-session/services/` ("Flux Dev", "Flux Schnell", "Krea 2", "Nano Banana 2") so the UI never prints raw ids. Note that CLAUDE.md names the Gemini lane `gemini-3.1-flash-image` via Vertex while the code serves it as `nano-banana-2` through Replicate (map §0.4, ADR-0048): label from the code's model id, not from CLAUDE.md.
- **UI.** `CutLightbox` accepts `lane` and `seed` props from `RevealGrid`; its design constraint (it must not see axis internals) is respected because lane and seed are not axis internals.

### 4.3 Copy (ADR-0036)

No money. No "TatT". Quiet voice.

- "drawn on {Flux Dev}"
- details: "seed {482910}" / "seed: not used on this lane"
- A one-line help under details: "Same seed, same lane, same prompt gives you the same cut."  (true for Flux/Krea only; hide the sentence on nano. Verify determinism empirically before shipping the sentence: unverified that Replicate's Flux/Krea outputs are bit-identical for equal inputs.)

## 5. Failure and edge cases

1. Backup-lane render (downgrade): `lane` is the fallback model's id, `seed` absent if that lane ignores it, or the seed sent if it accepts one; the cut shows what is true.
2. Old sessions with no `lane`/`seed`: show nothing (no "unknown" label).
3. A seed collision between two cuts of one round: the hash includes the cut id, so the two seeds differ; a hash collision across sessions is harmless.
4. Seed sent but the provider changes it or ignores it: store what `generate()` reports back, not what was sent, when they differ; log a warning.
5. Text-guard re-roll (billed as `1 + rerolls`, `generation/index.ts` screen-and-reroll): the re-roll uses the same request, hence the same seed, which could reproduce the same lettering. **Unverified** that the re-roll currently varies the seed or relies on provider randomness; if the guard depends on randomness to differ, a fixed seed would defeat it. Resolve before shipping: derive a per-attempt seed (`seedFor(sessionId, cutId) + attempt`) and store the accepted attempt's seed. This is the one place the change could regress behaviour, so it has its own test.
6. Staged-image reuse after a deploy: old staged objects lack lane/seed metadata; fall back to the requested model id and no seed.
7. Cost: none. A seed does not change spend.

## 6. Test plan

Extend:
- `src/services/generation/__tests__/replicate.test.ts`: a seed is included in the body for flux-dev, flux-schnell, krea-2 and omitted for nano-banana-2; `supportsSeed` exposed.
- `src/services/designSession/__tests__/rounds.test.ts` and `designSessionService.test.ts`: every render request from reveal and rounds carries `seed` on a Flux pin and none on a nano pin; stored `Variation` has `lane` and `seed`.
- `src/services/designSession/__tests__/durability.test.ts`: a reused staged image restores `lane` and `seed` from its metadata, including the downgrade case.
- `src/services/designSession/__tests__/reroll.test.ts` and `critique.test.ts`: re-roll and re-cut carry seeds; text-guard re-roll uses a different attempt seed.
- `src/features/design-session/__tests__/CutLightbox.test.tsx` and `RevealGrid.test.tsx`: lane line renders; seed in details; hidden when absent; nano shows "not used".

Add:
- `src/services/designSession/__tests__/seed.test.ts` (new): `seedFor` is stable, in range, differs per cut id, differs per session id.

## 7. Effort and dependencies

S: a helper, a catalog flag, threading two fields through one return type, one small UI addition. Do spec 11 first: if Option B there ships, "lane" becomes visible customer-facing information and must be right.

## 8. Open questions for Samson

1. Show the seed to customers at all, or keep it internal (stored, visible in the artist handoff brief and support tools) and show only the lane? Krea did not show its seed on screen (observed), so there is no competitor precedent for showing it.
2. Include lane and seed in the brief that goes to the artist at handoff (`HandoffCard`, `brief`)? It could help an artist reproduce the look; unverified whether artists want it.
3. Is the text-guard interaction in 5.5 acceptable to resolve by per-attempt seeds, or should seeds be skipped when the guard is enabled?
