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
STATE_NAMES = {name.replace("_", " ").lower(): code for name, code in zip(
    "Alabama Alaska Arizona Arkansas California Colorado Connecticut Delaware District_of_Columbia Florida Georgia Hawaii Idaho Illinois Indiana Iowa Kansas Kentucky Louisiana Maine Maryland Massachusetts Michigan Minnesota Mississippi Missouri Montana Nebraska Nevada New_Hampshire New_Jersey New_Mexico New_York North_Carolina North_Dakota Ohio Oklahoma Oregon Pennsylvania Rhode_Island South_Carolina South_Dakota Tennessee Texas Utah Vermont Virginia Washington West_Virginia Wisconsin Wyoming".split(), US_STATES)}

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


def parse_osm_elements(elements: Iterable[dict[str, Any]], state: str | None) -> dict[str, dict[str, Any]]:
    """``state`` is only trusted for state-area queries; pass None for bbox queries."""
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
            "state": (normalize_state(tags.get("addr:state")) or normalize_state(state)),
            "website": website or None,
            "instagram": instagram,
            "email": tags.get("contact:email") or tags.get("email"),
            "phone": tags.get("phone") or tags.get("contact:phone"),
            "lat": center.get("lat"),
            "lon": center.get("lon"),
        }
    return shops


def normalize_state(value: str | None) -> str | None:
    if not value:
        return None
    value = value.strip()
    if value.upper() in US_STATES:
        return value.upper()
    if value.upper().startswith("US-") and value[3:].upper() in US_STATES:
        return value[3:].upper()
    return STATE_NAMES.get(value.lower())


NOMINATIM_URL = "https://nominatim.openstreetmap.org/reverse"


def reverse_geocode(http: Http, lat: float, lon: float) -> tuple[str | None, str | None]:
    """(state, city) from OSM Nominatim. Policy: <=1 req/s, identifying UA, results cached."""
    query = urllib.parse.urlencode({"format": "jsonv2", "lat": lat, "lon": lon,
                                    "zoom": 10, "addressdetails": 1})
    address = json.loads(http.get(f"{NOMINATIM_URL}?{query}", check_robots=False)).get("address") or {}
    if address.get("country_code") not in (None, "us"):
        return None, None
    state = normalize_state(address.get("ISO3166-2-lvl4")) or normalize_state(address.get("state"))
    city = address.get("city") or address.get("town") or address.get("village")
    return state, city


def fill_locations(http: Http, shops: dict[str, Any]) -> None:
    """Infer state (and missing city) from coordinates; leave state None ("unknown") otherwise."""
    for shop in shops.values():
        if shop.get("state") and shop.get("city"):
            continue
        if shop.get("lat") is None or shop.get("lon") is None:
            shop.setdefault("stateSource", "unknown")
            continue
        try:
            state, city = reverse_geocode(http, shop["lat"], shop["lon"])
        except Exception as exc:
            print(f"[geo] {shop.get('name')}: {exc}", file=sys.stderr)
            state, city = None, None
        if not shop.get("state"):
            shop["state"] = state
            shop["stateSource"] = "geocode" if state else "unknown"
        if not shop.get("city") and city:
            shop["city"], shop["citySource"] = city, "geocode"


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
        shops = parse_osm_elements(overpass_fetch(http, bbox_query(bbox)), None)
        fill_locations(http, shops)
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

    NAME = "meta"
    MISS_SUBCODES = {2207013}  # "user not found" / not a business-discoverable account
    FATAL_CODES = {4, 17, 32, 190, 613}  # rate limits and auth: stop, never record as a miss

    def __init__(self, http: Http, ig_user_id: str, token: str):
        self.http, self.ig_user_id, self.token = http, ig_user_id, token
        self.last_error: str | None = None

    def fetch(self, handle: str) -> dict[str, Any] | None:
        self.last_error = None
        query = urllib.parse.urlencode({
            "fields": f"business_discovery.username({handle}){{{self.FIELDS}}}",
            "access_token": self.token,
        }, safe="{}(),")  # Graph wants the field-expansion braces unescaped
        try:
            body = self.http.get(f"{GRAPH_URL}/{self.ig_user_id}?{query}", check_robots=False)
        except urllib.error.HTTPError as error:
            try:
                info = json.loads(error.read().decode("utf-8", "replace")).get("error") or {}
            except Exception:
                info = {}
            code, sub = info.get("code"), info.get("error_subcode")
            if code in self.FATAL_CODES:
                # message only: never echo the request URL (it carries the token)
                raise RuntimeError(f"Graph API error code={code} subcode={sub}: {info.get('message')}") from None
            if error.code == 400:
                self.last_error = f"code={code} subcode={sub}"
                return None
            raise RuntimeError(f"Graph API HTTP {error.code} code={code} subcode={sub}") from None
        bd = json.loads(body).get("business_discovery")
        return profile_from_business_discovery(bd) if bd else None


class FixtureProvider:
    NAME = "fixture"

    def __init__(self, path: Path):
        self.rows = {k.lower(): v for k, v in json.loads(Path(path).read_text()).items()}

    def fetch(self, handle: str) -> dict[str, Any] | None:
        return self.rows.get(handle)


class ApifyProvider:
    """Paid fallback that reuses the existing actor plumbing unchanged."""
    NAME = "apify"

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
           maximum: int, refresh: bool = False) -> dict[str, Any]:
    """Resolve handles through ``provider``.

    Cache entries are reused only when the same provider produced them (tracked in
    ``profile_provenance.json``), so a fixture/offline run never masks the real API.
    """
    name = getattr(provider, "NAME", type(provider).__name__)
    prov_path = profiles_path.with_name("profile_provenance.json")
    profiles = load(profiles_path, {})
    misses = load(misses_path, {})
    provenance = load(prov_path, {})

    def cached(handle: str) -> bool:
        if refresh:
            return False
        miss = misses.get(handle)
        miss_from = miss.get("provider") if isinstance(miss, dict) else None
        return provenance.get(handle) == name or miss_from == name

    todo = [h for h in handles if not cached(h)][:maximum]
    if hasattr(provider, "prefetch") and todo:
        provider.prefetch(todo)
    resolved = 0

    def persist() -> None:
        save(profiles_path, profiles)
        save(misses_path, misses)
        save(prov_path, provenance)

    for handle in todo:
        try:
            row = provider.fetch(handle)
        except RuntimeError:
            persist()  # keep everything fetched before a rate-limit/fatal stop
            print(f"[enrich:{name}] stopped after requested={todo.index(handle)} resolved={resolved}")
            raise
        if row is None:
            if provenance.get(handle) != name:
                profiles.pop(handle, None)
                provenance.pop(handle, None)
            misses[handle] = {"provider": name,
                              "reason": getattr(provider, "last_error", None) or "not-resolvable(personal-or-missing)"}
        else:
            profiles[handle] = row
            provenance[handle] = name
            misses.pop(handle, None)
            resolved += 1
    persist()
    print(f"[enrich:{name}] requested={len(todo)} resolved={resolved} misses={len(todo) - resolved}")
    return profiles


def load_env_file(path: Path, keys: Iterable[str]) -> None:
    """Populate missing env vars from a KEY=VALUE file (values are never printed)."""
    if not path.exists():
        return
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.removeprefix("export ").strip()
        if key in keys and not os.environ.get(key):
            os.environ[key] = value.strip().strip('"').strip("'")


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
        unresolved = (shop.get("locationConflict") or {}).get("resolution") == "unresolved"
        loc = None if unresolved else location_token(shop.get("city"))
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
    for key in snap.get("tombstoneKeys", []) or []:
        if str(key).startswith("instagram:"):
            handle = normalize_handle(str(key)[len("instagram:"):])
            if handle:
                protected.add(handle)
    return handles, names, protected


# ---------------------------------------------------------------------------
# classification helpers: shop accounts, shop-linked bookability, state conflicts
# ---------------------------------------------------------------------------

GENERIC_SHOP_WORDS = {"tattoo", "tattoos", "tattooing", "studio", "studios", "shop", "parlor",
                      "parlour", "co", "company", "collective", "gallery", "the", "and", "llc",
                      "inc", "art", "arts", "body", "piercing"}
SHOP_HANDLE_WORDS = re.compile(r"tattoo|studio|parlou?r|collective|gallery|inkshop|shop", re.I)
SHOP_NAME_TAIL = re.compile(r"\b(tattoo|tattoos|studio|parlou?r|collective|tattoo co\.?|ink)\s*$", re.I)
PERSONAL = re.compile(r"\b(i|i'm|im|my|me)\b|owner/artist|artist\b", re.I)
SOFT_TATTOO = re.compile(r"\btats?\b|\btatt?s\b|\binked\b|\bink(ing)?\b|\btattoo", re.I)
SOFT_BOOK = re.compile(r"\bbook(s|ing|ed)?\b|\bappt|\bappointments?\b|\bdm\b|\bflash\b|"
                       r"\bdeposit|\bslots?\b|\bwalk[- ]?ins?\b|\binquir", re.I)
NOT_TATTOO_TRADE = re.compile(r"photograph|\bphoto\b|hair|barber|nails?\b|lash|brows?\b|"
                              r"realtor|real estate|makeup|mua\b|esthetic|clothing|apparel", re.I)


def name_tokens(text: str | None) -> list[str]:
    return [t for t in re.findall(r"[a-z0-9]+", (text or "").lower()) if t not in GENERIC_SHOP_WORDS]


def is_shop_account(handle: str, profile: dict[str, Any], shop_names: Iterable[str],
                    osm_handles: set[str]) -> str | None:
    """Return why ``handle`` is a shop's own account, or None for a person."""
    if handle in osm_handles:
        return "osm-shop-handle"
    full_name = str(profile.get("fullName") or "")
    bio = str(profile.get("bio") or "")
    compact = re.sub(r"[^a-z0-9]", "", handle.lower())
    for shop_name in shop_names:
        core = name_tokens(shop_name)
        if not core:
            continue
        if all(t in compact for t in core) and SHOP_HANDLE_WORDS.search(handle):
            return "handle-matches-shop"
        if name_tokens(full_name) == core and not PERSONAL.search(bio):
            return "name-matches-shop"
    mentions = len(set(MENTION.findall(bio)))
    if SHOP_NAME_TAIL.search(full_name.strip()) and (mentions >= 2 or SHOP_HANDLE_WORDS.search(handle)) \
            and not PERSONAL.search(bio):
        return "shop-name+roster"
    if mentions >= 3 and not PERSONAL.search(bio):
        return "roster-bio"
    return None


def assess_bookable(profile: dict[str, Any], shop_linked: bool) -> tuple[bool, str]:
    """Shared gate first; a narrow second chance for artists found on a shop's roster.

    The shared ``looks_bookable`` needs the literal word tattoo/tattooist. Artists a
    verified shop lists or tags often write "TATS", "Black & Grey", "books open"
    instead. Only those shop-linked accounts get the softer check, and they still
    need a non-empty bio, a booking signal, and a tattoo word or tattoo style term.
    """
    verdict, reason = looks_bookable(profile)
    if verdict or reason != "no-tattoo-signal" or not shop_linked:
        return verdict, reason
    if profile.get("private"):
        return False, "private"
    bio = str(profile.get("bio") or "").strip()
    text = f"{bio} {profile.get('fullName') or ''}"
    if not bio or NOT_TATTOO_TRADE.search(text):
        return False, reason
    booking = bool(SOFT_BOOK.search(text) or profile.get("url"))
    tattoo_word = bool(SOFT_TATTOO.search(text))
    styles = extract_styles(text)
    if booking and (tattoo_word or styles) and (tattoo_word or len(bio) >= 20):
        return True, "shop-linked:" + ("tattoo-word" if tattoo_word else "style") + "+booking"
    return False, reason


STATE_CODE_IN_TEXT = re.compile(r",\s*([A-Z]{2})\b")


def state_signals(*texts: str | None, handles: Iterable[str] = ()) -> set[str]:
    """States named in bios/names ("Omaha, NE", "Iowa") or glued into handles/domains."""
    found: set[str] = set()
    for text in texts:
        if not text:
            continue
        found.update(c for c in STATE_CODE_IN_TEXT.findall(text) if c in US_STATES)
        lowered = text.lower()
        for name, code in STATE_NAMES.items():
            if re.search(rf"\b{re.escape(name)}\b", lowered):
                found.add(code)
    for handle in handles:
        compact = re.sub(r"[^a-z]", "", (handle or "").lower())
        # longest names first so "arkansas" is not also read as "kansas"
        for name in sorted(STATE_NAMES, key=len, reverse=True):
            key = name.replace(" ", "")
            if len(key) >= 4 and key in compact:
                found.add(STATE_NAMES[name])
                compact = compact.replace(key, "")
    if "virginia" in " ".join(t or "" for t in texts).lower() and "WV" in found:
        found.discard("VA")  # "West Virginia" also matches "virginia"
    return found


def shop_profile_handles(key: str, shop: dict[str, Any], crawled: dict[str, Any],
                         profiles: dict[str, Any]) -> list[str]:
    handles = [shop["instagram"]] if shop.get("instagram") else []
    for handle in (crawled.get(key) or {}).get("instagram", []):
        profile = profiles.get(handle)
        if profile and handle not in handles and is_shop_account(handle, profile, [shop.get("name", "")], set()):
            handles.append(handle)
    return handles


def resolve_locations(http: Any, shops: dict[str, Any], crawled: dict[str, Any],
                      profiles: dict[str, Any]) -> Counter:
    """Flag shops whose own handle/bio/website names a different state than OSM.

    A conflict is never settled silently: the shop's coordinates are reverse-geocoded
    and the result is recorded next to every signal. If the geocode agrees with one
    side, that side is used and the conflict stays on record; otherwise the shop is
    marked unresolved and its city is withheld from candidates (importer holds them).
    """
    stats: Counter = Counter()
    for key, shop in shops.items():
        handles = shop_profile_handles(key, shop, crawled, profiles)
        texts = [shop.get("name")]
        for handle in handles:
            texts += [profiles[handle].get("bio"), profiles[handle].get("fullName")] if handle in profiles else []
        domain = urllib.parse.urlsplit(shop.get("website") or "").netloc
        signals = state_signals(*texts, handles=[*handles, domain.split(".")[0] if domain else ""])
        osm_state = shop.get("state")
        if not signals or osm_state in signals and len(signals) == 1:
            shop.pop("locationConflict", None)
            stats["consistent" if signals else "no-signal"] += 1
            continue
        conflict = {"osmCity": shop.get("osmCity", shop.get("city")), "osmState": osm_state,
                    "signals": sorted(signals), "signalSources": handles + ([domain] if domain else [])}
        geo_state = geo_city = None
        if shop.get("lat") is not None and shop.get("lon") is not None:
            try:
                geo_state, geo_city = reverse_geocode(http, shop["lat"], shop["lon"])
            except Exception as exc:
                conflict["geocodeError"] = str(exc)[:120]
        conflict.update(geocodeState=geo_state, geocodeCity=geo_city)
        shop.setdefault("osmCity", shop.get("city"))
        shop.setdefault("osmState", osm_state)
        if geo_state and geo_state in signals and geo_state != osm_state:
            conflict["resolution"] = "geocode-agrees-with-signal"
            shop["state"], shop["city"] = geo_state, geo_city or shop.get("city")
        elif geo_state and geo_state == osm_state:
            conflict["resolution"] = "geocode-agrees-with-osm"
        else:
            conflict["resolution"] = "unresolved"
        shop["locationConflict"] = conflict
        stats[conflict["resolution"]] += 1
        print(f"[geo] conflict {shop.get('name')}: osm={osm_state} signals={sorted(signals)} "
              f"geocode={geo_city},{geo_state} -> {conflict['resolution']}")
    return stats


def shop_keys_for(meta: dict[str, Any]) -> list[str]:
    keys = set(meta.get("shops") or ())
    keys.update(t[5:] for t in meta.get("seedFrom", ()) if t.startswith("shop:"))
    return sorted(keys)


def build_candidates(found, profiles, *, existing: set[str], reference_names: set[tuple[str, str]],
                     protected: set[str], shops: dict[str, Any]) -> tuple[list[dict], Counter]:
    output, skipped = [], Counter()
    osm_handles = {s["instagram"] for s in shops.values() if s.get("instagram")}
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
        keys = [k for k in shop_keys_for(meta) if k in shops]
        city = next((shops[k].get("city") for k in keys if shops[k].get("city")), None)
        if city and (str(profile.get("fullName") or "").strip().lower(), city.lower()) in reference_names:
            skipped["name+city-duplicate"] += 1
            continue
        shop_reason = is_shop_account(handle, profile, [shops[k].get("name", "") for k in keys], osm_handles)
        if shop_reason:
            verdict, reason = False, "shop-account"
        else:
            verdict, reason = assess_bookable(profile, shop_linked=bool(keys))
        bio = str(profile.get("bio") or "").replace("\n", " ").strip()
        shop_names = sorted({shops[k]["name"] for k in keys if shops[k].get("name")})
        conflicts = [shops[k]["locationConflict"] for k in keys if shops[k].get("locationConflict")]
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
            "fullName": profile.get("fullName"),
            "isShop": bool(shop_reason),
            "shopReason": shop_reason,
            # artist -> shop by name (OSM shops carry no placeId the graph knows)
            "shopName": None if shop_reason else (shop_names[0] if len(shop_names) == 1 else None),
            "shopCandidates": shop_names if len(shop_names) > 1 else None,
            "locationConflict": conflicts[0] if conflicts else None,
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
    seed.add_argument("--bbox", help="south,west,north,east (lighter metro query); state comes from address or reverse geocode")
    crawl = sub.add_parser("crawl-shops")
    crawl.add_argument("--max", type=int, default=50)
    en = sub.add_parser("enrich")
    en.add_argument("--provider", choices=["meta", "fixture", "apify"], default="meta")
    en.add_argument("--fixture", type=Path)
    en.add_argument("--max", type=int, default=200)
    en.add_argument("--sweep-id")
    en.add_argument("--refresh", action="store_true", help="ignore cached profiles/misses")
    sub.add_parser("resolve-locations", help="flag/verify shop state conflicts (reverse geocode)")
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
            load_env_file(ROOT / ".env.ig-graph", ("IG_GRAPH_USER_ID", "IG_GRAPH_TOKEN"))
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
            profiles = enrich(provider, todo, profiles_path, misses_path, args.max, refresh=args.refresh)
            args.refresh = False  # second pass reuses what pass one just fetched
        return 0
    if args.command == "resolve-locations":
        stats = resolve_locations(http, shops, crawled, profiles)
        save(shops_path, shops)
        print("[geo]", dict(stats))
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
