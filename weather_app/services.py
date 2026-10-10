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
# All of them are fetched in one request, so switching layers is free.
GRID_LAYERS: dict[str, list[str]] = {
    "temperature": ["temperature_2m"],
    "wind": ["wind_speed_10m", "wind_direction_10m"],
    "precipitation": ["precipitation"],
    "clouds": ["cloud_cover"],
    "humidity": ["relative_humidity_2m"],
    "pressure": ["pressure_msl"],
}

# Open-Meteo counts every grid point as one API call (free tier: 600/min,
# 5,000/hour, 10,000/day), so keep the grid small and reuse it a lot.
GRID_COLS = 12
GRID_MAX_ROWS = 10
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

    def __init__(self, message: str, status: int | None = None, reason: str | None = None):
        super().__init__(message)
        self.status = status
        self.reason = reason

    @property
    def rate_limited(self) -> bool:
        return self.status == 429


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

    def get(self, key: Any, default: Any = None) -> Any:
        with self._lock:
            hit = self._data.get(key)
            return hit[1] if hit and hit[0] > time.monotonic() else default

    def set(self, key: Any, value: Any, ttl: float) -> None:
        with self._lock:
            self._data[key] = (time.monotonic() + ttl, value)

    def clear(self) -> None:
        with self._lock:
            self._data.clear()


cache = TTLCache()
_session = requests.Session()
_session.headers["User-Agent"] = USER_AGENT


def _get_json(url: str, params: dict[str, Any] | None = None) -> Any:
    try:
        resp = _session.get(url, params=params, timeout=HTTP_TIMEOUT)
    except requests.RequestException as exc:
        raise UpstreamError(f"Request to {url} failed: {exc}") from exc
    if not resp.ok:
        reason = None
        try:
            reason = resp.json().get("reason")
        except (ValueError, AttributeError):
            pass
        raise UpstreamError(
            f"{url} returned HTTP {resp.status_code}: {reason or resp.text[:200]}",
            status=resp.status_code, reason=reason,
        )
    try:
        return resp.json()
    except ValueError as exc:
        raise UpstreamError(f"{url} returned invalid JSON") from exc


def _get_text(url: str) -> str:
    try:
        resp = _session.get(url, timeout=HTTP_TIMEOUT)
    except requests.RequestException as exc:
        raise UpstreamError(f"Request to {url} failed: {exc}") from exc
    if not resp.ok:
        raise UpstreamError(f"{url} returned HTTP {resp.status_code}", status=resp.status_code)
    return resp.text


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


def snap_bbox(south: float, west: float, north: float, east: float
              ) -> tuple[float, float, float, float]:
    """Expand a bbox outwards to a coarse lattice so nearby views share a grid.

    The lattice step is a power of two degrees, about a quarter of the view
    width. Views wider than the globe snap to the full -180..180 range.
    """
    span = max(east - west, (north - south) / 2, 0.5)
    step = 2.0 ** math.floor(math.log2(span / 4))
    step = min(max(step, 0.25), 90.0)
    west = math.floor(west / step) * step
    east = math.ceil(east / step) * step
    south = max(-MAX_MERCATOR_LAT, math.floor(south / step) * step)
    north = min(MAX_MERCATOR_LAT, math.ceil(north / step) * step)
    if east - west >= 360:
        west, east = -180.0, 180.0
    elif west < -180 or west >= 180:
        # Shift into the canonical world copy; the client handles wrapping.
        shift = math.floor((west + 180) / 360) * 360
        west, east = west - shift, east - shift
    return south, west, north, east


def get_grid(layer: str, south: float, west: float, north: float, east: float
             ) -> dict[str, Any]:
    if layer not in GRID_LAYERS:
        raise ValueError(f"Unknown layer '{layer}'")

    south = max(-MAX_MERCATOR_LAT, min(MAX_MERCATOR_LAT, south))
    north = max(-MAX_MERCATOR_LAT, min(MAX_MERCATOR_LAT, north))
    if north <= south or east <= west:
        raise ValueError("Invalid bounding box")

    south, west, north, east = snap_bbox(south, west, north, east)
    raw = cache.get_or_set(("grid", south, west, north, east), 1800,
                           lambda: _fetch_grid(south, west, north, east))
    return _grid_layer(raw, layer)


def _fetch_grid(south: float, west: float, north: float, east: float) -> dict[str, Any]:
    lats, lons = build_grid_points(south, west, north, east)
    point_lats = [round(lat, 3) for lat in lats for _ in lons]
    point_lons = [round(_normalise_lon(lon), 3) for _ in lats for lon in lons]
    variables = sorted({v for vs in GRID_LAYERS.values() for v in vs})

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

    def frames(var: str) -> list[list[list[float | None]]]:
        per_point = [loc["hourly"][var][::GRID_STEP_HOURS][:n_t] for loc in data]
        return [
            [[per_point[r * cols + c][t] for c in range(cols)] for r in range(rows)]
            for t in range(n_t)
        ]

    return {
        "bounds": {"south": south, "west": west, "north": north, "east": east},
        "rows": rows,
        "cols": cols,
        "times": times,
        "fields": {var: frames(var) for var in variables},
    }


def _grid_layer(raw: dict[str, Any], layer: str) -> dict[str, Any]:
    fields = raw["fields"]
    result = {k: raw[k] for k in ("bounds", "rows", "cols", "times")}
    result["layer"] = layer
    result["global"] = raw["bounds"]["east"] - raw["bounds"]["west"] >= 360

    if layer != "wind":
        result["values"] = fields[GRID_LAYERS[layer][0]]
        return result

    def vector(sp: float | None, d: float | None) -> tuple[float | None, float | None]:
        if sp is None or d is None:
            return None, None
        # Meteorological direction is where the wind blows *from*.
        rad = math.radians(d)
        return round(-sp * math.sin(rad), 2), round(-sp * math.cos(rad), 2)

    speeds, dirs = fields["wind_speed_10m"], fields["wind_direction_10m"]
    u_frames, v_frames = [], []
    for sp_f, d_f in zip(speeds, dirs):
        uv = [[vector(sp, d) for sp, d in zip(sp_r, d_r)] for sp_r, d_r in zip(sp_f, d_f)]
        u_frames.append([[p[0] for p in row] for row in uv])
        v_frames.append([[p[1] for p in row] for row in uv])
    result["values"] = speeds
    result["u"] = u_frames
    result["v"] = v_frames
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
