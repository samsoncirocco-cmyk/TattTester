#!/bin/bash
# TatT Overnight Crew — local launchd runner (fires nightly at 23:00).
# Clones TatT fresh into an isolated working dir (never touches ~/TatT or other
# sessions), copies local creds in, and runs Claude headless as the crew per CREW.md.
set -u
export PATH="/Users/samson/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
CREW_HOME=/Users/samson/tatt-crew
WD=$CREW_HOME/run
LOGDIR=$CREW_HOME/logs
STAMP=$(date +%Y%m%d-%H%M)
LOG=$LOGDIR/crew-$STAMP.log
mkdir -p "$LOGDIR"

echo "[$(date)] === TatT crew run start ===" >> "$LOG"

# Persistent isolated checkout (separate from ~/TatT so it never collides with
# live sessions there). Clone once; thereafter just sync to origin/main — this
# keeps the gitignored node_modules, so no re-download / re-install each night.
if [ ! -d "$WD/.git" ]; then
  git clone https://github.com/samsoncirocco-cmyk/TatT "$WD" >> "$LOG" 2>&1 || { echo "clone failed" >> "$LOG"; exit 1; }
fi
cd "$WD" || exit 1
git checkout -q main 2>>"$LOG" || git checkout -q -b main
git fetch -q origin >> "$LOG" 2>&1
git reset --hard -q origin/main >> "$LOG" 2>&1
git clean -fdq >> "$LOG" 2>&1   # drops stray files but NOT gitignored node_modules
cp /Users/samson/TatT/.env /Users/samson/TatT/.env.local "$WD/" 2>/dev/null
# Only reinstall deps when the lockfile actually changed since last run.
LOCKHASH=$(shasum package-lock.json 2>/dev/null | cut -d' ' -f1)
if [ ! -d node_modules ] || [ "$LOCKHASH" != "$(cat "$CREW_HOME/.lockhash" 2>/dev/null)" ]; then
  npm install >> "$LOG" 2>&1 && echo "$LOCKHASH" > "$CREW_HOME/.lockhash"
fi

PROMPT='You are the TatT Overnight Crew running locally and unattended overnight. Work carefully and conservatively.

STEP 1: Read CREW.md at the repo root IN FULL and follow it EXACTLY — it is your operating manual (lanes, the green tests+build gate, stop-on-red, the CREW_MODE training-wheels line which is currently pr-only, the $20 spend cap, and the end-of-run report). Also read CLAUDE.md for engineering standards. You are in an isolated fresh clone with local .env creds available, but CREW_MODE:pr-only means CODE TICKETS ONLY — no paid/data jobs, no merges, open PRs only.

STEP 2: npm install. Then git fetch origin and run npm test. If tests are RED on origin/main, do NOT do feature work (stop-on-red): fix only if trivial+safe, else stop and report on issue #83.

STEP 3: gh issue list --label crew:autonomous --state open. Skip any issue that already has an open PR. Pick up to 3 by priority. For EACH: comment on the issue that you are starting, branch crew/<issue#>-<slug> from origin/main, implement per the acceptance criteria (surgical diffs, TDD where sensible, punk/StudioShell design system for UI, never fake data), run npm test (fully green) AND npm run build (passes) as the hard gate, self-review the diff as a skeptic, then gh pr create with a summary, Closes #N, and the crew:autonomous label. DO NOT MERGE. If the gate fails or you are unsure, open a DRAFT PR explaining the blocker and move on.

NEVER: work crew:needs-grill or crew:human-ops issues; touch money/auth/data-deletion; run paid/data jobs (pr-only); commit secrets or .env; weaken tests; force-push; merge anything; spend money.

STEP 4: Post a summary comment on issue #83: tickets attempted, PRs opened with links, anything skipped and why, anything needing a human decision. This is the maintainer morning report.'

claude -p "$PROMPT" --dangerously-skip-permissions --model claude-sonnet-5 >> "$LOG" 2>&1
echo "[$(date)] === TatT crew run end (exit $?) ===" >> "$LOG"
