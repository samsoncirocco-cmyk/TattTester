#!/usr/bin/env python3
"""Deterministic artist enrichment from shop websites.

Extracts styles / portfolio images / bios for verified artists, scoped
per-artist by construction:

  * visible text only (script/style/noscript/svg/head/iframe/template stripped)
  * per-artist section scoping: content between the artist's name anchor and
    the next artist's anchor -- shop-level data is never assigned per-artist
  * junk-image rejection (logos/sprites/avatars/tiny variants)
  * bios are visible text, entity-unescaped, <=500 chars, anchored on the name
  * non-artists (piercers/photographers/managers) skipped by name/id hints
  * robots.txt respected, 1s/domain politeness, 15s timeouts,
    max 6 listed pages/domain + 2 followed artist-page links
  * social domains never fetched

Usage:
  enrich_artists.py --batches 0-2      # pilot
  enrich_artists.py --all              # everything (resumable; skips done shards)
  enrich_artists.py --validate         # run merge validator over shards only

Output: data/enrichment/shards-deterministic/shard-NNN.json
"""

import argparse
import json
import re
import sys
import time
import unicodedata
import urllib.robotparser
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from urllib.parse import urljoin, urlparse

import requests
from bs4 import BeautifulSoup, NavigableString

ROOT = Path(__file__).resolve().parent.parent
BATCH_DIR = ROOT / "data" / "enrichment" / "batches"
SHARD_DIR = ROOT / "data" / "enrichment" / "shards-deterministic"

UA = "TatTEnrichBot/1.0 (+https://tatt-app.vercel.app; polite; contact samson.cirocco@gmail.com)"
TIMEOUT = 15
DOMAIN_DELAY = 1.0
MAX_LISTED_PAGES = 6
MAX_FOLLOWED_LINKS = 2
MAX_IMAGES_PER_ARTIST = 12
MAX_BIO_CHARS = 500
SECTION_TOKEN_CAP = 80  # max tokens after anchor when no next-artist anchor found
WORKERS = 6

BLOCKED_DOMAINS = re.compile(
    r"(?:^|\.)(instagram\.com|facebook\.com|fb\.com|fb\.me|twitter\.com|x\.com|"
    r"tiktok\.com|youtube\.com|youtu\.be|pinterest\.com|linkedin\.com|"
    r"snapchat\.com|threads\.net|linktr\.ee|wa\.me|whatsapp\.com)$",
    re.I,
)

NON_ARTIST_HINTS = re.compile(
    r"piercer|piercing|photograph|videograph|manager|receptionist|"
    r"front[\s_-]?desk|counter[\s_-]?staff|shop[\s_-]?assistant|apprentice[\s_-]?piercer",
    re.I,
)

# canonical style -> regex over visible text
STYLE_PATTERNS = {
    "Traditional": re.compile(r"\b(?:american\s+)?traditional\b(?!\s*chinese)", re.I),
    "Neo-Traditional": re.compile(r"\bneo[\s-]?traditional\b", re.I),
    "Black & Grey": re.compile(r"\bblack\s*(?:&|and|\+|n)\s*gr[ae]y\b", re.I),
    "Blackwork": re.compile(r"\bblack[\s-]?work\b", re.I),
    "Fine Line": re.compile(r"\bfine[\s-]?line\b", re.I),
    "Realism": re.compile(r"\b(?:photo[\s-]?)?realis(?:m|tic)\b", re.I),
    "Illustrative": re.compile(r"\billustrat(?:ive|ion)\b", re.I),
    "Japanese": re.compile(r"\b(?:japanese|irezumi)\b", re.I),
    "Watercolor": re.compile(r"\bwater[\s-]?colou?r\b", re.I),
    "Geometric": re.compile(r"\bgeometr(?:ic|y)\b", re.I),
    "Tribal": re.compile(r"\btribal\b", re.I),
    "Chicano": re.compile(r"\bchicano\b", re.I),
    "Anime": re.compile(r"\b(?:anime|manga)\b", re.I),
    "Minimalist": re.compile(r"\bminimalis(?:t|m)\b", re.I),
    "Script": re.compile(r"\b(?:script|lettering|calligraphy)\s*(?:tattoo|work|style)?\b", re.I),
}
# "Neo-Traditional" text also matches the "Traditional" pattern's word --
# handled below by removing Traditional when only neo-traditional evidence.

BAD_IMG_URL = re.compile(
    r"logo|icon|favicon|sprite|placeholder|blur|avatar|headshot|team|staff|badge",
    re.I,
)
RESIZE_VARIANT = re.compile(r"[-_](\d{2,4})x(\d{2,4})(?:[._@]|$)")
IMG_EXT_OK = re.compile(r"\.(jpe?g|png|webp)(?:$|\?)", re.I)

NAV_WORDS = {
    "home", "about", "contact", "book", "book now", "booking", "menu", "gallery",
    "artists", "shop", "faq", "aftercare", "blog", "instagram", "facebook",
    "search", "cart", "close", "next", "prev", "previous", "read more", "more",
    "email", "phone", "call", "directions", "hours", "privacy policy", "terms",
}

STRIP_TAGS = ["script", "style", "noscript", "svg", "head", "iframe", "template"]


def norm(s):
    s = unicodedata.normalize("NFKD", s)
    s = "".join(c for c in s if not unicodedata.combining(c))
    return re.sub(r"\s+", " ", s).strip().casefold()


def domain_of(url):
    return urlparse(url).netloc.lower().lstrip("www.") if "://" in url else url.lower()


def is_blocked(url):
    host = urlparse(url).netloc.lower()
    host = host[4:] if host.startswith("www.") else host
    return bool(BLOCKED_DOMAINS.search(host))


class Fetcher:
    """Per-domain polite fetcher with robots.txt respect."""

    def __init__(self):
        self.session = requests.Session()
        self.session.headers["User-Agent"] = UA
        self.robots = {}
        self.last_fetch = 0.0

    def _rp(self, url):
        base = "{0.scheme}://{0.netloc}".format(urlparse(url))
        if base not in self.robots:
            rp = urllib.robotparser.RobotFileParser()
            try:
                r = self.session.get(base + "/robots.txt", timeout=TIMEOUT)
                if r.status_code == 200:
                    rp.parse(r.text.splitlines())
                else:
                    rp.parse([])  # no robots -> allow all
            except requests.RequestException:
                rp.parse([])
            self.robots[base] = rp
        return self.robots[base]

    def allowed(self, url):
        try:
            return self._rp(url).can_fetch(UA, url)
        except Exception:
            return True

    def get(self, url):
        if is_blocked(url):
            return None
        if not self.allowed(url):
            return None
        wait = DOMAIN_DELAY - (time.time() - self.last_fetch)
        if wait > 0:
            time.sleep(wait)
        self.last_fetch = time.time()
        try:
            r = self.session.get(url, timeout=TIMEOUT, allow_redirects=True)
            if r.status_code != 200:
                return None
            ct = r.headers.get("content-type", "")
            if "html" not in ct and ct:
                return None
            if is_blocked(r.url):
                return None
            return r
        except requests.RequestException:
            return None


def tokenize_page(html, base_url):
    """Return (tokens, soup). tokens = list of ('text', str) | ('img', url)."""
    soup = BeautifulSoup(html, "html.parser")
    for tag in soup(STRIP_TAGS):
        tag.decompose()
    body = soup.body or soup
    tokens = []
    for el in body.descendants:
        if isinstance(el, NavigableString):
            t = re.sub(r"\s+", " ", str(el)).strip()
            if t:
                tokens.append(("text", t))
        elif getattr(el, "name", None) == "img":
            src = el.get("src") or el.get("data-src") or el.get("data-lazy-src") or ""
            if not src and el.get("srcset"):
                src = el["srcset"].split(",")[0].split()[0]
            if not src or src.startswith("data:"):
                continue
            url = urljoin(base_url, src)
            w = str(el.get("width") or "")
            h = str(el.get("height") or "")
            tokens.append(("img", url, w, h, (el.get("alt") or "")))
    return tokens, soup


def image_ok(url, w, h):
    if not url.lower().startswith(("http://", "https://")):
        return False
    if BAD_IMG_URL.search(url):
        return False
    m = RESIZE_VARIANT.search(urlparse(url).path)
    if m and (int(m.group(1)) < 300 or int(m.group(2)) < 300):
        return False
    for dim in (w, h):
        d = re.sub(r"\D", "", dim or "")
        if d and int(d) < 300:
            return False
    path = urlparse(url).path
    if path and "." in path.rsplit("/", 1)[-1] and not IMG_EXT_OK.search(url):
        return False
    return True


def find_anchors(tokens, name_patterns):
    """Map artist_id -> list of token indices where their name appears."""
    anchors = {}
    for i, tok in enumerate(tokens):
        if tok[0] != "text":
            continue
        t = norm(tok[1])
        if len(t) > 300:  # long paragraphs are content, not headings/anchors
            continue
        for aid, pats in name_patterns.items():
            if any(p in t for p in pats):
                anchors.setdefault(aid, []).append(i)
    return anchors


def extract_sections(tokens, anchors, artist_ids):
    """artist_id -> list of (start, end) token ranges."""
    boundary = sorted(
        {(i, aid) for aid, idxs in anchors.items() for i in idxs},
        key=lambda x: x[0],
    )
    sections = {}
    for k, (start, aid) in enumerate(boundary):
        end = start + SECTION_TOKEN_CAP
        for j in range(k + 1, len(boundary)):
            if boundary[j][1] != aid:
                end = min(end, boundary[j][0])
                break
        sections.setdefault(aid, []).append((start, end))
    return sections


def styles_from_text(text):
    found = []
    for style, pat in STYLE_PATTERNS.items():
        if pat.search(text):
            found.append(style)
    # de-conflict: "neo-traditional" alone should not also yield Traditional
    if "Traditional" in found and "Neo-Traditional" in found:
        stripped = STYLE_PATTERNS["Neo-Traditional"].sub(" ", text)
        if not STYLE_PATTERNS["Traditional"].search(stripped):
            found.remove("Traditional")
    return found


def build_bio(tokens, start, end, name_norm_variants):
    parts, seen = [], set()
    for i in range(start, min(end, len(tokens))):
        tok = tokens[i]
        if tok[0] != "text":
            continue
        t = tok[1]
        tn = norm(t)
        if tn in NAV_WORDS or len(t) < 3 or tn in seen:
            continue
        seen.add(tn)
        parts.append(t)
        if sum(len(p) for p in parts) >= MAX_BIO_CHARS:
            break
    bio = re.sub(r"\s+", " ", " ".join(parts)).strip()[:MAX_BIO_CHARS]
    bn = norm(bio)
    if not any(v in bn for v in name_norm_variants):
        return None
    # must be more than just the name / heading fluff
    longest = max(name_norm_variants, key=len)
    if len(bn) < len(longest) + 40:
        return None
    return bio


def name_variants(artist):
    """Normalized strings whose presence anchors this artist."""
    variants = set()
    full = norm(artist["name"])
    if full and len(full) >= 5 and " " in full:
        variants.add(full)
    handle = artist["id"][len("artist_"):] if artist["id"].startswith("artist_") else artist["id"]
    handle = handle.strip("_")
    if len(handle) >= 6 and not handle.isdigit():
        variants.add(norm(handle))
        variants.add(norm(handle.replace("_", " ")).strip())
    return {v for v in variants if v}


def artist_page_links(soup, base_url, artists, already):
    """Links whose anchor text or href slug matches an artist name."""
    out = []
    base_host = urlparse(base_url).netloc
    for a in soup.find_all("a", href=True):
        href = urljoin(base_url, a["href"].split("#")[0])
        p = urlparse(href)
        if p.scheme not in ("http", "https") or p.netloc != base_host:
            continue
        if href in already or is_blocked(href):
            continue
        text = norm(a.get_text(" ", strip=True))
        slug = norm(p.path.replace("-", " ").replace("_", " ").replace("/", " "))
        for art in artists:
            nn = norm(art["name"])
            if nn and len(nn) >= 5 and (nn == text or nn in slug):
                out.append(href)
                break
    return out


def enrich_domain(domain, artists):
    """Process one domain; returns {artist_id: {...}}."""
    fetcher = Fetcher()
    artists = [a for a in artists
               if not (NON_ARTIST_HINTS.search(a.get("name") or "")
                       or NON_ARTIST_HINTS.search(a.get("id") or ""))]
    if not artists:
        return {}

    pages = []
    for a in artists:
        for u in a.get("pages", []):
            if u not in pages and not is_blocked(u):
                pages.append(u)
    pages = pages[:MAX_LISTED_PAGES]

    name_pats = {a["id"]: name_variants(a) for a in artists}
    name_pats = {k: v for k, v in name_pats.items() if v}

    results = {}
    fetched = set()
    followed = 0
    queue = list(pages)
    while queue:
        url = queue.pop(0)
        if url in fetched:
            continue
        fetched.add(url)
        r = fetcher.get(url)
        if r is None:
            continue
        tokens, soup = tokenize_page(r.text, r.url)
        anchors = find_anchors(tokens, name_pats)
        sections = extract_sections(tokens, anchors, list(name_pats))
        for aid, ranges in sections.items():
            art = next(a for a in artists if a["id"] == aid)
            rec = results.setdefault(aid, {"styles": [], "portfolioImages": [], "bio": None, "evidence": []})
            for (start, end) in ranges:
                sec_text = " ".join(t[1] for t in tokens[start:min(end, len(tokens))] if t[0] == "text")
                for s in styles_from_text(sec_text):
                    if s not in rec["styles"]:
                        rec["styles"].append(s)
                for t in tokens[start:min(end, len(tokens))]:
                    if t[0] == "img" and image_ok(t[1], t[2], t[3]):
                        if t[1] not in rec["portfolioImages"] and len(rec["portfolioImages"]) < MAX_IMAGES_PER_ARTIST:
                            rec["portfolioImages"].append(t[1])
                if rec["bio"] is None:
                    rec["bio"] = build_bio(tokens, start, end, name_pats[aid])
            if url not in rec["evidence"]:
                rec["evidence"].append(url)
        if followed < MAX_FOLLOWED_LINKS:
            for link in artist_page_links(soup, r.url, artists, fetched | set(queue)):
                if followed >= MAX_FOLLOWED_LINKS:
                    break
                queue.append(link)
                followed += 1

    # drop artists with nothing usable
    out = {}
    for aid, rec in results.items():
        if rec["styles"] or rec["portfolioImages"] or rec["bio"]:
            if rec["bio"] is None:
                del rec["bio"]
            out[aid] = rec
    return out


def validate_domain(domain_results):
    """Merge-time smear scrub: if >2 artists on a domain share an identical
    non-empty style-set or image list, strip that field from all of them."""
    removed = {"styles": 0, "images": 0}
    by_styles, by_images = {}, {}
    for aid, rec in domain_results.items():
        s = tuple(sorted(rec.get("styles", [])))
        if s:
            by_styles.setdefault(s, []).append(aid)
        im = tuple(rec.get("portfolioImages", []))
        if im:
            by_images.setdefault(im, []).append(aid)
    for s, aids in by_styles.items():
        if len(aids) > 2:
            for aid in aids:
                domain_results[aid]["styles"] = []
                removed["styles"] += 1
    for im, aids in by_images.items():
        if len(aids) > 2:
            for aid in aids:
                domain_results[aid]["portfolioImages"] = []
                removed["images"] += 1
    # re-drop emptied artists
    for aid in [a for a, r in domain_results.items()
                if not (r.get("styles") or r.get("portfolioImages") or r.get("bio"))]:
        del domain_results[aid]
    return removed


def process_batch(batch_path):
    batch = json.loads(batch_path.read_text())
    n = batch["batch"]
    shard_path = SHARD_DIR / f"shard-{n:03d}.json"
    if shard_path.exists():
        print(f"[batch {n}] shard exists, skipping", flush=True)
        return
    t0 = time.time()
    all_artists = {}
    scrub_totals = {"styles": 0, "images": 0}
    with ThreadPoolExecutor(max_workers=WORKERS) as pool:
        futs = {pool.submit(enrich_domain, d, arts): d for d, arts in batch["domains"].items()}
        for fut in as_completed(futs):
            dom = futs[fut]
            try:
                res = fut.result()
            except Exception as e:
                print(f"[batch {n}] {dom}: ERROR {e}", flush=True)
                continue
            scrub = validate_domain(res)
            scrub_totals["styles"] += scrub["styles"]
            scrub_totals["images"] += scrub["images"]
            all_artists.update(res)
            print(f"[batch {n}] {dom}: {len(res)} artists enriched", flush=True)
    SHARD_DIR.mkdir(parents=True, exist_ok=True)
    shard_path.write_text(json.dumps({"batch": n, "artists": all_artists}, indent=1))
    print(f"[batch {n}] DONE {len(all_artists)} artists, scrubbed {scrub_totals}, "
          f"{time.time()-t0:.0f}s -> {shard_path}", flush=True)


def revalidate_all():
    """Standalone validator pass over existing shards (uses batch files to
    re-derive domain groupings)."""
    for shard_path in sorted(SHARD_DIR.glob("shard-*.json")):
        shard = json.loads(shard_path.read_text())
        batch = json.loads((BATCH_DIR / f"batch-{shard['batch']:03d}.json").read_text())
        changed = False
        for dom, arts in batch["domains"].items():
            group = {a["id"]: shard["artists"][a["id"]]
                     for a in arts if a["id"] in shard["artists"]}
            removed = validate_domain(group)
            if removed["styles"] or removed["images"]:
                changed = True
                for a in arts:
                    if a["id"] in shard["artists"] and a["id"] not in group:
                        del shard["artists"][a["id"]]
                print(f"{shard_path.name} {dom}: scrubbed {removed}")
        if changed:
            shard_path.write_text(json.dumps(shard, indent=1))
    print("validation pass complete")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--batches", help="e.g. 0-2 or 5")
    ap.add_argument("--all", action="store_true")
    ap.add_argument("--validate", action="store_true", help="merge validator over existing shards")
    args = ap.parse_args()
    if args.validate:
        revalidate_all()
        return
    paths = sorted(BATCH_DIR.glob("batch-*.json"))
    if args.batches:
        if "-" in args.batches:
            lo, hi = map(int, args.batches.split("-"))
        else:
            lo = hi = int(args.batches)
        paths = [p for p in paths if lo <= int(p.stem.split("-")[1]) <= hi]
    elif not args.all:
        ap.error("need --batches, --all, or --validate")
    for p in paths:
        process_batch(p)


if __name__ == "__main__":
    main()
