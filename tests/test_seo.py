import json
import re
import sys
from pathlib import Path

import pytest

from weather_app import create_app, enso, seo, services

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))
import build_static  # noqa: E402

from test_enso import ONI, WEEKLY  # noqa: E402


@pytest.fixture(autouse=True)
def clear_cache():
    services.cache.clear()
    yield
    services.cache.clear()


def get_page(config=None):
    return create_app({"TESTING": True, **(config or {})}).test_client().get("/").get_data(as_text=True)


def json_ld(html):
    m = re.search(r'<script type="application/ld\+json">(.*?)</script>', html, re.S)
    return json.loads(m.group(1))


def test_meta_tags_and_canonical():
    html = get_page({"SITE_URL": "https://example.org/el-nino"})
    assert f"<title>{seo.TITLE.replace('&', '&amp;')}</title>" in html
    assert '<meta name="description"' in html
    assert '<link rel="canonical" href="https://example.org/el-nino/">' in html
    assert '<meta property="og:image" content="https://example.org/el-nino/static/img/og-image.png">' in html
    assert 'name="twitter:card" content="summary_large_image"' in html
    assert '<h1 class="brand">' in html
    assert '<link rel="manifest" href="manifest.webmanifest">' in html


def test_structured_data_has_app_faq_and_dataset():
    graph = json_ld(get_page())["@graph"]
    types = {node["@type"] for node in graph}
    assert {"WebSite", "WebApplication", "FAQPage", "Dataset"} <= types
    faq = next(n for n in graph if n["@type"] == "FAQPage")
    assert [q["name"] for q in faq["mainEntity"]] == [item["q"] for item in seo.FAQ]


def test_learn_panel_contains_every_faq_answer():
    html = get_page()
    for item in seo.FAQ:
        assert item["q"] in html
        assert item["a"].replace("'", "&#39;") in html


def test_page_prerenders_cached_enso_status_and_headlines():
    summary = enso.summarise(enso.parse_weekly(WEEKLY), enso.parse_oni(ONI))
    services.cache.set("enso", summary, 60)
    services.cache.set("news", {"articles": [{"title": "Monsoon watch: El Niño grows", "url": "https://x.example/a",
                                              "source": "x.example", "country": "India", "language": "English"}]}, 60)
    html = get_page()
    assert summary["headline"] in html
    assert "+0.6 °C" in html
    assert "Niño 1+2: +1.2 °C" in html
    assert "Monsoon watch: El Niño grows" in html
    assert json_ld(html)["@graph"][-1]["dateModified"] == summary["week"]


def test_page_without_data_still_renders():
    html = get_page()
    assert "Loading the latest El Niño status" in html


def test_robots_sitemap_manifest():
    client = create_app({"TESTING": True, "SITE_URL": "https://example.org/"}).test_client()
    robots = client.get("/robots.txt")
    assert robots.mimetype == "text/plain"
    assert "Sitemap: https://example.org/sitemap.xml" in robots.get_data(as_text=True)
    sitemap = client.get("/sitemap.xml").get_data(as_text=True)
    assert "<loc>https://example.org/</loc>" in sitemap
    manifest = client.get("/manifest.webmanifest").get_json(force=True)
    assert manifest["start_url"] == "./"
    assert {i["sizes"] for i in manifest["icons"]} == {"192x192", "512x512"}


def test_images_exist():
    img = Path(__file__).resolve().parent.parent / "weather_app" / "static" / "img"
    for name in ("og-image.png", "icon-192.png", "icon-512.png", "apple-touch-icon.png", "favicon-48.png"):
        assert (img / name).stat().st_size > 1000


@pytest.mark.parametrize("repo,expected", [
    ("3dworldfreenow/weather", "https://3dworldfreenow.github.io/weather/"),
    ("SomeOrg/SomeOrg.github.io", "https://someorg.github.io/"),
])
def test_default_site_url_from_github(monkeypatch, repo, expected):
    monkeypatch.delenv("SITE_URL", raising=False)
    monkeypatch.setenv("GITHUB_REPOSITORY", repo)
    assert build_static.default_site_url() == expected


def test_site_verification_meta_tags():
    html = get_page({"GOOGLE_SITE_VERIFICATION": "g-code", "BING_SITE_VERIFICATION": "b-code"})
    assert '<meta name="google-site-verification" content="g-code">' in html
    assert '<meta name="msvalidate.01" content="b-code">' in html
    assert "google-site-verification" not in get_page()
