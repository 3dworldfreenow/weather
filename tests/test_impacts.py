import json
from pathlib import Path

import pytest

from weather_app import create_app, impacts, services

GEO = json.loads((Path(__file__).resolve().parent.parent / "weather_app" / "static" / "data" / "countries.geojson").read_text())


@pytest.fixture(autouse=True)
def clear_cache():
    services.cache.clear()
    yield
    services.cache.clear()


def test_every_country_is_complete_and_unique():
    slugs = [c["slug"] for c in impacts.COUNTRIES]
    assert len(slugs) == len(set(slugs))
    for c in impacts.COUNTRIES:
        assert c["effect"] in impacts.EFFECTS
        assert c["summary"] and c["season"] and c["region"]
        assert -90 <= c["lat"] <= 90 and -180 <= c["lon"] <= 180
        if c["service"]:
            assert c["service"]["url"].startswith(("https://", "http://"))


def test_every_country_shape_exists_on_the_world_map():
    ids = {f["properties"]["id"] for f in GEO["features"]}
    names = {f["properties"]["name"] for f in GEO["features"]}
    for c in impacts.COUNTRIES:
        for i in c["map_ids"]:
            assert i in ids, f"{c['name']}: map id {i} missing"
        for n in c["map_names"]:
            assert n in names
    # Island nations too small for the map are drawn as points.
    assert [c["slug"] for c in impacts.COUNTRIES if not c["map_ids"] and not c["map_names"]] == ["kiribati"]


@pytest.mark.parametrize("text,themes", [
    ("El Niño drought hits rice harvest in Thailand", {"drought", "food"}),
    ("Floods and landslides in Peru as coastal El Niño strikes", {"floods"}),
    ("Dengue cases surge after El Niño rains", {"health"}),
    ("Coral bleaching spreads with El Niño marine heat", {"oceans"}),
    ("El Niño forecast: NOAA issues advisory", {"forecast"}),
    ("Kekeringan akibat El Nino ancam pertanian", {"drought", "food"}),
])
def test_classify_themes(text, themes):
    assert themes <= set(impacts.classify_themes(text))


@pytest.mark.parametrize("text,countries", [
    ("Indonesia and Malaysia brace for haze", {"indonesia", "malaysia"}),
    ("U.S. winter outlook: wetter California", {"united-states"}),
    ("Us farmers worry", set()),  # 'Us' alone is not the United States
    ("Kenya floods displace thousands", {"kenya"}),
])
def test_detect_countries(text, countries):
    assert set(impacts.detect_countries(text)) == countries


def test_public_data_is_json_serialisable_without_keywords():
    data = impacts.public_data()
    json.dumps(data)
    assert all("keywords" not in t for t in data["themes"])


def test_country_page_and_sitemap():
    client = create_app({"TESTING": True, "SITE_URL": "https://example.org/"}).test_client()
    page = client.get("/impacts/peru/")
    assert page.status_code == 200
    html = page.get_data(as_text=True)
    assert "<h1>El Niño impact on Peru</h1>" in html
    assert "SENAMHI" in html and "Ecuador" in html  # official service + related country
    assert '"@type": "BreadcrumbList"' in html
    assert client.get("/impacts/atlantis/").status_code == 404
    sitemap = client.get("/sitemap.xml").get_data(as_text=True)
    assert sitemap.count("<url>") == 1 + len(impacts.COUNTRIES)


def test_country_page_shows_cached_news_about_that_country():
    services.cache.set("news", {"articles": [
        {"title": "Peru braces for El Niño rains", "url": "https://n.example/1", "source": "n", "countries": ["peru"]},
        {"title": "Australia dry spring", "url": "https://n.example/2", "source": "n", "countries": ["australia"]},
    ]}, 60)
    html = create_app({"TESTING": True}).test_client().get("/impacts/peru/").get_data(as_text=True)
    assert "Peru braces for El Niño rains" in html
    assert "Australia dry spring" not in html
