---
status: accepted
---

# Mapping an Idea to artists: extend the hybrid matcher, don't rebuild it

Design discussion, 2026-08-05, following the Idea graph decisions
(ADR-0055–0058). Once an Idea carries faceted descriptors and canonical style
tags, the question is how it becomes an artist recommendation — and specifically
whether that runs on vision embeddings of artists' Instagram posts.

The proposal on the table: extract vision embeddings plus structured signals per
consented post, aggregate into an artist profile with confidence and recency,
match the Idea against both portfolio embedding and tag overlap, and score with
interpretable weights (visual 40%, ontology 30%, consistency 15%, practical 10%,
novelty 5%), showing evidence posts and "matched because" tags.

Most of that already exists, which changes the question from *what to build* to
*what to change*.

## What already ships

`src/features/match-pulse/services/hybridMatchService.ts` merges Neo4j graph
traversal with vector search. `src/utils/scoreAggregation.js` scores on
interpretable weights — `visualSimilarity` 0.30, `styleAlignment` 0.25,
`location` 0.15, `rating` 0.15, `budget` 0.10, `randomVariety` 0.05 — and
`generateMatchReasoning()` already emits the "matched because" strings. The
service already zeroes the vector weight when vector search degrades, so a dead
lane doesn't dilute real graph signal.

The proposed weighting (40/30/15/10/5) and the shipped weighting
(30/25/15/15/10/5) are the same design.

## Decision

Extend the existing hybrid matcher rather than building a second one. The two
additions that do not exist today and are worth having, sequenced per the
owner decisions below:

- **Artist consistency.** An artist with forty blackwork pieces and one with
  three blackwork among thirty color pieces currently score identically on
  style. Consistency across a portfolio is a real signal and is absent.
- **Negative signals.** Rejected artists and rejected descriptors are not fed
  back at all. ADR-0058's `REJECTED_DESCRIPTOR` is the intended source: "hate
  the first one, too busy" should push down ornate-heavy artists, not merely
  re-roll an image.

## Owner decisions (2026-08-11, grilled with Sonnet)

1. **Visual similarity: don't reverse the migration blind.** Keep text
   embeddings live, stand up image embeddings alongside them, and let real
   match/click data pick the weighting once it exists. Reversing the CLIP→text
   migration outright was rejected — nothing has shown image embeddings work
   better for this product, and the migration note says text was chosen
   because it matched user queries better. Running both in parallel does mean
   maintaining two embedding pipelines for a while; that cost is not yet
   sized and is an open risk.

2. **Portfolio image sourcing stays out of scope**, deferred to ADR-0037,
   ADR-0042, ADR-0043, ADR-0025 as originally proposed. Not re-litigated.

3. **Weights: collapse now, split later.** Ship with fewer, coarser weight
   categories instead of five precise terms at 5% granularity — that
   precision is a guess dressed up as a measurement when nobody has ever
   clicked a recommended artist. Revisit granularity once real interaction
   data exists to fit against.

4. **Novelty: drop the random slot, don't dress it up.** `randomVariety`'s
   `Math.random()` term is noise, not signal, and is removed from the score
   entirely. If a genuine "deliberate exposure to unfamiliar artists" feature
   gets built later, it is a distinct discovery mechanism, not a score weight
   — and it is not scheduled by this ADR.

5. **Build order: negative signals before artist consistency.** Both are real
   builds, not tuning, and nothing forces them together. Negative signals
   (`REJECTED_DESCRIPTOR` feedback pushing down matching artists) go first —
   it depends on ADR-0058's faceted vocabulary, which is already staffed and
   in flight, and it closes a gap users feel today ("hate it, too busy"
   currently does nothing but re-roll an image). Artist consistency (portfolio
   specialization signal) is next in line, with no owner or date yet.

## Rejected

- **A second, separate recommender.** Rediscovers the shipped design under new
  names and leaves two scorers to keep in sync.
- **Pure visual nearest-neighbour** ("which artist image looks most similar").
  Rejected in the proposal itself and rightly: it recommends imitation rather
  than fit, and it cannot explain itself, which the match surface requires.

## Consequences

Evidence posts are the missing half of an explanation that already half-exists —
`generateMatchReasoning` says why, but shows nothing.

Text embeddings stay the load-bearing signal until image embeddings are stood
up and data says otherwise — the faceted vocabulary of ADR-0058 continues
carrying more of the matching load than the original proposal assumed.

The score's weight categories will be collapsed and `randomVariety` removed as
a follow-up change to `scoreAggregation.js`, separate from the negative-signals
and artist-consistency builds.
