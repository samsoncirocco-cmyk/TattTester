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
