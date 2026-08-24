#!/bin/zsh
# Pulls scrape progress from the .83 runner (which owns queue.json/state.json/
# master.json now — see 2026-07-27 migration) back into this machine's data/,
# then runs the existing checkpoint (git commit/push + Neo4j import), since
# this machine holds the git credentials, node, and Neo4j config for that step.
set -euo pipefail
cd ~/tatt-scraper

REMOTE=ciroccofam@192.168.0.83:/Users/ciroccofam/tatt-scraper/data

rsync -a "$REMOTE/queue.json" "$REMOTE/state.json" "$REMOTE/master.json" "$REMOTE/scrape.log" data/ 2>&1

./checkpoint.sh
