import datetime as dt

import pytest

from weather_app import create_app, forecast, services


@pytest.fixture(autouse=True)
def clear_cache():
    services.cache.clear()
    yield
    services.cache.clear()


def hourly(n=72, start="2026-10-14T00:00"):
    t0 = dt.datetime.fromisoformat(start)
    return {
        "time": [(t0 + dt.timedelta(hours=i)).strftime("%Y-%m-%dT%H:%M") for i in range(n)],
        "temperature_2m": [20.04 + i for i in range(n)], "precipitation": [1.0] * n,
        "relative_humidity_2m": [60] * n, "pressure_msl": [1012.6] * n,
        "wind_speed_10m": [10.4] * n, "wind_direction_10m": [270] * n,
    }


def test_grid_covers_the_world():
    grid, points = forecast.grid_points()
    assert grid["nlat"] * grid["nlon"] == len(points)
    assert grid["lat0"] == 84 and points[-1][0] == -84 and grid["nlon"] == 60


def test_frames_start_at_the_last_3_hour_step():
    times = hourly()["time"]
    idx = forecast.frame_indices(times, dt.datetime(2026, 10, 14, 7, 40, tzinfo=dt.timezone.utc))
    assert times[idx[0]] == "2026-10-14T06:00" and len(idx) == forecast.FRAMES and idx[1] - idx[0] == 3


def test_series_sums_rain_over_each_step():
    s = forecast._series({"hourly": hourly()}, [6, 9])
    assert s["rain"] == [3.0, 3.0] and s["temp"] == [26.0, 29.0] and s["pressure"] == [1013, 1013]


def test_build_and_reuse(monkeypatch):
    calls = []

    def fake_get_json(url, params=None):
        n = len(params["latitude"].split(","))
        calls.append(n)
        return [{"hourly": hourly()} for _ in range(n)]

    monkeypatch.setattr(services, "_get_json", fake_get_json)
    monkeypatch.setattr(forecast.time, "sleep", lambda s: None)
    now = dt.datetime(2026, 10, 14, 7, 40, tzinfo=dt.timezone.utc)
    data = forecast.build_forecast(now)
    grid, points = forecast.grid_points()
    assert sum(calls) == len(points) + len(forecast.CITIES) and max(calls) <= forecast.BATCH
    assert data["times"][0] == "2026-10-14T06:00:00Z" and len(data["fields"]["temp"][0]) == len(points)
    assert len(data["cities"]) == len(forecast.CITIES) and data["cities"][0]["temp"][0] == 26.0

    assert forecast.get_forecast(data, now + dt.timedelta(hours=1)) is data  # recent: reused
    monkeypatch.setattr(services, "_get_json", lambda url, params=None: (_ for _ in ()).throw(services.UpstreamError("down")))
    assert forecast.get_forecast(data, now + dt.timedelta(hours=9)) is data  # refresh failed: keep old
    with pytest.raises(services.UpstreamError):
        forecast.get_forecast(None, now)


def test_api_forecast(monkeypatch):
    monkeypatch.setattr(forecast, "get_forecast", lambda: {"times": ["x"]})
    assert create_app({"TESTING": True}).test_client().get("/api/forecast").get_json() == {"times": ["x"]}
