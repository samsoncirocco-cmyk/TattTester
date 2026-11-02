"""Pure parsers for the in-house artist discovery lane.

No network and no clock. The shapes here follow what a logged-out browser
actually returns (see docs/operations/inhouse-artist-discovery.md): search
result HTML, a shop page, or an Instagram document that is either a login
wall or a public profile. Login walls and bot challenges are statuses, not
something to parse around.
"""

from __future__ import annotations

import re
from html import unescape
from typing import Any
from urllib.parse import parse_qs, unquote, urlparse

from bs4 import BeautifulSoup

from execution.scrape_artists import (
    extract_instagram_handles,
    name_near_handle,
)


US_STATE_CODES = frozenset(
    {
        "AL", "AK", "AZ", "AR", "CA", "CO", "CT", "DE", "DC", "FL", "GA", "HI",
        "ID", "IL", "IN", "IA", "KS", "KY", "LA", "ME", "MD", "MA", "MI", "MN",
        "MS", "MO", "MT", "NE", "NV", "NH", "NJ", "NM", "NY", "NC", "ND", "OH",
        "OK", "OR", "PA", "RI", "SC", "SD", "TN", "TX", "UT", "VT", "VA", "WA",
        "WV", "WI", "WY",
    }
)

# Hosts whose robots.txt, or whose logged-out behavior, forbids a generic
# crawler. The fetcher skips them unless the operator names the host.
DISALLOWED_HOSTS = frozenset(
    {
        "instagram.com",
        "www.instagram.com",
        "l.instagram.com",
        "google.com",
        "www.google.com",
    }
)

# Starting prices from the Apify console screenshot the owner attached,
# USD per 1,000 units. Used only to estimate avoided spend.
APIFY_USD_PER_THOUSAND = {
    "profile": 2.60,
    "hashtag": 2.60,
    "follow": 5.00,
    "contact": 2.00,
    "search": 4.50,
    "page": 2.28,
    "tech": 10.00,
}

EMAIL_RE = re.compile(r"[A-Z0-9._%+\-]+@[A-Z0-9.\-]+\.[A-Z]{2,}", re.I)
PHONE_RE = re.compile(r"(?:\+1[\s.\-]?)?\(?\d{3}\)?[\s.\-]\d{3}[\s.\-]\d{4}")
MENTION_RE = re.compile(r"(?<![\w.])@([A-Za-z0-9._]{3,30})")
JUNK_EMAIL_DOMAINS = frozenset(
    {
        "example.com",
        "example.org",
        "sentry.io",
        "wixpress.com",
        "godaddy.com",
        "schema.org",
        "squarespace.com",
        "instagram.com",
    }
)
BOOKING_HOST_MARKERS = (
    "vagaro.com",
    "booksy.com",
    "calendly.com",
    "glossgenius.com",
    "fresha.com",
    "square.site",
    "squareup.com",
    "acuityscheduling.com",
    "setmore.com",
    "schedulicity.com",
)

PLATFORM_RULES = (
    ("godaddy-website-builder", ("wsimg.com", "secureserver.net", "godaddy website builder", "starfield")),
    ("squarespace", ("squarespace.com", "squarespace-cdn", "static1.squarespace")),
    ("wix", ("wix.com", "wixstatic.com", "parastorage.com")),
    ("shopify", ("cdn.shopify.com", "myshopify.com")),
    ("wordpress", ("wp-content", "wp-includes", "wordpress")),
    ("webflow", ("webflow.com", "website-files.com")),
)


def host_of(url: str) -> str:
    try:
        return urlparse(url).netloc.lower().removeprefix("www.")
    except ValueError:
        return ""


def normalize_handle(raw: str | None) -> str | None:
    """Match scripts/lib/takedown-tombstone.mjs normalizeInstagramHandle."""
    if not raw:
        return None
    text = str(raw).strip()
    text = re.sub(r"^https?://(www\.)?instagram\.com/", "", text, flags=re.I)
    text = text[1:] if text.startswith("@") else text
    text = text.split("/")[0].split("?")[0].split("#")[0].strip().lower()
    if not text or not re.fullmatch(r"[a-z0-9._]{2,30}", text):
        return None
    return text


def is_profile_handle(handle: str | None) -> bool:
    if not handle:
        return False
    from execution.scrape_artists import IG_NON_ACCOUNT_PATHS

    return handle not in IG_NON_ACCOUNT_PATHS and len(handle) >= 3


def handles_from_text(text: str) -> list[str]:
    found = []
    seen = set()
    for handle in extract_instagram_handles(text or ""):
        if is_profile_handle(handle) and handle not in seen:
            seen.add(handle)
            found.append(handle)
    return found


def mentions_from_bio(bio: str) -> list[str]:
    found = []
    seen = set()
    for match in MENTION_RE.finditer(bio or ""):
        handle = normalize_handle(match.group(1))
        if is_profile_handle(handle) and handle not in seen:
            seen.add(handle)
            found.append(handle)
    return found


def search_query(city: str, state: str) -> str:
    return f"tattoo artist {city.strip()} {state.strip().upper()} site:instagram.com"


def duckduckgo_search_url(query: str) -> str:
    from urllib.parse import quote_plus

    return "https://html.duckduckgo.com/html/?q=" + quote_plus(query)


def _decode_result_href(href: str) -> str:
    href = unescape(href or "").strip()
    parsed = urlparse(href)
    host = parsed.netloc.lower()
    if host.endswith("duckduckgo.com") and parsed.path.startswith("/l/"):
        target = parse_qs(parsed.query).get("uddg", [""])[0]
        if target:
            return unquote(target)
    return href


def parse_search_html(html: str) -> dict[str, Any]:
    """Read a public search-results document.

    A challenge interstitial (DuckDuckGo's anomaly modal, HTTP 202 in the
    capture this was written against) is a stop signal. The parser does not
    look for a way through it.
    """
    text = html or ""
    lowered = text.lower()
    if "anomaly-modal" in lowered or "g-recaptcha" in lowered or "cf-challenge" in lowered:
        return {"fetchStatus": "challenge", "handles": []}

    soup = BeautifulSoup(text, "html.parser")
    handles = []
    seen = set()
    anchors = soup.select("a.result__a") or soup.find_all("a", href=True)
    for anchor in anchors:
        href = _decode_result_href(anchor.get("href") or "")
        if "instagram.com" not in href.lower():
            continue
        for handle in handles_from_text(href):
            if handle not in seen:
                seen.add(handle)
                handles.append(handle)
    status = "results" if handles else "empty"
    return {"fetchStatus": status, "handles": handles}


def instagram_final_status(final_url: str, status: int) -> str | None:
    """Return a blocked status when the document is not a public profile."""
    url = (final_url or "").lower()
    if "/accounts/login" in url or "is_from_rle" in url:
        return "login-wall"
    if status in (401, 403):
        return "forbidden"
    if status == 404:
        return "not-found"
    if status == 429:
        return "rate-limited"
    return None


def parse_instagram_document(html: str, final_url: str, status: int = 200) -> dict[str, Any]:
    blocked = instagram_final_status(final_url, status)
    if blocked:
        return _empty_profile(blocked)

    text = html or ""
    soup = BeautifulSoup(text, "html.parser")
    title = soup.title.get_text(" ", strip=True) if soup.title else ""
    if re.search(r"\blogin\b", title, re.I) and "og:description" not in text:
        return _empty_profile("login-wall")

    bio = _meta(soup, "og:description") or _meta(soup, "description") or ""
    full_name = _meta(soup, "og:title") or ""
    full_name = re.sub(r"\s*[•|·-]\s*Instagram.*$", "", full_name).strip()
    external = ""
    for anchor in soup.find_all("a", href=True):
        href = anchor["href"]
        if href.startswith("http") and "instagram.com" not in href.lower():
            external = href
            break

    followers = _followers_in_text(soup.get_text(" ", strip=True))
    post_count = _count_near(text, "posts")
    profile_links = handles_from_text(text)
    # A 200 document with no bio and no profile links is the JS shell REA
    # recorded for /popular/{tag}. Anchors that do exist are still returned
    # by handles_from_text; the document itself is not a profile.
    if not bio and not full_name and followers is None and len(profile_links) < 2:
        shell = _empty_profile("shell")
        shell["linkedHandles"] = profile_links
        return shell

    return {
        "fetchStatus": "ok",
        "bio": bio,
        "fullName": full_name,
        "followers": followers,
        "url": external,
        "private": bool(re.search(r"this account is private", text, re.I)),
        "verified": False,
        "postCount": post_count,
        "category": "",
        "linkedHandles": profile_links,
    }


def _empty_profile(status: str) -> dict[str, Any]:
    return {
        "fetchStatus": status,
        "bio": "",
        "fullName": "",
        "followers": None,
        "url": "",
        "private": status == "login-wall",
        "verified": False,
        "postCount": None,
        "category": "",
        "linkedHandles": [],
    }


def _meta(soup: BeautifulSoup, key: str) -> str:
    tag = soup.find("meta", attrs={"property": key}) or soup.find("meta", attrs={"name": key})
    if not tag:
        return ""
    return unescape(tag.get("content") or "").strip()


def _followers_in_text(text: str) -> int | None:
    match = re.search(r"([\d][\d,.]*)\s+Followers\b", text, re.I)
    if not match:
        return None
    digits = match.group(1).replace(",", "").replace(".", "")
    try:
        return int(digits)
    except ValueError:
        return None


def _count_near(text: str, label: str) -> int | None:
    match = re.search(rf"([\d][\d,]*)\s+{label}\b", text, re.I)
    if not match:
        return None
    try:
        return int(match.group(1).replace(",", ""))
    except ValueError:
        return None


def detect_platform(html: str) -> str | None:
    haystack = (html or "").lower()
    for name, markers in PLATFORM_RULES:
        if any(marker in haystack for marker in markers):
            return name
    return None


def extract_emails(html: str) -> list[str]:
    found = []
    seen = set()
    for match in EMAIL_RE.finditer(html or ""):
        email = match.group(0).lower().strip(".")
        domain = email.split("@", 1)[-1]
        if domain in JUNK_EMAIL_DOMAINS or email.startswith("noreply"):
            continue
        if email not in seen:
            seen.add(email)
            found.append(email)
    return found


def extract_phones(html: str) -> list[str]:
    soup = BeautifulSoup(html or "", "html.parser")
    found = []
    seen = set()
    for anchor in soup.find_all("a", href=True):
        href = anchor["href"]
        if href.lower().startswith("tel:"):
            number = re.sub(r"[^\d+]", "", href[4:])
            if number and number not in seen:
                seen.add(number)
                found.append(number)
    if found:
        return found
    for match in PHONE_RE.finditer(soup.get_text(" ", strip=True)):
        number = re.sub(r"[^\d+]", "", match.group(0))
        if number not in seen:
            seen.add(number)
            found.append(number)
    return found


def extract_booking_urls(html: str) -> list[str]:
    found = []
    seen = set()
    soup = BeautifulSoup(html or "", "html.parser")
    for anchor in soup.find_all("a", href=True):
        href = anchor["href"].strip()
        lowered = href.lower()
        if not href.startswith("http"):
            continue
        if any(marker in lowered for marker in BOOKING_HOST_MARKERS):
            if href not in seen:
                seen.add(href)
                found.append(href)
    return found


def local_card_text(anchor) -> str:
    """Text that belongs to this one Instagram link, not the whole roster."""
    node = anchor
    for _ in range(3):
        parent = getattr(node, "parent", None)
        if parent is None or getattr(parent, "name", None) in ("body", "html", "[document]"):
            break
        ig_links = 0
        for link in parent.find_all("a", href=True):
            if handles_from_text(link.get("href") or ""):
                ig_links += 1
        text = parent.get_text(" ", strip=True)
        if ig_links <= 1 and 0 < len(text) <= 320:
            return text
        node = parent
    return anchor.get_text(" ", strip=True)


def parse_shop_html(html: str, page_url: str, shop: dict[str, Any] | None = None) -> dict[str, Any]:
    shop = shop or {}
    soup = BeautifulSoup(html or "", "html.parser")
    artists = []
    seen = set()
    for anchor in soup.find_all("a", href=True):
        for handle in handles_from_text(anchor.get("href") or ""):
            if handle in seen:
                continue
            seen.add(handle)
            card = local_card_text(anchor)
            name = name_near_handle(soup, handle) or _anchor_name(anchor)
            artists.append(
                {
                    "handle": handle,
                    "fullName": name or "",
                    "cardText": card,
                }
            )
    return {
        "url": page_url,
        "shopName": (shop.get("shopName") or shop.get("name") or "").strip(),
        "city": (shop.get("city") or "").strip(),
        "state": (shop.get("state") or "").strip().upper(),
        "platform": detect_platform(html),
        "emails": extract_emails(html),
        "phones": extract_phones(html),
        "bookingUrls": extract_booking_urls(html),
        "artists": artists,
        "textExcerpt": soup.get_text(" ", strip=True)[:1500],
    }


def _anchor_name(anchor) -> str:
    text = anchor.get_text(" ", strip=True)
    if not text or len(text) > 40 or "@" in text:
        return ""
    if re.search(r"instagram|follow|book\b", text, re.I):
        return ""
    return text


def factual_roster_bio(name: str, shop_name: str, city: str, state: str, card_text: str) -> str:
    """A bio made only of fields the roster page actually showed.

    The national shop crawl already stores this shape
    ("Tattoo artist at {shop} in {city}, {state}."). The card text is appended
    only when it is the one artist's card, so styles stay attributable.
    """
    parts = []
    if shop_name:
        place = f" in {city}, {state}" if city and state else ""
        who = name or "Tattoo artist"
        parts.append(f"{who} is a tattoo artist at {shop_name}{place}.")
    card = (card_text or "").strip()
    if card and card not in " ".join(parts):
        parts.append(card)
    return " ".join(parts).strip()


def roster_profile(artist: dict[str, Any], shop: dict[str, Any]) -> dict[str, Any]:
    city = (shop.get("city") or "").strip()
    state = (shop.get("state") or "").strip().upper()
    bio = factual_roster_bio(
        artist.get("fullName") or "",
        shop.get("shopName") or "",
        city,
        state,
        artist.get("cardText") or "",
    )
    booking = (shop.get("bookingUrls") or [None])[0]
    return {
        "fetchStatus": "ok",
        "bio": bio,
        "fullName": artist.get("fullName") or "",
        "followers": None,
        "url": booking or "",
        "private": False,
        "verified": False,
        "postCount": None,
        "category": "",
        "origin": "site",
        "shopName": shop.get("shopName") or "",
        "seedCity": city,
        "seedState": state if state in US_STATE_CODES else "",
        "platform": shop.get("platform"),
        "emails": shop.get("emails") or [],
        "phones": shop.get("phones") or [],
    }


def protected_reason(artist: dict[str, Any] | None) -> str | None:
    if not isinstance(artist, dict):
        return None
    if artist.get("removedAt"):
        return "removed"
    if artist.get("claimedByUid") or artist.get("claimVerificationStatus") in {"verified", "claimed"}:
        return "claimed"
    if artist.get("selfRegistered") is True:
        return "self-registered"
    if artist.get("pendingTakedown") or artist.get("takedownStatus") or artist.get("takedown"):
        return "takedown"
    return None


def reference_indexes(queue: list[dict[str, Any]], reference: dict[str, Any] | None):
    known = set()
    protected: dict[str, str] = {}
    for row in queue or []:
        handle = normalize_handle(row.get("ig") or row.get("instagram") or "")
        if is_profile_handle(handle):
            known.add(handle)
    for artist in (reference or {}).get("artists") or []:
        handle = normalize_handle(artist.get("instagram") or artist.get("ig") or "")
        if not is_profile_handle(handle):
            continue
        reason = protected_reason(artist)
        if reason:
            protected[handle] = reason
        known.add(handle)
    return known, protected


def classify_handle(handle: str, known: set[str], protected: dict[str, str]) -> str:
    if handle in protected:
        return "protected"
    if handle in known:
        return "known"
    return "new"


def hashtag_seed(city: str) -> str:
    slug = re.sub(r"[^a-z0-9]", "", (city or "").lower())
    return f"#{slug}tattoo" if slug else ""


def empty_candidate_bucket() -> dict[str, Any]:
    return {"sources": set(), "seedFrom": set(), "seedCity": "", "seedState": ""}


def add_source(bucket: dict[str, Any], source: str, seed: str, city: str = "", state: str = "") -> None:
    bucket["sources"].add(source)
    if seed:
        bucket["seedFrom"].add(seed)
    state = (state or "").upper()
    if city and state in US_STATE_CODES and not bucket["seedCity"]:
        bucket["seedCity"] = city.strip()
        bucket["seedState"] = state


def assemble_candidates(
    *,
    queue: list[dict[str, Any]],
    reference: dict[str, Any] | None,
    search_rows: dict[str, Any],
    site_rows: dict[str, Any],
    mention_rows: dict[str, Any],
    profiles: dict[str, Any],
) -> dict[str, Any]:
    """Merge every public lane into the candidate shape discover_ig writes.

    Protected and already-known handles are omitted from candidates.json.
    They are counted in the report so a run can show it did not propose
    overwriting a claimed, removed, self-registered, or takedown-flagged artist.
    """
    known, protected = reference_indexes(queue, reference)
    buckets: dict[str, dict[str, Any]] = {}
    skipped_known: set[str] = set()
    skipped_protected: dict[str, str] = {}

    def consider(handle: str, source: str, seed: str, city: str = "", state: str = "") -> None:
        handle = normalize_handle(handle)
        if not is_profile_handle(handle):
            return
        kind = classify_handle(handle, known, protected)
        if kind == "protected":
            skipped_protected[handle] = protected[handle]
            return
        if kind == "known":
            skipped_known.add(handle)
            return
        bucket = buckets.setdefault(handle, empty_candidate_bucket())
        add_source(bucket, source, seed, city, state)

    for query, row in (search_rows or {}).items():
        if not isinstance(row, dict) or row.get("fetchStatus") != "results":
            continue
        city = row.get("city") or ""
        state = row.get("state") or ""
        seed = hashtag_seed(city)
        for handle in row.get("handles") or []:
            consider(handle, "search", seed, city, state)

    for url, row in (site_rows or {}).items():
        if not isinstance(row, dict) or row.get("fetchStatus") not in (None, "ok"):
            continue
        city = row.get("city") or ""
        state = row.get("state") or ""
        seed = hashtag_seed(city) or host_of(url)
        for artist in row.get("artists") or []:
            consider(artist.get("handle"), "site", seed, city, state)

    for seed_handle, handles in (mention_rows or {}).items():
        seed = normalize_handle(seed_handle) or ""
        for handle in handles or []:
            consider(handle, "mention", seed)

    candidates = []
    merged_profiles = dict(profiles or {})
    for handle, bucket in sorted(buckets.items()):
        profile = _profile_for(handle, bucket, site_rows, merged_profiles)
        merged_profiles[handle] = profile
        candidates.append(
            {
                "handle": handle,
                "source": ",".join(sorted(bucket["sources"])),
                "seedFrom": ",".join(sorted(bucket["seedFrom"])),
                "seedCity": bucket["seedCity"] or None,
                "seedState": bucket["seedState"] or None,
                "bioSnippet": str(profile.get("bio") or "").replace("\n", " ").strip()[:160],
                "followers": profile.get("followers"),
                "fullName": profile.get("fullName") or "",
            }
        )
    reasons: dict[str, int] = {}
    for reason in skipped_protected.values():
        reasons[reason] = reasons.get(reason, 0) + 1
    return {
        "candidates": candidates,
        "profiles": merged_profiles,
        "skipped": {
            "known": len(skipped_known),
            "protected": len(skipped_protected),
            "protectedReasons": reasons,
        },
    }


def _profile_for(handle, bucket, site_rows, profiles):
    existing = profiles.get(handle) if isinstance(profiles.get(handle), dict) else None
    if existing and existing.get("fetchStatus") == "ok" and existing.get("origin") != "site":
        profile = dict(existing)
    else:
        profile = dict(existing or _empty_profile("unfetched"))
        for row in (site_rows or {}).values():
            if not isinstance(row, dict):
                continue
            for artist in row.get("artists") or []:
                if normalize_handle(artist.get("handle")) == handle:
                    site_profile = roster_profile(artist, row)
                    # A real profile enrich wins over the roster sentence.
                    if not (existing and existing.get("fetchStatus") == "ok" and existing.get("origin") != "site"):
                        profile = site_profile
                    break
    if bucket.get("seedCity") and not profile.get("seedCity"):
        profile["seedCity"] = bucket["seedCity"]
        profile["seedState"] = bucket["seedState"]
    return profile


def apply_bookability(candidates: list[dict[str, Any]], profiles: dict[str, Any]) -> list[dict[str, Any]]:
    from execution.ig_quality import looks_bookable

    reviewed = []
    for candidate in candidates:
        profile = profiles.get(candidate["handle"]) or {}
        verdict, reason = looks_bookable(profile)
        reviewed.append(
            {
                **candidate,
                "looksBookable": verdict,
                "filterReason": reason,
            }
        )
    reviewed.sort(key=lambda item: (not item["looksBookable"], -(item["followers"] or 0), item["handle"]))
    return reviewed


def equivalent_apify_usd(*, profiles: int = 0, hashtag_results: int = 0, follow_items: int = 0,
                         contact_pages: int = 0, search_pages: int = 0, fetched_pages: int = 0,
                         tech_results: int = 0) -> dict[str, Any]:
    """What the same unit counts would have started at on Apify.

    One shop fetch stands in for contact + page-read + tech-stack. The figure
    is a starting-price illustration, not an invoice.
    """
    units = {
        "profile": profiles,
        "hashtag": hashtag_results,
        "follow": follow_items,
        "contact": contact_pages,
        "search": search_pages,
        "page": fetched_pages,
        "tech": tech_results,
    }
    cost = {name: round(count / 1000 * APIFY_USD_PER_THOUSAND[name], 4) for name, count in units.items()}
    cost["total"] = round(sum(cost.values()), 4)
    cost["units"] = units
    return cost


def style_harvest_document(profiles: dict[str, Any], evidence_by_handle: dict[str, list[dict]], generated_at: str) -> dict[str, Any]:
    artists = []
    for handle, evidence in sorted(evidence_by_handle.items()):
        if not evidence:
            continue
        profile = profiles.get(handle) or {}
        artists.append(
            {
                "artistId": f"artist_{handle}",
                "handle": handle,
                "styles": [hit["style"] for hit in evidence],
                "bio": profile.get("bio") or "",
                "evidence": evidence,
            }
        )
    return {
        "generatedAt": generated_at,
        "source": "inhouse-discovery",
        "artists": artists,
    }
