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


@pytest.fixture
def fake_upstream(monkeypatch):
    """Replace HTTP calls with a function of (url, params) -> JSON."""
    calls = []

    def install(handler):
        def fake_get_json(url, params=None):
            calls.append((url, params))
            return handler(url, params or {})
        monkeypatch.setattr(services, "_get_json", fake_get_json)
        return calls

    return install


def test_index_page(client):
    resp = client.get("/")
    assert resp.status_code == 200
    assert b'id="map"' in resp.data
    assert b"js/app.js" in resp.data


def test_static_assets(client):
    assert client.get("/static/js/app.js").status_code == 200
    assert client.get("/static/css/style.css").status_code == 200


def test_health(client):
    assert client.get("/healthz").get_json() == {"status": "ok"}


def test_weather_validates_coordinates(client):
    assert client.get("/api/weather?lat=abc&lon=1").status_code == 400
    assert client.get("/api/weather?lat=95&lon=1").status_code == 400
    assert client.get("/api/weather?lat=10").status_code == 400


def test_weather_proxies_open_meteo_and_caches(client, fake_upstream):
    calls = fake_upstream(lambda url, params: {"latitude": params["latitude"], "current": {}})
    first = client.get("/api/weather?lat=28.6139&lon=77.209")
    second = client.get("/api/weather?lat=28.6139&lon=77.209")
    assert first.status_code == second.status_code == 200
    assert first.get_json()["latitude"] == 28.614
    assert len(calls) == 1
    assert calls[0][0] == services.FORECAST_URL
    assert calls[0][1]["timezone"] == "auto"


def test_upstream_failure_returns_502(client, monkeypatch):
    def boom(url, params=None):
        raise services.UpstreamError("down")
    monkeypatch.setattr(services, "_get_json", boom)
    resp = client.get("/api/weather?lat=1&lon=1")
    assert resp.status_code == 502
    assert "error" in resp.get_json()


def test_rate_limit_returns_friendly_503(client, monkeypatch):
    def limited(url, params=None):
        raise services.UpstreamError("429", status=429, reason="Minutely API request limit exceeded")
    monkeypatch.setattr(services, "_get_json", limited)
    resp = client.get("/api/weather?lat=1&lon=1")
    assert resp.status_code == 503
    assert "limit" in resp.get_json()["error"]


def test_provider_reason_is_shown(client, monkeypatch):
    def bad(url, params=None):
        raise services.UpstreamError("400", status=400, reason="Cannot initialize WeatherVariable")
    monkeypatch.setattr(services, "_get_json", bad)
    resp = client.get("/api/weather?lat=1&lon=1")
    assert resp.status_code == 502
    assert "Cannot initialize WeatherVariable" in resp.get_json()["error"]


def test_get_json_reports_status_and_reason(monkeypatch):
    class Resp:
        ok = False
        status_code = 429
        text = "{}"
        def json(self):
            return {"error": True, "reason": "Too many requests"}
    monkeypatch.setattr(services._session, "get", lambda *a, **k: Resp())
    with pytest.raises(services.UpstreamError) as info:
        services._get_json("https://example.com")
    assert info.value.rate_limited
    assert info.value.reason == "Too many requests"


def test_search(client, fake_upstream):
    fake_upstream(lambda url, params: {"results": [{
        "name": "Delhi", "admin1": "Delhi", "country": "India", "country_code": "IN",
        "latitude": 28.65, "longitude": 77.23, "population": 1,
    }]})
    data = client.get("/api/search?q=Delhi").get_json()
    assert data == {"results": [{
        "name": "Delhi", "admin1": "Delhi", "country": "India", "country_code": "IN",
        "lat": 28.65, "lon": 77.23,
    }]}


def test_search_short_query_skips_upstream(client, fake_upstream):
    calls = fake_upstream(lambda url, params: {"results": []})
    assert client.get("/api/search?q=a").get_json() == {"results": []}
    assert calls == []


def test_build_grid_points_mercator_spacing():
    lats, lons = services.build_grid_points(-60, -180, 60, 180, cols=8)
    assert len(lons) == 8
    assert lons[0] == pytest.approx(-157.5)
    assert lats[0] > lats[-1]  # north -> south
    assert lats == pytest.approx([-v for v in reversed(lats)])  # symmetric bbox
    merc = [services._lat_to_merc(v) for v in lats]
    steps = [a - b for a, b in zip(merc, merc[1:])]
    assert all(s == pytest.approx(steps[0]) for s in steps)


GRID_DEFAULTS = {
    "temperature_2m": 10.0, "wind_speed_10m": 5.0, "wind_direction_10m": 0.0,
    "precipitation": 0.0, "cloud_cover": 0.0, "relative_humidity_2m": 50.0,
    "pressure_msl": 1013.0,
}


def _grid_handler(overrides):
    def handler(url, params):
        n = len(params["latitude"].split(","))
        hours = params["forecast_hours"]
        hourly = {"time": [1_700_000_000 + 3600 * h for h in range(hours)]}
        for var in params["hourly"].split(","):
            hourly[var] = [overrides.get(var, GRID_DEFAULTS[var])] * hours
        return [{"hourly": dict(hourly)} for _ in range(n)]
    return handler


def test_grid_temperature(client, fake_upstream):
    calls = fake_upstream(_grid_handler({"temperature_2m": 21.5}))
    resp = client.get("/api/grid?layer=temperature&south=0&west=60&north=30&east=100")
    assert resp.status_code == 200
    data = resp.get_json()
    assert data["cols"] == services.GRID_COLS
    assert len(data["times"]) == services.GRID_FORECAST_HOURS // services.GRID_STEP_HOURS
    assert len(data["values"]) == len(data["times"])
    assert len(data["values"][0]) == data["rows"]
    assert len(data["values"][0][0]) == data["cols"]
    assert data["values"][0][0][0] == 21.5
    assert "fields" not in data
    assert set(calls[0][1]["hourly"].split(",")) == set(GRID_DEFAULTS)


def test_grid_layers_and_nearby_views_share_one_request(client, fake_upstream):
    calls = fake_upstream(_grid_handler({}))
    for layer in ("temperature", "wind", "clouds", "pressure"):
        assert client.get(f"/api/grid?layer={layer}&south=1&west=61&north=29&east=99").status_code == 200
    assert client.get("/api/grid?layer=humidity&south=2&west=62&north=28&east=98").status_code == 200
    assert len(calls) == 1


def test_grid_wind_vectors(client, fake_upstream):
    # Wind blowing *from* the west (270 deg) moves eastward: u > 0, v ~ 0.
    fake_upstream(_grid_handler({"wind_speed_10m": 20.0, "wind_direction_10m": 270.0}))
    data = client.get("/api/grid?layer=wind&south=0&west=0&north=10&east=10").get_json()
    assert data["u"][0][0][0] == pytest.approx(20.0)
    assert abs(data["v"][0][0][0]) < 1e-6
    assert data["values"][0][0][0] == 20.0


def test_grid_normalises_wrapped_longitudes(client, fake_upstream):
    calls = fake_upstream(_grid_handler({}))
    resp = client.get("/api/grid?layer=clouds&south=0&west=170&north=10&east=200")
    assert resp.status_code == 200
    lons = [float(v) for v in calls[0][1]["longitude"].split(",")]
    assert all(-180 <= v <= 180 for v in lons)
    bounds = resp.get_json()["bounds"]
    assert bounds["west"] <= 170 and bounds["east"] >= 200


@pytest.mark.parametrize("bbox", [
    (10.3, 70.2, 30.7, 95.9),
    (-80, -300, 80, 300),
    (0, -200, 10, -170),
    (50, 2.1, 51, 3.3),
])
def test_snap_bbox_contains_view_and_is_canonical(bbox):
    south, west, north, east = bbox
    s, w, n, e = services.snap_bbox(*bbox)
    assert -180 <= w < 180
    assert s <= max(south, -85) and n >= min(north, 85)
    if e - w < 360:
        assert any(w <= west + k <= east + k <= e for k in (-360, 0, 360))
    assert e - w <= 360


def test_grid_world_view_is_global(client, fake_upstream):
    fake_upstream(_grid_handler({}))
    data = client.get("/api/grid?layer=temperature&south=-80&west=-250&north=80&east=250").get_json()
    assert data["global"] is True
    assert (data["bounds"]["west"], data["bounds"]["east"]) == (-180, 180)


def test_grid_rejects_bad_input(client):
    assert client.get("/api/grid?layer=nope&south=0&west=0&north=1&east=1").status_code == 400
    assert client.get("/api/grid?layer=wind&south=5&west=0&north=1&east=1").status_code == 400


def test_radar(client, fake_upstream):
    fake_upstream(lambda url, params: {
        "host": "https://tilecache.rainviewer.com",
        "radar": {
            "past": [{"time": 1, "path": "/v2/radar/1"}, {"time": 2, "path": "/v2/radar/2"}],
            "nowcast": [{"time": 3, "path": "/v2/radar/nowcast_3"}],
        },
    })
    data = client.get("/api/radar").get_json()
    assert data["host"] == "https://tilecache.rainviewer.com"
    assert [f["nowcast"] for f in data["frames"]] == [False, False, True]


def test_events(client, fake_upstream):
    fake_upstream(lambda url, params: {"events": [
        {
            "id": "EONET_1", "title": "Typhoon Test",
            "categories": [{"id": "severeStorms"}],
            "sources": [{"url": "https://example.com/storm"}],
            "geometry": [
                {"date": "2026-10-09T00:00:00Z", "type": "Point", "coordinates": [130.0, 15.0],
                 "magnitudeValue": 90, "magnitudeUnit": "kts"},
                {"date": "2026-10-08T00:00:00Z", "type": "Point", "coordinates": [132.0, 14.0]},
            ],
        },
        {
            "id": "EONET_2", "title": "Wildfire",
            "categories": [{"id": "wildfires"}],
            "geometry": [{"date": "2026-10-09T00:00:00Z", "type": "Point", "coordinates": [-120.0, 38.0]}],
        },
        {"id": "EONET_3", "title": "Iceberg", "categories": [{"id": "seaLakeIce"}],
         "geometry": [{"type": "Point", "coordinates": [0, -70]}]},
    ]})
    events = client.get("/api/events").get_json()["events"]
    assert [e["type"] for e in events] == ["storm", "fire"]
    storm = events[0]
    assert (storm["lat"], storm["lon"]) == (15.0, 130.0)  # latest point
    assert storm["track"] == [[14.0, 132.0], [15.0, 130.0]]
    assert storm["magnitude"] == 90
    assert events[1]["track"] == []


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
