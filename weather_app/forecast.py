"""Global forecast maps (temperature, precipitation, wind, humidity, pressure) and
city temperatures for the weather globe.

Source: Open-Meteo forecast API (free, no key; https://open-meteo.com/, CC BY 4.0).
A coarse global grid is fetched in a few batched requests and refreshed every few
hours (the static build reuses the published copy in between), which keeps us well
inside Open-Meteo's free daily allowance. The browser draws the colour maps and the
wind animation from this grid.
"""

from __future__ import annotations

import datetime as dt
import logging
import time
from typing import Any

from . import services

log = logging.getLogger(__name__)

FORECAST_URL = "https://api.open-meteo.com/v1/forecast"
ATTRIBUTION = 'Forecast: <a href="https://open-meteo.com/">Open-Meteo</a> (CC BY 4.0)'
GRID_STEP = 6.0          # degrees
GRID_MAX_LAT = 84.0
STEP_HOURS = 3           # time between forecast frames
FRAMES = 17              # 48 hours ahead
BATCH = 50               # locations per request
TIMEOUT = 60             # seconds; multi-location requests take a while
REFRESH_HOURS = 6        # reuse the previous data for this long
VARIABLES = "temperature_2m,precipitation,relative_humidity_2m,pressure_msl,wind_speed_10m,wind_direction_10m"

# Major cities for temperature labels: (name, lat, lon)
CITIES = [
    ("New Delhi", 28.61, 77.21), ("Mumbai", 19.08, 72.88), ("Kolkata", 22.57, 88.36), ("Chennai", 13.08, 80.27),
    ("Bengaluru", 12.97, 77.59), ("Hyderabad", 17.39, 78.49), ("Ahmedabad", 23.02, 72.57), ("Jaipur", 26.91, 75.79),
    ("Lucknow", 26.85, 80.95), ("Patna", 25.59, 85.14), ("Guwahati", 26.14, 91.74), ("Karachi", 24.86, 67.01),
    ("Lahore", 31.55, 74.34), ("Islamabad", 33.68, 73.05), ("Kabul", 34.56, 69.21), ("Dhaka", 23.81, 90.41),
    ("Kathmandu", 27.72, 85.32), ("Colombo", 6.93, 79.86), ("Yangon", 16.84, 96.17), ("Bangkok", 13.76, 100.5),
    ("Hanoi", 21.03, 105.85), ("Ho Chi Minh City", 10.82, 106.63), ("Phnom Penh", 11.56, 104.93),
    ("Kuala Lumpur", 3.14, 101.69), ("Singapore", 1.35, 103.82), ("Jakarta", -6.21, 106.85), ("Manila", 14.6, 120.98),
    ("Beijing", 39.9, 116.41), ("Shanghai", 31.23, 121.47), ("Guangzhou", 23.13, 113.26), ("Chengdu", 30.57, 104.07),
    ("Hong Kong", 22.32, 114.17), ("Taipei", 25.03, 121.57), ("Seoul", 37.57, 126.98), ("Tokyo", 35.68, 139.69),
    ("Osaka", 34.69, 135.5), ("Ulaanbaatar", 47.89, 106.91), ("Almaty", 43.24, 76.89), ("Tashkent", 41.3, 69.24),
    ("Tehran", 35.69, 51.39), ("Baghdad", 33.31, 44.36), ("Riyadh", 24.71, 46.68), ("Dubai", 25.2, 55.27),
    ("Muscat", 23.59, 58.41), ("Doha", 25.29, 51.53), ("Istanbul", 41.01, 28.98), ("Ankara", 39.93, 32.86),
    ("Cairo", 30.04, 31.24), ("Jerusalem", 31.77, 35.21), ("Moscow", 55.76, 37.62), ("Saint Petersburg", 59.93, 30.36),
    ("Novosibirsk", 55.01, 82.93), ("Yakutsk", 62.03, 129.73), ("Kyiv", 50.45, 30.52), ("Warsaw", 52.23, 21.01),
    ("Berlin", 52.52, 13.41), ("Paris", 48.86, 2.35), ("London", 51.51, -0.13), ("Madrid", 40.42, -3.7),
    ("Rome", 41.9, 12.5), ("Athens", 37.98, 23.73), ("Stockholm", 59.33, 18.07), ("Reykjavik", 64.15, -21.94),
    ("Lagos", 6.52, 3.38), ("Accra", 5.6, -0.19), ("Dakar", 14.72, -17.47), ("Abidjan", 5.36, -4.01),
    ("Kinshasa", -4.44, 15.27), ("Addis Ababa", 9.03, 38.74), ("Nairobi", -1.29, 36.82), ("Mogadishu", 2.05, 45.32),
    ("Dar es Salaam", -6.79, 39.21), ("Khartoum", 15.5, 32.56), ("Luanda", -8.84, 13.23), ("Harare", -17.83, 31.05),
    ("Lusaka", -15.39, 28.32), ("Johannesburg", -26.2, 28.05), ("Cape Town", -33.92, 18.42), ("Antananarivo", -18.88, 47.51),
    ("Casablanca", 33.57, -7.59), ("Algiers", 36.75, 3.06), ("Sydney", -33.87, 151.21), ("Melbourne", -37.81, 144.96),
    ("Brisbane", -27.47, 153.03), ("Perth", -31.95, 115.86), ("Darwin", -12.46, 130.84), ("Auckland", -36.85, 174.76),
    ("Suva", -18.14, 178.44), ("Port Moresby", -9.44, 147.18), ("Honolulu", 21.31, -157.86), ("Anchorage", 61.22, -149.9),
    ("Vancouver", 49.28, -123.12), ("Toronto", 43.65, -79.38), ("Montreal", 45.5, -73.57), ("New York", 40.71, -74.01),
    ("Washington", 38.91, -77.04), ("Chicago", 41.88, -87.63), ("Miami", 25.76, -80.19), ("Houston", 29.76, -95.37),
    ("Denver", 39.74, -104.99), ("Los Angeles", 34.05, -118.24), ("San Francisco", 37.77, -122.42),
    ("Mexico City", 19.43, -99.13), ("Guatemala City", 14.63, -90.51), ("Havana", 23.11, -82.37), ("Panama City", 8.98, -79.52),
    ("Bogotá", 4.71, -74.07), ("Caracas", 10.48, -66.9), ("Quito", -0.18, -78.47), ("Lima", -12.05, -77.04),
    ("La Paz", -16.5, -68.15), ("Santiago", -33.45, -70.67), ("Buenos Aires", -34.6, -58.38), ("Montevideo", -34.9, -56.16),
    ("Asunción", -25.26, -57.58), ("São Paulo", -23.55, -46.63), ("Rio de Janeiro", -22.91, -43.17), ("Brasília", -15.79, -47.88),
    ("Manaus", -3.12, -60.02), ("Recife", -8.05, -34.88), ("Nuuk", 64.18, -51.72),
]


def grid_points() -> tuple[dict[str, Any], list[tuple[float, float]]]:
    lats = []
    lat = GRID_MAX_LAT
    while lat >= -GRID_MAX_LAT - 1e-9:
        lats.append(round(lat, 3))
        lat -= GRID_STEP
    lons = [round(-180 + i * GRID_STEP, 3) for i in range(int(round(360 / GRID_STEP)))]
    grid = {"lat0": lats[0], "lon0": lons[0], "dlat": -GRID_STEP, "dlon": GRID_STEP, "nlat": len(lats), "nlon": len(lons)}
    return grid, [(la, lo) for la in lats for lo in lons]


def _fetch_batch(points: list[tuple[float, float]]) -> list[dict[str, Any]]:
    params = {
        "latitude": ",".join(f"{p[0]:g}" for p in points),
        "longitude": ",".join(f"{p[1]:g}" for p in points),
        "hourly": VARIABLES, "forecast_days": 3, "timezone": "GMT", "wind_speed_unit": "kmh",
    }
    for delay in (5, 20, 60, None):
        try:
            data = services._get_json(FORECAST_URL, params, timeout=TIMEOUT)
            return data if isinstance(data, list) else [data]
        except services.UpstreamError as exc:
            client_error = exc.status is not None and 400 <= exc.status < 500 and not exc.rate_limited
            if delay is None or client_error:  # retry timeouts, rate limits and server errors
                raise
            log.info("Open-Meteo busy (%s), retrying in %s s", exc, delay)
            time.sleep(delay)
    return []


def frame_indices(hourly_times: list[str], now: dt.datetime) -> list[int]:
    """Hourly indices of the frames: every STEP_HOURS from the last step at or before now."""
    start = now.replace(minute=0, second=0, microsecond=0)
    start -= dt.timedelta(hours=start.hour % STEP_HOURS)
    stamp = start.strftime("%Y-%m-%dT%H:%M")
    first = next((i for i, t in enumerate(hourly_times) if t >= stamp), 0)
    return list(range(first, len(hourly_times), STEP_HOURS))[:FRAMES]


def _series(loc: dict[str, Any], idx: list[int]) -> dict[str, list]:
    h = loc["hourly"]

    def pick(key, fn):
        values = h.get(key) or []
        return [fn(values[i]) if i < len(values) and values[i] is not None else None for i in idx]

    precip = h.get("precipitation") or []
    # Precipitation per frame: total over the STEP_HOURS hours that end at the frame.
    rain = [round(sum(v or 0 for v in precip[max(0, i - STEP_HOURS + 1): i + 1]), 1) if i < len(precip) else None
            for i in idx]
    return {
        "temp": pick("temperature_2m", lambda v: round(v, 1)),
        "rain": rain,
        "humidity": pick("relative_humidity_2m", round),
        "pressure": pick("pressure_msl", round),
        "wind": pick("wind_speed_10m", round),
        "wind_dir": pick("wind_direction_10m", round),
    }


def build_forecast(now: dt.datetime | None = None) -> dict[str, Any]:
    now = now or dt.datetime.now(dt.timezone.utc)
    grid, points = grid_points()
    locations: list[dict[str, Any]] = []
    for i in range(0, len(points), BATCH):
        locations += _fetch_batch(points[i: i + BATCH])
        time.sleep(1)  # be gentle with the free service
    if len(locations) != len(points):
        raise services.UpstreamError(f"Open-Meteo returned {len(locations)} of {len(points)} grid points")
    hourly_times = locations[0]["hourly"]["time"]
    idx = frame_indices(hourly_times, now)
    series = [_series(loc, idx) for loc in locations]
    fields = {key: [[s[key][f] for s in series] for f in range(len(idx))] for key in series[0]}

    cities = []
    try:
        city_locs = []
        for i in range(0, len(CITIES), BATCH):
            city_locs += _fetch_batch([(c[1], c[2]) for c in CITIES[i: i + BATCH]])
        for (name, lat, lon), loc in zip(CITIES, city_locs):
            cities.append({"name": name, "lat": lat, "lon": lon, "temp": _series(loc, idx)["temp"]})
    except services.UpstreamError as exc:
        log.warning("City temperatures failed: %s", exc)

    return {
        "built_at": now.isoformat(timespec="seconds"),
        "times": [hourly_times[i] + ":00Z" for i in idx],
        "step_hours": STEP_HOURS,
        "grid": grid,
        "fields": fields,
        "cities": cities,
        "attribution": ATTRIBUTION,
    }


def get_forecast(previous: dict[str, Any] | None = None, now: dt.datetime | None = None) -> dict[str, Any]:
    """Fresh forecast, or the previous one if it is recent enough."""
    now = now or dt.datetime.now(dt.timezone.utc)
    if previous and previous.get("built_at"):
        try:
            age = now - dt.datetime.fromisoformat(previous["built_at"])
            if age < dt.timedelta(hours=REFRESH_HOURS):
                return previous
        except ValueError:
            pass
    try:
        return build_forecast(now)
    except (services.UpstreamError, KeyError, IndexError, TypeError) as exc:
        if previous:
            log.warning("Forecast refresh failed, keeping the previous one: %s", exc)
            return previous
        raise services.UpstreamError(f"Forecast not available: {exc}") from exc
