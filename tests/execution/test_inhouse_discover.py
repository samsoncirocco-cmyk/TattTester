import json
from pathlib import Path

import pytest

from execution.inhouse_fetch import PoliteFetcher, TransportResult
from execution.inhouse_parse import (
    apply_bookability,
    assemble_candidates,
    equivalent_apify_usd,
    factual_roster_bio,
    mentions_from_bio,
    parse_instagram_document,
    parse_search_html,
    parse_shop_html,
)
import execution.inhouse_discover as discovery


SEARCH_HTML = """
<html><body>
<a class="result__a" href="https://duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.instagram.com%2Fada.ink%2F&amp;rut=1">Ada Ink</a>
<a class="result__a" href="https://www.instagram.com/popular/finelinetattoo/">tag</a>
<a class="result__a" href="https://www.instagram.com/bea.ink">Bea</a>
</body></html>
"""

CHALLENGE_HTML = """
<html><body>
<div class="anomaly-modal__title">Please confirm you are human</div>
<a class="result__a" href="https://www.instagram.com/ada.ink/">Ada</a>
</body></html>
"""

PROFILE_HTML = """
<html><head>
<meta property="og:title" content="Ada Ink • Instagram">
<meta property="og:description" content="Fine line tattoo artist in Boise, ID. Books open.">
</head><body>1,234 Followers 40 posts
<a href="https://ada.example/book">book</a>
</body></html>
"""

SHELL_HTML = """
<html><head><title>Finelinetattoo • 50M reels on Instagram</title>
<meta property="og:description" content="">
</head><body>
<a href="https://www.instagram.com/popular/finelinetattoo/?hl=es">es</a>
</body></html>
"""

SHOP_HTML = """
<html><head>
<meta name="generator" content="Starfield Technologies; Go Daddy Website Builder 8.0.0000">
<title>Example Shop artists</title>
</head><body>
<a href="mailto:book@example-shop.test">email</a>
<a href="tel:+15125550199">call</a>
<a href="https://booksy.com/example-shop">book</a>
<script src="https://img1.wsimg.com/widgets/UX.js"></script>
<section>
  <h2>Ada Ink</h2>
  <a href="https://instagram.com/ada.ink">Ada Ink</a>
  <p>Fine line tattoo artist. Books open.</p>
</section>
<section>
  <h2>Bea Ink</h2>
  <a href="https://instagram.com/bea.ink">Bea Ink</a>
  <p>Traditional tattoo artist.</p>
</section>
</body></html>
"""

SHARED_CARD_HTML = """
<html><body>
<section>
  <a href="https://instagram.com/ada.ink">Ada Ink</a>
  <a href="https://instagram.com/bea.ink">Bea Ink</a>
  <p>Fine line and traditional, the whole crew.</p>
</section>
</body></html>
"""


def test_search_html_reads_profile_links_and_skips_the_tag_shell():
    parsed = parse_search_html(SEARCH_HTML)
    assert parsed["fetchStatus"] == "results"
    assert parsed["handles"] == ["ada.ink", "bea.ink"]


def test_challenge_page_is_a_stop_and_not_mined_for_handles():
    parsed = parse_search_html(CHALLENGE_HTML)
    assert parsed["fetchStatus"] == "challenge"
    assert parsed["handles"] == []


def test_instagram_login_redirect_is_not_a_profile():
    parsed = parse_instagram_document(
        "<html><title>Login</title></html>",
        "https://www.instagram.com/accounts/login/?next=https%3A%2F%2Fwww.instagram.com%2Fada.ink%2F&is_from_rle",
        200,
    )
    assert parsed["fetchStatus"] == "login-wall"
    assert parsed["bio"] == ""


def test_public_profile_document_keeps_only_visible_fields():
    parsed = parse_instagram_document(PROFILE_HTML, "https://www.instagram.com/ada.ink/", 200)
    assert parsed["fetchStatus"] == "ok"
    assert parsed["fullName"] == "Ada Ink"
    assert "Fine line" in parsed["bio"]
    assert parsed["followers"] == 1234
    assert parsed["postCount"] == 40
    assert parsed["url"] == "https://ada.example/book"


def test_hashtag_shell_has_no_owner_list():
    parsed = parse_instagram_document(
        SHELL_HTML, "https://www.instagram.com/popular/finelinetattoo/", 200
    )
    assert parsed["fetchStatus"] == "shell"
    assert parsed["linkedHandles"] == []


def test_shop_page_extracts_platform_contacts_and_isolated_cards():
    parsed = parse_shop_html(
        SHOP_HTML,
        "https://example-shop.test/artists",
        {"shopName": "Example Shop", "city": "Austin", "state": "TX"},
    )
    assert parsed["platform"] == "godaddy-website-builder"
    assert parsed["emails"] == ["book@example-shop.test"]
    assert parsed["phones"] == ["+15125550199"]
    assert parsed["bookingUrls"] == ["https://booksy.com/example-shop"]
    by_handle = {artist["handle"]: artist["cardText"] for artist in parsed["artists"]}
    assert "Fine line" in by_handle["ada.ink"]
    assert "Traditional" not in by_handle["ada.ink"]
    assert "Traditional" in by_handle["bea.ink"]
    assert "Fine line" not in by_handle["bea.ink"]


def test_shared_roster_block_does_not_assign_every_style_to_every_artist():
    parsed = parse_shop_html(SHARED_CARD_HTML, "https://example-shop.test/artists", {})
    for artist in parsed["artists"]:
        assert "whole crew" not in artist["cardText"]


def test_factual_bio_uses_only_observed_shop_fields():
    bio = factual_roster_bio("Ada Ink", "Example Shop", "Austin", "TX", "Fine line.")
    assert bio == "Ada Ink is a tattoo artist at Example Shop in Austin, TX. Fine line."


def test_mentions_skip_the_account_itself_and_email_domains():
    assert mentions_from_bio("Books open. Email ada@example.com and @bea.ink") == ["bea.ink"]


def test_assemble_skips_known_and_protected_artists():
    assembled = assemble_candidates(
        queue=[{"id": "artist_known", "ig": "@known.ink"}],
        reference={
            "artists": [
                {"id": "artist_claimed", "instagram": "@claimed.ink", "claimedByUid": "uid-1"},
                {"id": "artist_removed", "instagram": "@removed.ink", "removedAt": "2026-01-01"},
                {"id": "artist_self", "instagram": "@self.ink", "selfRegistered": True},
                {"id": "artist_down", "instagram": "@down.ink", "pendingTakedown": True},
                {"id": "artist_plain", "instagram": "@plain.ink", "city": "Austin", "state": "TX"},
            ]
        },
        search_rows={
            "q": {
                "fetchStatus": "results",
                "city": "Boise",
                "state": "ID",
                "handles": [
                    "ada.ink",
                    "known.ink",
                    "claimed.ink",
                    "removed.ink",
                    "self.ink",
                    "down.ink",
                    "plain.ink",
                ],
            }
        },
        site_rows={},
        mention_rows={"mentor.ink": ["ada.ink", "pupil.ink"]},
        profiles={},
    )
    handles = {row["handle"] for row in assembled["candidates"]}
    assert handles == {"ada.ink", "pupil.ink"}
    ada = next(row for row in assembled["candidates"] if row["handle"] == "ada.ink")
    assert ada["seedCity"] == "Boise"
    assert ada["seedState"] == "ID"
    assert "search" in ada["source"] and "mention" in ada["source"]
    assert assembled["skipped"]["known"] == 2
    assert assembled["skipped"]["protected"] == 4
    assert assembled["skipped"]["protectedReasons"]["claimed"] == 1


def test_bookability_uses_the_shared_classifier():
    assembled = assemble_candidates(
        queue=[{"id": "artist_seed", "ig": "@seed.ink"}],
        reference=None,
        search_rows={},
        site_rows={
            "https://example-shop.test/artists": {
                "fetchStatus": "ok",
                "shopName": "Example Shop",
                "city": "Austin",
                "state": "TX",
                "bookingUrls": [],
                "emails": [],
                "phones": [],
                "artists": [
                    {
                        "handle": "ada.ink",
                        "fullName": "Ada Ink",
                        "cardText": "Fine line. Books open.",
                    }
                ],
            }
        },
        mention_rows={},
        profiles={},
    )
    reviewed = apply_bookability(assembled["candidates"], assembled["profiles"])
    assert reviewed[0]["looksBookable"] is True
    assert reviewed[0]["followers"] is None
    assert "Fine line" in reviewed[0]["bioSnippet"]


def test_apify_equivalent_is_a_starting_price_not_a_bill():
    cost = equivalent_apify_usd(contact_pages=1000, fetched_pages=1000, tech_results=1000)
    assert cost["total"] == pytest.approx(2.00 + 2.28 + 10.00)


class Clock:
    def __init__(self):
        self.t = 0.0
        self.slept = []

    def now(self):
        return self.t

    def sleep(self, seconds):
        self.slept.append(seconds)
        self.t += seconds


def _fetcher(transport, **kwargs):
    clock = kwargs.pop("clock", None) or Clock()
    return PoliteFetcher(
        transport=transport,
        delay_s=2.5,
        max_requests=kwargs.pop("max_requests", 10),
        allow_disallowed_hosts=frozenset(kwargs.pop("allow", [])),
        sleep=clock.sleep,
        now=clock.now,
        robots_loader=kwargs.pop(
            "robots", lambda _origin: "User-agent: *\nAllow: /\n"
        ),
    ), clock


def test_fetcher_paces_and_does_not_send_cookies():
    seen = []

    def transport(url, headers):
        seen.append(headers)
        return TransportResult(200, {}, "<html>ok</html>", url)

    fetcher, clock = _fetcher(transport)
    assert fetcher.fetch("https://example-shop.test/a").fetch_status == "ok"
    assert fetcher.fetch("https://example-shop.test/b").fetch_status == "ok"
    assert clock.slept == [2.5]
    assert all("Cookie" not in headers for headers in seen)


def test_instagram_is_not_fetched_unless_the_operator_allows_the_host():
    def transport(url, headers):
        raise AssertionError(url)

    fetcher, _clock = _fetcher(
        transport,
        robots=lambda _origin: (_ for _ in ()).throw(AssertionError("robots")),
    )
    outcome = fetcher.fetch("https://www.instagram.com/ada.ink/")
    assert outcome.fetch_status == "robots-disallow"
    assert fetcher.requests_made == 0


def test_allowed_instagram_login_wall_stops_the_host():
    calls = []

    def transport(url, headers):
        calls.append(url)
        return TransportResult(
            200,
            {},
            "<html>login</html>",
            "https://www.instagram.com/accounts/login/?next=%2Fada.ink%2F&is_from_rle",
        )

    fetcher, _clock = _fetcher(transport, allow=["instagram.com"])
    first = fetcher.fetch("https://www.instagram.com/ada.ink/")
    second = fetcher.fetch("https://www.instagram.com/bea.ink/")
    assert first.fetch_status == "login-wall"
    assert second.fetch_status == "login-wall"
    assert calls == ["https://www.instagram.com/ada.ink/"]


def test_challenge_and_rate_limit_stop_the_host():
    def challenge(url, headers):
        return TransportResult(202, {}, CHALLENGE_HTML, url)

    fetcher, _clock = _fetcher(challenge)
    assert fetcher.fetch("https://html.duckduckgo.com/html/?q=one").fetch_status == "challenge"
    assert fetcher.fetch("https://html.duckduckgo.com/html/?q=two").fetch_status == "challenge"

    calls = []

    def limited(url, headers):
        calls.append(url)
        return TransportResult(429, {"retry-after": "30"}, "", url)

    fetcher, _clock = _fetcher(limited)
    assert fetcher.fetch("https://example-shop.test/a").fetch_status == "rate-limited"
    assert fetcher.fetch("https://example-shop.test/b").fetch_status == "rate-limited"
    assert len(calls) == 1


def test_unknown_robots_fails_closed():
    def transport(url, headers):
        raise AssertionError("should not fetch the page")

    fetcher, _clock = _fetcher(transport, robots=lambda _origin: None)
    assert fetcher.fetch("https://example-shop.test/artists").fetch_status == "robots-unknown"


def test_request_cap_is_enforced():
    calls = []

    def transport(url, headers):
        calls.append(url)
        return TransportResult(200, {}, "ok", url)

    fetcher, _clock = _fetcher(transport, max_requests=1)
    assert fetcher.fetch("https://example-shop.test/a").fetch_status == "ok"
    assert fetcher.fetch("https://example-shop.test/b").fetch_status == "request-cap"
    assert calls == ["https://example-shop.test/a"]


def write_queue(path: Path) -> None:
    path.write_text(json.dumps([{"id": "artist_seed", "ig": "@seed.ink"}]))


def test_dry_run_does_not_fetch_or_write(tmp_path, capsys):
    queue = tmp_path / "queue.json"
    write_queue(queue)
    out = tmp_path / "out"
    assert (
        discovery.main(
            [
                "--queue",
                str(queue),
                "--out",
                str(out),
                "--metro",
                "Austin,TX",
                "collect-search",
            ]
        )
        == 0
    )
    assert "DRY RUN" in capsys.readouterr().out
    assert not out.exists()


def test_saved_search_html_and_shop_html_filter_without_network(tmp_path, monkeypatch):
    queue = tmp_path / "queue.json"
    write_queue(queue)
    out = tmp_path / "out"
    search = tmp_path / "search.html"
    search.write_text(SEARCH_HTML)
    shop = tmp_path / "shop.html"
    shop.write_text(SHOP_HTML)
    assert (
        discovery.main(
            [
                "--queue",
                str(queue),
                "--out",
                str(out),
                "--metro",
                "Austin,TX",
                "collect-search",
                "--html-file",
                str(search),
            ]
        )
        == 0
    )
    assert (
        discovery.main(
            [
                "--queue",
                str(queue),
                "--out",
                str(out),
                "collect-sites",
                "--html-file",
                str(shop),
                "--shop-name",
                "Example Shop",
                "--city",
                "Austin",
                "--state",
                "TX",
                "--page-url",
                "https://example-shop.test/artists",
            ]
        )
        == 0
    )
    monkeypatch.setattr(
        discovery,
        "extract_style_evidence",
        lambda bios: [
            [{"style": "Fine Line", "match": "Fine line", "index": 0}]
            if "Fine line" in bio
            else []
            for bio in bios
        ],
    )
    assert discovery.main(["--queue", str(queue), "--out", str(out), "filter"]) == 0
    candidates = json.loads((out / "candidates.json").read_text())
    ada = next(row for row in candidates if row["handle"] == "ada.ink")
    assert ada["looksBookable"] is True
    assert ada["seedCity"] == "Austin"
    assert ada["seedState"] == "TX"
    assert "Fine Line" in ada["styles"]
    harvest = json.loads((out / "style-harvest.json").read_text())
    assert harvest["source"] == "inhouse-discovery"
    assert any(row["artistId"] == "artist_ada.ink" for row in harvest["artists"])
    skipped = json.loads((out / "dedupe-report.json").read_text())
    assert "protected" in skipped


def test_execute_stops_on_a_search_challenge_without_a_second_query(tmp_path, monkeypatch):
    queue = tmp_path / "queue.json"
    write_queue(queue)
    out = tmp_path / "out"
    calls = []

    def transport(url, headers):
        calls.append(url)
        assert "Cookie" not in headers
        if url.endswith("/robots.txt"):
            return TransportResult(200, {}, "User-agent: *\nAllow: /\n", url)
        return TransportResult(202, {}, CHALLENGE_HTML, url)

    monkeypatch.setattr(discovery, "urllib_transport", transport)
    assert (
        discovery.main(
            [
                "--queue",
                str(queue),
                "--out",
                str(out),
                "--execute",
                "--delay-seconds",
                "0",
                "--metro",
                "Austin,TX",
                "--metro",
                "Boise,ID",
                "collect-search",
            ]
        )
        == 0
    )
    raw = json.loads((out / "raw_search.json").read_text())
    assert len(raw) == 1
    assert next(iter(raw.values()))["fetchStatus"] == "challenge"
    assert sum("html.duckduckgo.com/html" in url for url in calls) == 1


def test_style_extractor_uses_the_canonical_vocabulary():
    evidence = discovery.extract_style_evidence(
        ["Fine line and neo-traditional tattoo artist. Not geometric."]
    )
    styles = [hit["style"] for hit in evidence[0]]
    assert "Fine Line" in styles
    assert "Neo-Traditional" in styles
    assert "Geometric" not in styles
