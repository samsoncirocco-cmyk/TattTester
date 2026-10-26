# Spec 8 — Show the credit balance and link the exhausted message to /pricing

Status: draft · Effort: **S** · Depends on: none · Rollup rank 9 (gaps R1, G5)

## 1. Problem

The customer never sees how many cuts they have left, although the server already returns it on every charged call, and when they run out the message has no way to buy more. Wrong on day one: the first customer to hit 25 reads "Buy 25 more cuts to keep designing" with nothing to click.

Current behaviour (generation/matching map §B5; `designSessionApi.ts`, `DesignSessionFlow.tsx`, pricing and the billing routes are unchanged at 1e301a1; the confirm route changed with #401 and its credits line was re-read there):

- Charged routes return `credits: {id, source, freeRemaining, paidRemaining}` (post-debit): confirm (`src/app/api/v1/design-session/[id]/confirm/route.ts:119` in the map; the response line is `:124` at 1e301a1), round (`round/route.ts:134`), `/api/v1/generate` (`generate/route.ts:191,224`).
- The client discards it. `postJson` returns only `record.session` (`src/features/design-session/services/designSessionApi.ts:142-145`) and `runRefineRound` returns `{session, downgraded, creditReleased}`, dropping `credits` (`:222-232`).
- There is no balance read endpoint. `rg freeRemaining|paidRemaining` outside `lib/` finds only `services/sketchbotSms/types.ts:78-79` (map §B5). `src/lib/generation-credits.ts` exports `reserveGenerationCredit`, `releaseGenerationCredit`, `grantPurchasedGenerationCredits` and constants (`LIFETIME_FREE_GENERATIONS = 25`, `CREDIT_PACK_GENERATIONS = 25`, `:12-13`) but no plain read.
- The only balance-like copy is static: "First 25 cuts are free" (`DesignConversation.tsx:38-39`), the button "Refine — 1 credit" (`DesignSessionFlow.tsx:35`, `REFINE_BUTTON_LABEL`), and on `/pricing` "Every account starts with 25 lifetime designs" (`src/app/pricing/page.tsx:22`).
- The exhausted state is HTTP 402 `GENERATION_CREDITS_EXHAUSTED`: "You have used your free generations. Buy 25 more cuts to keep designing." (`confirm/route.ts:126-131`), rendered as a bot bubble plus a generic Retry (`DesignConversation.tsx:123,324-335`). The buy button lives only on `/pricing` (`src/components/billing/BillingButtons.tsx:71`; `pricing/page.tsx:81`). In the critique re-roll arm exhaustion arrives as spoken copy (`orchestrator.ts` critique arm; map §B1).
- `POST /api/v1/billing/credits` already exists and starts the $10 / 25-design Checkout (`src/app/api/v1/billing/credits/route.ts`; success URL `/pricing?credits=success`).

## 2. Competitor evidence

- Krea: a free-image counter is always on screen ("9 → 8 free Krea 3 images left"), debited at the click; a priced `POST /api/jobs/estimate` returns `k3FreeImagesLeft` before the click (rollup R1; `~/reports/tatttester/2026-10-24-rea-krea.html`, `ev_d1b35b13`). Whether a failed job refunds the count was **not observed**.
- Gemini: no balance shown on the free tier; the only gate is an "Upgrade" link (G5; `~/reports/tatttester/2026-10-24-rea-gemini.html`). The rollup notes TattTester "has the data and hides it".

## 3. Scope and non-goals

In scope: show free and paid cuts remaining beside "Refine — 1 credit" and in the conversation header; make the exhausted message link to `/pricing`; add a tiny balance read.

Non-goals: pre-click price estimates (credit cost is a constant 1 per round/reveal); changing credit amounts or pricing (ADR-0041); the Studio fix allowance (separate ledger, `tatt:studio-fixes`); in-app purchase from the chat (link only); refund policy.

## 4. Proposed change

### 4.1 User-visible behaviour

1. Beside the Refine button: "Refine — 1 credit · 18 left". The count is free plus paid, with the split on tap/hover ("12 free, 6 bought").
2. On the opening screen of `/design` for a signed-in customer: a quiet line, "{n} cuts left."; signed-out customers keep the existing "First 25 cuts are free".
3. After every charged action the number updates from the response, with no extra request.
4. When none are left, the message ends with a link: "Get 25 more cuts" to `/pricing`. The Refine button is replaced by that link rather than failing on tap.
5. A round that is refunded (failure or lane downgrade) shows the number going back up, consistent with the existing "your credit is back" line.

### 4.2 Data and API

- **Keep the response.** `postJson` and `runRefineRound` return `credits` alongside the session (`designSessionApi.ts:142-145,222-232`); `confirmProposal` likewise (`:371-389`). Hold it in a small client store (a context or a zustand slice) `useCreditBalance()` with `{free, paid, total, known}`. `creditReleased: true` means the pre-debit value is restored: compute from the response's post-debit numbers plus the release, or simply refetch (below).
- **Read endpoint.** `GET /api/v1/billing/credits` in the existing file `src/app/api/v1/billing/credits/route.ts` (same auth as its POST: `verifyApiAuth` + `verifyFirebaseToken`); returns `{freeRemaining, paidRemaining}`. Backed by a new `getGenerationCreditBalance(uid)` in `src/lib/generation-credits.ts` that reads `generation_credits/{uid}` without a transaction. A missing doc means the lifetime free allowance is untouched: return `freeRemaining: LIFETIME_FREE_GENERATIONS, paidRemaining: 0`. **Unverified:** whether the doc is created lazily on first reserve (`generation-credits.ts:49-100`); read `reserveGenerationCredit` before choosing the default.
- **Fetch policy.** Fetch once when a signed-in customer opens `/design` and after `creditReleased`; otherwise rely on the response numbers.
- **Exhausted link.** The 402 handler in `DesignConversation.tsx:123,324-335` renders a button/link for `code === 'GENERATION_CREDITS_EXHAUSTED'`; the critique re-roll arm's spoken line (orchestrator) gets the same link by adding a `buyLink` flag on the critique result that the UI renders, rather than putting a URL inside spoken copy.
- **Race.** Two tabs can desync the displayed number; the next response corrects it.

### 4.3 Copy (ADR-0036)

"TattTester" in any new string. **Money is mentioned** in "Get 25 more cuts" only if a price is shown; keep the price off the in-chat link and leave it on `/pricing`. ADR-0036 law 2 is about booking deposits and fees ("who pays what and who keeps what"); whether it also governs the consumer credit pack is not stated, so the pricing page is left as is and the chat link carries no amount (open question 8.2).

- Button: "Refine — 1 credit · 18 left".
- Count line: "18 cuts left."
- Exhausted (replaces the existing sentence's ending): "You've used your free cuts. Get 25 more to keep designing." with the link "Get 25 more cuts".
- Refund: unchanged, "your credit is back".

## 5. Failure and edge cases

1. Balance fetch fails or is slow: show nothing rather than a wrong number (`known:false` hides the count; the button label reverts to "Refine — 1 credit").
2. Signed-out customer: no count; the first charged action prompts sign-in as today (`SIGN_IN_LINE`, `DesignConversation.tsx:311-322`).
3. Free credits exhausted but paid credits remain: the displayed total is the sum; the 402 only appears at zero.
4. Reservation happens before the render and is released on failure (`generation-credits.ts:49-135`): the count dips during a render and comes back on failure. Showing the dip is accurate and matches the money the server holds; do not hide it.
5. After purchase the customer returns via `/pricing?credits=success`; the `/design` count refetches on mount.
6. Pack price or size changes: constants come from `CREDIT_PACK_GENERATIONS`; do not hard-code 25 in the new copy.
7. Critique fix allowance is a separate meter ("fixes left", `fixesLeftLine`, critiqueVoice); do not merge it into this count.

## 6. Test plan

Extend:
- `src/features/design-session/__tests__/designSessionApi.test.ts`: confirm/round/reroll results expose `credits`; `creditReleased` handled.
- `src/features/design-session/__tests__/DesignSessionFlow.test.tsx`: Refine label shows the count; label falls back when unknown; exhausted state shows the link instead of a failing button.
- `src/features/design-session/__tests__/DesignConversation.test.tsx`: 402 renders "Get 25 more cuts" linking to `/pricing`.
- `src/lib/generation-credits.test.ts`: `getGenerationCreditBalance` for missing doc, free-only, paid-only, mixed.
- `src/app/api/v1/billing/credits/route.test.ts`: GET requires auth, returns the balance, does not mutate.

Add:
- `src/features/design-session/__tests__/creditBalance.test.tsx` (new): store updates from responses and from a refund without an extra fetch.

## 7. Effort and dependencies

S: stop discarding a field, one small read, label and link changes. Independent; benefits spec 7's hydration (balance refetch on resume).

## 8. Open questions for Samson

1. Show the split (free vs bought) at all, or only the total? Recommendation: total, with the split on tap.
2. Does ADR-0036's money sentence law cover the consumer credit pack on `/pricing` and in the chat link, or only booking money? The pricing page currently has no "who keeps what" sentence for credits.
3. Should the count appear on the signed-out opener ("25 free cuts") as a number, or keep the static line?
