import json
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))

import build_static  # noqa: E402
from weather_app import enso, news, satellites, services  # noqa: E402

from test_enso import ONI, WEEKLY  # noqa: E402


@pytest.fixture(autouse=True)
def offline(monkeypatch):
    services.cache.clear()
    monkeypatch.setattr(satellites, "_catalogue", lambda source: None)
    monkeypatch.setattr(services, "_get_text", lambda url: WEEKLY if url == enso.WEEKLY_URL else ONI)
    monkeypatch.setattr(news, "get_news", lambda: {"articles": [{"title": "El Niño", "url": "https://n.example/1", "source": "n.example",
                                                              "countries": ["india"]}],
                                               "videos": [], "sources": []})
    yield
    services.cache.clear()


def test_build_static_site(tmp_path):
    out = tmp_path / "site"
    build_static.build(out, "https://demo.example/weather")

    html = (out / "index.html").read_text()
    assert 'window.APP_CONFIG = {"static": true}' in html
    assert 'src="static/js/static-api.js"' in html
    assert '"/static/' not in html  # relative paths for /<repo>/ hosting
    assert (out / "static" / "js" / "app.js").exists()
    assert (out / ".nojekyll").exists()

    sats = json.loads((out / "data" / "satellites.json").read_text())
    for style in satellites.STYLES:
        layers = sats["styles"][style]["layers"]
        assert len(layers) == 5
        gibs = [l for l in layers if l["type"] == "wmts"]
        assert all("{time}" in l["url"] for l in gibs)  # browser fills in the time

    assert json.loads((out / "data" / "enso.json").read_text())["focus"]["id"] == "nino12"
    assert not (out / "data" / "events.json").exists()
    assert json.loads((out / "data" / "news.json").read_text())["articles"][0]["title"] == "El Niño"
    assert json.loads((out / "data" / "build.json").read_text())["failed"] == []

    # SEO: canonical URL, pre-rendered El Niño status and headline, search files
    assert '<link rel="canonical" href="https://demo.example/weather/">' in html
    assert "strengthening" in html  # El Niño headline pre-rendered
    assert ">El Niño</div>" in html  # news headline pre-rendered
    india = (out / "impacts" / "india" / "index.html").read_text()
    assert "<h1>El Niño impact on India</h1>" in india
    assert 'href="../../static/css/style.css"' in india
    assert '<link rel="canonical" href="https://demo.example/weather/impacts/india/">' in india
    assert "<loc>https://demo.example/weather/impacts/peru/</loc>" in (out / "sitemap.xml").read_text()
    assert 'content="noindex"' in (out / "404.html").read_text()
    assert "Sitemap: https://demo.example/weather/sitemap.xml" in (out / "robots.txt").read_text()
    assert "<loc>https://demo.example/weather/</loc>" in (out / "sitemap.xml").read_text()
    assert json.loads((out / "manifest.webmanifest").read_text())["name"] == "El Niño Tracker"
    assert 'href="static/img/apple-touch-icon.png"' in html


def test_build_survives_missing_optional_data(tmp_path, monkeypatch):
    def down(url):
        raise services.UpstreamError("down")
    monkeypatch.setattr(services, "_get_text", down)
    build_static.build(tmp_path / "site")
    assert not (tmp_path / "site" / "data" / "enso.json").exists()
    assert json.loads((tmp_path / "site" / "data" / "build.json").read_text())["failed"] == ["enso.json"]


def test_flask_page_is_not_static():
    from weather_app import create_app
    html = create_app({"TESTING": True}).test_client().get("/").get_data(as_text=True)
    assert 'window.APP_CONFIG = {"static": false}' in html
    assert "static-api.js" not in html
