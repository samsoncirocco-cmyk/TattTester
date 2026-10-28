#!/usr/bin/env python3
"""Resumable background Meta business_discovery pass over the August scheduler's artists.

Reads ``~/tatt-scraper/data/master.json`` read-only and lays it out as a normal
discover_inhouse work dir (raw_shops.json + raw_shop_sites.json, one "crawl" entry
per shop listing its artists' handles), then repeatedly runs the existing
``discover_inhouse.py enrich --provider meta`` and ``filter`` steps, so caching,
miss tracking, shop-account detection and the importer candidate format are reused.

Budget: at most --per-hour calls in any rolling hour (default 180), in small
batches. Rate-limit codes (4/17/32/613) pause an hour; token error 190 stops.
Everything is checkpointed under --root; rerun the same command to resume.
Touch <root>/STOP to stop cleanly. Never prints the token. No Neo4j access.

    nohup caffeinate -s python3 execution/master_enrich.py run >> <root>/job.log 2>&1 &
"""
from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DISCOVER = ROOT / "execution" / "discover_inhouse.py"
MASTER = Path(os.path.expanduser("~/tatt-scraper/data/master.json"))
DEFAULT_ROOT = ROOT / "data" / "discovery-inhouse" / "master-enrich"
REFERENCE = ROOT / "data" / "discovery-inhouse" / "reference-snapshot.json"
RATE_CODES = {"4", "17", "32", "613"}
sys.path.insert(0, str(ROOT / "execution"))
from discover_inhouse import load, normalize_handle, normalize_state, save  # noqa: E402


def log(msg: str) -> None:
    print(time.strftime("%Y-%m-%d %H:%M:%S"), msg, flush=True)


def shop_key(name: str, city: str, state: str) -> str:
    return f"{(name or '').strip().lower()}|{(city or '').strip().lower()}|{(state or '').strip().upper()}"


def prepare(master: dict, work: Path) -> dict:
    """master.json -> raw_shops.json + raw_shop_sites.json (artist handles per shop)."""
    shops, index = {}, {}
    for s in master.get("shops", []):
        key = f"gmaps:{s['place_id']}"
        shops[key] = {"name": s.get("shopName", ""), "city": s.get("city"),
                      "state": normalize_state(s.get("state")), "website": s.get("website"),
                      "instagram": None, "email": None, "phone": None,
                      "lat": s.get("lat"), "lon": s.get("lng"), "placeId": s["place_id"], "source": "places"}
        index.setdefault(shop_key(s.get("shopName"), s.get("city"), s.get("state")), key)
    crawl: dict[str, dict] = {}
    unmatched = 0
    for a in master.get("artists", []):
        handle = normalize_handle(a.get("instagram"))
        if not handle:
            continue
        key = index.get(shop_key(a.get("shopName"), a.get("city"), a.get("state")))
        if not key:
            unmatched += 1
            continue  # no shop record: skipped (no seed location to trust)
        entry = crawl.setdefault(key, {"instagram": [], "emails": [], "phones": [], "tech": [],
                                       "pages": ["master.json"], "errors": []})
        if handle not in entry["instagram"]:
            entry["instagram"].append(handle)
    work.mkdir(parents=True, exist_ok=True)
    save(work / "raw_shops.json", shops)
    save(work / "raw_shop_sites.json", crawl)
    handles = sum(len(v["instagram"]) for v in crawl.values())
    return {"shops": len(shops), "shopsWithArtists": len(crawl), "handles": handles, "unmatchedArtists": unmatched}


def allowed_now(calls: list[float], per_hour: int, now: float) -> int:
    return max(0, per_hour - sum(1 for t in calls if now - t < 3600))


def parse_enrich_output(out: str) -> tuple[int, int, str | None]:
    req = sum(int(x) for x in re.findall(r"requested=(\d+)", out))
    res = sum(int(x) for x in re.findall(r"resolved=(\d+)", out))
    m = re.search(r"code=(\d+)", out)
    return req, res, (m.group(1) if m else None)


def disc(work: Path, reference: Path, *args: str) -> tuple[int, str]:
    cmd = [sys.executable, str(DISCOVER), "--out", str(work), "--reference", str(reference), *args]
    proc = subprocess.run(cmd, capture_output=True, text=True, cwd=ROOT, timeout=3600)
    # discover_inhouse never prints the token; strip anything token-shaped anyway
    out = re.sub(r"access_token=[^&\s]+", "access_token=***", proc.stdout + proc.stderr)
    return proc.returncode, out[-4000:]


def run(root: Path, reference: Path, per_hour: int, batch: int) -> int:
    work = root / "work"
    state_path = root / "state.json"
    state = load(state_path, {"calls": [], "requested": 0, "resolved": 0, "pauseUntil": 0})
    if not (work / "raw_shops.json").exists():
        log(f"prepare: {prepare(load(MASTER, {}), work)}")
    while True:
        if (root / "STOP").exists():
            log("STOP file found — exiting cleanly")
            return 0
        now = time.time()
        if state.get("pauseUntil", 0) > now:
            time.sleep(min(300, state["pauseUntil"] - now))
            continue
        state["calls"] = [t for t in state["calls"] if now - t < 3600]
        room = min(batch, allowed_now(state["calls"], per_hour, now))
        if room < 2:
            time.sleep(60)
            continue
        code, out = disc(work, reference, "enrich", "--provider", "meta", "--max", str(max(1, room // 2)))
        req, res, err = parse_enrich_output(out)
        state["calls"] += [time.time()] * req
        state["requested"] += req
        state["resolved"] += res
        save(state_path, state)
        log(f"batch requested={req} resolved={res} totals req={state['requested']} res={state['resolved']}"
            + (f" exit={code} err={err}" if code else ""))
        if code and err == "190":
            log("Meta token error 190 — stopping; refresh IG_GRAPH_TOKEN then rerun to resume")
            return 2
        if code and err in RATE_CODES:
            state["pauseUntil"] = time.time() + 3600
            save(state_path, state)
            log(f"rate-limit code {err} — pausing 1h")
            continue
        if code:
            log("enrich failed: " + out.strip().splitlines()[-1][:200] if out.strip() else "enrich failed")
            time.sleep(300)
            continue
        fcode, fout = disc(work, reference, "filter")
        log("filter: " + (fout.strip().splitlines()[0][:200] if fout.strip() else f"exit {fcode}"))
        if req == 0:
            log("nothing left to look up — done")
            return 0
        time.sleep(max(20, 3600 / per_hour * req))  # spread calls evenly over the hour


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--root", type=Path, default=DEFAULT_ROOT)
    ap.add_argument("--reference", type=Path, default=REFERENCE)
    sub = ap.add_subparsers(dest="cmd", required=True)
    r = sub.add_parser("run")
    r.add_argument("--per-hour", type=int, default=180)
    r.add_argument("--batch", type=int, default=30)
    sub.add_parser("status")
    a = ap.parse_args()
    if a.cmd == "run":
        return run(a.root, a.reference, a.per_hour, a.batch)
    state = load(a.root / "state.json", {})
    cands = load(a.root / "work" / "candidates.json", [])
    print(json.dumps({"requested": state.get("requested"), "resolved": state.get("resolved"),
                      "lastHourCalls": sum(1 for t in state.get("calls", []) if time.time() - t < 3600),
                      "candidates": len(cands), "bookable": sum(1 for c in cands if c.get("looksBookable")),
                      "stopFile": (a.root / "STOP").exists()}, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
