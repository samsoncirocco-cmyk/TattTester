import json

import pytest

import execution.discover_inhouse as inhouse

FIXTURES = inhouse.ROOT / "tests" / "fixtures" / "discovery_inhouse"


def test_normalize_handle_rejects_reserved_paths():
    assert inhouse.normalize_handle("https://www.instagram.com/InkByJess/?hl=en") == "inkbyjess"
    assert inhouse.normalize_handle("@omaha.trad") == "omaha.trad"
    assert inhouse.normalize_handle("https://instagram.com/p/abc123") is None
    assert inhouse.normalize_handle("explore") is None
    assert inhouse.normalize_handle("") is None


def test_parse_osm_elements_maps_tags_and_falls_back_to_state():
    shops = inhouse.parse_osm_elements([
        {"type": "node", "id": 1, "lat": 41.2, "lon": -96.0, "tags": {
            "name": "Salvaged Soul Tattoo", "shop": "tattoo", "addr:city": "Omaha",
            "contact:instagram": "salvagedsoultattoo", "website": "https://example-shop.com"}},
        {"type": "way", "id": 2, "center": {"lat": 1, "lon": 2}, "tags": {
            "name": "Ink Barn", "website": "https://www.instagram.com/inkbarn/"}},
        {"type": "node", "id": 3, "tags": {"shop": "tattoo"}},  # unnamed -> dropped
    ], "NE")
    assert set(shops) == {"osm:node/1", "osm:way/2"}
    assert shops["osm:node/1"]["instagram"] == "salvagedsoultattoo"
    assert shops["osm:node/1"]["state"] == "NE" and shops["osm:node/1"]["city"] == "Omaha"
    assert shops["osm:way/2"]["instagram"] == "inkbarn"
    assert shops["osm:way/2"]["lat"] == 1


def test_parse_site_extracts_contacts_handles_and_tech():
    html = """
    <meta name="generator" content="WordPress 6.5">
    <link href="/wp-content/x.css">
    <a href="https://instagram.com/inkbyjess">Jess</a>
    <a href="https://www.instagram.com/p/XYZ/">post</a>
    <a href="mailto:Book@Shop.com">mail</a> logo@2x.png
    <a href="tel:+1 (402) 555-0100">call</a>
    """
    facts = inhouse.parse_site(html)
    assert facts["instagram"] == ["inkbyjess"]
    assert facts["emails"] == ["book@shop.com"]
    assert facts["phones"] == ["+14025550100"]
    assert "wordpress" in facts["tech"] and "generator:WordPress 6.5" in facts["tech"]


def test_throttle_enforces_per_host_interval():
    clock = {"t": 0.0}
    slept = []
    throttle = inhouse.Throttle(2.0, clock=lambda: clock["t"],
                                sleep=lambda s: (slept.append(s), clock.__setitem__("t", clock["t"] + s)))
    throttle.wait("a.com")
    throttle.wait("a.com")
    throttle.wait("b.com")
    assert slept == [2.0]


def test_http_respects_robots_txt():
    class Resp:
        def __init__(self, body):
            self.body = body

        def __enter__(self):
            return self

        def __exit__(self, *a):
            return None

        def read(self, _n):
            return self.body

    calls = []

    def opener(request, timeout):
        calls.append(request.full_url)
        if request.full_url.endswith("/robots.txt"):
            return Resp(b"User-agent: *\nDisallow: /private\n")
        return Resp(b"<html>ok</html>")

    http = inhouse.Http(interval=0, opener=opener)
    assert http.get("https://shop.test/artists") == "<html>ok</html>"
    with pytest.raises(PermissionError):
        http.get("https://shop.test/private/x")
    assert calls.count("https://shop.test/robots.txt") == 1


def test_business_discovery_maps_to_discover_ig_profile_shape():
    profile = inhouse.profile_from_business_discovery({
        "username": "inkbyjess", "name": "Jess", "biography": "tattoo artist",
        "followers_count": 10, "media_count": 4, "website": "https://x.com"})
    assert set(profile) >= {"bio", "followers", "fullName", "url", "private", "postCount"}
    assert profile["postCount"] == 4 and profile["followers"] == 10


def test_meta_provider_treats_400_as_unresolvable(monkeypatch):
    import urllib.error

    class FakeHttp:
        def get(self, url, check_robots=False):
            assert "business_discovery.username(someone)" in urllib.parse.unquote(url)
            raise urllib.error.HTTPError(url, 400, "bad", {}, None)

    import urllib.parse
    assert inhouse.MetaProvider(FakeHttp(), "123", "tok").fetch("someone") is None


def _pipeline(tmp_path, reference=None, queue=None):
    out = tmp_path / "out"
    out.mkdir()
    (out / "raw_shops.json").write_text(json.dumps({
        "osm:node/1": {"name": "Salvaged Soul Tattoo", "city": "Omaha", "state": "NE",
                       "website": "https://shop.test", "instagram": "salvagedsoultattoo"}}))
    (out / "raw_shop_sites.json").write_text(json.dumps({
        "osm:node/1": {"instagram": ["salvagedsoultattoo", "claimedartist"], "emails": [], "phones": [],
                       "tech": [], "pages": ["/"], "errors": []}}))
    base = ["--out", str(out)]
    if reference:
        base += ["--reference", str(reference)]
    if queue:
        base += ["--queue", str(queue)]
    assert inhouse.main(base + ["enrich", "--provider", "fixture",
                                "--fixture", str(FIXTURES / "profiles.json")]) == 0
    assert inhouse.main(base + ["filter"]) == 0
    return out, {c["handle"]: c for c in json.loads((out / "candidates.json").read_text())}


def test_end_to_end_fixture_run_emits_importer_artifacts(tmp_path):
    out, by_handle = _pipeline(tmp_path)
    # mention expansion pulled in the shop's resident artists and the apprentice chain
    assert {"inkbyjess", "omaha.trad"} <= set(by_handle)
    jess = by_handle["inkbyjess"]
    assert jess["source"] == "mention" and jess["looksBookable"] is True
    assert "#omaha" in jess["seedFrom"].split(",")  # importer seed resolver reads this as Omaha
    assert jess["styles"] == ["blackwork", "fine line"]
    assert by_handle["salvagedsoultattoo"]["filterReason"] == "shop-account"
    # same keys discover_ig.py writes, so import-discovery-to-neo4j.mjs reads it unchanged
    for key in ("handle", "source", "seedFrom", "bioSnippet", "followers", "looksBookable", "filterReason"):
        assert key in jess
    profiles = json.loads((out / "profiles.json").read_text())
    assert profiles["inkbyjess"]["postCount"] == 220


def test_protected_and_known_artists_are_skipped(tmp_path):
    reference = tmp_path / "ref.json"
    reference.write_text(json.dumps({"artists": [
        {"id": "a1", "name": "Claimed Person", "instagram": "claimedartist", "city": "Omaha",
         "state": "NE", "claimed": True}]}))
    queue = tmp_path / "queue.json"
    queue.write_text(json.dumps([{"id": "a2", "ig": "@omaha.trad"}]))
    _, by_handle = _pipeline(tmp_path, reference=reference, queue=queue)
    assert "claimedartist" not in by_handle
    assert "omaha.trad" not in by_handle
    assert "inkbyjess" in by_handle


def test_module_never_imports_neo4j():
    source = (inhouse.ROOT / "execution" / "discover_inhouse.py").read_text()
    assert "neo4j" not in source.split('"""', 2)[2].lower().replace("import-discovery-to-neo4j", "")


def test_bbox_shops_infer_state_from_coordinates_or_mark_unknown():
    shops = inhouse.parse_osm_elements([
        {"type": "node", "id": 1, "lat": 41.26, "lon": -95.86, "tags": {"name": "Black Squirrel"}},
        {"type": "node", "id": 2, "lat": 41.25, "lon": -96.0, "tags": {"name": "Has Addr", "addr:state": "Nebraska", "addr:city": "Omaha"}},
        {"type": "node", "id": 3, "tags": {"name": "No Coords"}},
    ], None)
    assert shops["osm:node/1"]["state"] is None  # never the searched state
    assert shops["osm:node/2"]["state"] == "NE"

    class GeoHttp:
        def get(self, url, check_robots=False):
            assert "nominatim" in url
            return json.dumps({"address": {"country_code": "us", "ISO3166-2-lvl4": "US-IA",
                                           "city": "Council Bluffs"}})

    inhouse.fill_locations(GeoHttp(), shops)
    assert shops["osm:node/1"]["state"] == "IA" and shops["osm:node/1"]["stateSource"] == "geocode"
    assert shops["osm:node/1"]["city"] == "Council Bluffs"
    assert shops["osm:node/2"].get("stateSource") is None
    assert shops["osm:node/3"]["state"] is None and shops["osm:node/3"]["stateSource"] == "unknown"


def test_cache_from_another_provider_does_not_mask_real_api(tmp_path):
    profiles, misses = tmp_path / "profiles.json", tmp_path / "profile_misses.json"
    fixture = tmp_path / "fx.json"
    fixture.write_text(json.dumps({}))
    inhouse.enrich(inhouse.FixtureProvider(fixture), ["salvagedsouljason"], profiles, misses, 10)
    assert json.loads(misses.read_text())["salvagedsouljason"]["provider"] == "fixture"

    class Live:
        NAME = "meta"
        calls = []

        def fetch(self, handle):
            self.calls.append(handle)
            return {"bio": "tattoo artist", "followers": 1, "postCount": 1}

    live = Live()
    inhouse.enrich(live, ["salvagedsouljason"], profiles, misses, 10)
    assert live.calls == ["salvagedsouljason"]
    assert "salvagedsouljason" in json.loads(profiles.read_text())
    assert "salvagedsouljason" not in json.loads(misses.read_text())
    inhouse.enrich(live, ["salvagedsouljason"], profiles, misses, 10)  # same provider -> cached
    assert live.calls == ["salvagedsouljason"]


def test_meta_provider_url_braces_and_error_classification():
    import io
    import urllib.error
    import urllib.parse

    seen = {}

    def http_error(code, payload):
        return urllib.error.HTTPError("u", code, "x", {}, io.BytesIO(json.dumps(payload).encode()))

    class FakeHttp:
        def __init__(self, exc=None):
            self.exc = exc

        def get(self, url, check_robots=False):
            seen["url"] = url
            if self.exc:
                raise self.exc
            return json.dumps({"business_discovery": {"username": "x", "biography": "b",
                                                      "followers_count": 5, "media_count": 2}})

    assert inhouse.MetaProvider(FakeHttp(), "1", "SECRET").fetch("x")["followers"] == 5
    assert "business_discovery.username(x){username," in seen["url"]

    miss = inhouse.MetaProvider(FakeHttp(http_error(400, {"error": {"code": 110, "error_subcode": 2207013}})), "1", "SECRET")
    assert miss.fetch("kadestattoos") is None and "2207013" in miss.last_error

    for payload in ({"error": {"code": 190, "message": "expired"}}, {"error": {"code": 4}}):
        with pytest.raises(RuntimeError) as info:
            inhouse.MetaProvider(FakeHttp(http_error(400, payload)), "1", "SECRET").fetch("y")
        assert "SECRET" not in str(info.value)


def test_load_env_file_does_not_override(tmp_path, monkeypatch):
    env = tmp_path / ".env.ig-graph"
    env.write_text("IG_GRAPH_USER_ID=123\nexport IG_GRAPH_TOKEN='abc'\nOTHER=1\n")
    monkeypatch.delenv("IG_GRAPH_TOKEN", raising=False)
    monkeypatch.setenv("IG_GRAPH_USER_ID", "keep")
    monkeypatch.delenv("OTHER", raising=False)
    inhouse.load_env_file(env, ("IG_GRAPH_USER_ID", "IG_GRAPH_TOKEN"))
    import os
    assert os.environ["IG_GRAPH_TOKEN"] == "abc" and os.environ["IG_GRAPH_USER_ID"] == "keep"
    assert "OTHER" not in os.environ


# --- shop accounts, shop-linked bookability, state conflicts (live Omaha cases) ---

BLACK_SQUIRREL = {"bio": "@mdinovo  @ugghhhkylie @stabbed.by.kai   To book: ⤵️", "fullName": "Black Squirrel Tattoo",
                  "followers": 1999, "postCount": 276, "url": "https://blacksquirreltattoo.com", "private": False}
KYLIE = {"bio": "☆ the internet is cursed and so is this account ☆ ✦ Black & Grey Luvr ✦ Omaha, NE | Books open",
         "fullName": "Kylie Ann 🫐🦷 TATS", "followers": 1608, "postCount": 86, "url": "", "private": False}
MATT = {"bio": "Black Squirrel Tattoo Iowa Owner/Artist ▶️Booking: visit website below", "fullName": "Matt Dinovo",
        "followers": 2430, "postCount": 265, "url": "https://blacksquirreltattoo.com", "private": False}


def test_shop_accounts_are_detected_but_staff_are_not():
    names = ["Black Squirrel Tattoo", "Ink Link Tattoo", "Salvaged Soul Tattoo"]
    assert inhouse.is_shop_account("blacksquirreltattooiowa", BLACK_SQUIRREL, names, set()) == "handle-matches-shop"
    assert inhouse.is_shop_account("inklinktattooomaha", {"bio": "Call for availability", "fullName": "Ink Link Omaha"},
                                   names, set())
    assert inhouse.is_shop_account("salvagedsoultattoo", {}, [], {"salvagedsoultattoo"}) == "osm-shop-handle"
    # an artist whose handle carries the shop name, and an owner/artist, stay people
    assert inhouse.is_shop_account("salvagedsouljason", {"bio": "", "fullName": "Jason Contreras"}, names, set()) is None
    assert inhouse.is_shop_account("mdinovo", MATT, names, set()) is None
    assert inhouse.is_shop_account("someone", {"bio": "@a @b @c guest artists", "fullName": "Ink Den Tattoo"}, [], set())


def test_shop_linked_artist_with_tats_and_books_passes_but_junk_does_not():
    assert inhouse.looks_bookable(KYLIE)[0] is False  # shared gate alone still rejects
    verdict, reason = inhouse.assess_bookable(KYLIE, shop_linked=True)
    assert verdict and reason.startswith("shop-linked:")
    assert inhouse.assess_bookable(KYLIE, shop_linked=False) == (False, "no-tattoo-signal")
    junk = [
        {"bio": "", "fullName": "Jason Contreras"},
        {"bio": "dog mom | coffee | Omaha, NE", "fullName": "Sam"},
        {"bio": "Black & grey photography | book a shoot", "fullName": "Lens Co"},
        {"bio": "Hair + nails, books open!", "fullName": "Glam Tats Salon"},
        {"bio": "Black & Grey Luvr | books open", "fullName": "Private", "private": True},
    ]
    for profile in junk:
        assert inhouse.assess_bookable(profile, shop_linked=True)[0] is False, profile


def test_state_signals_from_handles_bios_and_codes():
    assert inhouse.state_signals(handles=["blacksquirreltattooiowa"]) == {"IA"}
    assert inhouse.state_signals(handles=["arkansasink"]) == {"AR"}
    assert inhouse.state_signals("Omaha, NE | Books") == {"NE"}
    assert inhouse.state_signals("Council Bluffs, Iowa") == {"IA"}
    assert inhouse.state_signals("no location here", handles=["inkbyjess"]) == set()


def _conflict_fixture():
    shops = {"osm:way/1": {"name": "Black Squirrel Tattoo", "city": "Omaha", "state": "NE",
                           "website": "https://blacksquirreltattoo.com/", "lat": 41.24, "lon": -95.98}}
    crawled = {"osm:way/1": {"instagram": ["blacksquirreltattooiowa", "mdinovo"]}}
    profiles = {"blacksquirreltattooiowa": BLACK_SQUIRREL, "mdinovo": MATT}
    return shops, crawled, profiles


class _Geo:
    def __init__(self, state, city):
        self.answer = {"address": {"country_code": "us", "ISO3166-2-lvl4": f"US-{state}", "city": city}} if state else {}
        self.calls = 0

    def get(self, url, check_robots=False):
        self.calls += 1
        if not self.answer:
            raise TimeoutError("nominatim down")
        return json.dumps(self.answer)


@pytest.mark.parametrize("geo,resolution,state,city", [
    (("IA", "Council Bluffs"), "geocode-agrees-with-signal", "IA", "Council Bluffs"),
    (("NE", "Omaha"), "geocode-agrees-with-osm", "NE", "Omaha"),
    ((None, None), "unresolved", "NE", "Omaha"),
])
def test_state_conflicts_are_flagged_and_verified_not_silently_picked(geo, resolution, state, city):
    shops, crawled, profiles = _conflict_fixture()
    http = _Geo(*geo)
    stats = inhouse.resolve_locations(http, shops, crawled, profiles)
    shop = shops["osm:way/1"]
    assert http.calls == 1 and stats[resolution] == 1
    conflict = shop["locationConflict"]
    assert conflict["osmState"] == "NE" and conflict["signals"] == ["IA"]
    assert conflict["resolution"] == resolution
    assert (shop["state"], shop["city"]) == (state, city)
    found = inhouse.collect_sources(shops, crawled, profiles)
    cands, _ = inhouse.build_candidates(found, profiles, existing=set(), reference_names=set(),
                                        protected=set(), shops=shops)
    by = {c["handle"]: c for c in cands}
    assert by["blacksquirreltattooiowa"]["isShop"] and not by["blacksquirreltattooiowa"]["looksBookable"]
    matt = by["mdinovo"]
    assert matt["shopName"] == "Black Squirrel Tattoo" and matt["locationConflict"]["resolution"] == resolution
    tokens = matt["seedFrom"].split(",")
    if resolution == "unresolved":
        assert not any(t.startswith("#") for t in tokens)  # importer holds it instead of guessing
    else:
        assert f"#{city.lower()}" in tokens
    if resolution == "unresolved":
        assert matt["seedShopCity"] is None and matt["seedShopState"] is None
    else:
        assert (matt["seedShopCity"], matt["seedShopState"]) == (city, state)


def test_consistent_shop_is_not_geocoded():
    shops = {"osm:node/2": {"name": "Ink Link Tattoo", "city": "Omaha", "state": "NE", "lat": 1, "lon": 2}}
    http = _Geo("IA", "x")
    inhouse.resolve_locations(http, shops, {}, {})
    assert http.calls == 0 and "locationConflict" not in shops["osm:node/2"]


@pytest.mark.parametrize("shop,why", [
    ({"name": "Ivory Rose Aesthetics/Shore Laser + Aesthetics"}, "non-tattoo-shop"),
    ({"name": "Removery Tattoo Removal"}, "non-tattoo-shop"),
    ({"name": "Emerald Empire Tattoo & Tattoo Laser Removal"}, None),
    ({"name": "Ink & Lash Bar"}, None),
    ({"name": "House of GRIM", "website": "http://www.grimstudios.ca/"}, "non-us-shop"),
    ({"name": "Seraphim Studio", "website": "http://linktr.ee/x", "address": "1 St, San Antonio, TX 78240, USA"}, None),
    ({"name": "Black Ash Tattoo", "address": "Niagara Falls, ON L2G 4P6, Canada"}, "non-us-shop"),
    ({"name": "Stockholm Ink Bash", "lat": 59.32, "lon": 18.05}, "non-us-shop"),
    ({"name": "Rayon Noir", "address": "12 Rue Crozatier, 75012 Paris, France"}, "non-us-shop"),
    ({"name": "LES Tattoos", "lat": 38.57, "lon": -121.5, "address": "2223 10th St, Sacramento, CA 95811, USA"}, None),
    ({"name": "Aloha Ink", "lat": 21.3, "lon": -157.8}, None),
    ({"name": "Uptown Ink Tattoo", "address": "3265 Main St, Mexico, NY 13114, USA", "website": "https://x.de"}, None),
    ({"name": "Isla Tattoo", "address": "Calle 1, San Juan, 00901, Puerto Rico", "lat": 18.46, "lon": -66.1}, None),
])
def test_seed_shop_reject(shop, why):
    assert inhouse.seed_shop_reject(shop) == why


def test_build_candidates_skips_artists_only_seen_at_rejected_shops():
    shops = {"gmaps:a": {"name": "Ivory Rose Aesthetics", "city": "Pasadena", "state": "MD"},
             "gmaps:g": {"name": "House of GRIM", "city": "Fort Hamilton", "state": "NY",
                         "website": "http://www.grimstudios.ca/"}}
    found = {"pmu": {"sources": {"shop-site"}, "seedFrom": {"shop:gmaps:a", "#pasadena"}, "shops": {"gmaps:a"}},
             "grim": {"sources": {"shop-site"}, "seedFrom": {"shop:gmaps:g"}, "shops": {"gmaps:g"}}}
    profiles = {h: {"bio": "tattoo artist, books open", "followers": 900, "postCount": 50} for h in found}
    cands, skipped = inhouse.build_candidates(found, profiles, existing=set(), reference_names=set(),
                                              protected=set(), shops=shops)
    assert cands == [] and skipped["non-tattoo-shop"] == 1 and skipped["non-us-shop"] == 1
