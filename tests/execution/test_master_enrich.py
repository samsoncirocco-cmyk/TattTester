import execution.master_enrich as me


def test_prepare_maps_artists_to_their_shop(tmp_path):
    master = {"shops": [{"place_id": "p1", "shopName": "Ink Co", "city": "Salinas", "state": "CA"}],
              "artists": [{"instagram": "@Jane.Doe", "shopName": "Ink Co", "city": "Salinas", "state": "CA"},
                          {"instagram": "nobody", "shopName": "Other", "city": "X", "state": "CA"},
                          {"instagram": None, "shopName": "Ink Co", "city": "Salinas", "state": "CA"}]}
    stats = me.prepare(master, tmp_path)
    crawl = me.load(tmp_path / "raw_shop_sites.json", {})
    assert crawl["gmaps:p1"]["instagram"] == ["jane.doe"]
    assert stats == {"shops": 1, "shopsWithArtists": 1, "handles": 1, "unmatchedArtists": 1}


def test_budget_and_output_parsing():
    assert me.allowed_now([0, 100, 4000], 180, 4100) == 179
    assert me.parse_enrich_output("requested=5 resolved=2\nrequested=1 resolved=1") == (6, 3, None)
    assert me.parse_enrich_output("Graph API error code=190 subcode=1")[2] == "190"
