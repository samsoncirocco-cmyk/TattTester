#!/bin/bash
# Parallelized bulk enrichment. Phase 1: scrape the remaining queue with N
# concurrent Apify workers. Phase 2: host all scraped profiles with N parallel
# GCS/graph workers (the real bottleneck). Idempotent throughout.
set -u
TATT=/Users/samson/TatT
SCR=/Users/samson/tatt-scraper
PROF=$SCR/data/enrichment/instagram/apify-profiles
SHARD=$SCR/data/enrichment/instagram/host-shards
LOG=$SCR/data/enrichment/instagram/parallel.log
START=${1:-400}; END=${2:-10427}; NW=${3:-8}
TS=$(( $(date +%s) * 1000 ))
say(){ echo "[$(date +%H:%M:%S)] $*" >> "$LOG"; }

say "PARALLEL ENRICH start=$START end=$END workers=$NW"

# ---- Phase 1: concurrent scrape ----
span=$(( (END - START + NW - 1) / NW ))
pids=()
for w in $(seq 0 $((NW-1))); do
  s=$(( START + w*span )); c=$span
  [ "$s" -ge "$END" ] && break
  python3 "$SCR/execution/apify_ig_enrich.py" --start "$s" --count "$c" --chunk 100 >> "$LOG" 2>&1 &
  pids+=($!)
done
say "phase1: ${#pids[@]} scrape workers launched"
for p in "${pids[@]}"; do wait "$p"; done
say "phase1 DONE. scraped total: $(ls "$PROF"/*.json 2>/dev/null | wc -l)"

# ---- Phase 2: parallel host (shard profiles by hardlink round-robin) ----
rm -rf "$SHARD"; mkdir -p "$SHARD"
for w in $(seq 0 $((NW-1))); do mkdir -p "$SHARD/$w"; done
i=0
for f in "$PROF"/*.json; do
  ln -f "$f" "$SHARD/$((i % NW))/$(basename "$f")"
  i=$((i+1))
done
say "phase2: sharded $i profiles across $NW host workers"
pids=()
for w in $(seq 0 $((NW-1))); do
  ( cd "$TATT" && node scripts/host-artist-images.mjs --input "$SHARD/$w" --timestamp "$TS" >> "$LOG" 2>&1 ) &
  pids+=($!)
done
for p in "${pids[@]}"; do wait "$p"; done
say "PARALLEL ENRICH COMPLETE"
