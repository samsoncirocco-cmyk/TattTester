"""Tests for the pure parsing/inference functions in scrape_artists.py."""

from execution.scrape_artists import (
    extract_instagram_handles,
    find_person_links,
    find_roster_links,
    extract_images,
    infer_styles,
    infer_tags,
    handle_to_display_name,
    looks_like_shop_account,
    normalize_dataset,
)

ROSTER_HTML = """
<html><body>
  <nav><a href="/artists">Our Artists</a><a href="/booking">Book</a></nav>
  <section>
    <h2>Felix Ramirez</h2>
    <a href="https://www.instagram.com/felix.ramirez.ink/">Felix Ramirez</a>
    <img src="/images/portfolio/felix-1.jpg">
    <img src="/images/site-logo.png">
    <img src="https://cdn.example.com/work/sleeve.webp">
  </section>
  <a href="https://instagram.com/p/Cxyz123/">a post</a>
  <a href="https://instagram.com/explore/">explore</a>
  <a href="https://instagram.com/goldenrule_tattoo">shop account</a>
  <a href="https://other-shop.com/artists">competitor</a>
</body></html>
"""


class TestExtractInstagramHandles:
    def test_finds_account_handles_only(self):
        handles = extract_instagram_handles(ROSTER_HTML)
        assert "felix.ramirez.ink" in handles
        assert "goldenrule_tattoo" in handles
        # content paths are not accounts
        assert "p" not in handles
        assert "explore" not in handles
        assert "popular" not in extract_instagram_handles(
            '<a href="https://www.instagram.com/popular/finelinetattoo/">tag</a>'
        )

    def test_dedupes_and_lowercases(self):
        html = (
            '<a href="https://instagram.com/InkMaster99">x</a>'
            '<a href="http://www.instagram.com/inkmaster99/">y</a>'
        )
        assert extract_instagram_handles(html) == ["inkmaster99"]

    def test_empty_page(self):
        assert extract_instagram_handles("<html></html>") == []


class TestFindRosterLinks:
    def test_same_site_roster_links_only(self):
        links = find_roster_links(ROSTER_HTML, "https://goldenrule.com/")
        assert "https://goldenrule.com/artists" in links
        assert all("other-shop.com" not in l for l in links)
        assert all("/booking" not in l for l in links)

    def test_www_and_bare_host_are_same_site(self):
        html = '<a href="https://www.shop.com/team">Team</a>'
        assert find_roster_links(html, "https://shop.com/") == [
            "https://www.shop.com/team"
        ]


class TestFindPersonLinks:
    ROSTER = """
    <html><body>
      <a href="/hayden/">Hayden Blackshaw</a>
      <a href="/honest-bob/">Honest Bob Gibson</a>
      <a href="/artists/">Artists</a>
      <a href="/booking/">Book Now</a>
      <a href="https://giftup.app/order">Purchase Gift Cards</a>
      <a href="https://www.hellowildern.com/">Wildern</a>
      <a href="/directions/">Get Directions</a>
    </body></html>
    """

    def test_person_links_from_roster(self):
        found = find_person_links(self.ROSTER, "https://goldenrule.com/artists/")
        names = [n for n, _ in found]
        assert "Hayden Blackshaw" in names
        assert "Honest Bob Gibson" in names
        # nav, external, and utility links excluded
        assert "Artists" not in names
        assert "Purchase Gift Cards" not in names
        assert "Wildern" not in names
        assert "Get Directions" not in names

    def test_urls_absolutized_same_site(self):
        found = dict(find_person_links(self.ROSTER, "https://goldenrule.com/artists/"))
        assert found["Hayden Blackshaw"] == "https://goldenrule.com/hayden/"


class TestExtractImages:
    def test_filters_logos_and_absolutizes(self):
        images = extract_images(ROSTER_HTML, "https://goldenrule.com/artists")
        assert "https://goldenrule.com/images/portfolio/felix-1.jpg" in images
        assert "https://cdn.example.com/work/sleeve.webp" in images
        assert all("logo" not in i for i in images)

    def test_skips_data_uris_and_svg(self):
        html = '<img src="data:image/png;base64,xx"><img src="/art.svg">'
        assert extract_images(html, "https://x.com") == []


class TestInference:
    def test_infer_styles(self):
        text = "Specializing in American Traditional and fine line work"
        styles = infer_styles(text)
        assert "Traditional" in styles
        assert "Fine Line" in styles
        assert "Watercolor" not in styles

    def test_infer_tags(self):
        assert "walk-ins" in infer_tags("Walk-ins welcome every day!")
        assert infer_tags("nothing relevant") == []

    def test_handle_to_display_name(self):
        assert handle_to_display_name("felix_young.ink") == "Felix Young Ink"

    def test_clean_person_name(self):
        from execution.scrape_artists import clean_person_name
        assert clean_person_name("Hayden Blackshaw") == "Hayden Blackshaw"
        assert clean_person_name("MIKEY") == "Mikey"
        assert clean_person_name("View Portfolio") is None
        assert clean_person_name("VIEW PORTFOLIO") is None
        assert clean_person_name("@felix") is None
        assert clean_person_name("Follow on Instagram") is None
        assert clean_person_name("") is None

    def test_shop_account_detection(self):
        assert looks_like_shop_account("goldenrule_tattoo", "Golden Rule Tattoo")
        assert not looks_like_shop_account("felix.ramirez.ink", "Golden Rule Tattoo")
        # generic words alone don't make it a shop account
        assert not looks_like_shop_account("tattoo_felix", "Golden Rule Tattoo")


class TestNormalizeDataset:
    RAW = [{
        "shopName": "Golden Rule Tattoo",
        "city": "Phoenix",
        "state": "AZ",
        "lat": 33.45,
        "lng": -112.07,
        "rating": 4.8,
        "reviewCount": 312,
        "artists": [
            {
                "instagram": "felix.ramirez.ink",
                "name": "Felix Ramirez",
                "portfolioImages": ["https://cdn.example.com/1.jpg"],
                "page_text": "Felix does realism and black and grey work",
                "source_pages": ["https://goldenrule.com/artists/felix"],
            },
            {
                "instagram": "no.name.artist",
                "name": None,
                "portfolioImages": [],
                "page_text": "",
                "source_pages": [],
            },
        ],
    }]

    def test_importer_shape(self):
        data = normalize_dataset(self.RAW)
        assert set(data.keys()) == {"artists", "cities", "styles"}
        assert data["cities"] == ["Phoenix, AZ"]
        artist = data["artists"][0]
        assert artist["id"] == "artist_felix.ramirez.ink"
        assert artist["instagram"] == "@felix.ramirez.ink"
        assert artist["coordinates"] == {"lat": 33.45, "lng": -112.07}
        assert "Realism" in artist["styles"]
        assert "Black & Grey" in artist["styles"]

    def test_honest_nulls_not_fabricated(self):
        artist = normalize_dataset(self.RAW)["artists"][0]
        assert artist["hourlyRate"] is None
        assert artist["yearsExperience"] is None
        assert "shop-rating" in artist["tags"]

    def test_fallback_name_from_handle(self):
        artists = normalize_dataset(self.RAW)["artists"]
        assert artists[1]["name"] == "No Name Artist"

    def test_dedupes_across_shops(self):
        raw = self.RAW + [dict(self.RAW[0], shopName="Second Shop")]
        data = normalize_dataset(raw)
        assert len(data["artists"]) == 2
