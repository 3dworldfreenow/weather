import pytest

from weather_app import create_app, services


@pytest.fixture(autouse=True)
def clear_cache():
    services.cache.clear()
    yield
    services.cache.clear()


@pytest.fixture
def client():
    return create_app({"TESTING": True}).test_client()


def test_weather_globe_home(client):
    html = client.get("/").get_data(as_text=True)
    assert 'id="wx-globe"' in html and "js/globe.js" in html
    for item in ('data-map="satellite"', 'data-map="radar"', 'data-map="rain"', 'data-map="wind"', 'data-map="temp"',
                 'data-map="humidity"', 'data-map="pressure"', 'data-overlay="windanim"', 'id="wx-slider"'):
        assert item in html
    assert "tab-news" not in html  # no news or El Niño panels on the globe


def test_index_page(client):
    resp = client.get("/el-nino/")
    assert resp.status_code == 200
    html = resp.get_data(as_text=True)
    assert 'id="map"' in html and 'id="globe"' in html
    assert 'id="sheet"' in html and 'id="tab-impacts"' in html
    assert "js/app.js" in html


def test_static_assets(client):
    assert client.get("/static/js/app.js").status_code == 200
    assert client.get("/static/css/style.css").status_code == 200


def test_health(client):
    assert client.get("/healthz").get_json() == {"status": "ok"}


@pytest.mark.parametrize("path", ["/api/weather?lat=1&lon=1", "/api/search?q=Delhi",
                                  "/api/grid?layer=wind", "/api/radar", "/api/events"])
def test_removed_weather_endpoints(client, path):
    assert client.get(path).status_code == 404


def test_upstream_failure_returns_502(client, monkeypatch):
    def boom(url):
        raise services.UpstreamError("down")
    monkeypatch.setattr(services, "_get_text", boom)
    resp = client.get("/api/enso")
    assert resp.status_code == 502
    assert "error" in resp.get_json()


def test_rate_limit_returns_friendly_503(client, monkeypatch):
    def limited(url):
        raise services.UpstreamError("429", status=429, reason="Too many requests")
    monkeypatch.setattr(services, "_get_text", limited)
    resp = client.get("/api/enso")
    assert resp.status_code == 503
    assert "limit" in resp.get_json()["error"]


def test_provider_reason_is_shown(client, monkeypatch):
    def bad(url):
        raise services.UpstreamError("400", status=400, reason="Bad request")
    monkeypatch.setattr(services, "_get_text", bad)
    assert "Bad request" in client.get("/api/enso").get_json()["error"]


def test_get_text_reports_status(monkeypatch):
    class Resp:
        ok = False
        status_code = 429
    monkeypatch.setattr(services._session, "get", lambda *a, **k: Resp())
    with pytest.raises(services.UpstreamError) as info:
        services._get_text("https://example.com")
    assert info.value.rate_limited


def test_ttl_cache_expires(monkeypatch):
    cache = services.TTLCache()
    now = [100.0]
    monkeypatch.setattr(services.time, "monotonic", lambda: now[0])
    calls = []

    def factory():
        calls.append(1)
        return len(calls)

    assert cache.get_or_set("k", 10, factory) == 1
    assert cache.get_or_set("k", 10, factory) == 1
    now[0] += 11
    assert cache.get_or_set("k", 10, factory) == 2
