#!/bin/bash
set -u
TATT=/Users/samson/TatT; SCR=/Users/samson/tatt-scraper
PROF=$SCR/data/enrichment/instagram/apify-profiles
SHARD=$SCR/data/enrichment/instagram/host-shards
LOG=$SCR/data/enrichment/instagram/host_only.log
NW=${1:-3}; TS=$(( $(date +%s) * 1000 ))
say(){ echo "[$(date +%H:%M:%S)] $*" >> "$LOG"; }
rm -rf "$SHARD"; mkdir -p "$SHARD"; for w in $(seq 0 $((NW-1))); do mkdir -p "$SHARD/$w"; done
i=0; for f in "$PROF"/*.json; do ln -f "$f" "$SHARD/$((i % NW))/$(basename "$f")"; i=$((i+1)); done
say "host_only: sharded $i profiles across $NW niced workers"
pids=()
for w in $(seq 0 $((NW-1))); do
  ( cd "$TATT" && nice -n 15 node scripts/host-artist-images.mjs --input "$SHARD/$w" --timestamp "$TS" >> "$LOG" 2>&1 ) &
  pids+=($!)
done
for p in "${pids[@]}"; do wait "$p"; done
say "HOST COMPLETE"
