#!/usr/bin/env python3
"""Resumable, rate-budgeted US-wide artist discovery sweep (dry-run only).

Ranks US places (Census 2023 population + gazetteer centroids) by under-coverage in
the read-only reference snapshot, turns them into non-overlapping bbox tiles, and
drives ``discover_inhouse.py`` per tile:

    seed (Overpass) -> crawl (robots-aware) -> enrich (Meta, budgeted) -> resolve -> filter

All state lives under ``--root`` (default data/discovery-inhouse/us-sweep, gitignored):
  plan.json         ranked tiles
  state.json        per-tile stage + errors, global pause-until
  meta_calls.json   timestamps of Meta calls (rolling hourly budget)
  combined_candidates.json   deduped bookable candidates across tiles
  STOP              create this file to stop cleanly after the current step

Meta is the bottleneck (~200 calls/hr). When the budget is spent or Meta returns a
rate-limit code, enrichment pauses and the sweep keeps seeding/crawling ahead, so
the per-tile handle queues (raw_shop_sites.json + profile cache) fill up and are
drained as budget returns. A token error (190) stops the sweep. Never writes Neo4j.

    python3 execution/discover_us_sweep.py plan
    python3 execution/discover_us_sweep.py run      # loops until done or STOP
    python3 execution/discover_us_sweep.py status
    python3 execution/discover_us_sweep.py combine
"""
from __future__ import annotations

import argparse
import csv
import io
import json
import math
import re
import subprocess
import sys
import time
import urllib.request
import zipfile
from collections import Counter
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DISCOVER = ROOT / "execution" / "discover_inhouse.py"
GAZ = "https://www2.census.gov/geo/docs/maps-data/data/gazetteer/2023_Gazetteer/2023_Gaz_place_national.zip"
POP = "https://www2.census.gov/programs-surveys/popest/datasets/2020-2023/cities/totals/sub-est2023.csv"
UA = "TattTester-discovery/0.1 (+https://github.com/; contact: owner)"
META_PER_HOUR = 180          # stay under Meta's ~200/hr
RATE_CODES = {"4", "17", "32", "613"}
SUFFIX = re.compile(r"\s+(city|town|village|CDP|municipality|borough|consolidated government.*|"
                    r"metropolitan government.*|unified government.*|\(balance\)|urban county)$", re.I)


def log(msg: str) -> None:
    print(f"{datetime.now():%Y-%m-%d %H:%M:%S} {msg}", flush=True)


def load(path: Path, default):
    return json.loads(path.read_text()) if path.exists() else default


def save(path: Path, data) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(data, indent=1, ensure_ascii=False))
    tmp.replace(path)


def fetch(url: str, dest: Path) -> Path:
    if not dest.exists():
        dest.parent.mkdir(parents=True, exist_ok=True)
        req = urllib.request.Request(url, headers={"User-Agent": UA})
        dest.write_bytes(urllib.request.urlopen(req, timeout=120).read())
    return dest


def clean_city(name: str) -> str:
    """'Oklahoma City city' -> 'Oklahoma City', 'Nashville-Davidson metropolitan
    government (balance)' -> 'Nashville', 'San Buenaventura (Ventura) city' -> 'Ventura'."""
    consolidated = bool(re.search(r"government|consolidated|\(balance\)| County$", name))
    name = re.sub(r"\s*\(balance\)", "", name).strip()
    name = SUFFIX.sub("", name).strip()
    alias = re.search(r"\(([^)]+)\)", name)
    if alias:
        name = alias.group(1)
    name = name.split("/")[0].strip()
    name = re.sub(r"^Urban\s+", "", name)
    if consolidated and "-" in name:
        name = name.split("-")[0]
    return re.sub(r"\s+County$", "", name).strip()


def build_plan(root: Path, reference: Path, min_pop: int, max_tiles: int) -> list[dict]:
    cache = root / "census"
    gz = zipfile.ZipFile(fetch(GAZ, cache / "gaz.zip"))
    rows = csv.DictReader(io.TextIOWrapper(gz.open(gz.namelist()[0]), "utf-8"), delimiter="\t")
    geo = {}
    for r in rows:
        r = {k.strip(): v.strip() for k, v in r.items()}
        geo[r["GEOID"]] = r
    places = []
    with open(fetch(POP, cache / "pop.csv"), encoding="latin-1") as fh:
        for r in csv.DictReader(fh):
            if r["SUMLEV"] != "162":
                continue
            g = geo.get(r["STATE"] + r["PLACE"])
            pop = int(r["POPESTIMATE2023"] or 0)
            if not g or pop < min_pop:
                continue
            places.append({"city": clean_city(r["NAME"]), "state": g["USPS"], "pop": pop,
                           "lat": float(g["INTPTLAT"]), "lon": float(g["INTPTLONG"]),
                           "sqmi": float(g["ALAND_SQMI"])})
    snap = load(reference, {})
    have = Counter(((a.get("city") or "").strip().lower(), (a.get("state") or "").strip().upper())
                   for a in snap.get("artists", []))
    for p in places:
        p["artists"] = have[(p["city"].lower(), p["state"])]
        p["per100k"] = round(p["artists"] * 1e5 / p["pop"], 2)
        p["priority"] = p["pop"] / (p["artists"] + 1)   # big + thin coverage first
    places.sort(key=lambda p: -p["priority"])
    tiles: list[dict] = []
    for p in places:
        if any(t["s"] <= p["lat"] <= t["n"] and t["w"] <= p["lon"] <= t["e"] for t in tiles):
            continue                                       # suburb already inside a tile
        r_mi = min(max(math.sqrt(p["sqmi"]) * 0.65, 4.0), 18.0)
        dlat, dlon = r_mi / 69.0, r_mi / (69.0 * math.cos(math.radians(p["lat"])))
        slug = re.sub(r"[^a-z0-9]+", "-", f"{p['city']}-{p['state']}".lower()).strip("-")
        tiles.append({**p, "id": slug, "s": round(p["lat"] - dlat, 4), "n": round(p["lat"] + dlat, 4),
                      "w": round(p["lon"] - dlon, 4), "e": round(p["lon"] + dlon, 4)})
        if len(tiles) >= max_tiles:
            break
    for t in tiles:
        t["bbox"] = f"{t['s']},{t['w']},{t['n']},{t['e']}"
    return tiles


class Sweep:
    def __init__(self, root: Path, reference: Path, crawl_max: int):
        self.root, self.reference, self.crawl_max = root, reference, crawl_max
        self.state = load(root / "state.json", {"tiles": {}, "pauseUntil": 0})
        self.calls = load(root / "meta_calls.json", [])
        self.plan = load(root / "plan.json", [])

    def flush(self) -> None:
        save(self.root / "state.json", self.state)
        save(self.root / "meta_calls.json", self.calls)

    def tile(self, tid: str) -> dict:
        return self.state["tiles"].setdefault(tid, {"stage": "new", "errors": 0})

    def budget(self) -> int:
        now = time.time()
        self.calls = [t for t in self.calls if now - t < 3600]
        if now < self.state.get("pauseUntil", 0):
            return 0
        return META_PER_HOUR - len(self.calls)

    def disc(self, tid: str, *args: str, timeout: int = 3600) -> tuple[int, str]:
        cmd = [sys.executable, str(DISCOVER), "--out", str(self.root / "tiles" / tid),
               "--reference", str(self.reference), *args]
        try:
            proc = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout, cwd=ROOT)
        except subprocess.TimeoutExpired:
            return 124, "timeout"
        out = (proc.stdout + proc.stderr)[-4000:]
        return proc.returncode, out

    def step_prep(self, t: dict) -> None:
        st = self.tile(t["id"])
        if st["stage"] == "new":
            code, out = self.disc(t["id"], "seed-shops", "--bbox", t["bbox"], timeout=1800)
            m = re.search(r"shops=(\d+)", out)
            if code == 0 and m:
                st.update(stage="seeded", shops=int(m.group(1)))
            else:
                st["errors"] += 1
                st["lastError"] = out.strip().splitlines()[-1][:200] if out.strip() else f"exit {code}"
                if st["errors"] >= 3:
                    st["stage"] = "failed"
            log(f"[{t['id']}] seed -> {st['stage']} shops={st.get('shops')}")
        elif st["stage"] == "seeded":
            code, out = self.disc(t["id"], "crawl-shops", "--max", str(self.crawl_max))
            st["stage"] = "crawled" if code == 0 else st["stage"]
            if code:
                st["errors"] += 1
                if st["errors"] >= 3:
                    st["stage"] = "crawled"   # enrich with what OSM gave us
            code, out = self.disc(t["id"], "stats")
            try:
                st["handles"] = json.loads(out[out.index("{"):])["handlesFound"]
            except Exception:
                pass
            log(f"[{t['id']}] crawl -> {st['stage']} handles={st.get('handles')}")
        self.flush()

    def step_enrich(self, t: dict, budget: int) -> bool:
        """Returns False when the sweep must stop (token problem)."""
        st = self.tile(t["id"])
        per_pass = max(1, budget // 2)
        code, out = self.disc(t["id"], "enrich", "--provider", "meta", "--max", str(per_pass))
        req = sum(int(x) for x in re.findall(r"requested=(\d+)", out))
        res = sum(int(x) for x in re.findall(r"resolved=(\d+)", out))
        self.calls += [time.time()] * req
        st["metaCalls"] = st.get("metaCalls", 0) + req
        st["resolved"] = st.get("resolved", 0) + res
        if code:
            m = re.search(r"code=(\d+)", out)
            err = m.group(1) if m else "?"
            if err == "190":
                log(f"[{t['id']}] Meta token error (190) — stopping sweep; refresh the token then rerun")
                self.flush()
                return False
            if err in RATE_CODES:
                self.state["pauseUntil"] = time.time() + 3600
                log(f"[{t['id']}] Meta rate limit code={err} — pausing Meta 60 min")
            else:
                st["errors"] += 1
                log(f"[{t['id']}] enrich error code={err}")
                if st["errors"] >= 5:
                    st["stage"] = "enriched"
        elif req == 0 or req < per_pass:
            st["stage"] = "enriched"     # queue drained for this tile
        log(f"[{t['id']}] enrich requested={req} resolved={res} -> {st['stage']}")
        self.flush()
        if st["stage"] == "enriched":
            self.finish(t)
        return True

    def finish(self, t: dict) -> None:
        st = self.tile(t["id"])
        self.disc(t["id"], "resolve-locations", timeout=1800)
        code, out = self.disc(t["id"], "filter")
        m = re.search(r"reviewed=(\d+) accepted=(\d+)", out)
        if m:
            st.update(reviewed=int(m.group(1)), accepted=int(m.group(2)))
        st["stage"] = "done"
        st["doneAt"] = time.time()
        log(f"[{t['id']}] done reviewed={st.get('reviewed')} accepted={st.get('accepted')}")
        self.flush()
        self.combine()

    def combine(self) -> dict:
        seen: dict[str, dict] = {}
        for t in self.plan:
            for c in load(self.root / "tiles" / t["id"] / "candidates.json", []):
                if c.get("looksBookable") and c["handle"] not in seen:
                    seen[c["handle"]] = {**c, "sweepTile": t["id"]}
        rows = list(seen.values())
        save(self.root / "combined_candidates.json", rows)
        return {"bookable": len(rows)}

    def run(self, ahead: int) -> None:
        stop = self.root / "STOP"
        log(f"sweep start tiles={len(self.plan)}")
        while not stop.exists():
            stages = {t["id"]: self.tile(t["id"])["stage"] for t in self.plan}
            if all(s in ("done", "failed") for s in stages.values()):
                log("sweep complete")
                break
            budget = self.budget()
            ready = [t for t in self.plan if stages[t["id"]] == "crawled"]
            if budget >= 4 and ready:
                if not self.step_enrich(ready[0], budget):
                    break
                continue
            prep = [t for t in self.plan if stages[t["id"]] in ("new", "seeded")]
            if prep and len(ready) < ahead:
                self.step_prep(prep[0])
                continue
            wait = 300 if not ready else max(60, int(self.state.get("pauseUntil", 0) - time.time()),
                                             int(3600 - (time.time() - min(self.calls))) if self.calls else 60)
            log(f"waiting {min(wait, 900)}s for Meta budget (queued tiles={len(ready)})")
            time.sleep(min(wait, 900))
        if stop.exists():
            log("STOP file found — exiting cleanly (rerun `run` to resume)")

    def status(self) -> dict:
        tiles = self.state["tiles"]
        by = Counter(tiles.get(t["id"], {}).get("stage", "new") for t in self.plan)
        done = [v for v in tiles.values() if v.get("stage") == "done" and v.get("doneAt")]
        calls = sum(v.get("metaCalls", 0) for v in tiles.values())
        out = {"tiles": len(self.plan), "byStage": dict(by),
               "shops": sum(v.get("shops", 0) for v in tiles.values()),
               "handles": sum(v.get("handles", 0) or 0 for v in tiles.values()),
               "metaCalls": calls, "resolved": sum(v.get("resolved", 0) for v in tiles.values()),
               "bookable": len(load(self.root / "combined_candidates.json", [])),
               "pausedUntil": datetime.fromtimestamp(self.state.get("pauseUntil", 0)).isoformat()
               if self.state.get("pauseUntil", 0) > time.time() else None}
        if done and calls:
            calls_per_tile = calls / len(done)
            remaining = len(self.plan) - len(done)
            out["etaHours"] = round(remaining * calls_per_tile / META_PER_HOUR, 1)
        return out


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--root", type=Path, default=ROOT / "data" / "discovery-inhouse" / "us-sweep")
    ap.add_argument("--reference", type=Path, default=ROOT / "data" / "discovery-inhouse" / "reference-snapshot.json")
    ap.add_argument("--crawl-max", type=int, default=60)
    sub = ap.add_subparsers(dest="cmd", required=True)
    pl = sub.add_parser("plan")
    pl.add_argument("--min-pop", type=int, default=50000)
    pl.add_argument("--max-tiles", type=int, default=600)
    rn = sub.add_parser("run")
    rn.add_argument("--ahead", type=int, default=6, help="tiles to crawl ahead of Meta enrichment")
    sub.add_parser("status")
    sub.add_parser("combine")
    args = ap.parse_args()
    if args.cmd == "plan":
        tiles = build_plan(args.root, args.reference, args.min_pop, args.max_tiles)
        save(args.root / "plan.json", tiles)
        print(f"planned {len(tiles)} tiles; top 15:")
        for t in tiles[:15]:
            print(f"  {t['city']}, {t['state']} pop={t['pop']} artists={t['artists']} per100k={t['per100k']}")
        return 0
    sweep = Sweep(args.root, args.reference, args.crawl_max)
    if args.cmd == "run":
        sweep.run(args.ahead)
    elif args.cmd == "status":
        print(json.dumps(sweep.status(), indent=2))
    else:
        print(json.dumps(sweep.combine()))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
