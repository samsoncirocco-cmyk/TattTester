import execution.master_enrich as me


def test_prepare_maps_artists_to_their_shop(tmp_path):
    master = {"shops": [{"place_id": "p1", "shopName": "Ink Co", "city": "Salinas", "state": "CA"}],
              "artists": [{"instagram": "@Jane.Doe", "shopName": "Ink Co", "city": "Salinas", "state": "CA"},
                          {"instagram": "nobody", "shopName": "Other", "city": "X", "state": "CA"},
                          {"instagram": None, "shopName": "Ink Co", "city": "Salinas", "state": "CA"}]}
    stats = me.prepare(master, tmp_path)
    crawl = me.load(tmp_path / "raw_shop_sites.json", {})
    assert crawl["gmaps:p1"]["instagram"] == ["jane.doe"]
    assert stats == {"shops": 1, "shopsWithArtists": 1, "handles": 1, "unmatchedArtists": 1, "rejectedShops": {}}


def test_budget_and_output_parsing():
    assert me.allowed_now([0, 100, 4000], 180, 4100) == 179
    assert me.parse_enrich_output("requested=5 resolved=2\nrequested=1 resolved=1") == (6, 3, None)
    assert me.parse_enrich_output("Graph API error code=190 subcode=1")[2] == "190"


def test_prepare_drops_non_tattoo_and_non_us_shops(tmp_path):
    master = {"shops": [
        {"place_id": "a", "shopName": "Ivory Rose Aesthetics/Shore Laser + Aesthetics", "city": "Pasadena", "state": "MD"},
        {"place_id": "g", "shopName": "House of GRIM", "city": "Fort Hamilton", "state": "NY",
         "address": "196 Parkdale Ave N, Hamilton, ON L8H 5X2, Canada", "website": "http://www.grimstudios.ca/"},
        {"place_id": "t", "shopName": "Black Hatchet Tattoo Co.", "city": "Meriden", "state": "CT"}],
        "artists": [{"instagram": "x", "shopName": "Black Hatchet Tattoo Co.", "city": "Meriden", "state": "CT"}]}
    stats = me.prepare(master, tmp_path)
    assert list(me.load(tmp_path / "raw_shops.json", {})) == ["gmaps:t"]
    assert stats["rejectedShops"] == {"non-tattoo-shop": 1, "non-us-shop": 1}
