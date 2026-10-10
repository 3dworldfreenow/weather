"""Clients for the free, key-less weather data sources used by the app.

* Open-Meteo      - point forecasts, forecast grids and place search
* RainViewer      - recent precipitation radar frames (map tiles)
* NASA EONET      - active tropical storms, wildfires and volcanoes
"""

from __future__ import annotations

import math
import threading
import time
from typing import Any, Callable

import requests

FORECAST_URL = "https://api.open-meteo.com/v1/forecast"
GEOCODING_URL = "https://geocoding-api.open-meteo.com/v1/search"
RAINVIEWER_URL = "https://api.rainviewer.com/public/weather-maps.json"
EONET_URL = "https://eonet.gsfc.nasa.gov/api/v3/events"

HTTP_TIMEOUT = 15
USER_AGENT = "weather-map/1.0 (+https://github.com/3dworldfreenow/weather)"

# Map layer name -> Open-Meteo hourly variables needed to draw it.
GRID_LAYERS: dict[str, list[str]] = {
    "temperature": ["temperature_2m"],
    "wind": ["wind_speed_10m", "wind_direction_10m"],
    "precipitation": ["precipitation"],
    "clouds": ["cloud_cover"],
    "humidity": ["relative_humidity_2m"],
    "pressure": ["pressure_msl"],
}

GRID_COLS = 16
GRID_MAX_ROWS = 14
GRID_FORECAST_HOURS = 48
GRID_STEP_HOURS = 3
MAX_MERCATOR_LAT = 85.0

EONET_CATEGORIES = {
    "severeStorms": "storm",
    "wildfires": "fire",
    "volcanoes": "volcano",
}


class UpstreamError(RuntimeError):
    """Raised when an upstream data provider fails or returns bad data."""


class TTLCache:
    """Tiny thread-safe in-memory cache with per-entry expiry."""

    def __init__(self, max_entries: int = 512):
        self._data: dict[Any, tuple[float, Any]] = {}
        self._lock = threading.Lock()
        self._max_entries = max_entries

    def get_or_set(self, key: Any, ttl: float, factory: Callable[[], Any]) -> Any:
        now = time.monotonic()
        with self._lock:
            hit = self._data.get(key)
            if hit and hit[0] > now:
                return hit[1]
        value = factory()
        with self._lock:
            if len(self._data) >= self._max_entries:
                self._data = {k: v for k, v in self._data.items() if v[0] > now}
                if len(self._data) >= self._max_entries:
                    self._data.clear()
            self._data[key] = (now + ttl, value)
        return value

    def clear(self) -> None:
        with self._lock:
            self._data.clear()


cache = TTLCache()
_session = requests.Session()
_session.headers["User-Agent"] = USER_AGENT


def _get_json(url: str, params: dict[str, Any] | None = None) -> Any:
    try:
        resp = _session.get(url, params=params, timeout=HTTP_TIMEOUT)
        resp.raise_for_status()
        return resp.json()
    except (requests.RequestException, ValueError) as exc:
        raise UpstreamError(f"Request to {url} failed: {exc}") from exc


# --------------------------------------------------------------------------
# Point forecast
# --------------------------------------------------------------------------

def get_forecast(lat: float, lon: float) -> dict[str, Any]:
    """Current conditions, next 24 hours and 7-day forecast for one point."""
    params = {
        "latitude": round(lat, 3),
        "longitude": round(lon, 3),
        "timezone": "auto",
        "current": ",".join([
            "temperature_2m", "apparent_temperature", "relative_humidity_2m",
            "precipitation", "weather_code", "cloud_cover", "pressure_msl",
            "wind_speed_10m", "wind_direction_10m", "wind_gusts_10m", "is_day",
        ]),
        "hourly": ",".join([
            "temperature_2m", "precipitation_probability", "weather_code",
            "wind_speed_10m", "is_day",
        ]),
        "daily": ",".join([
            "weather_code", "temperature_2m_max", "temperature_2m_min",
            "precipitation_sum", "precipitation_probability_max",
            "wind_speed_10m_max", "sunrise", "sunset",
        ]),
        "forecast_hours": 24,
        "forecast_days": 7,
    }
    key = ("forecast", params["latitude"], params["longitude"])
    return cache.get_or_set(key, 600, lambda: _get_json(FORECAST_URL, params))


# --------------------------------------------------------------------------
# Place search
# --------------------------------------------------------------------------

def search_places(query: str, limit: int = 8) -> list[dict[str, Any]]:
    query = query.strip()
    if len(query) < 2:
        return []

    def fetch() -> list[dict[str, Any]]:
        data = _get_json(GEOCODING_URL, {
            "name": query, "count": limit, "language": "en", "format": "json",
        })
        return [
            {
                "name": r.get("name"),
                "admin1": r.get("admin1"),
                "country": r.get("country"),
                "country_code": r.get("country_code"),
                "lat": r.get("latitude"),
                "lon": r.get("longitude"),
            }
            for r in data.get("results") or []
        ]

    return cache.get_or_set(("search", query.lower(), limit), 3600, fetch)


# --------------------------------------------------------------------------
# Forecast grid for map overlays (temperature, wind, ...)
# --------------------------------------------------------------------------

def _lat_to_merc(lat: float) -> float:
    lat = max(-MAX_MERCATOR_LAT, min(MAX_MERCATOR_LAT, lat))
    return math.log(math.tan(math.pi / 4 + math.radians(lat) / 2))


def _merc_to_lat(y: float) -> float:
    return math.degrees(2 * math.atan(math.exp(y)) - math.pi / 2)


def build_grid_points(south: float, west: float, north: float, east: float,
                      cols: int = GRID_COLS, max_rows: int = GRID_MAX_ROWS
                      ) -> tuple[list[float], list[float]]:
    """Sample points at the pixel centres of a cols x rows image covering the bbox.

    Latitudes are spaced evenly in Web Mercator space so that the grid can be
    stretched over the map as a plain image overlay without distortion.
    Rows are returned north -> south, columns west -> east.
    """
    y_s, y_n = _lat_to_merc(south), _lat_to_merc(north)
    width_rad = math.radians(east - west)
    aspect = (y_n - y_s) / width_rad if width_rad > 0 else 1
    rows = max(4, min(max_rows, round(cols * aspect)))

    lons = [west + (east - west) * (i + 0.5) / cols for i in range(cols)]
    lats = [_merc_to_lat(y_n - (y_n - y_s) * (j + 0.5) / rows) for j in range(rows)]
    return lats, lons


def _normalise_lon(lon: float) -> float:
    return ((lon + 180) % 360) - 180


def get_grid(layer: str, south: float, west: float, north: float, east: float
             ) -> dict[str, Any]:
    if layer not in GRID_LAYERS:
        raise ValueError(f"Unknown layer '{layer}'")

    south = max(-MAX_MERCATOR_LAT, min(MAX_MERCATOR_LAT, south))
    north = max(-MAX_MERCATOR_LAT, min(MAX_MERCATOR_LAT, north))
    if north <= south or east <= west:
        raise ValueError("Invalid bounding box")
    if east - west > 360:
        west, east = -180.0, 180.0

    # Round the bbox so nearby map views share cache entries.
    south, west, north, east = (round(v, 1) for v in (south, west, north, east))
    key = ("grid", layer, south, west, north, east)
    return cache.get_or_set(key, 900, lambda: _fetch_grid(layer, south, west, north, east))


def _fetch_grid(layer: str, south: float, west: float, north: float, east: float
                ) -> dict[str, Any]:
    lats, lons = build_grid_points(south, west, north, east)
    point_lats = [round(lat, 3) for lat in lats for _ in lons]
    point_lons = [round(_normalise_lon(lon), 3) for _ in lats for lon in lons]
    variables = GRID_LAYERS[layer]

    data = _get_json(FORECAST_URL, {
        "latitude": ",".join(map(str, point_lats)),
        "longitude": ",".join(map(str, point_lons)),
        "hourly": ",".join(variables),
        "forecast_hours": GRID_FORECAST_HOURS,
        "timezone": "GMT",
        "timeformat": "unixtime",
        "wind_speed_unit": "kmh",
    })
    if isinstance(data, dict):
        data = [data]
    if not isinstance(data, list) or len(data) != len(point_lats):
        raise UpstreamError("Unexpected forecast grid response")

    times = data[0]["hourly"]["time"][::GRID_STEP_HOURS]
    n_t, rows, cols = len(times), len(lats), len(lons)

    def series(var: str) -> list[list[float | None]]:
        return [loc["hourly"][var][::GRID_STEP_HOURS][:n_t] for loc in data]

    def to_frames(per_point: list[list[float | None]]) -> list[list[list[float | None]]]:
        return [
            [[per_point[r * cols + c][t] for c in range(cols)] for r in range(rows)]
            for t in range(n_t)
        ]

    result: dict[str, Any] = {
        "layer": layer,
        "bounds": {"south": south, "west": west, "north": north, "east": east},
        "rows": rows,
        "cols": cols,
        "times": times,
    }

    if layer == "wind":
        speeds, dirs = series("wind_speed_10m"), series("wind_direction_10m")
        u_pts, v_pts = [], []
        for sp_row, dir_row in zip(speeds, dirs):
            u_row, v_row = [], []
            for sp, d in zip(sp_row, dir_row):
                if sp is None or d is None:
                    u_row.append(None)
                    v_row.append(None)
                    continue
                # Meteorological direction is where the wind blows *from*.
                rad = math.radians(d)
                u_row.append(round(-sp * math.sin(rad), 2))
                v_row.append(round(-sp * math.cos(rad), 2))
            u_pts.append(u_row)
            v_pts.append(v_row)
        result["values"] = to_frames(speeds)
        result["u"] = to_frames(u_pts)
        result["v"] = to_frames(v_pts)
    else:
        result["values"] = to_frames(series(variables[0]))
    return result


# --------------------------------------------------------------------------
# Radar
# --------------------------------------------------------------------------

def get_radar_frames() -> dict[str, Any]:
    def fetch() -> dict[str, Any]:
        data = _get_json(RAINVIEWER_URL)
        radar = data.get("radar") or {}
        frames = [
            {"time": f["time"], "path": f["path"], "nowcast": nowcast}
            for nowcast, group in ((False, radar.get("past")), (True, radar.get("nowcast")))
            for f in group or []
        ]
        return {"host": data.get("host", "https://tilecache.rainviewer.com"), "frames": frames}

    return cache.get_or_set("radar", 120, fetch)


# --------------------------------------------------------------------------
# Storms, fires and volcanoes
# --------------------------------------------------------------------------

def get_events(days: int = 20) -> list[dict[str, Any]]:
    def fetch() -> list[dict[str, Any]]:
        data = _get_json(EONET_URL, {
            "status": "open",
            "days": days,
            "category": ",".join(EONET_CATEGORIES),
        })
        events = []
        for ev in data.get("events") or []:
            category = next(
                (EONET_CATEGORIES[c["id"]] for c in ev.get("categories", [])
                 if c.get("id") in EONET_CATEGORIES),
                None,
            )
            points = [
                g for g in ev.get("geometry") or []
                if g.get("type") == "Point" and g.get("coordinates")
            ]
            if not category or not points:
                continue
            points.sort(key=lambda g: g.get("date") or "")
            latest = points[-1]
            events.append({
                "id": ev.get("id"),
                "title": ev.get("title"),
                "type": category,
                "date": latest.get("date"),
                "lat": latest["coordinates"][1],
                "lon": latest["coordinates"][0],
                "magnitude": latest.get("magnitudeValue"),
                "magnitude_unit": latest.get("magnitudeUnit"),
                "track": [[p["coordinates"][1], p["coordinates"][0]] for p in points]
                if category == "storm" else [],
                "link": next((s.get("url") for s in ev.get("sources") or []), None),
            })
        return events

    return cache.get_or_set(("events", days), 1800, fetch)
