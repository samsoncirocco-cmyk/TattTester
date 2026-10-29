import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "execution"))
import places_seed as ps  # noqa: E402


def test_to_raw_maps_places_shop():
    k, v = ps.to_raw({"place_id": "ChIJx", "shopName": "Ink", "city": "Stockton", "state": "CA",
                      "website": "https://ink.com", "lat": 1.0, "lng": 2.0})
    assert k == "gmaps:ChIJx" and v["placeId"] == "ChIJx" and v["lon"] == 2.0 and v["website"] == "https://ink.com"


def test_to_raw_instagram_website_becomes_handle():
    _, v = ps.to_raw({"place_id": "ChIJy", "shopName": "X", "website": "https://instagram.com/some.artist/"})
    assert v["website"] is None and v["instagram"] == "some.artist"


def test_cached_shops_filters_city(tmp_path):
    (tmp_path / "master.json").write_text('{"shops":[{"place_id":"a","city":"Salinas","state":"CA"},'
                                          '{"place_id":"b","city":"Salinas","state":"KS"}]}')
    assert [s["place_id"] for s in ps.cached_shops("Salinas", "CA", tmp_path)] == ["a"]


def test_seed_skips_non_tattoo_and_non_us_shops(tmp_path, monkeypatch):
    monkeypatch.setattr(ps, "cached_shops", lambda c, s: [
        {"place_id": "a", "shopName": "Luxe Brow Studio", "city": "Salinas", "state": "CA"},
        {"place_id": "b", "shopName": "Skin Candy Tattoo", "city": "Salinas", "state": "CA",
         "website": "http://www.skincandytattoo.ca/"},
        {"place_id": "c", "shopName": "Glow Spa", "city": "Salinas", "state": "CA", "types": ["spa"]},
        {"place_id": "d", "shopName": "Salinas Ink", "city": "Salinas", "state": "CA",
         "website": "https://linktr.ee/x", "address": "1 Main St, Salinas, CA 93901, USA"}])
    res = ps.seed(tmp_path, "Salinas", "CA", live=False, max_shops=10)
    assert list(ps.load(tmp_path / "raw_shops.json", {})) == ["gmaps:d"]
    assert res["rejected"] == {"non-tattoo-shop": 2, "non-us-shop": 1}
