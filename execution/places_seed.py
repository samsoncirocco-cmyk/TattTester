#!/usr/bin/env python3
"""Seed discover_inhouse raw_shops.json from scrape_artists.py's Google Places discovery.

Reuses ``scrape_artists.places_search_city`` (live Places Text Search) and the
scheduler's cached ``master.json`` shops, instead of OSM. Keys are ``gmaps:<placeId>``
so the importer can match shops by placeId. The API key comes from
GOOGLE_PLACES_API_KEY or the scheduler workspace's places-key.txt; it is never printed.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from discover_inhouse import IG_LINK, load, normalize_handle, normalize_state, save  # noqa: E402

WORKSPACE = Path(os.path.expanduser("~/tatt-scraper/data"))


def to_raw(shop: dict) -> tuple[str, dict]:
    site = shop.get("website") or None
    m = IG_LINK.search(site or "")
    return f"gmaps:{shop['place_id']}", {
        "name": shop.get("shopName", ""), "address": shop.get("address"),
        "city": shop.get("city"), "state": normalize_state(shop.get("state")),
        "website": None if m else site,
        "instagram": normalize_handle(m.group(1)) if m else None,
        "email": None, "phone": None, "lat": shop.get("lat"), "lon": shop.get("lng"),
        "rating": shop.get("rating"), "placeId": shop["place_id"], "source": "places",
    }


def cached_shops(city: str, state: str, workspace: Path = WORKSPACE) -> list[dict]:
    master = load(workspace / "master.json", {})
    return [s for s in master.get("shops", []) if s.get("city") == city and s.get("state") == state]


def api_key(workspace: Path = WORKSPACE) -> str | None:
    key = os.environ.get("GOOGLE_PLACES_API_KEY")
    f = workspace / "places-key.txt"
    return key or (f.read_text().strip() if f.exists() else None)


def seed(out: Path, city: str, state: str, live: bool, max_shops: int) -> dict:
    raw_path = out / "raw_shops.json"
    raw = load(raw_path, {})
    cached = cached_shops(city, state)
    shops, src = list(cached), "cache"
    if live:
        key = api_key()
        if not key:
            raise SystemExit("no Places key (GOOGLE_PLACES_API_KEY or places-key.txt)")
        from scrape_artists import places_search_city
        shops += places_search_city(city, state, key, max_shops)
        src = "cache+live"
    for s in shops:
        k, v = to_raw(s)
        raw.setdefault(k, v)
    out.mkdir(parents=True, exist_ok=True)
    save(raw_path, raw)
    res = {"city": city, "state": state, "source": src, "cached": len(cached),
           "shops": len(raw), "withSite": sum(1 for v in raw.values() if v.get("website"))}
    print(f"[places] {city}, {state}: shops={len(raw)} cached={len(cached)} src={src}")
    return res


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--out", type=Path, required=True)
    ap.add_argument("--city", required=True)
    ap.add_argument("--state", required=True)
    ap.add_argument("--live", action="store_true", help="also call Places Text Search (billed)")
    ap.add_argument("--max-shops", type=int, default=60)
    a = ap.parse_args()
    print(json.dumps(seed(a.out, a.city, a.state, a.live, a.max_shops)))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
