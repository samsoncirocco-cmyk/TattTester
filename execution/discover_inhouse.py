#!/usr/bin/env python3
"""In-house replacement for the Apify actors used in artist discovery.

Writes the SAME review artifacts as ``execution/discover_ig.py``
(``candidates.json`` + ``profiles.json`` in ``--out``), so
``scripts/import-discovery-to-neo4j.mjs`` consumes them unchanged. This module
never talks to Neo4j or any database; the importer stays the only writer and
stays dry-run by default.

Stages (each caches its own raw artifact and is resumable):

  seed-shops      OpenStreetMap Overpass ``shop=tattoo`` per US state
                  (replaces apify/google-search-scraper + Google Maps seeding)
  crawl-shops     polite crawl of each shop's own website: Instagram handles,
                  emails, phones, tech stack (replaces vdrmota/contact-info-scraper,
                  apify/rag-web-browser, website-technology-stack-detector)
  enrich          Instagram profile facts via the official Meta Graph API
                  ``business_discovery`` field (replaces
                  apify/instagram-profile-scraper). ``--provider apify`` keeps
                  the paid actor as a fallback; ``--provider fixture`` reads a
                  local JSON file for offline runs and tests.
  expand          follower-graph substitute: @mentions in enriched bios
                  ("resident @shop", "apprentice of @artist") become new
                  candidates, seeded from the account that mentioned them
  filter          shared ``ig_quality.looks_bookable`` gate + dedupe against the
                  queue and an optional reference snapshot; writes candidates.json

Why not scrape instagram.com directly: an REA browser capture of a logged-out
profile page (docs in execution/README.md) shows Instagram now renders only a
sign-up dialog and fetches no profile data anonymously, and the anonymous
``web_profile_info`` endpoint answers 401 ``require_login``. Getting around that
needs logins or proxy rotation, which this project does not do.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import urllib.robotparser
from collections import Counter
from pathlib import Path
from typing import Any, Callable, Iterable

try:
    from execution.ig_quality import looks_bookable
except ModuleNotFoundError:  # direct ``python execution/discover_inhouse.py``
    from ig_quality import looks_bookable

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "data" / "discovery-inhouse"
USER_AGENT = "TattTesterDiscovery/1.0 (+https://github.com/samsoncirocco-cmyk/TattTester)"
OVERPASS_URL = "https://overpass-api.de/api/interpreter"
OVERPASS_MIRRORS = [OVERPASS_URL, "https://overpass.private.coffee/api/interpreter",
                    "https://maps.mail.ru/osm/tools/overpass/api/interpreter"]
GRAPH_URL = "https://graph.facebook.com/v21.0"

US_STATES = (
    "AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO "
    "MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY"
).split()

IG_RESERVED = {
    "p", "reel", "reels", "explore", "accounts", "stories", "tv", "about", "legal",
    "developer", "direct", "web", "share", "sharer", "static", "privacy", "help",
    "instagram", "tags", "locations", "challenge", "login", "signup",
}
IG_LINK = re.compile(r"instagram\.com/(?:_u/)?([A-Za-z0-9_.]{1,30})(?=[/?#\"'\s<]|$)", re.I)
MENTION = re.compile(r"(?<![\w.@])@([A-Za-z0-9_](?:[A-Za-z0-9_.]{0,28}[A-Za-z0-9_])?)")
EMAIL = re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}")
PHONE = re.compile(r"tel:([+\d][\d\-\s().]{6,})", re.I)
ROSTER_PATHS = ("", "artists", "our-artists", "team", "about", "contact")
TECH_MARKERS = {
    "wix": "static.wixstatic.com",
    "squarespace": "squarespace",
    "shopify": "cdn.shopify.com",
    "wordpress": "wp-content",
    "square-online": "squareup.com",
    "godaddy": "img1.wsimg.com",
    "webflow": "webflow",
    "linktree": "linktr.ee",
    "vagaro": "vagaro.com",
    "tattoodo": "tattoodo.com",
}
STYLE_WORDS = {
    "traditional": r"\b(american )?traditional\b|\btrad\b",
    "neo-traditional": r"neo[- ]?trad",
    "blackwork": r"blackwork|black ?work",
    "fine line": r"fine ?line",
    "realism": r"\brealism\b|realistic",
    "black and grey": r"black (and|&|n) gr[ae]y|\bb&g\b",
    "japanese": r"japanese|irezumi",
    "illustrative": r"illustrative",
    "watercolor": r"watercolou?r",
    "geometric": r"geometric",
    "dotwork": r"dot ?work",
    "anime": r"\banime\b|otaku",
    "lettering": r"lettering|script",
    "color": r"\bcolou?r (work|realism|tattoos?)\b",
}


# ---------------------------------------------------------------------------
# io helpers
# ---------------------------------------------------------------------------

def load(path: Path, fallback: Any) -> Any:
    try:
        return json.loads(path.read_text())
    except FileNotFoundError:
        return fallback


def save(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(value, indent=2, sort_keys=True) + "\n")
    tmp.replace(path)


def normalize_handle(raw: Any) -> str | None:
    text = str(raw or "").strip()
    text = re.sub(r"^https?://(www\.)?instagram\.com/", "", text, flags=re.I)
    text = text.lstrip("@").split("/")[0].split("?")[0].strip().lower().rstrip(".")
    if not text or text in IG_RESERVED or not re.fullmatch(r"[a-z0-9_.]{1,30}", text):
        return None
    return text


def extract_styles(text: str) -> list[str]:
    return sorted(name for name, pat in STYLE_WORDS.items() if re.search(pat, text or "", re.I))


class Throttle:
    """Per-host minimum interval. Polite by default, never parallel per host."""

    def __init__(self, interval: float, clock: Callable[[], float] = time.monotonic,
                 sleep: Callable[[float], None] = time.sleep):
        self.interval, self.clock, self.sleep = interval, clock, sleep
        self.last: dict[str, float] = {}

    def wait(self, host: str) -> None:
        now = self.clock()
        due = self.last.get(host, -1e9) + self.interval
        if now < due:
            self.sleep(due - now)
        self.last[host] = max(now, due)


class Http:
    def __init__(self, interval: float = 2.0, timeout: int = 20, opener=None):
        self.throttle = Throttle(interval)
        self.timeout = timeout
        self.opener = opener or urllib.request.urlopen
        self.robots: dict[str, urllib.robotparser.RobotFileParser | None] = {}

    def allowed(self, url: str) -> bool:
        parts = urllib.parse.urlsplit(url)
        base = f"{parts.scheme}://{parts.netloc}"
        if base not in self.robots:
            parser = urllib.robotparser.RobotFileParser()
            try:
                body = self.get(f"{base}/robots.txt", check_robots=False)
                parser.parse(body.splitlines())
            except Exception:
                parser = None  # no robots.txt reachable -> allowed
            self.robots[base] = parser
        parser = self.robots[base]
        return parser is None or parser.can_fetch(USER_AGENT, url)

    def get(self, url: str, *, data: bytes | None = None, check_robots: bool = True,
            max_bytes: int = 2_000_000) -> str:
        if check_robots and not self.allowed(url):
            raise PermissionError(f"robots.txt disallows {url}")
        self.throttle.wait(urllib.parse.urlsplit(url).netloc)
        request = urllib.request.Request(url, data=data, headers={"User-Agent": USER_AGENT})
        with self.opener(request, timeout=self.timeout) as response:
            return response.read(max_bytes).decode("utf-8", "replace")


# ---------------------------------------------------------------------------
# stage 1: shop seeds from OpenStreetMap
# ---------------------------------------------------------------------------

def overpass_query(state: str) -> str:
    return (
        f'[out:json][timeout:120];area["ISO3166-2"="US-{state}"][admin_level=4]->.a;'
        'nwr["shop"="tattoo"](area.a);out center tags;'
    )


def parse_osm_elements(elements: Iterable[dict[str, Any]], state: str) -> dict[str, dict[str, Any]]:
    shops: dict[str, dict[str, Any]] = {}
    for element in elements:
        tags = element.get("tags") or {}
        name = (tags.get("name") or "").strip()
        if not name:
            continue
        center = element.get("center") or element
        website = tags.get("website") or tags.get("contact:website") or ""
        instagram = normalize_handle(tags.get("contact:instagram") or tags.get("instagram"))
        if not instagram:
            match = IG_LINK.search(website)
            instagram = normalize_handle(match.group(1)) if match else None
        shops[f"osm:{element.get('type', 'node')}/{element.get('id')}"] = {
            "name": name,
            "city": (tags.get("addr:city") or "").strip() or None,
            "state": (tags.get("addr:state") or state).strip().upper(),
            "website": website or None,
            "instagram": instagram,
            "email": tags.get("contact:email") or tags.get("email"),
            "phone": tags.get("phone") or tags.get("contact:phone"),
            "lat": center.get("lat"),
            "lon": center.get("lon"),
        }
    return shops


def bbox_query(bbox: str) -> str:
    return (f'[out:json][timeout:60];(nwr["shop"="tattoo"]({bbox}););out center tags;')


def overpass_fetch(http: Http, query: str, retries: int = 2) -> list[dict[str, Any]]:
    """Polite Overpass call: try each public mirror in turn, back off between rounds."""
    last: Exception | None = None
    for attempt in range(retries + 1):
        for url in OVERPASS_MIRRORS:
            try:
                body = http.get(url, data=urllib.parse.urlencode({"data": query}).encode(),
                                check_robots=False)
                return json.loads(body).get("elements", [])
            except Exception as exc:  # 429/502/504/timeouts are routine on public Overpass
                last = exc
                print(f"[osm] {url.split('/')[2]} failed: {exc}", file=sys.stderr)
        time.sleep(15 * (attempt + 1))
    raise RuntimeError(f"all Overpass mirrors failed: {last}")


def seed_shops(http: Http, states: list[str], raw_path: Path,
               bbox: str | None = None) -> dict[str, Any]:
    raw = load(raw_path, {})
    if bbox:
        shops = parse_osm_elements(overpass_fetch(http, bbox_query(bbox)), states[0] if states else "")
        raw.update(shops)
        save(raw_path, raw)
        print(f"[osm] bbox {bbox}: shops={len(shops)}")
        return raw
    for state in states:
        if any(v.get("state") == state for v in raw.values()):
            print(f"[osm] {state}: cached")
            continue
        try:
            shops = parse_osm_elements(overpass_fetch(http, overpass_query(state)), state)
        except RuntimeError as exc:
            print(f"[osm] {state}: skipped ({exc}); rerun later or use --bbox", file=sys.stderr)
            continue
        raw.update(shops)
        save(raw_path, raw)
        print(f"[osm] {state}: shops={len(shops)}")
    return raw


# ---------------------------------------------------------------------------
# stage 2: shop website crawl (contact info + roster handles + tech stack)
# ---------------------------------------------------------------------------

def parse_site(html: str) -> dict[str, Any]:
    handles = sorted({h for h in (normalize_handle(m) for m in IG_LINK.findall(html)) if h})
    emails = sorted({e.lower() for e in EMAIL.findall(html)
                     if not e.lower().endswith((".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg"))
                     and "sentry" not in e.lower() and "example." not in e.lower() and "mystore.com" not in e.lower()})
    phones = sorted({re.sub(r"[^\d+]", "", p) for p in PHONE.findall(html)})
    generator = re.search(r'<meta[^>]+name=["\']generator["\'][^>]+content=["\']([^"\']+)', html, re.I)
    tech = sorted(name for name, marker in TECH_MARKERS.items() if marker in html.lower())
    if generator:
        tech.append(f"generator:{generator.group(1).strip()[:60]}")
    return {"instagram": handles, "emails": emails, "phones": phones, "tech": tech}


def crawl_shops(http: Http, shops: dict[str, Any], crawl_path: Path, max_shops: int) -> dict[str, Any]:
    crawled = load(crawl_path, {})
    todo = [k for k, s in shops.items() if s.get("website") and k not in crawled
            and "facebook.com" not in s["website"] and "instagram.com" not in s["website"]][:max_shops]
    for key in todo:
        base = shops[key]["website"].rstrip("/")
        if not base.startswith("http"):
            base = "https://" + base
        merged = {"instagram": set(), "emails": set(), "phones": set(), "tech": set()}
        pages, errors = [], []
        for path in ROSTER_PATHS:
            url = f"{base}/{path}" if path else base
            try:
                facts = parse_site(http.get(url))
            except Exception as error:  # 404s on guessed roster paths are normal
                errors.append(f"{path or '/'}: {type(error).__name__}")
                continue
            pages.append(path or "/")
            for field in merged:
                merged[field].update(facts[field])
        crawled[key] = {**{k: sorted(v) for k, v in merged.items()}, "pages": pages, "errors": errors}
        save(crawl_path, crawled)
        print(f"[site] {shops[key]['name']}: pages={len(pages)} ig={len(merged['instagram'])}")
    return crawled


# ---------------------------------------------------------------------------
# stage 3: profile enrichment
# ---------------------------------------------------------------------------

def profile_from_business_discovery(bd: dict[str, Any]) -> dict[str, Any]:
    """Map a Graph API business_discovery node to the discover_ig profile shape."""
    return {
        "bio": bd.get("biography") or "",
        "followers": bd.get("followers_count"),
        "fullName": bd.get("name") or "",
        "url": bd.get("website") or "",
        "category": "",
        "private": False,  # business_discovery only resolves public pro accounts
        "verified": None,
        "postCount": bd.get("media_count"),
    }


class MetaProvider:
    """Official Instagram Graph API. Needs a Business/Creator IG account id + token."""

    FIELDS = "username,name,biography,followers_count,media_count,website"

    def __init__(self, http: Http, ig_user_id: str, token: str):
        self.http, self.ig_user_id, self.token = http, ig_user_id, token

    def fetch(self, handle: str) -> dict[str, Any] | None:
        query = urllib.parse.urlencode({
            "fields": f"business_discovery.username({handle}){{{self.FIELDS}}}",
            "access_token": self.token,
        })
        try:
            body = self.http.get(f"{GRAPH_URL}/{self.ig_user_id}?{query}", check_robots=False)
        except urllib.error.HTTPError as error:
            if error.code == 400:  # personal account or no such user
                return None
            raise
        bd = json.loads(body).get("business_discovery")
        return profile_from_business_discovery(bd) if bd else None


class FixtureProvider:
    def __init__(self, path: Path):
        self.rows = {k.lower(): v for k, v in json.loads(Path(path).read_text()).items()}

    def fetch(self, handle: str) -> dict[str, Any] | None:
        return self.rows.get(handle)


class ApifyProvider:
    """Paid fallback that reuses the existing actor plumbing unchanged."""

    def __init__(self, sweep_id: str, run_report: Path):
        from execution import discover_ig  # lazy: only when explicitly chosen
        self.discover_ig, self.sweep_id, self.run_report = discover_ig, sweep_id, run_report
        self.token = discover_ig.load_token()
        self.buffer: dict[str, dict[str, Any]] = {}

    def prefetch(self, handles: list[str]) -> None:
        di = self.discover_ig
        def checkpoint(record):
            di.update_json_locked(self.run_report, {}, lambda cur: di.merge_run_report(
                cur, sweep_id=self.sweep_id, checked_at=di.utc_now(),
                run_slice={"command": "inhouse-enrich"}, summary={"command": "inhouse-enrich"},
                actor_runs=[record]))
        for offset in range(0, len(handles), 50):
            _, items = di.run_actor(self.token, di.PROFILE_ACTOR, {"usernames": handles[offset:offset + 50]},
                                    checkpoint=checkpoint, operation=f"inhouse-enrich:{offset}")
            for row in items:
                self.buffer[str(row.get("username") or "").lower()] = {
                    "bio": row.get("biography") or "", "followers": row.get("followersCount"),
                    "fullName": row.get("fullName") or "", "url": row.get("externalUrl") or "",
                    "category": row.get("businessCategoryName") or "", "private": row.get("private"),
                    "verified": row.get("verified"), "postCount": row.get("postsCount"),
                }

    def fetch(self, handle: str) -> dict[str, Any] | None:
        return self.buffer.get(handle)


def enrich(provider: Any, handles: list[str], profiles_path: Path, misses_path: Path,
           maximum: int) -> dict[str, Any]:
    profiles = load(profiles_path, {})
    misses = load(misses_path, {})
    todo = [h for h in handles if h not in profiles and h not in misses][:maximum]
    if hasattr(provider, "prefetch") and todo:
        provider.prefetch(todo)
    for handle in todo:
        row = provider.fetch(handle)
        if row is None:
            misses[handle] = "not-resolvable(personal-or-missing)"
        else:
            profiles[handle] = row
    save(profiles_path, profiles)
    save(misses_path, misses)
    print(f"[enrich] requested={len(todo)} resolved={len(todo) - sum(1 for h in todo if h in misses)}")
    return profiles


# ---------------------------------------------------------------------------
# candidate assembly (discovery sources -> candidates.json)
# ---------------------------------------------------------------------------

def location_token(city: str | None) -> str | None:
    """A ``#city`` token the importer's seed resolver reads as a city hashtag."""
    return f"#{city.strip().lower()}" if city else None


def collect_sources(shops: dict[str, Any], crawled: dict[str, Any],
                    profiles: dict[str, Any]) -> dict[str, dict[str, set[str]]]:
    found: dict[str, dict[str, set[str]]] = {}

    def add(handle: str | None, source: str, seeds: Iterable[str | None]):
        if not handle:
            return
        item = found.setdefault(handle, {"sources": set(), "seedFrom": set(), "shops": set()})
        item["sources"].add(source)
        item["seedFrom"].update(s for s in seeds if s)

    for key, shop in shops.items():
        loc = location_token(shop.get("city"))
        shop_ref = f"shop:{key}"
        if shop.get("instagram"):
            add(shop["instagram"], "osm", [shop_ref, loc])
            found[shop["instagram"]]["shops"].add(key)
        for handle in (crawled.get(key) or {}).get("instagram", []):
            add(handle, "shop-site", [shop_ref, loc])
            found[handle]["shops"].add(key)
    # follower-graph substitute: accounts mentioned in an enriched bio
    for parent, profile in profiles.items():
        for mention in MENTION.findall(profile.get("bio") or ""):
            handle = normalize_handle(mention)
            if handle and handle != parent:
                add(handle, "mention", [parent, *found.get(parent, {}).get("seedFrom", set())])
    return found


def load_reference(path: Path | None) -> tuple[set[str], set[tuple[str, str]], set[str]]:
    if not path:
        return set(), set(), set()
    snap = json.loads(Path(path).read_text())
    handles, names, protected = set(), set(), set()
    for artist in snap.get("artists", []):
        handle = normalize_handle(artist.get("instagram"))
        if handle:
            handles.add(handle)
        if artist.get("name") and artist.get("city"):
            names.add((artist["name"].strip().lower(), artist["city"].strip().lower()))
        if handle and any(artist.get(flag) for flag in (
                "claimed", "selfRegistered", "removed", "takedownPending", "tombstoned", "verified")):
            protected.add(handle)
    return handles, names, protected


def build_candidates(found, profiles, *, existing: set[str], reference_names: set[tuple[str, str]],
                     protected: set[str], shops: dict[str, Any]) -> tuple[list[dict], Counter]:
    output, skipped = [], Counter()
    for handle, meta in found.items():
        if handle in protected:
            skipped["protected"] += 1
            continue
        if handle in existing:
            skipped["already-known"] += 1
            continue
        profile = profiles.get(handle)
        if not profile:
            skipped["no-profile"] += 1
            continue
        city = next((shops[k].get("city") for k in meta["shops"] if shops.get(k, {}).get("city")), None)
        if city and (str(profile.get("fullName") or "").strip().lower(), city.lower()) in reference_names:
            skipped["name+city-duplicate"] += 1
            continue
        verdict, reason = looks_bookable(profile)
        bio = str(profile.get("bio") or "").replace("\n", " ").strip()
        output.append({
            "handle": handle,
            "source": ",".join(sorted(meta["sources"])),
            "seedFrom": ",".join(sorted(meta["seedFrom"])),
            "bioSnippet": bio[:160],
            "followers": profile.get("followers"),
            "postCount": profile.get("postCount"),
            "looksBookable": verdict,
            "filterReason": reason,
            "styles": extract_styles(f"{bio} {profile.get('fullName') or ''}"),
        })
    output.sort(key=lambda c: (not c["looksBookable"], -(c["followers"] or 0)))
    return output, skipped


def queue_handles(path: Path | None) -> set[str]:
    if not path:
        return set()
    return {h for h in (normalize_handle(a.get("ig")) for a in json.loads(Path(path).read_text())) if h}


# ---------------------------------------------------------------------------
# cli
# ---------------------------------------------------------------------------

def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--out", type=Path, default=OUT)
    parser.add_argument("--queue", type=Path, help="existing artist queue (id/ig) to dedupe against")
    parser.add_argument("--reference", type=Path, help="importer reference snapshot (artists[]) for dedupe/protection")
    parser.add_argument("--interval", type=float, default=2.0, help="seconds between requests to one host")
    sub = parser.add_subparsers(dest="command", required=True)
    seed = sub.add_parser("seed-shops")
    seed.add_argument("--states", default="NE,IA,SD")
    seed.add_argument("--bbox", help="south,west,north,east (lighter metro query); --states gives the state")
    crawl = sub.add_parser("crawl-shops")
    crawl.add_argument("--max", type=int, default=50)
    en = sub.add_parser("enrich")
    en.add_argument("--provider", choices=["meta", "fixture", "apify"], default="meta")
    en.add_argument("--fixture", type=Path)
    en.add_argument("--max", type=int, default=200)
    en.add_argument("--sweep-id")
    sub.add_parser("filter")
    sub.add_parser("stats")
    args = parser.parse_args(argv)

    out = args.out
    shops_path, crawl_path = out / "raw_shops.json", out / "raw_shop_sites.json"
    profiles_path, misses_path = out / "profiles.json", out / "profile_misses.json"
    candidates_path = out / "candidates.json"
    http = Http(interval=args.interval)

    if args.command == "seed-shops":
        states = [s.strip().upper() for s in args.states.split(",") if s.strip()]
        bad = [s for s in states if s not in US_STATES]
        if bad:
            parser.error(f"unknown state codes: {bad}")
        seed_shops(http, states, shops_path, bbox=args.bbox)
        return 0
    shops = load(shops_path, {})
    if args.command == "crawl-shops":
        crawl_shops(http, shops, crawl_path, args.max)
        return 0
    crawled = load(crawl_path, {})
    profiles = load(profiles_path, {})
    existing = queue_handles(args.queue)
    ref_handles, ref_names, protected = load_reference(args.reference)
    if args.command == "enrich":
        if args.provider == "fixture":
            if not args.fixture:
                parser.error("--fixture is required with --provider fixture")
            provider = FixtureProvider(args.fixture)
        elif args.provider == "meta":
            ig_id, token = os.environ.get("IG_GRAPH_USER_ID"), os.environ.get("IG_GRAPH_TOKEN")
            if not ig_id or not token:
                parser.error("IG_GRAPH_USER_ID and IG_GRAPH_TOKEN must be set for --provider meta")
            provider = MetaProvider(Http(interval=1.0), ig_id, token)
        else:
            if not args.sweep_id:
                parser.error("--sweep-id is required with --provider apify")
            provider = ApifyProvider(args.sweep_id, out / "apify-discovery-run-report.json")
        # two passes: shop/site handles first, then handles their bios mention
        for _ in range(2):
            found = collect_sources(shops, crawled, profiles)
            todo = [h for h in found if h not in existing and h not in ref_handles and h not in protected]
            profiles = enrich(provider, todo, profiles_path, misses_path, args.max)
        return 0
    found = collect_sources(shops, crawled, profiles)
    if args.command == "stats":
        print(json.dumps({
            "shops": len(shops), "shopsWithWebsite": sum(1 for s in shops.values() if s.get("website")),
            "sitesCrawled": len(crawled), "handlesFound": len(found), "profiles": len(profiles),
            "bySource": Counter(s for m in found.values() for s in m["sources"]),
        }, indent=2, default=dict))
        return 0
    candidates, skipped = build_candidates(found, profiles, existing=existing | ref_handles,
                                           reference_names=ref_names, protected=protected, shops=shops)
    save(candidates_path, candidates)
    accepted = sum(1 for c in candidates if c["looksBookable"])
    print(f"reviewed={len(candidates)} accepted={accepted} skipped={dict(skipped)}")
    print("reasons:", dict(Counter(c["filterReason"] for c in candidates)))
    print(f"written -> {candidates_path} (importer: node scripts/import-discovery-to-neo4j.mjs "
          f"--input {candidates_path} --reference <snapshot.json>)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
