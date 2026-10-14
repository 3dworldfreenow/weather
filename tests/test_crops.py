import datetime as dt

import pytest

from weather_app import create_app, crops, impacts, services


@pytest.fixture(autouse=True)
def clear_cache():
    services.cache.clear()
    yield
    services.cache.clear()


def test_regions_point_to_known_countries_and_crops():
    ids = [r["id"] for r in crops.REGIONS]
    assert len(ids) == len(set(ids))
    for r in crops.REGIONS:
        assert r["country"] in impacts.BY_SLUG
        assert r["crop"] in crops.CROPS
        assert r["outlook"] in crops.OUTLOOKS
        assert -90 <= r["lat"] <= 90 and -180 <= r["lon"] <= 180


def test_detect_crops():
    assert crops.detect_crops("El Niño to cut sugarcane and palm oil output") == ["sugar", "palm-oil"]
    assert crops.detect_crops("India's kharif rice and cotton sowing lags") == ["rice", "cotton"]
    assert crops.detect_crops("Ocean temperatures rise") == []


def test_parse_climatology_converts_to_mm_per_month():
    p = {m: 2.0 for m in crops.MONTHS}
    p["MAR"] = -999
    clim = crops.parse_climatology({"properties": {"parameter": {"PRECTOTCORR": p}}})
    assert clim[0] == 62.0 and clim[1] == 56.0 and clim[2] is None


def test_monthly_totals_keeps_only_complete_months():
    days = {}
    d = dt.date(2026, 7, 1)
    while d <= dt.date(2026, 9, 10):
        days[d.strftime("%Y%m%d")] = 1.0
        d += dt.timedelta(days=1)
    days["20260815"] = -999  # one missing day is fine
    rows = crops.monthly_totals({"properties": {"parameter": {"PRECTOTCORR": days}}})
    assert rows == [{"month": "2026-07", "rain": 31.0}, {"month": "2026-08", "rain": 30.0}]


def test_rain_summary():
    clim = [100.0] * 12
    recent = [{"month": f"2026-{m:02d}", "rain": 50.0} for m in range(1, 10)]
    s = crops.rain_summary(clim, recent)
    assert len(s["months"]) == 9 and s["months"][0]["pct"] == 50
    assert s["last3_pct"] == 50 and s["last3_label"] == "2026-07 to 2026-09"


def test_parse_fred_csv_and_summary():
    text = "observation_date,PSUGAISAUSDM\n1989-12-01,10\n2025-08-01,20\n2025-09-01,.\n2026-08-01,25.5\n"
    series = crops.parse_fred_csv(text)
    assert series == [["2025-08", 20.0], ["2026-08", 25.5]]
    assert crops.price_summary(series) == {"latest_month": "2026-08", "latest": 25.5, "change_12m_pct": 27.5}


def test_get_crops_reuses_fresh_data_and_keeps_old_values(monkeypatch):
    recent = {"built_at": dt.datetime.now(dt.timezone.utc).isoformat(), "prices": {"x": 1}, "rain": {}}
    assert crops.get_crops(recent) is recent

    def fail(*args, **kwargs):
        raise services.UpstreamError("down")
    monkeypatch.setattr(crops, "fetch_rain", fail)
    monkeypatch.setattr(crops, "fetch_price", lambda c: {"latest": 1.0} if c == "sugar" else fail())
    old = {"built_at": "2020-01-01T00:00:00+00:00", "prices": {"rice": {"latest": 9.0}},
           "rain": {"india-rice": {"last3_pct": 80}}}
    data = crops.get_crops(old)
    assert data["prices"] == {"sugar": {"latest": 1.0}, "rice": {"latest": 9.0}}
    assert data["rain"] == {"india-rice": {"last3_pct": 80}}

    monkeypatch.setattr(crops, "fetch_price", fail)
    with pytest.raises(services.UpstreamError):
        crops.get_crops(None)


def test_crops_page_and_api(monkeypatch):
    monkeypatch.setattr(crops, "fetch_price", lambda c: {"latest": 1.0})
    monkeypatch.setattr(crops, "fetch_rain", lambda r: {"last3_pct": 90, "months": []})
    monkeypatch.setattr(services, "_get_text", lambda url: (_ for _ in ()).throw(services.UpstreamError("offline")))
    client = create_app({"TESTING": True}).test_client()
    html = client.get("/crops/").get_data(as_text=True)
    assert "<h1>🌾 El Niño and crops</h1>" in html
    assert 'id="crop-table"' in html and 'data-region="india-rice"' in html
    assert "js/crops.js" in html

    assert client.get("/api/crops").get_json()["prices"]["sugar"] == {"latest": 1.0}
    assert client.get("/api/crops/rain?region=india-rice").get_json()["last3_pct"] == 90
    assert client.get("/api/crops/rain?region=nowhere").status_code == 400

    india = client.get("/impacts/india/").get_data(as_text=True)
    assert 'href="../../crops/#country=india&amp;crop=rice"' in india
