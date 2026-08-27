---
status: accepted
---

# An open color question is asked, not answered

Decided 2026-08-27 (grill session with Samson; issue #378). The triggering
case: a customer says "geometric" and never mentions color at all. Geometric
tattoos are overwhelmingly blackwork, so the cheap move is to let the style
tag vote monochrome in `resolvePalette` and render black ink without comment.

We already ruled once that the system must not answer a question the customer
has visibly left open: when intake flags `color-blackwork` in `ambiguousAxes`,
palette derivation returns `undefined` and asserts nothing (the deference
restored on the `jvxaow` branch after commit 5571002 dropped it). Issue #378
asked whether the *silent* version of the same situation — the customer never
brought color up — deserves the same treatment or a genre-norm default.

## Decision

It gets the same treatment. When a style implies a palette but the customer
has said nothing about color, the app asks one question — "black ink or
color?" — before rendering. No silent default, ever. "Never mentioned color"
and "flagged ambiguous on color" are the same state from the customer's point
of view: an open question. The two paths must behave identically: defer, then
ask.

The answer, once given, is customer voice — it settles the axis and must
survive to the reveal path like any settled axis (the seam #382 covers:
`settledAxes` → `resolvePalette` → the rendered prompt).

## Rejected

- **Silent blackwork default.** Genre-accurate and frictionless, but it
  quietly answers for the customer, and a reroll costing a credit makes the
  wrong guess *their* expense.
- **Default plus escape-hatch copy** ("shown in classic blackwork — want
  color? just say so"). Honest, but it still spends a render on a guess and
  makes the correction the customer's job.

## Consequence

One added question of friction on monochrome-leaning styles with no color
word. Accepted deliberately: the deference principle stays uniform instead of
forking on how the openness was detected.
