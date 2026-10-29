---
name: verify-changes
description: Use when validating any change in this repo before calling it done — after edits, before commit/push, while shepherding a PR to merge, or when CI is red and you need to know what "green" means here. Do not use for writing new tests or debugging product behavior (see booking-flow-debug for booking symptoms).
---

# Verifying changes in TattTester

## What to run

- `npm test` — full Vitest suite (`vitest run`).
- `npm run lint` — ESLint. Advisory: CI runs it with `continue-on-error`
  because of a pre-existing backlog (193 errors / 109 warnings as of
  run 33032690138, left over from the flat-config migration). Don't add new errors; don't treat old ones as your blocker.
- `npm run docs:check` — validates docs (`scripts/docs/validate-docs.mjs`).
  Run it for any change under `docs/` (ADR numbering is checked).
- `npm run security:secrets` — secret scan; its CI twin ("Scan for committed
  secrets") is a required check.
- `npm run build` — only when the change plausibly affects the build
  (config, imports, server components). CI's "Build Next.js App" is required
  on main pushes.

## Expected green baseline

Main is fully green. The last CI run on main (run 33032690138, commit
`6b1a0af`, 2026-08-27) reported **3372 passed, 2 skipped (3374 tests)
across 259 test files (258 run, 1 skipped), 0 failures**. If main has
moved since, refresh this from `gh run list --branch main --workflow ci-cd.yml`.
Any failure you see after your change is yours until proven otherwise —
there is no known-flaky allowance.

If you cannot install dependencies quickly (`npm ci --legacy-peer-deps`,
matching CI), say so explicitly in the PR body rather than implying you ran
the suite. Docs-only changes still need `docs:check`.

## What merging to main actually requires

Branch protection on main (verified via the GitHub API):

- Required checks: **Scan for committed secrets, Test JavaScript,
  Test Python, Build Next.js App**. Lint is NOT required (advisory).
- **Strict up-to-date branches**: a BEHIND branch cannot merge.
- **Conversation resolution required**: every review thread must be
  resolved.
- Enforced for admins; no force pushes.

Python tests (`pytest tests/execution/`) run in CI even for JS-only
changes; they are a required check, so a red Python job blocks you too.

## Gotchas

- **Scoped test runs hide breakage.** `vitest run path/to/x.test.ts` passing
  proves nothing about the rest of the 3,300+ tests — copy assertions
  (e.g. `src/lib/money-copy.test.ts`) and cross-cutting suites break from
  edits far away. Always finish with the full `npm test`.
- **Unresolved review threads read as a policy block.** With conversation
  resolution required, `gh pr merge` failures phrased like "base branch
  policy prohibits the merge" usually mean an unresolved thread, not a
  permissions problem. Resolve or reply-and-resolve every thread.
- **Auto-merge does not fire on BEHIND branches.** Because strict checks are
  on, a branch behind main sits idle even with auto-merge armed. Run
  `gh api -X PUT repos/{owner}/{repo}/pulls/<N>/update-branch` **once**,
  then let CI finish and merge. Never loop update-branch: every update
  resets CI and can chase its own tail if main keeps moving.
- **Bugbot re-reviews every push.** Each push to a PR triggers a fresh
  Bugbot review round that can open new threads (which then block merge via
  conversation resolution). Batch your fixes; don't push one-line commits
  repeatedly while shepherding.
- **The workflow header comment is stale.** It claims PRs run "lint + tests
  only", but the `build-app` job has no condition — "Build Next.js App"
  runs on every PR, using `cp env.demo .env.local` (credential-free demo
  config). If your change needs a real env var at build time, CI won't
  have it; keep builds working against `env.demo`.
