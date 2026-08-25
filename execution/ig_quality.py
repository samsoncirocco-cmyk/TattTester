"""Auditable, conservative Instagram account-quality classifier.

This is the single implementation used by discovery and enrichment.  It is a
heuristic, not an identity decision: rejected accounts are recorded with a
reason and operators can deliberately bypass the gate with ``--no-filter``.
"""

from __future__ import annotations

import re
from typing import Any, Mapping


TATTOO_DOER = re.compile(
    r"tattoo(er|ist|ing)?\b|tattoo\s*artist|tatuador|tatowier|ink slinger|"
    r"blackwork|fineline|fine line|realism|traditional tattoo|apprentice",
    re.I,
)
BOOK = re.compile(
    r"book(ing|s)?\b|appt|appointment|dm to book|walk[- ]?in|"
    r"books?\s*(open|closed)|flash|guest ?spot|resident|inquir|deposit|slots?\b",
    re.I,
)
PIERCE = re.compile(r"pierc", re.I)
SUPPLY = re.compile(
    r"\b(supply|supplies|cartridge|needles?|ointment|wholesale|distributor|"
    r"worldwide shipping|shop now|our products?|pigment|machines? for|equipment|"
    r"official (page|account|store)|®|™)\b",
    re.I,
)
BRAND_NAMES = re.compile(
    r"\b(electric ?ink|dragonhawk|eternal ?ink|cheyenne|bishop|critical|fusion ink|"
    r"world famous|villain ?arts|inkjecta|kwadron|dynamic color|stigma)\b",
    re.I,
)
CONVENTION = re.compile(
    r"convention|expo\b|invitational|tattoo ?fest|festival|tickets? (on|now)|"
    r"book your booth",
    re.I,
)
SHOP_ACCOUNT = re.compile(
    r"our (artists|team)|resident artists|guest artists|artists:|now hiring|"
    r"hiring artists|book (with|your artist)|walk[- ]?ins welcome|"
    r"tattoo (studio|shop|parlou?r|collective) (in|located|est)|"
    r"@\w+ ?(&|and) ?@\w+",
    re.I,
)


def _value(profile: Mapping[str, Any], *keys: str, default: Any = None) -> Any:
    for key in keys:
        value = profile.get(key)
        if value is not None:
            return value
    return default


def looks_bookable(profile: Mapping[str, Any]) -> tuple[bool, str]:
    """Return ``(verdict, reason)`` for an Apify/discovery profile row."""

    bio = str(_value(profile, "bio", "biography", default="") or "")
    name = str(_value(profile, "fullName", "name", default="") or "")
    text = f"{bio} {name}"
    lowered = text.lower()
    followers = int(_value(profile, "followers", "followersCount", default=0) or 0)
    private = bool(_value(profile, "private", "isPrivate", default=False))
    url = _value(profile, "url", "externalUrl", "externalUrlShimmed")

    if private:
        return False, "private"

    is_tattooer = bool(TATTOO_DOER.search(text)) or "tattoo" in lowered
    if not is_tattooer:
        return False, "no-tattoo-signal"
    if PIERCE.search(text) and not TATTOO_DOER.search(text) and "tattoo" not in lowered:
        return False, "piercer-only"
    if BRAND_NAMES.search(text) or SUPPLY.search(text):
        return False, "supply/brand"
    if CONVENTION.search(text):
        return False, "convention/event"
    if followers > 60_000 and (
        SUPPLY.search(text) or "official" in lowered or "products" in lowered
    ):
        return False, "brand-account"
    if SHOP_ACCOUNT.search(text):
        return False, "shop-account"

    has_person = bool(TATTOO_DOER.search(text))
    has_booking = bool(BOOK.search(text))
    has_link = bool(url)
    if has_person and (has_booking or has_link):
        return True, "artist+booking"
    if has_booking or has_link:
        return True, "bookable-signal"
    return True, "tattoo-artist(weak)"
