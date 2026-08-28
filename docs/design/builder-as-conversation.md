---
title: "The builder as a conversation"
status: draft
issue: 295
date: 2026-08-03
---

# The builder as a conversation

Design doc for GitHub issue #295 (move 3 of the 2026-08-04 SketchBot plan).
Draft for review by Samson, Fizz, and Honey. This document proposes; the ADRs
decide. Product questions it cannot answer are listed at the end, undecided.

**Decisions this design implements** (currently on branch
`worktree-sketchbot-stencil-chain` as ADR-0040–0042; they renumber when they
land via issue #292 — cited here by title and future number):

- *SketchBot owns the toolkit; the customer never picks a mode* (future
  ADR-0044)
- *Assembly: SketchBot proposes the layout; the customer reacts in words*
  (future ADR-0045)
- *The builder fires on SketchBot's judgment, not a cast-size rule* (future
  ADR-0046)

**Decisions this design must not break**: ADR-0038 (the Studio is the
refinery; the full bench is gear 3 behind a door), ADR-0039 (the critique
lane re-cuts compositions in `/design`; the Studio repairs images), ADR-0041
(consumer credits: 25 lifetime free generations, enforced server-side, one
counter across SMS and web).

**Evidence base**: the 2026-08-04 layer-bench trace on issue #294 (verified
against `origin/main` @ 7652574) and the 2026-08-03 handoff
(`docs/handoffs/2026-08-03-sms-parity-and-multicharacter-measurement.md` on
the same branch).

---

## 1. What the builder is

The builder is the piece-by-piece path for larger tattoos: each element
generated and approved individually, then assembled into one design. It is a
**tool in SketchBot's kit**, not a room, not a mode, not a button. The
customer describes a tattoo; SketchBot decides — from what they say they want
to control, never from a subject count — whether this request gets one render
or gets built piece by piece (future ADR-0046). A four-character sleeve may
go piece-first immediately; a six-element request may get one render.

Why it exists at all, in one sentence from the measurement work: today's
critique loop re-cuts the whole image, so fixing Riku's keyblade re-rolls
Sora — the builder is the control fix, not the quality fix (quality was
mostly a routing problem; Imagen returns a complete 3+ cast 92% of the time
per the 2026-08-03 handoff).

**Known boundary, inherited and non-negotiable**: separately generated
pieces can be *arranged* but cannot *interact*. A stacked sleeve works;
crossing keyblades needs a single render. SketchBot's tool choice must know
this and say it plainly when a customer asks for an action scene.

## 2. The conversation shape

One consultant, no modes, on SMS and web equally. The builder adds three
beats to the conversation the product already runs; nothing about intake,
proposal, or the reveal vocabulary changes.

### 2.1 Entering the build

SketchBot announces the plan in voice, as a proposal, before spending
anything:

> "This one wants building in pieces — Sora, Riku, Kairi, and Roxas each
> drawn on their own so we can get each one right, then I'll lay them out on
> the sleeve for you. Sound good? We'll start with Sora."

The customer can decline ("just show me the whole thing") and get a one-shot
render instead. The trigger is judgment; the customer's reaction is part of
the judgment. Misfires are expected and are the learning data (future
ADR-0046) — there is no threshold to tune yet, and per the owner's explicit
call recorded there, spend is not the constraint; `BUDGET_MAX_SPEND_CENTS`
remains the only hard backstop.

### 2.2 The piece loop

For each piece: SketchBot generates it, shows it, and asks for a verdict.
The customer answers in words:

- **approve** — "yes", "next", "love it" → piece is locked, loop advances
- **redo with critique** — "his hair should be silver" → regenerate this
  piece with the customer's words folded into its prompt, verbatim
  (ADR-0010's rule), exactly like the critique lane does for whole cuts
- **skip/drop** — "actually lose Roxas" → piece removed from the plan

This is the critique lane's grammar applied to one piece instead of four
cuts, and it should reuse the same deterministic posture as
`internal/critique.ts` (ADR-0039): the default is to act, only bare chatter
is chatter, no LLM classifier in front of a paid render.

### 2.3 Assembly is proposed, not dragged

When the pieces are approved, SketchBot composes them onto a
placement-shaped canvas and sends the result **as an image** — a proposal,
not a finished fact (future ADR-0045). The customer adjusts in words:

> "swap Riku and Sora" · "make Roxas bigger" · "more space at the wrist"

Each adjustment re-composes (a compositing operation, not a generation —
see §3) and re-sends. Words are the contract on both channels; the web
canvas *additionally* allows dragging on top of the proposal, as an
enhancement, never as the required path. The adjustment vocabulary
("bigger", "smaller", "swap", "higher", "lower", "left", "right") becomes a
parsed contract like the pick and critique vocabularies before it — small,
deterministic, testable.

When the customer approves the layout, the composite becomes the design —
it enters the same downstream everything else uses: pick, Brief, stencil
derivation, placement preview, Studio refinement, artist handoff.

## 3. How it maps onto the existing machinery

The #294 trace's verdict, adopted here wholesale: **the builder is a
conversational driver over machinery that already exists and passes its
tests** (107/107 in the scoped bench suite). Nothing below is new
infrastructure; it is a new caller.

| Builder concept | Existing machinery |
|---|---|
| A piece | A layer in `useForgeStore` (`src/store/useForgeStore.ts` — CRUD, z-order, transforms, blend modes, 3-deep undo/redo) |
| Generating a piece | The "Add element" loop, `src/features/Generate.jsx:485-509`: prompt → `generateHighRes` → `addLayer`/`addMultipleLayers` → `addVersion`. The trace calls this "~80% of the builder's core loop", and having read it, that is fair — it is missing only a conversational caller |
| The assembly render | `compositeLayers` (`src/features/generate/services/canvasService.ts:337`) — respects visibility, z-index, blend modes, and transforms. Export paths already exist: `exportAsPNG` (`canvasService.ts:410`), `exportAsARAsset` (`canvasService.ts:439`) |
| A word-level adjustment | A transform mutation on a layer ("bigger" → scale, "swap" → exchange positions/z) followed by re-composite. No generation call, no spend |
| Build history | `versionService.js` snapshots, as the add-element loop already writes them |
| The web power surface | The full bench (`FullBench.jsx`, mounted desktop-only behind the Studio gear-3 door per ADR-0038, via `src/app/studio/page.tsx:17` → `src/features/Generate.jsx:648-863`) |

Two consequences of this mapping worth stating out loud:

- **Piece generations are real generations.** Each piece goes through
  `generateHighRes` like any render, with the same budget policy
  (`checkBudget`/`recordSpend`). A 4-piece build with two redos is 6 renders
  before assembly. How that counts against the customer's allowance is an
  open product question (§6).
- **Assembly adjustments are free.** Compositing is canvas work, not a
  model call. The customer can nudge the layout twenty times at no spend —
  which is exactly the behaviour the proposal-and-react shape invites, and
  why the boundary between "adjust the layout" (free) and "redraw a piece"
  (a render) must be legible in SketchBot's voice.

### 3.1 The SMS channel: the conversation is the interface

SMS has no canvas and gets none. Every beat above is words and pictures,
which the shape already guarantees: the piece loop sends one image per
piece; assembly sends the composed proposal as an image; adjustments are
sentences. The precedent is the placement preview at commit `e9caed2`, which
ran the web's browser-canvas composite server-side with sharp, importing the
shared keying/gating logic from `@/lib/designBackdrop` rather than forking
it — the same discipline applies here: **one composite definition, two
executors.** `compositeLayers` is client-side (`HTMLCanvasElement`); the SMS
lane needs a server-side equivalent that consumes the same layer state
(image, transform, z-order, visibility) and must not silently drift from the
browser result.

That implies the pieces themselves must live somewhere a server can read.
Which leads directly to phase 0.

The web/SMS delta is then only what the handoff's parity table already
established for the reveal: the web gets picks as clicks for free; SMS
needs its `isBarePickReference`-style disambiguation ("2" is an approval of
piece 2, "2 but with silver hair" is a redo) and keeps `RESTART_INTENT`.

## 4. Phase 0: prerequisite repairs (from the #294 trace)

These are not builder features; they are the trace's "repair first" items,
and the builder is not honest without them.

1. **Wire `setForgeStoreContext`.** The function exists
   (`src/store/useForgeStore.ts:50`) and the Firestore persistence branch
   exists (`useForgeStore.ts:417`, `createFirestoreZustandStorage`), but
   nothing ever calls the setter, so the branch is unreachable and layers
   persist only to `sessionStorage`. Today **a multi-piece build dies on tab
   close** and is invisible to any server — fatal for a builder whose whole
   premise is accumulating approved pieces, and doubly fatal for SMS, which
   has no browser storage at all. Fix: call `setForgeStoreContext(userId,
   designId)` where the Studio mounts with an authenticated user and a
   design id; verify the version history story (currently localStorage-only)
   while there.
2. **Delete the dead `multiLayerService` duplicate.**
   `src/services/multiLayerService.ts` (414 lines) is a dead copy whose 34
   green tests (`src/services/multiLayerService.test.js`) test the dead
   code, while the live copy
   (`src/features/generate/services/multiLayerService.ts`, 278 lines) —
   the one the add-element loop actually calls — has zero tests. Delete the
   dead copy, re-point the tests at the live one.

Two further trace findings fold into builder work rather than blocking it:
the effectively-inert RGBA-separation branch (live
`multiLayerService.ts:194` gates on `rgbaReady`, which is meaningless while
Flux PNGs carry no alpha), and the absence of any tests on `useForgeStore`
and `canvasService` — the compose step itself is untested, and phase 1 must
not build on it without adding them. Review escalation (#296): the RGBA
finding is load-bearing, not incidental — if piece separation is
unmeasured, opaque boxes behind pieces make every assembly look broken in a
way no unit test catches. Before phase 1 leans on multi-piece composition,
run a small measured check of piece separation on real Flux output, in the
bake-off spirit.

## 5. Phased build plan

Each phase has one testable exit criterion. No phase starts before the
previous one's criterion is green.

### Phase 0 — repairs

Wire persistence (§4.1), delete the duplicate and re-point its tests
(§4.2), add first tests on `useForgeStore` layer CRUD and
`compositeLayers`.

**Exit criterion:** the test environment can produce a real 2D canvas
context (resolved by adding the `canvas` devDependency — PR #309, which
also cleared the long-standing 32-test failure baseline to zero) and a
Firestore emulator is configured in CI (`firebase.json` currently has an
empty `emulators` block — this half is real harness work); an automated
test signs in, creates two layers, and reads the same two layers back
through the Firestore storage path (proving the `:417` branch is
reachable); the re-pointed `multiLayerService` tests pass against the live
copy; `src/services/multiLayerService.ts` is gone.

### Phase 1 — conversation skeleton on web

The builder tool inside SketchBot's toolkit: the entry proposal (§2.1), the
piece loop driving the add-element machinery (§2.2), the assembly proposal
via `compositeLayers` and the word-level adjustment vocabulary (§2.3), and
the approved composite landing in the normal downstream. Deterministic
vocabularies, ADR-0039-style; spend recorded in the service, never the
channel adapter (the handoff's double-charge lesson).

**Exit criterion:** a scripted web session builds a three-piece design
end-to-end in conversation — propose, generate/approve each piece, receive
a composed layout image, adjust it once in words, approve — with zero
canvas interaction required, and the resulting design opens in the Studio
with its three layers intact.

### Phase 2 — SMS parity

The same builder over the Twilio webhook
(`src/app/api/webhooks/twilio/route.ts`): server-side assembly compositing
in the `e9caed2` pattern (sharp, shared logic — one composite definition),
piece state read from the server-visible store, pick/redo disambiguation
per the existing SMS-only rules. Composites in memory; body photos never
persisted (established rule).

**Exit criterion:** a webhook-level transcript test completes the identical
three-piece build over simulated SMS — every proposal arriving as an MMS
image, every adjustment as a text — and a pixel-level comparison shows the
server composite matches the browser composite for the same layer state
within an agreed tolerance (writable as stated now that CI has a real
canvas via #309). **Documented fallback**, kept in reserve rather than
expected: compare the server composite against a committed reference PNG
for a fixed layer state. The two executors are two implementations of one
contract; this comparison is the only thing enforcing it, so it may be
weakened but never dropped.

### Phase 3 — polish

Web canvas dragging on top of the proposal (the enhancement, not the
contract); build history surfaced through `versionService`; stencil
derivation from the assembled composite (one render, behind
`STENCIL_DERIVATION_ENABLED`); transcript-based evaluation of the builder
trigger, per future ADR-0046's consequence that judgment is untestable
until transcripts exist.

**Exit criterion:** a dragged adjustment and the equivalent worded
adjustment produce the same stored layer state; a full builder session
yields a stencil derived from the approved composite; a first
trigger-judgment review has been run over real or staged transcripts and
its findings filed as an issue.

## 6. Open product questions — for Samson, deliberately not decided here

1. **IP posture on reference images.** Feeding a copyrighted reference
   *image* into the generator is a different legal posture from naming a
   character in text. Today reference pixels are discarded and contribute
   only a one-line text description; `sourceImage` (image-to-image) makes
   wiring them through trivial, and the builder's piece loop is exactly
   where it would be most tempting ("make Riku look like *this*"). This is
   a product/legal call, not a technical one (carried forward from the
   2026-08-03 handoff, open decision 2).
2. **Do builder renders share the 25-generation lifetime allowance
   (ADR-0041)?** A four-piece build with a couple of redos is 6+ renders
   before assembly — a quarter of a customer's lifetime free allowance for
   one tattoo, if pieces count one-for-one. Options that need an owner
   call, not a guess: pieces count individually; a build counts as some
   fixed number; a build counts as one. Related and equally undecided: how
   piece redos interact with the per-design 25 fix allowance
   (ADR-0038/0039, `resolveFixAllowance()`) — same counter, a separate
   counter, or not counted there at all.
3. **What does the artist receive — the flat composite, or the pieces?**
   The founder's own reference example asked for separable linework ("so
   the lines can be easily edited and arranged on an iPad"), and the
   builder uniquely *has* separable pieces where a one-shot render does
   not. Whether the Brief/handoff carries only the approved flat design (as
   today) or also the individual piece assets and their layout is a product
   decision about what we promise artists, with storage and format
   consequences downstream.

---

*Sources: issue #294 trace comment (2026-08-04, verified against
`origin/main` @ 7652574); `docs/handoffs/2026-08-03-sms-parity-and-multicharacter-measurement.md`
and `docs/product/glossary.md` on `worktree-sketchbot-stencil-chain`;
ADR-0038, ADR-0039, ADR-0041 on `main`; future ADR-0044–0046 by title as
noted above. File:line citations checked against `origin/main` @ 7652574.*
