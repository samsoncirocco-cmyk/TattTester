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
