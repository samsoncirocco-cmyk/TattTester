#!/usr/bin/env python3
"""Artist data acquisition pipeline: real shops, real artists, honest fields.

Replaces the abandoned scripts/data_acquisition/ prototype (BrowserAct mocks,
0 artists found) and the generate-* scripts that fabricated synthetic data.

Three stages, each resumable from the previous stage's JSON output:

  discover   Google Places API (New) text search per city -> shops.json
             (name, address, lat/lng, rating, review count, website)
  crawl      Fetch each shop's public website, follow roster-ish pages
             (/artists, /team, ...), extract Instagram handles, artist
             names, and portfolio image URLs -> raw_artists.json
  normalize  Merge, dedupe, infer styles/tags from page text, emit the
             exact {artists, cities, styles} shape that
             scripts/import-to-neo4j.js reads -> artists.json

Fields we cannot observe (hourlyRate, yearsExperience) are null, never
fabricated. rating/reviewCount are the shop's Google values, flagged via
tags with "shop-rating" so the frontend can label them.

Usage:
  export GOOGLE_PLACES_API_KEY=...
  python execution/scrape_artists.py all --cities "Phoenix,Scottsdale,Tempe"
  python execution/scrape_artists.py discover --cities Phoenix --max-shops 10
  python execution/scrape_artists.py crawl
  python execution/scrape_artists.py normalize

Costs: Places Text Search only (~1 request per 20 shops per city). A full
Arizona run stays inside the monthly free tier. Website crawling is
polite: identifies itself, honors robots.txt, 1 req/sec/site, <=8 pages.
"""

import argparse
import json
import os
import re
import sys
import time
import urllib.robotparser
from pathlib import Path
from urllib.parse import urljoin, urlparse

import requests
from bs4 import BeautifulSoup

PLACES_SEARCH_URL = "https://places.googleapis.com/v1/places:searchText"
PLACES_FIELD_MASK = ",".join([
    "places.id",
    "places.displayName",
    "places.formattedAddress",
    "places.location",
    "places.rating",
    "places.userRatingCount",
    "places.websiteUri",
    "places.businessStatus",
    "nextPageToken",
])

USER_AGENT = "TatTArtistBot/1.0 (+https://tatt-app.vercel.app; data for artist discovery)"
DEFAULT_CITIES = [
    "Phoenix", "Scottsdale", "Tempe", "Mesa", "Chandler", "Gilbert",
    "Glendale", "Peoria", "Tucson", "Flagstaff",
]
DEFAULT_OUT_DIR = ".tmp/scrape"

# Paths on a shop site likely to list the artist roster
ROSTER_LINK_RE = re.compile(
    r"artist|tattooer|team|crew|staff|our-people|meet|portfolio", re.I
)

# instagram.com/<handle> where <handle> is an account, not a content page
IG_HANDLE_RE = re.compile(
    r"instagram\.com/([A-Za-z0-9._]{2,30})(?![A-Za-z0-9._])", re.I
)
IG_NON_ACCOUNT_PATHS = {
    "p", "reel", "reels", "tv", "stories", "explore", "accounts",
    "sharer", "share", "about", "legal", "directory", "developer", "tags",
    # /popular/{tag} is the logged-out hashtag shell, not an artist account.
    "popular",
}

IMAGE_EXT_RE = re.compile(r"\.(jpe?g|png|webp)(\?|$)", re.I)
IMAGE_SKIP_RE = re.compile(
    r"logo|icon|favicon|badge|banner|sprite|avatar|placeholder|pixel|"
    r"header|footer|bg[-_]|background", re.I
)

STYLE_KEYWORDS = {
    "Traditional": ["traditional", "american traditional", "old school"],
    "Neo-Traditional": ["neo-traditional", "neo traditional", "neotraditional"],
    "Realism": ["realism", "realistic", "photorealism", "portrait"],
    "Black & Grey": ["black and grey", "black & grey", "black and gray"],
    "Blackwork": ["blackwork", "black work", "dotwork", "dot work"],
    "Japanese (Irezumi)": ["japanese", "irezumi", "oriental"],
    "Fine Line": ["fine line", "fineline", "single needle"],
    "Watercolor": ["watercolor", "watercolour"],
    "Geometric": ["geometric", "sacred geometry", "mandala"],
    "Illustrative": ["illustrative", "illustration"],
    "New School": ["new school", "newschool"],
    "Tribal": ["tribal", "polynesian", "maori"],
    "Chicano": ["chicano", "lettering", "script"],
    "Anime": ["anime", "manga"],
    "Ornamental": ["ornamental", "filigree"],
}

TAG_KEYWORDS = {
    "walk-ins": ["walk-in", "walk in", "walkins"],
    "custom-designs": ["custom design", "custom work", "custom tattoo"],
    "cover-ups": ["cover-up", "cover up", "coverup"],
    "color": ["full color", "color tattoo", "vibrant color"],
    "piercing": ["piercing"],
    "award-winning": ["award-winning", "award winning"],
    "appointment-only": ["appointment only", "by appointment"],
}


# ---------------------------------------------------------------------------
# Pure parsing/inference functions (unit tested in tests/execution/)
# ---------------------------------------------------------------------------

def extract_instagram_handles(html):
    """Return unique Instagram account handles linked from an HTML page."""
    handles = []
    seen = set()
    for match in IG_HANDLE_RE.finditer(html):
        handle = match.group(1).strip(".").lower()
        if handle in IG_NON_ACCOUNT_PATHS or len(handle) < 3:
            continue
        if handle not in seen:
            seen.add(handle)
            handles.append(handle)
    return handles


def find_roster_links(html, base_url):
    """Return same-site links whose path or text suggests an artist roster."""
    soup = BeautifulSoup(html, "html.parser")
    base_host = urlparse(base_url).netloc.lower().removeprefix("www.")
    links = []
    seen = set()
    for a in soup.find_all("a", href=True):
        href = a["href"]
        text = a.get_text(" ", strip=True)
        if not (ROSTER_LINK_RE.search(href) or ROSTER_LINK_RE.search(text)):
            continue
        absolute = urljoin(base_url, href)
        parsed = urlparse(absolute)
        if parsed.scheme not in ("http", "https"):
            continue
        if parsed.netloc.lower().removeprefix("www.") != base_host:
            continue
        clean = absolute.split("#")[0]
        if clean not in seen and clean != base_url:
            seen.add(clean)
            links.append(clean)
    return links


def extract_images(html, base_url):
    """Return absolute portfolio-candidate image URLs from a page."""
    soup = BeautifulSoup(html, "html.parser")
    urls = []
    seen = set()
    for img in soup.find_all("img"):
        src = img.get("src") or img.get("data-src") or ""
        if not src or src.startswith("data:"):
            continue
        absolute = urljoin(base_url, src)
        if not IMAGE_EXT_RE.search(absolute) or IMAGE_SKIP_RE.search(absolute):
            continue
        if absolute not in seen:
            seen.add(absolute)
            urls.append(absolute)
    return urls


def infer_styles(text):
    """Map free text to canonical style names via keyword search."""
    lowered = text.lower()
    return [
        style for style, keywords in STYLE_KEYWORDS.items()
        if any(k in lowered for k in keywords)
    ]


def infer_tags(text):
    lowered = text.lower()
    return [
        tag for tag, keywords in TAG_KEYWORDS.items()
        if any(k in lowered for k in keywords)
    ]


def handle_to_display_name(handle):
    """'felix_young.ink' -> 'Felix Young Ink' (fallback when no name found)."""
    words = re.split(r"[._]+", handle)
    return " ".join(w.capitalize() for w in words if w)


def looks_like_shop_account(handle, shop_name):
    """True when an IG handle is probably the shop's own account."""
    generic = {"tattoo", "tattoos", "studio", "shop", "gallery", "collective",
               "company", "parlor", "parlour", "piercing"}
    shop_tokens = {t for t in re.split(r"\W+", shop_name.lower()) if len(t) > 3}
    distinctive = shop_tokens - generic
    compact_handle = re.sub(r"[._\d]+", "", handle.lower())
    return any(tok in compact_handle for tok in distinctive)


PERSON_NAME_RE = re.compile(r"^[A-Z][\w'.-]*(?: [A-Z][\w'.-]*){0,3}$")
NAV_WORDS = {
    "artists", "artist", "home", "about", "contact", "booking", "book",
    "gallery", "shop", "store", "faq", "piercing", "piercings", "gift",
    "cards", "blog", "news", "menu", "aftercare", "policies", "policy",
    "appointments", "directions", "location", "locations", "merch",
    "events", "reviews", "financing", "careers", "apply", "more",
}


def find_person_links(html, base_url):
    """(name, url) pairs for links whose anchor text looks like a person.

    Roster pages typically link artist detail pages with the artist's
    name as anchor text (often top-level slugs like /hayden/), so the
    anchor text doubles as the artist's display name.
    """
    soup = BeautifulSoup(html, "html.parser")
    base_host = urlparse(base_url).netloc.lower().removeprefix("www.")
    results, seen = [], set()
    for a in soup.find_all("a", href=True):
        text = a.get_text(" ", strip=True)
        if not text or len(text) > 40 or not PERSON_NAME_RE.match(text):
            continue
        if any(w in NAV_WORDS for w in text.lower().split()):
            continue
        absolute = urljoin(base_url, a["href"]).split("#")[0]
        parsed = urlparse(absolute)
        if parsed.scheme not in ("http", "https"):
            continue
        if parsed.netloc.lower().removeprefix("www.") != base_host:
            continue
        if absolute.rstrip("/") == base_url.rstrip("/"):
            continue
        if absolute not in seen:
            seen.add(absolute)
            results.append((text, absolute))
    return results


# Link/heading text that is a call-to-action, not a person's name
JUNK_NAME_RE = re.compile(
    r"view|portfolio|follow|instagram|book|gallery|artists?\b|tattoo|"
    r"read more|learn more|see more|click|schedule|appointment", re.I
)


def clean_person_name(text):
    """Return a plausible display name from raw text, or None."""
    if not text or not (2 < len(text.strip()) < 40):
        return None
    text = text.strip()
    if not re.search(r"[A-Za-z]", text) or "@" in text or JUNK_NAME_RE.search(text):
        return None
    return text.title() if text.isupper() else text


def name_near_handle(soup, handle):
    """Best-effort artist name: text of the IG link or its nearest heading."""
    for a in soup.find_all("a", href=True):
        if handle not in a["href"].lower():
            continue
        name = clean_person_name(a.get_text(" ", strip=True))
        if name:
            return name
        for parent in a.parents:
            heading = parent.find(["h1", "h2", "h3", "h4"])
            if heading:
                name = clean_person_name(heading.get_text(" ", strip=True))
                if name:
                    return name
            if parent.name in ("section", "article", "body"):
                break
    return None


# ---------------------------------------------------------------------------
# Stage 1: discover shops via Places API
# ---------------------------------------------------------------------------

def places_search_city(city, state, api_key, max_shops):
    """All tattoo shops Places returns for one city (paginated)."""
    shops = []
    body = {"textQuery": f"tattoo shop in {city}, {state}", "pageSize": 20}
    headers = {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": api_key,
        "X-Goog-FieldMask": PLACES_FIELD_MASK,
    }
    while len(shops) < max_shops:
        resp = requests.post(PLACES_SEARCH_URL, json=body, headers=headers,
                             timeout=30)
        resp.raise_for_status()
        data = resp.json()
        for place in data.get("places", []):
            if place.get("businessStatus") not in (None, "OPERATIONAL"):
                continue
            shops.append({
                "place_id": place["id"],
                "shopName": place.get("displayName", {}).get("text", ""),
                "address": place.get("formattedAddress", ""),
                "lat": place.get("location", {}).get("latitude"),
                "lng": place.get("location", {}).get("longitude"),
                "rating": place.get("rating"),
                "reviewCount": place.get("userRatingCount"),
                "website": place.get("websiteUri"),
                "city": city,
                "state": state,
            })
        token = data.get("nextPageToken")
        if not token:
            break
        body["pageToken"] = token
        time.sleep(2)  # token becomes valid shortly after the response
    return shops[:max_shops]


def stage_discover(args, out_dir):
    api_key = args.key or os.environ.get("GOOGLE_PLACES_API_KEY")
    if not api_key:
        sys.exit("GOOGLE_PLACES_API_KEY is required for discover")
    cities = [c.strip() for c in args.cities.split(",") if c.strip()]
    all_shops, seen = [], set()
    for city in cities:
        found = places_search_city(city, args.state, api_key, args.max_shops)
        fresh = [s for s in found if s["place_id"] not in seen]
        seen.update(s["place_id"] for s in fresh)
        all_shops.extend(fresh)
        print(f"  {city}: {len(fresh)} shops")
    out = out_dir / "shops.json"
    out.write_text(json.dumps(all_shops, indent=2))
    with_sites = sum(1 for s in all_shops if s.get("website"))
    print(f"discover: {len(all_shops)} shops ({with_sites} with websites) -> {out}")
    return all_shops


# ---------------------------------------------------------------------------
# Stage 2: crawl shop websites for artists
# ---------------------------------------------------------------------------

def robots_allows(session, base_url):
    parsed = urlparse(base_url)
    rp = urllib.robotparser.RobotFileParser()
    try:
        resp = session.get(
            f"{parsed.scheme}://{parsed.netloc}/robots.txt", timeout=10)
        if resp.status_code >= 400:
            return lambda url: True
        rp.parse(resp.text.splitlines())
        return lambda url: rp.can_fetch(USER_AGENT, url)
    except requests.RequestException:
        return lambda url: True


def fetch(session, url, delay):
    time.sleep(delay)
    resp = session.get(url, timeout=15, allow_redirects=True)
    resp.raise_for_status()
    if "text/html" not in resp.headers.get("Content-Type", "text/html"):
        raise ValueError(f"not html: {url}")
    return resp.text


def harvest_page(artists, shop, url, html):
    """Record artist handles (and single-artist-page images) from one page."""
    handles = extract_instagram_handles(html)
    artist_handles = [
        h for h in handles if not looks_like_shop_account(h, shop["shopName"])
    ]
    if not artist_handles:
        return
    soup = BeautifulSoup(html, "html.parser")
    page_text = soup.get_text(" ", strip=True)
    page_images = extract_images(html, url) if len(artist_handles) == 1 else []
    for handle in artist_handles:
        rec = artists.setdefault(handle, {
            "instagram": handle,
            "name": None,
            "portfolioImages": [],
            "page_text": "",
            "source_pages": [],
        })
        rec["name"] = rec["name"] or name_near_handle(soup, handle)
        rec["source_pages"].append(url)
        if page_images and not rec["portfolioImages"]:
            rec["portfolioImages"] = page_images[:12]
            rec["page_text"] = page_text[:5000]


def crawl_shop(session, shop, max_pages, delay):
    """Return {handle: artist_record} found on one shop's website.

    Three hops: homepage -> roster pages (nav text like "Artists") ->
    person pages (anchor text that looks like a name, e.g. /hayden/).
    The person-link anchor text is the most reliable artist name source.
    """
    website = shop.get("website")
    if not website:
        return {}

    # Some shops list an Instagram URL as their website; nothing to crawl.
    ig_as_site = IG_HANDLE_RE.search(website)
    if "instagram.com" in website.lower():
        if ig_as_site:
            shop["shop_instagram"] = ig_as_site.group(1).lower()
        return {}

    can_fetch = robots_allows(session, website)
    if not can_fetch(website):
        print(f"    robots.txt disallows {website}, skipping")
        return {}

    try:
        home_html = fetch(session, website, delay)
    except (requests.RequestException, ValueError) as e:
        print(f"    unreachable: {website} ({type(e).__name__})")
        return {}

    artists = {}
    budget = max_pages - 1
    harvest_page(artists, shop, website, home_html)

    roster_pages = []
    for link in find_roster_links(home_html, website):
        if budget <= 0:
            break
        if not can_fetch(link):
            continue
        try:
            html = fetch(session, link, delay)
        except (requests.RequestException, ValueError):
            continue
        budget -= 1
        roster_pages.append((link, html))
        harvest_page(artists, shop, link, html)

    # Second hop: person-named links off the homepage and roster pages
    person_links, seen_urls = [], {website} | {u for u, _ in roster_pages}
    for src_url, src_html in [(website, home_html)] + roster_pages:
        for name, url in find_person_links(src_html, src_url):
            if url not in seen_urls:
                seen_urls.add(url)
                person_links.append((name, url))
    for name, url in person_links:
        if budget <= 0:
            break
        if not can_fetch(url):
            continue
        try:
            html = fetch(session, url, delay)
        except (requests.RequestException, ValueError):
            continue
        budget -= 1
        before = set(artists)
        harvest_page(artists, shop, url, html)
        # The anchor text naming this page beats any heading heuristic
        for handle in set(artists) - before:
            artists[handle]["name"] = name
    return artists


def stage_crawl(args, out_dir):
    shops = json.loads((out_dir / "shops.json").read_text())
    session = requests.Session()
    session.headers["User-Agent"] = USER_AGENT
    results = []
    for i, shop in enumerate(shops, 1):
        print(f"  [{i}/{len(shops)}] {shop['shopName']}")
        found = crawl_shop(session, shop, args.max_pages, args.delay)
        shop_out = dict(shop)
        shop_out["artists"] = list(found.values())
        results.append(shop_out)
        print(f"    -> {len(found)} artist handle(s)")
    out = out_dir / "raw_artists.json"
    out.write_text(json.dumps(results, indent=2))
    total = sum(len(s["artists"]) for s in results)
    print(f"crawl: {total} artist records across {len(results)} shops -> {out}")
    return results


# ---------------------------------------------------------------------------
# Stage 3: normalize to importer shape
# ---------------------------------------------------------------------------

def normalize_dataset(raw_shops):
    """Build the {artists, cities, styles} document import-to-neo4j.js reads."""
    artists, seen_handles = [], set()
    for shop in raw_shops:
        for raw in shop.get("artists", []):
            handle = raw["instagram"]
            if handle in seen_handles:
                continue
            seen_handles.add(handle)
            context = raw.get("page_text", "")
            styles = infer_styles(context)
            # Sanitize again here so re-normalizing old crawl output also heals
            name = clean_person_name(raw.get("name") or "") \
                or handle_to_display_name(handle)
            artists.append({
                "id": f"artist_{handle}",
                "name": name,
                "shopName": shop["shopName"],
                "city": shop["city"],
                "state": shop["state"],
                "location": f"{shop['city']}, {shop['state']}",
                "coordinates": {"lat": shop["lat"], "lng": shop["lng"]},
                "instagram": f"@{handle}",
                "hourlyRate": None,          # not observable; never fabricated
                "rating": shop.get("rating"),         # shop's Google rating
                "reviewCount": shop.get("reviewCount"),
                "bio": f"Tattoo artist at {shop['shopName']} in "
                       f"{shop['city']}, {shop['state']}.",
                "yearsExperience": None,     # not observable; never fabricated
                "bookingAvailable": None,
                "portfolioImages": raw.get("portfolioImages", []),
                "styles": styles,
                "tags": infer_tags(context) + ["shop-rating"],
                "source": "scraped",
                "sourcePages": raw.get("source_pages", []),
            })
    cities = sorted({f"{a['city']}, {a['state']}" for a in artists})
    styles = sorted({s for a in artists for s in a["styles"]})
    return {"artists": artists, "cities": cities, "styles": styles}


def stage_normalize(args, out_dir):
    raw_shops = json.loads((out_dir / "raw_artists.json").read_text())
    dataset = normalize_dataset(raw_shops)
    out = out_dir / "artists.json"
    out.write_text(json.dumps(dataset, indent=2))
    n = dataset["artists"]
    with_imgs = sum(1 for a in n if a["portfolioImages"])
    with_styles = sum(1 for a in n if a["styles"])
    print(f"normalize: {len(n)} artists | {with_imgs} with portfolio images | "
          f"{with_styles} with styles | {len(dataset['cities'])} cities -> {out}")
    return dataset


# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("stage", choices=["discover", "crawl", "normalize", "all"])
    parser.add_argument("--cities", default=",".join(DEFAULT_CITIES))
    parser.add_argument("--state", default="AZ")
    parser.add_argument("--key", help="Places API key (or GOOGLE_PLACES_API_KEY)")
    parser.add_argument("--max-shops", type=int, default=20,
                        help="max shops per city")
    parser.add_argument("--max-pages", type=int, default=25,
                        help="max pages fetched per shop site")
    parser.add_argument("--delay", type=float, default=1.0,
                        help="seconds between fetches on one site")
    parser.add_argument("--out-dir", default=DEFAULT_OUT_DIR)
    args = parser.parse_args()

    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    if args.stage in ("discover", "all"):
        stage_discover(args, out_dir)
    if args.stage in ("crawl", "all"):
        stage_crawl(args, out_dir)
    if args.stage in ("normalize", "all"):
        stage_normalize(args, out_dir)


if __name__ == "__main__":
    main()
