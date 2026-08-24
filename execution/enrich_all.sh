#!/bin/bash
# Combined bulk enrichment: Apify scrape -> GCS host -> graph write, in batches,
# over the full remaining artist queue. Idempotent (host script skips existing
# GCS paths cheaply; scraper overwrites its own per-artist json).
set -u
TATT=/Users/samson/TatT
SCRAPER=/Users/samson/tatt-scraper
PROFILES=$SCRAPER/data/enrichment/instagram/apify-profiles
LOG=$SCRAPER/data/enrichment/instagram/enrich_all.log
START=${1:-100}
END=${2:-10427}
STEP=${3:-300}
TS=$(( $(date +%s) * 1000 ))

echo "[$(date +%H:%M:%S)] BULK ENRICH start=$START end=$END step=$STEP" >> "$LOG"
off=$START
while [ "$off" -lt "$END" ]; do
  echo "[$(date +%H:%M:%S)] === batch offset $off ===" >> "$LOG"
  # 1. scrape this batch via Apify
  python3 "$SCRAPER/execution/apify_ig_enrich.py" --start "$off" --count "$STEP" --chunk 100 >> "$LOG" 2>&1
  # 2. host the images downloaded so far (idempotent; only new artists upload)
  ( cd "$TATT" && node scripts/host-artist-images.mjs --input "$PROFILES" --timestamp "$TS" >> "$LOG" 2>&1 )
  echo "[$(date +%H:%M:%S)] batch offset $off done" >> "$LOG"
  off=$(( off + STEP ))
done
echo "[$(date +%H:%M:%S)] BULK ENRICH COMPLETE" >> "$LOG"
